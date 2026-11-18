const dollars = (value) =>
  typeof value === 'number'
    ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
    : 'unknown';
const runName = (run) =>
  `#${run.id} · ${run.target.adapter} / ${run.target.model} / ${run.target.effort} · ${new Date(run.startedAt).toLocaleString()}`;

export function createEvalsView(document, request) {
  const by = (name) => document.getElementById(`eval-${name}`);
  const make = (name, text = '') => {
    const element = document.createElement(name);
    element.textContent = text;
    return element;
  };
  const option = (value, title) => {
    const item = make('option', title);
    item.value = value;
    return item;
  };
  const post = (path, data) => request(`/api/evals/${path}`, { method: 'POST', body: JSON.stringify(data) });
  let catalog,
    confirmed,
    revision = 0,
    page = 0,
    comparison = 0,
    listVersion = 0,
    timer,
    visible = false,
    busy = false;
  const history = new Map();
  const error = (message = '') => {
    by('error').textContent = message;
    by('error').hidden = !message;
  };
  const invalidate = () => {
    revision++;
    confirmed = null;
    by('confirm').hidden = true;
  };
  const updateEffort = () =>
    by('effort').replaceChildren(...catalog.efforts[by('adapter').value].map((value) => option(value, value)));
  by('adapter').addEventListener('change', () => {
    updateEffort();
    invalidate();
  });
  by('form').addEventListener('input', invalidate);
  by('form').addEventListener('submit', (event) => {
    event.preventDefault();
    invalidate();
    error();
    const token = revision;
    const data = {
      adapter: by('adapter').value,
      model: by('model').value.trim(),
      effort: by('effort').value,
      budgetUsd: Number(by('budget').value),
      cases: [...by('cases').querySelectorAll('input:checked')].map((element) => element.value),
    };
    if (!data.cases.length) return error('Select at least one work sample.');
    void post('estimate', data)
      .then((cases) => {
        if (revision !== token) return;
        const known = cases.filter((item) => item.usd !== null);
        const estimate = known.length
          ? `${dollars(known.reduce((sum, item) => sum + item.usd, 0))} for ${known.length} of ${cases.length} cases with matching history`
          : 'No measured estimate for these versions and settings yet';
        by('estimate').textContent =
          `${data.model} · ${data.adapter} / ${data.effort} · ${cases.length} cases · ${dollars(data.budgetUsd)} budget (stops before the next case). ${estimate}.`;
        confirmed = data;
        by('confirm').hidden = false;
      })
      .catch((failure) => {
        if (revision === token) error(failure.message);
      });
  });

  function resultCell(run, info) {
    const cell = make('td');
    if (!run?.cases.some(({ digest }) => digest === info.digest)) {
      cell.textContent = 'Not in this run';
      return cell;
    }
    const result = run.results.find(({ digest }) => digest === info.digest);
    if (!result || result.status === 'running') {
      cell.textContent = result ? 'Running' : run.status === 'running' ? 'Queued' : 'Not run';
      return cell;
    }
    const score = result.score;
    cell.append(
      make('strong', score ? `${score.earned}/${score.possible} checks` : 'Case failed'),
      make(
        'p',
        `${dollars(result.costUsd)} · ${result.tokens ?? 'unknown'} tokens · ${result.durationMs == null ? 'unknown time' : `${(result.durationMs / 1000).toFixed(1)} s`}`,
      ),
    );
    const details = make('details');
    details.append(make('summary', 'Inspect evidence'));
    for (const check of score?.checks ?? [])
      details.append(make('p', `${check.passed ? 'Pass' : 'Miss'}: ${check.label}`));
    for (const text of [
      result.error,
      result.costError,
      score?.note,
      result.observedModel && `Reported model: ${result.observedModel}`,
    ].filter(Boolean))
      details.append(make('p', text));
    if (result.reply) details.append(make('pre', result.reply));
    cell.append(details);
    return cell;
  }

  async function compare() {
    const version = ++comparison;
    const runs = await Promise.all(
      ['left', 'right'].map((side) => (by(side).value ? request(`/api/evals/runs/${by(side).value}`) : null)),
    );
    if (version !== comparison || !visible) return;
    const box = by('comparison');
    if (!runs.some(Boolean)) {
      box.replaceChildren(make('p', 'No saved runs. Preview a run to get started.'));
      return;
    }
    const table = make('table'),
      heading = make('tr');
    heading.append(make('th', 'Work sample'));
    const head = make('thead'),
      body = make('tbody');
    head.append(heading);
    table.append(head, body);
    for (const run of runs) {
      const cell = make('th', run ? runName(run) : 'No run selected');
      if (run) {
        const tokenTotal =
          run.results.length && run.results.every((item) => Number.isSafeInteger(item.tokens))
            ? run.results.reduce((sum, item) => sum + item.tokens, 0).toLocaleString()
            : 'unknown';
        const total =
          run.status === 'complete'
            ? `${Math.round((100 * run.results.reduce((sum, item) => sum + (item.weight * item.score.earned) / item.score.possible, 0)) / run.cases.reduce((sum, item) => sum + item.weight, 0))}% · weighted case score`
            : 'No complete suite score';
        cell.append(
          make('p', `${run.status} · ${run.graded}/${run.cases.length} graded · ${total}`),
          make(
            'p',
            `Cost ${dollars(run.costUsd)}${run.costUsd === null ? ` (known ${dollars(run.knownUsd)})` : ''} · budget ${dollars(run.budgetUsd)}`,
          ),
          make('small', `Harness image ${run.image.slice(7, 19)}`),
        );
        if (run.finishedAt)
          cell.append(
            make(
              'p',
              `${((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} s elapsed · ${tokenTotal} tokens`,
            ),
          );
        if (run.reason) cell.append(make('p', run.reason));
      }
      heading.append(cell);
    }
    const cases = new Map(runs.filter(Boolean).flatMap((run) => run.cases.map((item) => [item.digest, item])));
    for (const item of cases.values()) {
      const row = make('tr');
      row.append(make('th', `${item.title} · ${item.digest.slice(0, 8)}`), ...runs.map((run) => resultCell(run, item)));
      body.append(row);
    }
    const sameSuite = runs.every((run) => run && run.cases.length === cases.size);
    box.replaceChildren(
      ...(runs.every(Boolean) && !sameSuite
        ? [make('p', 'Different suites: compare matching rows, not overall percentages.')]
        : []),
      table,
    );
  }

  async function refresh({ older = false, select = null } = {}) {
    clearTimeout(timer);
    const version = ++listVersion;
    const old = history.size ? [...history.keys()].reduce((lowest, id) => Math.min(lowest, id)) : undefined;
    const list = await request(`/api/evals/runs${older && old ? `?before=${old}` : ''}`);
    if (version !== listVersion || !visible) return;
    for (const run of list) history.set(run.id, run);
    const sorted = [...history.values()].sort((left, right) => right.id - left.id);
    for (const [index, side] of ['left', 'right'].entries()) {
      const value = select && !index ? String(select) : by(side).value || String(sorted[index]?.id ?? '');
      by(side).replaceChildren(option('', 'Choose a run'), ...sorted.map((run) => option(run.id, runName(run))));
      by(side).value = value;
    }
    if (older || old === undefined) by('older').hidden = list.length < 50;
    await compare();
    if (version === listVersion && visible && sorted.some(({ status }) => status === 'running'))
      timer = setTimeout(() => void refresh().catch((failure) => error(failure.message)), 2000);
  }
  for (const side of ['left', 'right'])
    by(side).addEventListener('change', () => void compare().catch((failure) => error(failure.message)));
  by('older').addEventListener('click', () => void refresh({ older: true }).catch((failure) => error(failure.message)));
  by('start').addEventListener('click', () => {
    if (!confirmed || busy) return;
    busy = true;
    by('start').disabled = true;
    error();
    void post('runs', confirmed)
      .then(async (run) => {
        invalidate();
        await refresh({ select: run.id });
      })
      .catch((failure) => error(failure.message))
      .finally(() => {
        busy = false;
        by('start').disabled = false;
      });
  });

  async function load() {
    const version = ++page;
    error();
    invalidate();
    await Promise.all([
      refresh(),
      (async () => {
        const loaded = await request('/api/evals');
        if (!visible || version !== page) return;
        const prior = by('adapter').value,
          effort = by('effort').value;
        // A changed case has a new digest, so it is offered selected like a new case; only boxes the user cleared stay so.
        const cleared = new Set([...by('cases').querySelectorAll('input:not(:checked)')].map((input) => input.value));
        catalog = loaded;
        by('adapter').replaceChildren(...Object.keys(catalog.efforts).map((value) => option(value, value)));
        if (prior) by('adapter').value = prior;
        updateEffort();
        if (effort) by('effort').value = effort;
        by('cases').replaceChildren(
          ...catalog.cases.map((item) => {
            const label = make('label'),
              input = make('input');
            input.type = 'checkbox';
            input.value = item.digest;
            input.checked = !cleared.has(item.digest);
            label.append(input, ` ${item.title} — ${item.skill}`);
            return label;
          }),
        );
      })(),
    ]);
  }
  const show = () => {
    visible = true;
    void load().catch((failure) => error(failure.message));
  };
  by('refresh').addEventListener('click', show);
  return {
    show,
    hide() {
      visible = false;
      ++page;
      ++comparison;
      ++listVersion;
      invalidate();
      clearTimeout(timer);
    },
  };
}
