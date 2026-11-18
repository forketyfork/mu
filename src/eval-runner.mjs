import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const providerEnv = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  pi: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY'],
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
      const runtimeEnv = { ...env };
      if (target.adapter === 'pi' && env.MU_EVAL_PI_MODELS_JSON) args.push('--env', 'MU_EVAL_PI_MODELS_JSON');
      for (const key of keys) {
        const value =
          (target.adapter === 'pi' ? env[`MU_EVAL_PI_${key}`] : undefined) ?? env[`MU_EVAL_${key}`] ?? env[key];
        if (value) {
          runtimeEnv[key] = value;
          args.push('--env', key);
        }
      }
      function redact(text) {
        for (const key of keys)
          if (!key.endsWith('URL') && runtimeEnv[key]) text = text.replaceAll(runtimeEnv[key], '[redacted]');
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
