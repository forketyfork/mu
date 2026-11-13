# Run Mu as a launchd agent

On macOS, Mu can run as a launchd user agent instead of in a terminal. launchd starts Mu when you log in and starts it again when it exits unexpectedly. The lead can then also restart Mu by itself, for example after it merged a change to Mu's own code. The design is in [Running under launchd](architecture.md#running-under-launchd).

## Before you install

- Docker Desktop must start when you log in: turn on its setting **Start Docker Desktop when you sign in**. The chat server container has a restart policy (in `compose.yaml`), so Docker starts it again together with Docker.
- Under launchd, Mu exits when no chat server answers at its start, and launchd tries again every 10 seconds until the chat server is up. A chat server lost later is reconnected inside the running process.

## Install

Run these steps in the Mu checkout, in your usual login shell: the installer records that shell's `PATH` and the Mu environment variables.

1. If Mu runs in a terminal, stop it with Ctrl-C and wait until it exits. Agents in the middle of a turn continue on the next start.
2. Run `npm run chat:up`. If the chat server container was created before it had a restart policy, this creates it again; Mu must be stopped for that, which step 1 did.
3. Set the same `MU_*` variables that you use for `npm start`, if any, and run:

   ```bash
   npm run service:install
   ```

4. Open the dashboard. The sign-in you saved in the browser still works, because the data directory and its credential stay the same. `node src/cli.mjs dashboard` prints the link again. Under launchd, Mu does not print the link to its log.

The installer writes nothing and refuses to install when:

- `claude`, `codex`, `pi`, or a custom adapter command from the configuration is not on `PATH`. If you do not use one of them, name it with `--allow-missing` (comma-separated); agents of that CLI then fail to start.
- your login shell's startup files drop entries of the recorded `PATH` (see below);
- the Mu port is taken, no chat server answers, or the agent is already installed.

### What the agent records

launchd gives a job none of your shell's environment, so the installer records what Mu and the CLIs need:

- `PATH`, `HOME`, `LANG`, `LC_ALL`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and the `MU_HOME`, `MU_PORT`, `MU_DATA_DIR`, `MU_CONFIG` and `MU_IRC_*` variables that are set, with relative paths made absolute;
- the current `node`. For a Homebrew installation it records the `opt/<formula>` path, which stays valid after `brew upgrade`.

Name each further variable that your CLIs need with `--env`, for example a proxy address for Claude Code:

```bash
npm run service:install -- --allow-missing pi --env ANTHROPIC_BASE_URL
```

The installer prints what it recorded, without the values of `--env` variables, and lists the variables of your shell that it left out.

Codex runs each command of an agent in your login shell (`zsh -lc` for zsh), started with the recorded environment. If the shell's startup files replace `PATH` instead of extending it, Codex agents cannot find `node` to run the Mu CLI, so the installer starts your login shell the same way and refuses when that happens. Some setups replace `PATH` unless a variable is set that launchd does not pass. nix-darwin's `/etc/zshenv` is one; its variable is `__NIX_DARWIN_SET_ENVIRONMENT_DONE`. Record such a variable with `--env NAME`.

After you change `PATH`, the Node.js installation or a recorded variable, uninstall and install again.

### Files

- The agent definition: `~/Library/LaunchAgents/local.mu.plist`, readable only by you. It runs `src/server.mjs` of this checkout.
- The log: `~/Library/Logs/Mu/local.mu.log`, readable only by you. Follow it with `tail -f ~/Library/Logs/Mu/local.mu.log`. A stall of the service longer than one second appears as a dated `WARNING: event loop blocked` line. launchd does not rotate the log.

`--label` installs under another label than `local.mu`, for example to test a second instance next to the main one. The file names follow the label.

## Restart

Run `node src/cli.mjs restart`. The lead can run it too.

1. Mu first starts the checkout's current code on a separate port, with a copy of the database. If that start fails, nothing is restarted and the command shows the output.
2. If the check passes, Mu waits until the lead's current turn has ended, shuts down cleanly, and launchd starts it again. If the lead's turn does not end within 15 minutes, the restart is cancelled.
3. The new process posts a notice in the conversation where the restart was requested.

The command waits up to 90 seconds for the check. When it gets no answer in that time, the result is unknown: look for the restart notice before you try again.

When the check fails, `main` holds code that does not start. Fix or revert it soon: any start that is not a checked restart, such as a crash, your next login or `launchctl kickstart`, runs that code.

`launchctl kickstart -k gui/$(id -u)/local.mu` restarts Mu without the check.

### Is the running code current?

`node src/cli.mjs service` shows the running process, its start time, and `code.state`:

- `current`: the checkout holds the code that the process loaded.
- `stale`: the source files, `package.json`, `package-lock.json` or the configuration file changed since the start. The message names the Git commit that was loaded and the current one, or says that uncommitted changes differ. A merge after the last start shows as `stale` until the next restart.
- `unknown`: the code cannot be read; the message says why.

### Merges by the lead

When you have given the lead a standing permission to merge (it records that in its memory), a reviewed change to Mu is merged into `main`, pushed, and, under launchd, followed by a restart, without asking you, unless the task or you say otherwise. You still verify the task.

## Stop

`npm run service:uninstall` shuts Mu down cleanly and removes the agent definition. Agents in the middle of a turn continue on the next start. Install again, or run `npm start`, to start Mu again.

## If Mu keeps restarting

When the code on `main` fails at startup, launchd starts it again every 10 seconds. The dashboard and the lead are unavailable then, so nobody reports the failure to you. The restart check prevents most of these cases. If it happens anyway:

1. Read the end of `~/Library/Logs/Mu/local.mu.log` for the error.
2. Fix `main`, for example with `git revert` of the merge that broke it. The next attempt picks up the fixed code by itself.
3. To work on the fix without the repeated attempts, run `npm run service:uninstall`, then `npm start` in a terminal to see the error. Install the agent again once Mu starts.
