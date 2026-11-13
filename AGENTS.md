# Working on Mu

These rules apply to every agent that changes Mu itself. They hold unless the request says otherwise, so a brief for Mu work does not need to repeat them.

## The live service

- The running Mu service serves the team that is coordinating your work, from the main checkout. A worker never stops, restarts, or signals it, and never runs `restart`. The lead may restart it with `node src/cli.mjs restart` when it runs as a launchd agent, as the team-lead skill describes; otherwise the user restarts it. Do not modify its Mu home (`~/.mu/` unless `MU_HOME` says otherwise), which holds its data directory (`~/.mu/data/`), configuration and instructions, except the `dreams/` and `brag/` files in the data directory that a dream brief asks for, or its IRC broker, and do not install, uninstall, or kickstart its launchd agent. A lead can ask the service to run `init`; workers cannot.
- Read `mu.sqlite` in its data directory only when a task needs the evidence; the service owns it.
- Verify behavior with `npm test`. To try the launchd agent, install it with your own `--label`, `MU_PORT`, `MU_DATA_DIR` and broker port, and uninstall it before you report; never use the default label `local.mu`. When a running instance is needed, start a separate one with its own `MU_PORT`, `MU_DATA_DIR` under `.tmp/`, and its own IRC broker port (`MU_IRC_PORT`); without its own `MU_DATA_DIR` it would take the live one, and the lock there refuses it. Or create one in a script with `createApp` and a fake `chatFactory`, as the tests do. A second instance must never connect to the live broker: both would use the same agent nicknames.
- Stop every process you started, such as preview servers and headless browsers, before reporting.

## Branches and merging

- Mu is a git repository. Work on a branch in a separate git worktree, not in the main checkout: other agents and the live service use it. Create the worktree outside the checkout. A Claude agent never creates or opens one inside a directory of `codexSandbox.writableRoots` in the Mu home's `config.json`; those directories hold only Codex worktrees.
- Merging a change to `src/cli.mjs` that the running service cannot answer, or a change to the API contract, breaks every running agent at once: the helper runs from the main checkout, and the live service keeps the code of its last start, so each Mu command fails until the service restarts. Merge such a change only after the lead has said it will restart right away, or the user has, and say in your report that Mu must be restarted now. If the new CLI cannot talk to the running service at all, the lead's `restart` fails too, and only the user can restart.
- A worker that merges a Mu change into `main` pushes `main` to `origin` as part of the same task.
- Merge into `main` when the request asks for it, or when the lead's standing authorization applies: a change that passed its review, unless the task or the user says otherwise (see the team-lead skill). After a merge, the service serves `public/` changes on the next page load. A change under `skills/` is live only after the lead runs `init` and confirms the home defaults are current. Changes under `src/` take effect only after a restart, which the lead or the user does; say so in your report.
- Never commit runtime state, `.tmp/`, or `mu.config.json`; `.gitignore` covers them.
- Install dependencies in each worktree with its own `npm ci`; never symlink or copy `node_modules` from another checkout. The `pretest` `npm ci` deletes the contents of a symlinked `node_modules` target, so a symlink to another checkout empties that checkout's dependencies.

## Tests and documentation

- Tests must run alongside another `npm test` and from a deep checkout path: take ports from `freePort()` and data directories that hold Unix sockets from `shortTempDir()` (both in `tests/isolation.mjs`), never a literal port or a directory under the checkout.
- `npm test` runs the unit and HTTP tests and the integration tests; the latter start their own throwaway IRC broker in Docker (`tests/broker.mjs`), so they need a Docker daemon but never the live broker. `npm run test:integration` runs only those.
- A behavior change needs tests. A bug fix needs a test that fails before the fix.
- `npm run check` must pass; the pre-commit hook runs it before `npm test`. Fix a finding in the code. Turn a rule off only in `eslint.config.mjs` or `stylelint.config.mjs`, with the reason, and disable it inline only for one deliberate exception, with the reason after `--`. Format with `npm run format`, not by hand.
- The type checker reads JSDoc. Where it cannot infer an option or a data shape, give it a JSDoc type; do not cast to `any` except in test fakes.
- Keep `README.md` (how-tos for the user) and `docs/architecture.md` (design decisions) current with every behavior change. The role skills in `skills/` are the coordination policy; they stay model-neutral and free of dated facts: model tables, harness probes and other facts about the CLIs belong in the lead's memory.
