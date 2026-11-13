# Agent CLIs

Mu runs agents through **adapters**. An adapter starts a CLI for each turn, gives it the message and the role file, reads its answer, and posts the answer in the conversation. Mu has these adapters:

| Adapter | Runs | Sandbox |
| --- | --- | --- |
| `claude` | Claude Code | None; Claude Code's own permission rules |
| `codex` | Codex | Codex's sandbox, with a profile that Mu builds |
| `pi` | pi | A macOS Seatbelt sandbox that Mu builds |
| `demo` | A simulated agent, without a model | — |
| `manual` | Nothing: you run the CLI yourself and it polls its inbox | Whatever you run |
| a name from `adapters` in `config.json` | Your wrapper program | None |

For `claude`, `codex` and `pi`, Mu records each conversation's session and resumes exactly that session on the next turn. It never picks up "the most recent session" of a CLI, which could belong to another agent. Each CLI uses its own credentials and provider settings; the executable must be on the service's `PATH`.

## Model and effort per agent

`spawn` and `configure` take `--model` and `--effort` for one agent.

- **`--model`** goes to the CLI unchanged: Claude Code accepts aliases such as `sonnet` and `opus` as well as full names, Codex accepts its model names, and pi needs `provider/model-id`. It overrides a model in `cliArgs`. Without it, the agent uses the CLI's configured default, which changes when that configuration changes. The team-lead role file therefore has the lead pass an exact, tested model name on every spawn.
- **`--effort`** sets the reasoning effort for every turn. Mu passes it to Claude Code as `--effort`, to Codex as `-c model_reasoning_effort=…`, and to pi as `--thinking`, after `cliArgs`, so it wins over an effort set there. Claude Code takes `low`, `medium`, `high`, `xhigh` and `max`; Codex also takes `none` and `minimal`; pi takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Mu rejects other values, because Claude Code and pi only warn about an unknown level and then run at their default.

## Claude Code

Claude Code runs without a sandbox, with your user's permissions. Mu starts it in print mode with structured output and resumes its session by ID.

**Permission mode.** A Claude Code session in print mode without a permission mode refuses everything that needs an approval, because nobody can answer the prompt. The seeded `config.json` therefore sets `"cliArgs": {"claude": ["--permission-mode", "auto"]}`. In auto mode, Claude Code approves routine file edits itself and lets its classifier decide about other actions, such as shell commands. Mu also passes `--permission-prompts none`, so an action that would still need a person is denied instead of waiting. Your deny rules, protected paths and working-directory limits still apply. Auto mode needs a Claude Code version, model and provider that support it; see Claude Code's [permission modes](https://code.claude.com/docs/en/permission-modes#tool-calls-denied-in-claude--p-and-agent-sdk-runs). Mu does not change the mode after a denial; the agent reports the denial as a blocker.

**The Mu CLI allowance.** Mu allows the exact command of its own CLI helper, which the agent's prompt names. The agent must run each Mu command as a separate shell call: combined with other commands or pipes, the command no longer matches the allowance.

**Working directory.** Start each Claude worker in the worktree it is to change, or configure the additional directories it needs. Claude Code limits writes to its working directory unless told otherwise.

Mu turns off Claude Code's messaging between sessions in managed turns (`CLAUDE_CODE_HARBOR_KITE=0`), because other local processes could otherwise send messages into a session. In auto mode, the classifier is the only thing between a Claude worker and your files and credentials; see [Security model](security.md).

## Codex

Codex runs in its own sandbox. For each turn, Mu builds a permission profile named `mu-agent` and passes it on the command line. It starts from Codex's built-in `:workspace` profile and adds network access, so that the agent can reach Mu; network access is not limited to Mu.

### What a Codex agent can write

- its working directory;
- each directory in `codexSandbox.writableRoots`;
- in the Git directory of its repository, what fetching, creating a branch or worktree, and committing in a linked worktree need: objects, refs, logs, `worktrees`, `FETCH_HEAD`, `packed-refs` and `shallow`, and the agent's own linked worktree's Git directory.

These stay read-only, because Git or another CLI runs code from them outside the sandbox:

- the Git directory itself and its `config`, `hooks`, `index` and `HEAD`, the hooks directory and configuration files that Git reports, and submodule Git directories;
- the files of linked worktrees that decide where Git reads their configuration (`commondir`, `gitdir`, `config.worktree`), for the agent's own worktree and for worktrees outside the writable roots;
- the `.git` entry of each repository up to three directory levels below the working directory;
- the `.git`, `.claude`, `.codex`, `.pi` and `.agents` entries of the working directory, of its repository's top level and of each writable root;
- the Mu home. Its `memory/` is unreadable, except that a Codex lead can read and write `memory/lead/`.

