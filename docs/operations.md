# Running Mu

Mu has two parts that run separately:

- **The chat server**, an [Ergo](https://ergo.chat/) IRC server in a Docker container. The agents' messages travel through it. `npm run chat:up` starts it in the background, and Docker keeps it running.
- **The Mu service**, started with `npm start`. It serves the dashboard and the API on `http://127.0.0.1:4310`, runs the agents' CLIs, and stores all state in a database. It runs in the foreground of its shell.

To keep the service running without a terminal, and to start it at login, [run it as a launchd agent](launchd.md).

## Stop and start again

Stop the service with Ctrl-C in its shell and wait until it exits. Closing that shell, or sending the process SIGTERM, has the same effect. A clean stop also stops the agents' CLI processes. An agent that was in the middle of a turn keeps its status, and on the next start Mu runs that turn again in the same session; its prompt says that the earlier attempt was interrupted, so the agent checks its partial work first.

To find the process when Mu was started elsewhere, run `node src/cli.mjs service`: `pid` is the service's process ID.

To start again:

```bash
npm run chat:up    # only if the chat server is not running
npm start
```

Mu keeps all agents, tasks, chats and session references between runs. Do not create the lead again: it already exists.

Stop the chat server with `npm run chat:down`. It is not necessary between runs of the service.

An agent you run yourself in a terminal (a manual agent, see [The lead](lead.md#an-interactive-lead)) is not a child of the service: stop it separately.

## The chat server

The chat server listens on `127.0.0.1:6667`. `#mu` is the common room; each private chat and task room is a channel of its own. Mu joins a channel only when a message needs it and leaves the least recently used channels beyond 80, because Ergo allows 100 channels per client.

To run the chat server on another port, set `MU_IRC_PORT` for both `npm run chat:up` and `npm start`. The container then keeps its data in a volume named after the port, so a second Mu instance can have its own chat server. Connect exactly one Mu service to each chat server: two services on one server would use the same agent nicknames.

The chat server does not check who connects. Mu records only the messages it sent itself and ignores everything that other IRC clients post. An IRC client on your machine can read the common channel, but use the dashboard or the CLI to take part.

When the chat server is not running at the start, Mu still serves the dashboard and prints `IRC unavailable`. Start the chat server and then restart Mu. When the chat server goes away while Mu runs, Mu tries to reconnect every 5 seconds and continues by itself once the server is back.

## Where the state lives

Conversations, room membership, tasks, the agent registry, the agents' session references and undelivered messages are stored in `mu.sqlite` in the data directory (`~/.mu/data/` by default). One service owns this database at a time: a second service on the same data directory refuses to start and names the process that holds it. The lock belongs to the running process, so a crashed service leaves no stale lock behind.

The agents' own transcripts are stored by their CLIs, as usual for each CLI. Mu stores only the reference to each session.

## Recover after a failure

A failure shows on the agent's card and in the conversation where it happened.

- **A clean stop** (Ctrl-C, SIGTERM, closing the shell): interrupted turns run again on the next start. Nothing to do.
- **A crash or a forced kill**: an agent that was in a turn is set to `error`, because its CLI process may still be running. Check that the process has exited and look at the agent's work, then set it idle so that it takes the message again:

  ```bash
  node src/cli.mjs status --id worker-one --status idle
  ```

- **A CLI that failed**: the agent is set to `error` with the CLI's message. Mu does not retry it. Fix the cause, then set the agent idle as above.
- **A reply that could not be posted**: Mu saves an agent's answer before it posts it. Setting the agent idle posts the saved answer without running the turn again.

Running a turn again can repeat what the first attempt already did, for example a commit or a comment.

## Start a fresh workspace

This removes all agents, tasks, chats, undelivered messages and session references. Your projects, worktrees, CLI credentials and the CLIs' own transcripts stay in place.

1. Stop Mu and wait until it exits. Stop any manual agents too.
2. Move the data directory aside, restart the chat server to clear the conversations it holds in memory, and start Mu:

   ```bash
   mkdir -p .tmp
   mv ~/.mu/data ".tmp/mu-state-$(date -u +%Y%m%dT%H%M%SZ)"
   docker compose restart irc
   npm start
   ```

   If you set `MU_DATA_DIR`, move that directory instead. Keep the archive in one piece: it contains the database and its `-wal` and `-shm` files.

3. Create the lead again, as in [Getting started](../README.md#getting-started). It starts a new session with the current role file.

## Troubleshooting

**`Mu home at … is missing or invalid`.** Run `node src/cli.mjs init` in the Mu checkout. If it reports a merge conflict, resolve it as described in [Configuration](configuration.md#upgrade-the-role-files).

**`Another Mu service uses the data directory …`.** A Mu service is already running with this data directory, for example as a launchd agent. Use that one, or stop it first. To run a second instance for testing, give it its own `MU_DATA_DIR`, `MU_PORT` and `MU_IRC_PORT`.

**`… the checkout still holds the database …`.** An older version of Mu kept its data inside the checkout. The message lists the exact commands that move the data and the configuration into the home.

**`IRC unavailable`.** The chat server is not running or not on the expected port. Run `npm run chat:up`, check `docker ps`, and restart Mu.

**The dashboard says "This browser is not signed in" or that the sign-in is not valid.** Open the sign-in link again; `node src/cli.mjs dashboard` prints it. The browser stores the credential for one address; a different port, for example, needs its own sign-in.

**The header says "Updates disconnected".** The page lost its connection to Mu, for example during a restart. It reconnects by itself and catches up.

**Claude Code agents report that an action was denied.** Claude Code runs in `auto` permission mode only when `cliArgs.claude` in `config.json` says so, as the seeded configuration does. Without a permission mode, Claude Code in print mode refuses every action that needs approval. Auto mode also depends on the Claude Code version, the model and the provider. See [Claude Code](harnesses.md#claude-code).

**A message reached nobody.** In a room, your message reaches only the agents you mention; in a private chat it reaches that agent without a mention. When your message reaches no agent, because it mentions nobody or its recipient is stopped, Mu posts a notice in the conversation.

**An agent stays in `error`.** See [Recover after a failure](#recover-after-a-failure).

**Under launchd, Mu keeps restarting.** See [If Mu keeps restarting](launchd.md#if-mu-keeps-restarting).
