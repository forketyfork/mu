import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A container gets only what the service's environment sets explicitly for evaluations: MU_EVAL_<NAME> becomes <NAME>
// for Claude and Codex, and MU_EVAL_PI_<PROVIDER>_API_KEY becomes <PROVIDER>_API_KEY for pi. The service's own
// credentials, such as a key or login exported for the user's CLIs, never reach a case.
const providerEnv = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  pi: [],
};

function docker(args, { env, input = '', signal = undefined, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { env, timeout, signal, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`Docker ${args[0]} failed: ${stderr.trim().slice(-1200) || error.code || error.message}`, {
              cause: error,
            }),
          );
        else resolve(stdout.trim());
      },
    );
    child.stdin.on('error', (error) => {
      if (!('code' in error && error.code === 'EPIPE')) reject(error);
    });
    child.stdin.end(input);
  });
}

export function containerRunner(env, pricing) {
  return {
    async prepare() {
      const tag = env.MU_EVAL_IMAGE || 'mu-eval-runner:local';
      const image = await docker(['image', 'inspect', '--format', '{{.Id}}', '--', tag], { env });
      if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker did not return a local image digest');
      return image;
    },
    async execute({ target, prompt, remaining, image, signal }) {
      const name = `mu-eval-${randomUUID()}`;
      const extra =
        target.adapter === 'pi'
          ? Object.keys(env).flatMap((name) => /^MU_EVAL_PI_([A-Z][A-Z0-9_]*_API_KEY)$/.exec(name)?.slice(1) ?? [])
          : [];
      const keys = [...new Set([...providerEnv[target.adapter], ...extra])];
      const args = [
        'run',
        '--rm',
        '--pull=never',
        '--interactive',
        '--init',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=1000:1000',
        '--pids-limit=128',
        '--memory=1g',
        '--cpus=2',
        '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--name',
        name,
      ];
      if (target.adapter === 'pi' && env.MU_EVAL_PI_MODELS_JSON) args.push('--env', 'MU_EVAL_PI_MODELS_JSON');
      const forwarded = Object.fromEntries(
        keys
          .map((key) => [key, env[target.adapter === 'pi' ? `MU_EVAL_PI_${key}` : `MU_EVAL_${key}`]])
          .filter(([, value]) => value),
      );
      for (const key of Object.keys(forwarded)) args.push('--env', key);
      const runtimeEnv = { ...env, ...forwarded };
      function redact(text) {
        for (const [key, value] of Object.entries(forwarded))
          if (!key.endsWith('URL')) text = text.replaceAll(value, '[redacted]');
        return text;
      }
      try {
        const result = JSON.parse(
          await docker([...args, image], {
            input: JSON.stringify({ target, prompt, remaining }),
            signal,
            timeout: 270000,
            env: runtimeEnv,
          }),
        );
        if (target.adapter === 'codex' && result.calls?.length) Object.assign(result, pricing.price(result.calls));
        for (const key of ['error', 'reply', 'costError', 'observedModel'])
          if (typeof result[key] === 'string') result[key] = redact(result[key]);
        return result;
      } catch (error) {
        try {
          await docker(['rm', '--force', name], { env });
        } catch (cleanup) {
          if (!cleanup.message.includes('No such container'))
            throw new AggregateError(
              [error, cleanup],
              `${redact(error.message)}; removing ${name}: ${cleanup.message}`,
              { cause: cleanup },
            );
        }
        throw new Error(redact(error.message), { cause: error });
      }
    },
  };
}
