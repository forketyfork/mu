# The lead

The lead is the one agent you talk to. Its identity is always `lead`, and each Mu workspace has exactly one. It follows the team-lead role file, `skills/team-lead/SKILL.md` in the Mu home: it coordinates and delegates, and does not investigate, change code or run tests itself. That is an instruction, not a technical restriction.

Mu runs the lead's CLI for each message it receives and resumes the lead's session for that conversation. The lead has one session per conversation: one for your private chat and one for each room it works in.

## Memory

The lead remembers durable facts, such as your name, your preferences, your models and your standing permissions, as plain Markdown files in `memory/lead/` in the Mu home:

- `MEMORY.md` is the index: one line per fact, with a link to the fact's file and a short description.
- Each fact is one file with `name`, `description` and `metadata.type` in its front matter.

The section "Remember as you go" in the team-lead role file defines the format and when the lead writes it. You can read and edit the files yourself.

Mu puts the index into the lead's prompt: on the first turn of each session, again when the index changed since that session last saw it, and after the CLI may have compacted its context. A fact that the lead saved in one conversation thus reaches its other sessions. The lead opens a fact's file when the index line applies. Mu sends at most 16 KiB of the index; a longer one is cut at a line, and the prompt says so.

For safety, Mu refuses an index that is a symbolic link, has a second hard link, is not a regular file, is writable by another user, or is not UTF-8 text, and a `memory` or `memory/lead` directory that is a symbolic link. The lead's turn then fails with the reason.

Mu turns off the CLI's own memory for the lead, so that it does not keep a second, hidden memory beside this one:

- For Claude Code, Mu adds `autoMemoryEnabled: false` to the JSON of the last `--settings` argument (Claude Code reads only the last one), or adds a `--settings` argument of its own. A configured `--settings` value that is not a JSON object, such as a file name, is refused when Mu starts.
- For Codex, Mu adds `-c features.memories=false` after `cliArgs.codex`.
- pi has no memory of its own.

Workers keep their CLI's memory, and they never receive the lead's.

## What the lead sees on each turn

Besides the message, the lead's prompt includes:

- the path of `projects.md`, which it reads before choosing a worker's directory;
- up to 20 active tasks that have no "Waiting for you" card while all their workers are idle, done or stopped, so that stalled work does not go unnoticed;
- in your private chat, up to 20 recent messages that its other sessions posted there since its last turn, each shortened to 400 characters.

Mu sends the current role file again whenever it changes and after a context compaction.

## Model, effort and context

The lead's model and reasoning effort come from the first of these that sets them:

1. **The lead's own record**: `model` and `effort` in `node src/cli.mjs agents` (`null` means not set). You set them with `configure`, below.
2. **`roleCliArgs.lead.<cli>`** in `config.json`: arguments for the lead only, such as `--model` and `--effort`.
3. **`cliArgs.<cli>`** in `config.json`, for every agent of that CLI, and then the CLI's own default.

