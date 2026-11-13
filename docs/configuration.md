# Configuration

Mu keeps everything that is yours or that changes at run time outside the Git checkout, in its **home directory**, `~/.mu` by default. The checkout holds only code, so you can update or replace it without losing anything.

## The home directory

| Path | Contents | Who changes it |
| --- | --- | --- |
| `skills/team-lead/SKILL.md`, `skills/worker/SKILL.md` | The **role files**: the instructions every lead and every worker follows | `init`, and you if you want to change the instructions |
| `projects.md` | Your list of projects: where each one is and what it is | You. The lead reads it to choose where a worker runs; it never writes it |
| `memory/lead/` | The lead's memory: `MEMORY.md` is the index, and each fact is one Markdown file | The lead, and you; see [The lead](lead.md#memory) |
| `config.json` | Mu's configuration, described below | You |
| `data/` | Run-time data: the database `mu.sqlite`, your credential, the agents' credentials and sockets, pi's directories, dream and brag pages | Mu |

Set `MU_HOME` to use another directory. It must be outside the Mu checkout. `MU_CONFIG` and `MU_DATA_DIR` move the configuration file and the data directory elsewhere; the data directory must not contain the home or one of its entries.

### Create the home

Run `node src/cli.mjs init` in the Mu checkout before the first start. It creates the home, copies the two role files from `skills/` in the checkout, and creates `projects.md`, `memory/lead/MEMORY.md` and `config.json` (a copy of `mu.config.example.json`). Directories get mode 0700 and files mode 0600, so only your user can read them. Mu does not start when a role file is missing or the home is invalid.

`init` never overwrites `projects.md`, `MEMORY.md` or `config.json`: they are yours after the first run.

### Upgrade the role files

A new version of Mu can ship new role files. Check whether the home is current with `node src/cli.mjs service`: each entry under `home.defaults` is `current`, `missing`, `outdated`, `edited`, or a merge state such as `mergeable` or `conflict`.

Run `node src/cli.mjs init` to upgrade. A role file you did not edit is replaced. A role file you edited is merged with the new version. When the merge has a conflict, `init` leaves the file unchanged: resolve the conflict in the file yourself, then run `node src/cli.mjs init --accept skills/team-lead/SKILL.md` (or the worker's path) to take the current shipped version as the new merge base.

Other options:

- `init --dry-run` shows the planned changes and writes nothing.
- `init --adopt` lets a different Mu checkout take over the home, after you deliberately moved to a new checkout.

The lead can run `init` and `init --dry-run` through the service, and does so after a change to the role files. Workers cannot. Only you can use `--accept` and `--adopt`.

Mu reads the role files from the home at each agent turn, so an edit applies to the next turn without a restart. When a role file differs from the last version Mu saw, Mu posts one notice in the common chat that names the file and its modification time. If you or `init` made the change, ignore the notice. Otherwise, look at the file: every agent follows it.

## The configuration file

The configuration file is `config.json` in the home. Mu reads it only when it starts, so restart Mu after each change (see [Running Mu](operations.md#stop-and-start-again)). `node src/cli.mjs service` reports `"state": "stale"` under `code` while the running service holds an older version of the file. A file selected with `MU_CONFIG` must exist; without `MU_CONFIG`, a missing file means an empty configuration.

The seeded file:

```json
{
  "cliArgs": {
    "codex": [],
    "claude": ["--permission-mode", "auto"]
  },
  "pricing": {
    "enabled": true
  }
}
```

| Key | Value | Purpose |
| --- | --- | --- |
| `cliArgs.claude`, `cliArgs.codex`, `cliArgs.pi` | Array of strings | Extra command-line arguments for every agent of that CLI, such as a model, a permission mode or a profile. They are passed as they are, without a shell. Codex arguments come before `exec`; Claude Code arguments come before Mu's own. |
| `roleCliArgs.lead.<cli>`, `roleCliArgs.worker.<cli>` | Array of strings | Extra arguments for one role only, added after `cliArgs`. Use them, for example, to make the lead compact its context earlier; see [The lead](lead.md#model-effort-and-context). |
| `codexSandbox.writableRoots` | Array of absolute paths | Directories that Codex agents may write in addition to their working directory, such as a directory for their Git worktrees. See [Codex](harnesses.md#codex). |
| `piSandbox.writableRoots` | Array of absolute paths | Directories that pi agents may write in addition to their working directory. |
| `piSandbox.localPorts` | Array of port numbers | Loopback ports that pi agents may connect to, such as a local model proxy. Must not contain Mu's port or the chat server's port. See [pi](harnesses.md#pi). |
| `adapters.<name>` | `{"command": "...", "args": [...]}` | A custom adapter: a wrapper program that runs another CLI. See [Other CLIs](harnesses.md#other-clis). |
| `pricing.enabled` | `true` or `false` | Whether Mu downloads a model price list to show Codex spend. See [Spend](dashboard.md#spend). |

Mu refuses to start when the file has an unknown key in `pricing`, `piSandbox` or `codexSandbox`, an argument that is not a string, or a role other than `lead` and `worker`. The default configuration does not turn off any sandbox or permission check.

## Environment variables

Set these in the shell where you run `npm start` and `npm run chat:up`, or record them in the launchd agent when you install it (see [launchd](launchd.md)).

| Variable | Default | Purpose |
| --- | --- | --- |
| `MU_HOME` | `~/.mu` | The home directory |
| `MU_CONFIG` | `config.json` in the home | The configuration file |
| `MU_DATA_DIR` | `data` in the home | The data directory |
| `MU_PORT` | `4310` | The port of the dashboard and API, on 127.0.0.1 |
| `MU_IRC_HOST` | `127.0.0.1` | The chat server's host |
| `MU_IRC_PORT` | `6667` | The chat server's port; also read by `npm run chat:up` |
| `MU_IRC_CHANNEL` | `#mu` | The common chat channel |

The CLI (`node src/cli.mjs`) also reads:

| Variable | Purpose |
| --- | --- |
| `MU_URL` | The service address: an `http://` URL, or `unix:/path` for an agent's socket. Default `http://127.0.0.1:4310`. |
| `MU_TOKEN` | A credential to send. It takes precedence over the others. |
| `MU_TOKEN_FILE` | A file that holds a credential. Mu gives each managed agent turn one. |
| `MU_AGENT_ID` | The identity for commands such as `inbox` and `status` when `--id` is not given |
| `MU_CONVERSATION_ID` | The conversation for `say` when `--conversation` is not given |

Without `MU_TOKEN` or `MU_TOKEN_FILE`, the CLI uses your own credential from the data directory, so in your shell every command acts as you.

The launchd installer sets `MU_LAUNCHD_LABEL`, `MU_LAUNCHD_LOG` and `MU_REQUIRE_IRC` in the agent's environment. Do not set them yourself: Mu refuses to start with `MU_LAUNCHD_LABEL` when launchd did not start it as that job.
