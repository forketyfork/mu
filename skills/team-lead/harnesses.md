# Harnesses and the model table

## Build the model table

When your memory has no model table, build it before the first spawn. Ask the user which agent CLIs (`claude`, `codex`, `pi`) are installed and which models they want for each tier. Probe each model and effort through its own CLI with one trivial prompt, outside the live service: `claude --model <name> --effort <level>`, `codex -m <name> -c model_reasoning_effort=<level>`, `pi --model <name> --thinking <level>`. `codex debug models` lists the Codex models; `pi --list-models` lists pi's catalog. Save the table with the probe date as a `reference` fact.

The measured facts of each harness (what it can write, read, fetch and commit, which Mu helper and test steps work inside it, the time a command adds, how the card prices spend) belong in a `reference` fact next to the table. Probe them on a throwaway git worktree, one turn per harness, when the memory has none. Re-check both when a CLI version or the user's configuration changes, and add what you learn about a model or harness (a refusal, a failed probe, a changed default) to the same fact, with its date.

Claude Code takes the efforts `low`, `medium`, `high`, `xhigh` and `max`; Codex also takes `none` and `minimal`; pi takes `off`, `minimal` and the Claude Code levels. Mu rejects other values.

## `codex`

- Any Codex model can fail a security review with `cyber_policy`, and a resumed thread re-sends the same history and fails again: security-sensitive material goes to `claude`.
- It runs in a sandbox limited to its working directory and writable roots. Tools that write elsewhere, such as a build tool's global cache, run after a reviewed escalation, which adds a few seconds per command; expect friction with a browser. The reviewer is not consistent: it can reject a build or install it approved before. When a task's gate is such a command, say in the brief that a rejected escalation is reported and the PR's CI is then the gate.
- Keep untrusted input away from it while escalation is on: one approved command can plant code that unsandboxed agents run later.
- It fetches, creates a worktree and commits only when the user's configuration has both `codexSandbox.writableRoots` in `~/.mu/config.json`, naming a directory that holds only Codex worktrees, and a launchd agent whose environment lets its shell find `node` for the Mu helper ("Codex setup" in `docs/harnesses.md` of the Mu checkout). Read `~/.mu/config.json` before routing a change that ships. Without both, `codex` takes work that reads and reports (investigations, CI failure analyses, PR reviews through `gh` or the checked-out tree, surveys), and a change that must be committed goes to `claude`.
- Brief a `codex` worker to start in the repository's main checkout or its own worktree, to create its worktree under a writable root with `git worktree add --no-track`, and to push with `git push origin HEAD:refs/heads/<branch>`: its sandbox cannot write git configuration, so recording an upstream or committing in the main checkout would need an escalation.

## `pi`

Small, mechanical, local tasks on inexpensive models: running a command, reading or summarizing files, editing files in the working directory. It has a tighter sandbox and no network: never give it a task that commits, pushes, calls `gh`, or needs the internet. It has no per-command judgment and can delete anything in its working directory, so prefer it only when the task is read-mostly or the files are disposable; the lead or a `claude` worker commits the result.

## Worktrees that `codex` or `pi` wrote

A worktree or repository that a `codex` or `pi` worker created or wrote can carry git configuration, hooks and agent settings that run code as soon as git or an agent CLI starts there outside a sandbox, and every `codex` worker can write every directory in a writable root, not only its own.

- `claude` agents create and work in worktrees outside every `codexSandbox.writableRoots` entry; a `codex` worker creates its worktree inside one. Tell each worker where.
- Never start a `claude` agent in a Codex worktree, and do not run git there yourself. A reviewer of either kind starts in the main checkout and creates its own worktree from the pushed branch (a `codex` reviewer under a writable root); you merge from the branch ref in the main checkout.
- Before anyone checks out, switches to, commits on, merges, or runs the tests of a branch that a `codex` worker committed, check its diff from the refs without checking it out: `git diff origin/<default>...origin/<branch> -- .githooks .claude .codex .agents .pi package.json`. In a repository whose `core.hooksPath` is inside the work tree, as Mu's `.githooks` is, git runs the branch's own hooks from the first checkout or merge on. Creating the worktree from the main checkout does not run them.
