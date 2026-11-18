# Changes to Mu itself

Workers fix Mu's own skills, docs and tooling on a branch, with the usual verification. Workers never initialize, edit, restart, stop or signal Mu; proposed changes to the home's skills go through the normal review.

## Merge

- **Standing authorization**, when the user gave it and your memory records it: a Mu change that passed its review may be merged into `main`, pushed to `origin`, and the service restarted, without asking the user, unless the task or the user says otherwise. Skill or doc text needs no review step first. The user still verifies the task.
- A merge that changes `src/` takes effect only after a restart. A change to `src/cli.mjs` or the API breaks every running agent's Mu commands until then: the helper runs from the checkout, the service runs the code of its last start. When Mu runs as a launchd agent, restart right after such a merge. Otherwise, or when the new CLI cannot reach the running service at all, tell the user before the merge, and have the worker merge only when the user is ready to restart.
- Changes to other projects, `~/.mu/config.json`, or the user's global agent configuration are proposals for the user, not changes.

## Update the home

The runner reads the role files from the Mu home. After a merge that changes `skills/`, and whenever `node "$MU_CLI" service` reports a default as `missing`, `outdated` or `mergeable`, run `node "$MU_CLI" init` (or `init --dry-run` first), and confirm that `home.defaults` no longer reports those states before telling anyone a new skill is live. A `conflict` needs the user: only the user resolves conflicts and runs `--accept` or `--adopt`. An `edited` default is the user's edit and needs nothing. An `unmanaged` one never updates: tell the user, who reads it and runs `init --accept FILE`. A merge that adds a role file needs the user too: the running service's `init` installs only the files its own code lists, and a restart refuses while one is missing. Ask the user to run `node src/cli.mjs init` in a shell, then restart.

## Restart the service

When `service` shows a `launchd` job, you may restart Mu yourself, without asking: after a merge that changes `src/`, or when the user asks.

1. **Pick the moment.** Check `agents`. A restart cuts off running worker turns; each resumes its message after the start and must inspect its partial work, which can repeat effects and costs a turn. Prefer a moment when no worker is `working`, and never restart during a worker's merge, push, or another step that must not be cut off. A merge that changes both `public/` and `src/`, or the API between them, does not wait for idle workers: the dashboard loads the new page and runs it against the old backend, which can freeze it. Restart as soon as no worker is in such a step.
2. **Restart.** Run `node "$MU_CLI" restart` as the last action of your turn, then end the turn. Mu first starts the checkout's code on its own port. If that fails, nothing restarts, but `main` is unsafe: a crash or the next login would start it unchecked. Have the change reverted or fixed right away, and tell the user in the source conversation, with the output; a refusal that names a missing role file needs only the user's `init` above. Otherwise Mu restarts once your turn has ended; it cancels the restart if your turn runs 15 more minutes.
3. **Check.** The new process posts a notice that mentions you in the same conversation. Run `service` and check that `pid` and `startedAt` are new, then tell the user that Mu restarted and why. Run `agents --status error`: a worker whose turn the restart cut off can end in `error` with the restart in its `lastError`. Look at its partial work, resume it with `status --id ID --status idle` so it takes its message again, and tell its room what was cut off. Do not restart again in answer to the notice. A notice that Mu did not restart gives the reason; report it.
4. **Unknown outcome.** If `restart` says the outcome is unknown, Mu may still restart: end your turn and wait for the notice; do not request it again. If it says nothing restarted, Mu cannot carry your messages either, so the user must recover it; do not retry with other tools.
