import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { modelArgs, effortArgs, modelError, effortError, readTurn, turnReply } from './adapters.mjs';
import { CodexRollouts } from './codex-rollout.mjs';

export function evalCommand(target, remaining, env = process.env) {
  const { adapter, model, effort } = target;
  const invalid = modelError(adapter, model) || effortError(adapter, effort);
  if (invalid) throw new Error(invalid);
  if (!(Number.isFinite(remaining) && remaining > 0)) throw new Error('No remaining budget');
  const selected = [...modelArgs(target), ...effortArgs(target)];
  if (adapter === 'codex')
    return [
      adapter,
      ...effortArgs(target),
      ...(env.OPENAI_BASE_URL
        ? [
            '-c',
            'model_provider="mu_eval"',
            '-c',
            `model_providers.mu_eval={name="Evaluation gateway",base_url=${JSON.stringify(env.OPENAI_BASE_URL)},env_key="${env.CODEX_API_KEY ? 'CODEX_API_KEY' : 'OPENAI_API_KEY'}",wire_api="responses",supports_websockets=false}`,
          ]
        : []),
      '-c',
      'approval_policy="never"',
      // A case is answered from the prompt alone, as Claude and pi answer it without tools. Web search could look up a
      // public answer key, and the spend of a sub-agent thread is not in the rollout that Mu prices.
      ...[
        'features.shell_tool=false',
        'web_search="disabled"',
        'features.multi_agent=false',
        'features.goals=false',
        'features.view_image=false',
      ].flatMap((setting) => ['-c', setting]),
      'exec',
      ...modelArgs(target),
      '--sandbox',
      'read-only',
      '--json',
      '--skip-git-repo-check',
      '-',
    ];
  if (adapter === 'claude')
    return [
      adapter,
      ...selected,
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--max-budget-usd',
      String(remaining),
    ];
  return [adapter, ...selected, '-p', '--mode', 'json', '--no-session', '--no-tools'];
}

export function resultFromStream(adapter, stdout) {
  const turn = readTurn(adapter, stdout);
  let error = null,
    reply = null;
  try {
    reply = turnReply(adapter, turn).text;
  } catch (failure) {
    error = failure.message;
  }
  const usage = turn.usage;
  let tokens = usage.totalTokens;
  let costUsd = usage.costUsd;
  const events = stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  let costError = null;
  if (adapter === 'pi') {
    const messages = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant');
    if (messages.some(({ message }) => !Number.isFinite(message.usage?.cost?.total))) costUsd = null;
    if (messages.some(({ message }) => !Number.isSafeInteger(message.usage?.totalTokens))) tokens = null;
    // pi prices a model that its catalog lists without a cost at zero; a call with tokens cannot have been free.
    const unpriced = messages.find(({ message }) => message.usage?.cost?.total === 0 && message.usage?.totalTokens > 0);
    if (unpriced) {
      costUsd = null;
      costError = `pi has no price for ${unpriced.message.provider}/${unpriced.message.model}`;
    }
  }
  if (adapter === 'claude') {
    const results = events.filter((event) => event.type === 'result');
    if (
      results.length &&
      results.every(({ usage }) => Number.isFinite(usage?.input_tokens) && Number.isFinite(usage.output_tokens))
    )
      tokens = results.reduce(
        (sum, { usage }) =>
          sum +
          usage.input_tokens +
          usage.output_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        0,
      );
  }
  return { error, reply, observedModel: usage.model, costUsd, tokens, sessionId: turn.sessionId, costError };
}

// A harness that is killed, by the timeout or a signal, may have a model call in flight whose spend it never reported.
export function harnessResult(adapter, error, stdout, stderr) {
  const result = resultFromStream(adapter, stdout);
  if (!error) return result;
  result.error = `Harness exited ${error.code ?? error.signal}: ${stderr.trim().slice(-1200) || result.error || 'no diagnostic'}`;
  if (error.killed || error.signal) {
    result.costUsd = null;
    result.costError = 'The harness was stopped before it finished, so a call it had started may be unpriced';
  }
  return result;
}

async function main() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { target, prompt, remaining } = JSON.parse(input);
  const [command, ...args] = evalCommand(target, remaining);
  await mkdir('/tmp/work', { recursive: true });
  await mkdir('/tmp/home', { recursive: true });
  if (target.adapter === 'pi' && process.env.MU_EVAL_PI_MODELS_JSON) {
    const models = JSON.parse(process.env.MU_EVAL_PI_MODELS_JSON);
    if (!models?.providers || typeof models.providers !== 'object' || Array.isArray(models.providers))
      throw new Error('MU_EVAL_PI_MODELS_JSON needs a pi providers object');
    await mkdir('/tmp/home/.pi/agent', { recursive: true });
    await writeFile('/tmp/home/.pi/agent/models.json', JSON.stringify(models), { mode: 0o600 });
    delete process.env.MU_EVAL_PI_MODELS_JSON;
  }
  const result = await new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: '/tmp/work', encoding: 'utf8', timeout: 240000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          resolve(harnessResult(target.adapter, error, stdout, stderr));
        } catch (failure) {
          reject(failure);
        }
      },
    );
    child.stdin.on('error', (error) => {
      if (!('code' in error && error.code === 'EPIPE')) reject(error);
    });
    child.stdin.end(prompt);
  });
  // Codex is priced from its rollout's calls, so a killed harness, whose spend is unknown, is not priced at all.
  if (target.adapter === 'codex' && result.sessionId && !result.costError) {
    try {
      const facts = await new CodexRollouts().read(result.sessionId);
      Object.assign(result, { observedModel: facts.model, calls: facts.calls });
    } catch (error) {
      result.costError = error.message;
    }
  }
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
