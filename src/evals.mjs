import { join } from 'node:path';
import { EFFORT_LEVELS, modelError, effortError } from './adapters.mjs';
import { loadCases, caseInfo, casePrompt, grade } from './eval-cases.mjs';
import { httpError } from './http-error.mjs';

const money = (value) => Number.isFinite(value) && value >= 0;
const date = () => new Date().toISOString();
const json = (row) => JSON.parse(row.data);

export function createEvals({ store, home, root, runner }) {
  const db = store.db;
  let active = null,
    closed = false;
  const catalog = () => loadCases(join(root, 'evals'), join(home, 'evals'));
  function save(run) {
    db.prepare('UPDATE eval_runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id);
  }
  function saveResult(id, result) {
    db.prepare(
      'INSERT INTO eval_results (run_id,digest,data) VALUES (?,?,?) ON CONFLICT(run_id,digest) DO UPDATE SET data=excluded.data',
    ).run(id, result.digest, JSON.stringify(result));
  }
  const results = (id) => db.prepare('SELECT data FROM eval_results WHERE run_id=? ORDER BY rowid').all(id).map(json);
  function stop(run, reason) {
    Object.assign(run, { status: 'stopped', reason, finishedAt: date() });
    save(run);
  }
  for (const row of db.prepare("SELECT data FROM eval_runs WHERE json_extract(data,'$.status')='running'").all()) {
    const run = json(row);
    store.transaction(() => {
      for (const item of results(run.id))
        if (item.status === 'running') {
          saveResult(run.id, { ...item, status: 'error', error: 'Service interrupted this case', costUsd: null });
          run.costUsd = null;
        }
      stop(run, 'Service restarted; no cases were replayed');
    });
  }

  async function selection(body) {
    const { adapter, model, effort, cases } = body;
    const error = modelError(adapter, model) || effortError(adapter, effort);
    if (error) throw httpError(error);
    if (!Array.isArray(cases) || !cases.length || cases.length > 50 || new Set(cases).size !== cases.length)
      throw httpError('Select 1–50 different case versions');
    const available = new Map((await catalog()).map((item) => [item.digest, item]));
    if (cases.some((digest) => !available.has(digest)))
      throw httpError('The selected suite changed. Reload Evals before starting.', 409);
    return { target: { adapter, model, effort }, cases: cases.map((digest) => available.get(digest)) };
  }

  async function execute(run, items, signal) {
    for (const item of items) {
      if (signal.aborted) return stop(run, 'Service is stopping');
      const remaining = run.budgetUsd - run.knownUsd;
      if (remaining <= Number.EPSILON * run.budgetUsd * run.graded)
        return stop(run, 'Budget reached before the next case');
      const started = Date.now();
      const row = { ...caseInfo(item), status: 'running', costUsd: null, startedAt: date() };
      saveResult(run.id, row);
      let output;
      try {
        output = await runner.execute({
          target: run.target,
          image: run.image,
          remaining,
          prompt: casePrompt(item),
          signal,
        });
      } catch (error) {
        output = { error: error.message };
      }
      const costUsd = money(output.costUsd) ? output.costUsd : null;
      const error = output.error || (typeof output.reply !== 'string' ? 'Harness did not return a reply' : null);
      const result = {
        ...row,
        status: error ? 'error' : 'graded',
        error,
        reply: output.reply?.slice(0, 64000),
        observedModel: output.observedModel ?? null,
        score: error ? null : grade(item, output.reply),
        tokens: Number.isSafeInteger(output.tokens) && output.tokens >= 0 ? output.tokens : null,
        durationMs: Date.now() - started,
        costUsd,
        costError: costUsd === null ? output.costError || 'No measured cost from the harness' : null,
      };
      store.transaction(() => {
        saveResult(run.id, result);
        run.knownUsd += costUsd ?? 0;
        run.costUsd = costUsd === null ? null : run.knownUsd;
        run.graded += Number(!error);
        if (error || costUsd === null) stop(run, [error, result.costError].filter(Boolean).join('; '));
        else save(run);
      });
      if (run.status === 'stopped') return;
    }
    Object.assign(run, { status: 'complete', finishedAt: date() });
    save(run);
  }
  function details(id) {
    const row = db.prepare('SELECT data FROM eval_runs WHERE id=?').get(id);
    if (!row) throw httpError('Unknown eval run', 404);
    return { ...json(row), results: results(id) };
  }
  return {
    async catalog() {
      return { cases: (await catalog()).map(caseInfo), efforts: EFFORT_LEVELS };
    },
    list(before = null) {
      if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))))
        throw httpError('Invalid run cursor');
      return db
        .prepare('SELECT data FROM eval_runs WHERE id < ? ORDER BY id DESC LIMIT 50')
        .all(before === null ? Number.MAX_SAFE_INTEGER : Number(before))
        .map(json);
    },
    details,
    async estimate(body) {
      const { target, cases } = await selection(body);
      const query = db.prepare(
        `SELECT json_extract(result.data,'$.costUsd') AS usd, run.id FROM eval_results result JOIN eval_runs run ON run.id=result.run_id WHERE result.digest=? AND json_extract(run.data,'$.target.adapter')=? AND json_extract(run.data,'$.target.model')=? AND json_extract(run.data,'$.target.effort')=? AND json_extract(result.data,'$.status')='graded' AND json_extract(result.data,'$.costUsd') IS NOT NULL ORDER BY run.id DESC LIMIT 1`,
      );
      return cases.map(({ id, digest }) => ({
        id,
        digest,
        ...(query.get(digest, target.adapter, target.model, target.effort) ?? { usd: null }),
      }));
    },
    async start(body) {
      const { target, cases } = await selection(body);
      if (!Number.isFinite(body.budgetUsd) || body.budgetUsd <= 0 || body.budgetUsd > 1000)
        throw httpError('Budget must be greater than $0 and at most $1000');
      if (closed || active) throw httpError('Another run is active or the service is stopping', 409);
      const image = await runner.prepare();
      if (closed || active) throw httpError('Another run is active or the service is stopping', 409);
      const run = {
        id: 0,
        target,
        cases: cases.map(caseInfo),
        image,
        budgetUsd: body.budgetUsd,
        knownUsd: 0,
        costUsd: 0,
        status: 'running',
        graded: 0,
        startedAt: date(),
        finishedAt: null,
        reason: null,
      };
      store.transaction(() => {
        run.id = Number(db.prepare("INSERT INTO eval_runs(data) VALUES('{}')").run().lastInsertRowid);
        save(run);
      });
      const controller = new AbortController();
      const work = execute(run, cases, controller.signal)
        .catch((error) => {
          run.costUsd = null;
          stop(run, error.message);
        })
        .finally(() => {
          active = null;
        });
      active = { controller, work };
      return details(run.id);
    },
    async close() {
      closed = true;
      active?.controller.abort();
      await active?.work;
    },
  };
}