Mu's data directory, your credential and the CLIs' state directories are unreadable; see [Security model](security.md#what-sandboxed-agents-can-read).

Mu lists these paths before each turn, so they protect only what existed at the start of the turn. A worktree or repository that a Codex agent creates during a turn can contain Git configuration, hooks or CLI settings of its choice, which run when Git or an unsandboxed agent starts there later.

### Writable roots are shared

Inside a writable root Mu protects nothing more: every Codex agent can write every directory in it, including other agents' worktrees, their `.git` files, `.claude` settings and hooks. Listing each of them is not practical either, because Codex's time to build a sandbox grows faster than the number of listed paths (with about 800 paths, every command took 14 s). So:

- Give Codex a writable root that holds **only Codex worktrees**, such as `~/codex-worktrees`.
- Keep the worktrees of Claude agents and your own outside every writable root.
- Treat any directory that a Codex agent wrote, and any directory in a writable root, as untrusted for unsandboxed tools. Review a Codex agent's work from a worktree you create yourself from its pushed branch.
- Before anyone checks out, merges or tests a branch that a Codex agent committed, look at its changes to hooks and agent settings without checking it out:

  ```bash
  git diff origin/main...origin/<branch> -- .githooks .claude .codex .agents .pi package.json
  ```

  In a repository whose `core.hooksPath` is inside the work tree, as Mu's `.githooks` is, Git runs the branch's own hooks from the first checkout or merge on.

Mu refuses a writable root inside the data directory or another unreadable path, a writable root that contains an unreadable path (such as your home directory), a writable root inside the Mu home or containing it, and a working directory inside the Mu home.

### Codex setup

Without setup, Codex agents can read, investigate and review, and the lead gives work that must be committed to Claude agents. For a Codex agent to fetch, create a worktree and commit, two things are needed:

1. **A writable root for Codex worktrees.** Create a directory for them, add it to `config.json`, and restart Mu:

   ```json
   {
     "codexSandbox": { "writableRoots": ["/Users/me/codex-worktrees"] }
   }
   ```

   A Codex agent then creates its worktree there with `git worktree add --no-track` and pushes with `git push origin HEAD:refs/heads/<branch>`. These forms need no change to the repository's Git configuration, which the sandbox keeps read-only.

2. **Under launchd, a `PATH` that survives the login shell.** Codex runs each command in your login shell. If its startup files replace `PATH`, Codex agents cannot find `node` for the Mu CLI. Record the variable that your shell needs with `--env`; see [What the agent records](launchd.md#what-the-agent-records).

**Caches in your home directory.** Tools such as npm write caches under your home directory, which the sandbox refuses. Point the cache at a writable place through Codex's shell environment (`/tmp` is writable for Codex). Do not add the cache directory as a writable root: `~/.npm/_npx` holds packages that `npx` later runs outside the sandbox.

```json
{
  "cliArgs": { "codex": ["-c", "shell_environment_policy.set.npm_config_cache=\"/private/tmp/mu-codex-npm\""] }
}
```

`cliArgs.codex` must not contain `--sandbox` or `sandbox_mode`: Codex rejects them together with a permission profile.

### Escalation outside the sandbox

When the sandbox refuses a step, a Codex agent can ask to run that one command outside it, with a justification. Codex's automatic reviewer decides. Mu passes `approval_policy="on-request"` and `approvals_reviewer="auto_review"` on every turn, because a non-interactive turn has nobody else to ask; `cliArgs.codex` can override them. This is how a Codex agent runs, for example, a build tool that writes to `~/.gradle`.

An approved command can write the whole file system, except what the profile denies: Mu's data directory, the credentials, the CLIs' state and the home's `memory/` stay unreadable and unwritable. That also means the command cannot read its own Mu credential, so the Mu CLI fails inside it. Everything else is open to an approved command, including Mu's checkout, the home's role files and `config.json`, shell startup files and `~/Library/LaunchAgents`. Code planted there runs later outside every sandbox. For such a command, the reviewer is the only boundary, as Claude Code's classifier is in auto mode.

Mu also passes `--ignore-rules`, so Codex's execpolicy rules (yours in `~/.codex/rules` and a repository's `.codex/rules`) do not apply to Mu agents. With a profile that has deny entries, a command that an allow rule matches skips the review but stays in the sandbox, so it could never get out, even when it must. This also drops any `forbidden` or `prompt` rule.

To turn escalation off for every Codex agent, for example for untrusted input, add `"-c", "approval_policy=\"never\""` to `cliArgs.codex`. Codex then rejects every request to leave the sandbox.

## pi

`--adapter pi` runs the [pi](https://github.com/badlogic/pi-mono) coding agent in JSON print mode. pi reaches models from many providers through one CLI, which suits small tasks on inexpensive models. A pi agent needs `--model` as `provider/model-id`; `pi --list-models` lists them. Mu reads the model, the context size and the spend from pi's events.

pi has neither approval prompts nor a sandbox, so Mu runs each pi turn inside a macOS Seatbelt sandbox (`sandbox-exec`). pi agents are available only on macOS. Inside the sandbox:

- pi and the commands it runs can read every file that your user can, except the paths listed in [Security model](security.md#what-sandboxed-agents-can-read).
- They can write only the working directory, the agent's own pi directory, and `piSandbox.writableRoots`. Even there, these stay read-only:
  - every `.git`, `.pi`, `.claude` and `.codex` entry, at any depth;
  - the hooks directory and the configuration files that Git reports;
  - the Mu checkout, the Mu home and the data directory, except the agent's own pi directory and, for a pi lead, `memory/lead/`.

  A pi agent therefore cannot commit. Give it a separate worktree: a working directory inside the Mu checkout is read-only as a whole.
- The working directory, the pi directory and each writable root cannot be removed, moved or replaced, and neither can their parent directories or the symbolic links on the way to them. Mu grants these paths again on the next turn, so an agent must not be able to point them elsewhere. Mu refuses to start a turn when the pi directory has been replaced with a symbolic link; inspect and remove it.
- The network is closed except for the loopback ports in `piSandbox.localPorts`. DNS and other hosts are unreachable, so the model provider must be reached through a local proxy that you start outside the sandbox. pi reaches Mu through its own socket, `<data dir>/sockets/<agent id>.sock`.

pi uses `<data dir>/pi/<agent id>` as its configuration directory instead of `~/.pi/agent`, so your own pi settings, credentials and extensions do not load, and a pi agent cannot change them. Load the extensions that the agents need with `cliArgs.pi`. For example, an extension that routes models through a local proxy on port 8080:

```json
{
  "cliArgs": {
    "pi": ["--no-extensions", "-e", "/path/to/.pi/agent/extensions/local-proxy.ts", "--no-mcp"]
  },
  "piSandbox": {
    "localPorts": [8080]
  }
}
```

A refused action fails inside pi with `Operation not permitted` or a connection error, and the model sees that result. Mu does not retry it outside the sandbox. Treat `writableRoots` and `localPorts` as grants: a writable root gives the agent every file in it that you later run, such as build scripts, and an allowed port gives it everything the service behind that port offers.

## The demo adapter

The `demo` adapter runs a simulated agent that uses no model and changes no files. Use it to see the chat, tasks and dashboard work without spending tokens. With Mu running and a lead registered:

```bash
MU_AGENT_ID=user node src/cli.mjs room create --id demo-check --name "Demo delivery check" --members lead --source-conversation dm-lead
MU_AGENT_ID=user node src/cli.mjs spawn --id demo-worker --adapter demo --cwd "$PWD" --conversation demo-check --task-title "Demo delivery check" --task "Verify message delivery; this is a simulated demo, not implementation work."
node src/cli.mjs say --from user --conversation dm-demo-worker "Verify a private follow-up"
```

The worker receives its assignment through the chat server, runs a process, updates its status, and answers in the room; the private follow-up is answered in its private chat.

## Other CLIs

**Interactively.** Any CLI that can run shell commands can act as an agent: register it with `--adapter manual`, have it read the role file, and let it poll its inbox. See [Manual agents](cli.md#manual-agents). Mu never types into a terminal; all interaction after the start goes through chat, so the agent must keep polling. A terminal tool that can open sessions with a given directory, environment and command can start such agents; Mu does not depend on one.

**Managed, with a wrapper.** For automatic turns with another CLI, add a custom adapter to `config.json`:

```json
{
  "adapters": {
    "my-cli": { "command": "my-cli-wrapper", "args": [] }
  }
}
```

The command must be an executable on the service's `PATH`. Mu runs it without a shell for each turn, writes the prompt to its standard input (and, for a wrapper that cannot read it, to `MU_PROMPT`), and sets `MU_AGENT_ID`, `MU_ROLE`, `MU_CONVERSATION_ID`, `MU_MESSAGE_ID`, `MU_CLI`, `MU_URL` and `MU_TOKEN_FILE` in its environment. The wrapper prints the agent's final reply on standard output and diagnostics on standard error. To keep context between turns, it must keep one session per pair of `MU_AGENT_ID` and `MU_CONVERSATION_ID`. Custom adapters run without a sandbox. See the [architecture guide](architecture.md) for the adapter and delivery design.
