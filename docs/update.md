# Update Mu

This guide moves an existing Mu installation to the latest version. It has one path for Mu in a terminal and one for Mu as a [launchd agent](launchd.md). Both paths have the same four parts:

1. Get the new code and its dependencies.
2. Restart Mu, so that the service runs the new code.
3. Bring the role files in the Mu home up to date.
4. Check the result.

Mu keeps your agents, tasks, chats and settings in the [Mu home](configuration.md#the-home-directory), outside the checkout, so an update does not touch them. Run every command in the Mu checkout.

## What an update changes

| Part | Where it lives | Updated by |
| --- | --- | --- |
| Code of the service and the CLI, and the dashboard files | The checkout | `git pull`, then a restart |
| Dependencies | `node_modules/` in the checkout | `npm ci` |
| The two role files, `skills/team-lead/SKILL.md` and `skills/worker/SKILL.md` | The Mu home | `node src/cli.mjs init` |
| The visuals skill, `skills/visuals/SKILL.md` | The checkout | The `git pull` alone: `node src/cli.mjs visual guide` prints the file of the checkout, and the home holds no copy |
| `projects.md`, `memory/`, `config.json`, `data/` | The Mu home | You and Mu; an update never rewrites them |

A running service keeps the code of its last start. After the `git pull`, it serves the old code until you restart it, and `node src/cli.mjs service` reports `code.state` as `stale` until then. A change in `src/`, in `public/`, or a new command of the CLI needs a restart; a change to a role file needs `init`.

## Get the new code

1. Look at the checkout, and note the commit you update from. Update only a checkout without local changes that you want to keep apart from the update:

   ```bash
   git status
   OLD=$(git rev-parse HEAD)
   ```

2. Fast-forward the checkout, then install the dependencies of the new `package-lock.json`:

   ```bash
   git pull --ff-only
   npm ci
   ```

   `npm ci` replaces `node_modules/`. Run it even when you do not know whether the dependencies changed: Mu refuses to start, and `restart` refuses, when `node_modules/` does not match `package-lock.json`.

3. Find out whether the update changed the chat server's definition:

   ```bash
   git diff --stat "$OLD" HEAD -- compose.yaml
   ```

   The command prints nothing when the file did not change. If it printed a change, run `npm run chat:up` once the new code is in place; Docker then recreates the container. Mu reconnects to a chat server that comes back (every 5 seconds), but do it while no agent is in a turn that you care about.

## Update Mu in a terminal

1. Stop Mu with Ctrl-C in its shell and wait until it exits. A turn that was running is run again on the next start, in the same session; see [Stop and start again](operations.md#stop-and-start-again).
2. [Get the new code](#get-the-new-code).
3. Update the role files: [Bring the Mu home up to date](#bring-the-mu-home-up-to-date). Mu is stopped, so no agent reads a role file halfway.
4. Start Mu again:

   ```bash
   npm run chat:up
   npm start
   ```

   `chat:up` returns at once when the chat server already runs. Mu prints the sign-in link; the browser keeps its credential, so you can also open `http://127.0.0.1:4310/` directly.

5. [Check the result](#check-the-result).

If a manual agent runs in another terminal (see [The lead](lead.md#an-interactive-lead)), it is not a child of the service and keeps running. Its Mu commands fail while Mu is stopped; it needs no action once Mu is back.

## Update Mu under launchd

The agent definition runs `src/server.mjs` of your checkout, so a `git pull` changes the code that the next start loads. You do not install the agent again after an update. Install it again only after a change of `PATH`, of the Node.js installation or of a recorded variable, as [launchd](launchd.md#what-the-agent-records) says.

1. [Get the new code](#get-the-new-code). Mu keeps running on the old code.
2. Restart Mu with the checked restart:

   ```bash
   node src/cli.mjs restart
   ```

   Mu compares `node_modules/` with `package-lock.json`, starts the new code on a separate port with a copy of the database, and restarts only when that start works. When it refuses, it prints the reason, and the old service keeps running. A refusal about packages means that `npm ci` is missing. A refusal that shows a start error means that the code you pulled does not start: do not use `launchctl kickstart` to force it, because that runs the same code without a check; see [If Mu keeps restarting](launchd.md#if-mu-keeps-restarting).

   After the check, a restart that you request has no turn to wait for, so Mu shuts down at once and launchd starts it again. (When the lead requests it, Mu first waits until the lead's current turn has ended, for up to 15 minutes.) The command waits up to 90 seconds for the check. If it reports that the result is unknown, look for the restart notice in the dashboard, or run `node src/cli.mjs service`, before you try again.

   The lead can run `restart` too, and does so after it merged a change to Mu with your standing permission.

3. [Bring the Mu home up to date](#bring-the-mu-home-up-to-date), after the restart: the new role files can name commands that only the new code has.
4. [Check the result](#check-the-result).

## Bring the Mu home up to date

The role files are the instructions of every agent. A new version of Mu can ship new ones, and the home keeps your edits of them, so `init` does the update, not `git pull`.

Look at what `init` plans. This writes nothing and works while Mu runs or not:

```bash
node src/cli.mjs init --dry-run
```

Each file under `actions` has one of these actions, which the table lists with the matching state that `node src/cli.mjs service` shows under `home.defaults` when Mu runs:

| State of the role file | Dry-run action | What `init` does, and what you do |
| --- | --- | --- |
| `current` | `current` | Nothing to do. |
| `outdated` (you did not edit it; the checkout has a newer version) | `replace` | Replaces the file. The old file goes to `.backup/` in the home. |
| `edited` (you edited it; the checkout's version did not change) | `keep-edit` | Keeps your file. |
| `mergeable` (both changed in different places) | `merge` | Merges your edit with the new version with `git merge-file` and backs up the old file. Read the result afterwards. |
| `conflict` (both changed in the same place) | none: the command fails | See [A conflict](#a-conflict). |
| `missing` | `install` | Installs the file. |
| `unmanaged` (the home's record of installed files is lost) | `keep-unmanaged` | Keeps your file and does not update it. Read the file, then run `init --accept FILE` as in [A conflict](#a-conflict) to record the current shipped version as its base. |

The plan has more entries than role files. The rest concern the other files of the home:

| Dry-run action | Meaning |
| --- | --- |
| `seed` | A one-time file is missing (`projects.md`, `memory/lead/MEMORY.md` or `config.json`), and `init` creates it. |
| `keep-seed` | The one-time file exists. It is yours, and `init` never overwrites it. |
| `write-manifest` | `init` updates its private record of the installed role files (`.install/manifest.json` in the home): their hashes, the checkout and the texts used as merge bases. |
| `create-directory` | A directory of the home does not exist yet, and `init` creates it with mode 0700. |
| `restrict-directory-mode` | A directory of the home is readable by others. `init` sets its mode to 0700, so only your user can read it. |
| `restrict-file-mode` | A file of the home is readable by others. `init` sets its mode to 0600. |
| `accept-current-edit` | Only with `--accept FILE`: `init` records the shipped version as the file's merge base and leaves the file as it is. |

The mode entries are routine on an older home: they list each file whose permissions differ and change nothing else. Nothing needs your attention in `seed`, `keep-seed`, `write-manifest` and the mode entries. `init` still never overwrites `projects.md`, `memory/lead/MEMORY.md` or `config.json`.

Run it when the plan looks right:

```bash
node src/cli.mjs init
```

The lead can run `init` and `init --dry-run` through the service. You can ask it to do so after an update; it also does so after a change to the role files. A worker cannot, and `--accept` and `--adopt` are yours alone: the lead is refused them too.

### A conflict

`init` fails with `Mu home upgrade has conflicts; no files were changed`, names each file and the lines of the conflict, and changes nothing, in any file.

1. Compare your file in `~/.mu/skills/…` with the shipped one in the checkout's `skills/…`. For example:

   ```bash
   git diff --no-index ~/.mu/skills/worker/SKILL.md skills/worker/SKILL.md
   ```

2. Edit the file in the home by hand: keep your changes and add the new ones from the shipped file.
3. Tell Mu that this file is up to date with the shipped version:

   ```bash
   node src/cli.mjs init --accept skills/worker/SKILL.md
   ```

   `--accept` changes no content. It records the current shipped version as the base of the next merge, so your file counts as `edited` and later updates merge against the new base. It needs the path of a role file, relative to the home: `skills/team-lead/SKILL.md` or `skills/worker/SKILL.md`. Run it once per file.

4. Run `node src/cli.mjs init` again to update the rest.

To drop your edits instead, move the file out of the home (`mv ~/.mu/skills/worker/SKILL.md ~/worker-skill.md.old`) and run `init`: it installs the shipped version.

### A different checkout

`init` refuses with `Mu home was installed from …, not …` when the home was set up from another checkout, for example after you cloned Mu again. If you moved to the new checkout on purpose, run `node src/cli.mjs init --adopt` in it. The home then follows the new checkout's role files, with the same rules as above. Do not use `--adopt` to make two checkouts share one home while both run.

## Check the result

1. Ask the service what it runs:

   ```bash
   node src/cli.mjs service
   ```

   - `code.state` is `current`, and `code.loaded.head` equals `git rev-parse HEAD`. `stale` means a restart is missing, or something changed in the checkout after it.
   - `startedAt` is the time of your restart.
   - Every entry of `home.defaults` is `current`, or `edited` for a file that you changed on purpose.

   Under launchd, `restart` is the remedy for `stale`. In a terminal, stop and start Mu again.

2. Open the dashboard. While Mu was away the header showed **Updates disconnected**; the page reconnects by itself and catches up. Reload the page to load the new dashboard files.
3. Under launchd, read the end of the log for startup errors: `tail -n 50 ~/Library/Logs/Mu/local.mu.log`.
4. Look at the agents: `node src/cli.mjs agents`. An agent that was interrupted by the restart is running its turn again or is idle. An agent in `error` stopped for another reason; see [Recover after a failure](operations.md#recover-after-a-failure).

## What running agents see

- **Role files.** Mu reads the role files from the home at the start of every turn. An agent that is in a turn keeps the instructions it began with; its next turn uses the new ones. When a role file differs from the last version Mu saw, Mu posts one notice in the common chat that names the file. For a change made by `init`, ignore it.
- **The visuals guide.** An agent that runs `node src/cli.mjs visual guide` reads the file of the checkout at that moment, so it sees the new guide right after the `git pull`, before the restart. The service accepts the new visual commands only after the restart.
- **The restart under launchd.** The requester's turn ends first. Every other running turn is stopped cleanly when Mu shuts down, and Mu runs it again in the same session after the start; its prompt says that the earlier attempt was interrupted, so the agent checks its partial work first. A Mu command that is run while Mu is down fails with `Cannot reach Mu`. The new process posts a notice in the conversation where the restart was requested, and the lead confirms the restart to you without running it again.
- **The terminal.** Ctrl-C does the same shutdown without waiting for any turn. Interrupted turns resume on the next start.
- **A crash during the update.** A crash or `kill -9` differs from a clean stop: the agents that were in a turn move to `error`, and you set them idle yourself. See [Recover after a failure](operations.md#recover-after-a-failure). The restart check and the order above keep an update from needing it.

## When something goes wrong

| Symptom | Cause and remedy |
| --- | --- |
| `restart` or the start refuses, and names packages | `node_modules/` differs from `package-lock.json`. Run `npm ci`. |
| `restart` prints a start error | The pulled code does not start. Read the output. Mu keeps running its old code meanwhile, so you can wait for a fix or move the checkout back to the commit you noted as `OLD`, with `git switch --detach "$OLD"`, and run `npm ci` again. |
| `restart` says nothing was restarted | No service answered: Mu is not running, or runs in a terminal, where `restart` does not apply. Stop and start it as in [Update Mu in a terminal](#update-mu-in-a-terminal). |
| `init` fails with a conflict | [A conflict](#a-conflict). |
| `init` refuses because of another checkout | [A different checkout](#a-different-checkout). |
| `service` reports `code.state` `stale` right after a restart | The checkout changed again after the restart, or an uncommitted edit differs; the message says which. Restart again. |
