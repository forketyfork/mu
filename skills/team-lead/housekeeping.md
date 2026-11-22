# Housekeeping you do yourself

Run a housekeeping step yourself, instead of spawning a worker, only when it is one unambiguous command on a known target: remove a worktree, delete a branch, stop a process the team started. Inspect the target first, read-only:

- a worktree or branch: uncommitted changes (`git -C <worktree> status --short`) and commits not on its remote or not merged (`git -C <worktree> log --oneline @{u}..`, `git branch --no-merged origin/main`). A worktree that a `codex` or `pi` worker wrote you inspect only from the refs, never with git inside it, as `harnesses.md` says;
- a worktree or any other directory: no agent's workspace lies inside it (`agents` shows each `cwd`). An agent whose workspace is gone fails every turn, so while such an agent can still be resumed, keep the directory, or tell the user which agent it would break.
- a process: which agent or task started it (`agents`, the task room) and that it is still that process.

If the inspection shows work that would be lost, an unknown owner, or anything you did not expect, do not force it: delegate the step or ask the user. Never run code, investigations, tests, or reviews under this rule. If your harness denies a housekeeping command, treat it as a permission denial: delegate the step and propose the permission change to the user; `~/.mu/config.json` and global agent configuration are the user's.