The lead created in [Getting started](../README.md#getting-started) has no model or effort in its record, so the configuration file decides.

**Change them in the configuration file** to keep all of the lead's arguments in one place:

1. Edit the lead's arguments, for example:

   ```json
   {
     "roleCliArgs": {
       "lead": {
         "claude": ["--model", "claude-opus-5-5", "--effort", "medium", "--settings", "{\"autoCompactWindow\":263000}"]
       }
     }
   }
   ```

2. Restart Mu (`node src/cli.mjs restart` under launchd, otherwise Ctrl-C and `npm start`). Mu reads the file only at start; stopping and starting the lead does not reload it. Until the restart, `node src/cli.mjs service` reports `"state": "stale"` under `code`.

**Change them in the lead's record** to apply them at once, without a restart:

```bash
node src/cli.mjs stop --id lead
node src/cli.mjs configure --id lead --model claude-opus-5-5 --effort medium
node src/cli.mjs status --id lead --status idle
```

Mu refuses the change while the lead is in a turn, so stop it first. `--model default --effort default` clears both, and the configuration file applies again. The lead keeps its sessions when only the model or effort changes; the next turn resumes them on the new model.

**Check what the lead runs.** `node src/cli.mjs agents --id lead` shows the record's `model` and `effort`, and under `usage` the model that the CLI reported for the last turn in each conversation. The model on the dashboard card is that reported model. The effort on the card is only the record's; the CLIs do not report the effort they ran with.

**Compact the context earlier.** A long-running lead session grows toward the end of the model's context window, and every model call re-reads all of it. The `--settings` value above makes Claude Code compact the lead's context at about 250k tokens: the trigger is the `autoCompactWindow` value minus 13k. For Codex, use `["-c", "model_auto_compact_token_limit=250000"]`. Mu sends the role file again after a compaction. A `worker` block of the same shape does the same for workers; with a window of 300000 or less, a Claude worker compacts before it reaches the 300k tokens at which Mu tells it that its session is large.

## Start the lead from an empty context

The `lead` identity cannot be deleted or created again, but it can start over. `--new-session` forgets all of the lead's sessions; chats, tasks and messages stay:

```bash
node src/cli.mjs stop --id lead
node src/cli.mjs configure --id lead --new-session
node src/cli.mjs status --id lead --status idle
```

The next message in each conversation starts a new session. The lead then has its role file, its memory, the message and Mu's shared state, which it reads with `agents`, `task list` and `history`, but nothing else from the old sessions. Messages that arrived while it was stopped are delivered to the new session.

## Switch the lead to another CLI

Stop the lead, look at any pending work, and change its adapter:

```bash
node src/cli.mjs stop --id lead
node src/cli.mjs configure --id lead --adapter codex
node src/cli.mjs status --id lead --status idle
```

Changing the adapter or the working directory (`--cwd`) starts new sessions; undelivered messages stay. The record's effort must be valid for the new CLI, or you pass a new `--effort` in the same command. A switch to pi needs a `--model`. You can combine all of these with `--new-session` in one `configure` command.

## Dreams

When you ask the lead to *dream*, it reviews how the team has worked since the last dream: what failed, what was slow, what could be improved in the tools, the role files and its memory. Workers do the inspection and write a report in `dreams/` in the data directory, and the lead attaches it to the dream's task and summarizes the proposals for you. Each dream also writes the [brag doc](dashboard.md#brag-doc) pages for the period. The section "Dream" of the team-lead role file describes it.

## An interactive lead

Instead of a lead that Mu runs, you can be in the lead's seat with an interactive CLI in your own terminal. This uses the same `lead` identity, so a workspace has either a managed lead or an interactive one. If a lead already exists, [switch it](#switch-the-lead-to-another-cli) to the `manual` adapter instead of registering a new one.

1. In the Mu checkout, set the helper environment:

   ```bash
   export MU_CLI="$PWD/src/cli.mjs"
   export MU_LEAD_SKILL="$PWD/skills/team-lead/SKILL.md"
   export MU_URL=http://127.0.0.1:4310
   export MU_AGENT_ID=lead
   export MU_CONVERSATION_ID=dm-lead
   ```

2. Change to the project the team will work on, register the lead there, and start your CLI with its own memory turned off:

   ```bash
   node "$MU_CLI" register --id lead --role lead --adapter manual --cwd "$PWD" --task "Coordinate the user's work"
   codex -c features.memories=false   # or: claude --settings '{"autoMemoryEnabled":false}'
   ```

3. Tell the agent:

   > Read the skill file named by MU_LEAD_SKILL and act as my team lead. Delegate all investigation, implementation, testing, and review to workers. Use Mu chat for coordination, and keep checking your inbox while the team is active.

The role file tells it to read `memory/lead/MEMORY.md` in the Mu home at the start; Mu does not put the memory into an interactive lead's prompt.

An interactive agent receives messages only while it runs `node "$MU_CLI" inbox --wait 25` in a loop; Mu cannot type into its terminal. Stopping it in Mu does not close its terminal. See [Manual agents](cli.md#manual-agents) for the inbox commands.
