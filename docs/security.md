# Security model

Mu is a local tool for one person. The service and the chat server listen only on 127.0.0.1. Within that, Mu decides who may do what from a **credential**, and how far an agent can reach depends on its CLI's sandbox.

## Credentials

The service identifies every caller by its credential, never by a `--from` option or a browser header.

- **You** (identity `user`) hold the credential in `user-token` in the data directory. Mu creates it at the first start, readable only by your user. The CLI sends it when no agent credential is set, and the browser receives it with the sign-in link. With it, you act as yourself or as a `manual` agent whose CLI you run.
- **A managed agent** gets a new credential for each turn, in a file named by `MU_TOKEN_FILE`, and Mu deletes the file when the turn ends. The credential is never in the environment, because a sandboxed process can read other processes' environments. An agent always acts as itself: a request that names another identity is refused.

## Who may do what

| Action | You | Lead | Worker |
| --- | --- | --- | --- |
| Send messages | as yourself or a manual agent | as itself | as itself |
| Create agents | yes | yes; a pi or Codex lead only agents of its own CLI inside its own workspace | no |
| Change an agent's adapter or directory | yes | no | no |
| Update status and assignment text | any agent | itself and workers | itself |
| Stop agents | any agent | workers without other unverified tasks | no |
| Create tasks, edit them, assign workers, mark them ready | yes | yes, in its conversations | no |
| Verify a task | yes | no | no |
| Retire a verified task's workers | no | yes | no |
| Add and remove "Waiting for you" cards | no | yes | no |
| Change focus-list cards | yes | yes | no |
| Read conversations, rooms and tasks | all | its conversations | its conversations |
| See other agents' assignments, errors and usage | all | from its conversations | from its conversations |
| Read the whole state and the event stream | yes | no | no |
| Read agent transcripts | yes | no | no |
| Run `init` | yes | yes, without `--accept` and `--adopt` | no |
| Restart the service (launchd only) | yes | yes | no |

Private chats and rooms keep messages, history and model sessions apart in normal use. They are not a secrecy boundary between processes on your machine: you can read every conversation, and an agent that escapes its CLI's restrictions could too.

## How strong the isolation is

**pi** runs in a Seatbelt sandbox with no route to Mu's TCP port; it reaches Mu only through its own socket. It cannot read your credential, so a pi agent can act only as itself, even with a credential it found. See [pi](harnesses.md#pi).

**Codex** runs with a Mu permission profile in which the data directory is unreadable, except the agent's own credential file. It can reach Mu's TCP port, but it cannot read your credential or another agent's. A command that Codex's reviewer lets out of the sandbox keeps these denies but can write everywhere else, so for such a command the reviewer is the boundary. See [Codex](harnesses.md#codex).

**Claude Code** and custom adapters run without a sandbox, with your user's permissions. In auto mode, a Claude agent that deliberately reads your credential or another agent's environment can act as that identity. Claude Code's permission rules stop ordinary and accidental attempts, but they are not an isolation boundary.

For untrusted input, such as code or issues from strangers, use a pi agent, or a Codex agent with escalation turned off (`approval_policy="never"` in `cliArgs.codex`, which applies to every Codex agent).

### What sandboxed agents can read

pi and Codex agents can read most of the file system, but not:

- Mu's data directory: the database, the credentials, the other agents' pi directories (each agent's own credential and socket excepted);
- the home's `memory/` directory, except `memory/lead/` for a Codex or pi lead;
- the state of Claude Code and Codex (`~/.claude`, `~/.claude.json`, `/tmp/claude-<uid>`, `~/.codex`) and pi's sessions, which hold transcripts and prompts;
- the profile directories of common browsers, where the dashboard keeps its credential.

They can read the home's `skills/`, `projects.md` and `config.json`, but not write them. They can also read other processes' environments and command lines, so Mu never puts a credential or a prompt in an environment. A running `say` or `spawn --task` shows its text on its command line; `say --file` avoids that.

Mu refuses a Codex or pi agent whose working directory is inside the Mu home, and a writable root inside the home or around it.

### The home and the role files

The role files are the instructions of every agent, including unsandboxed ones. Sandboxed agents cannot write them. The worker role file tells Claude workers never to write the home or read its memory, but nothing enforces that for Claude Code. When a role file changes, Mu posts a notice in the common chat (see [Configuration](configuration.md#upgrade-the-role-files)); a notice you did not cause deserves a look.

## The chat server

The IRC server does not authenticate clients or nicknames. Mu therefore records only the messages that it sent itself and ignores everything that other IRC clients post. Any local process can read the common channel. Use the dashboard or the CLI to take part.

## The HTTP service

Every API request needs a credential. The service also rejects requests whose `Host` or `Origin` is not the local Mu address, against cross-site requests from web pages and DNS rebinding.

## Outbound requests

Mu itself makes one kind of outbound request: it downloads a model price list from GitHub to compute Codex spend. Set `pricing.enabled` to `false` to stop it; see [Spend](dashboard.md#spend). The agents' CLIs connect to their model providers as they normally do.
