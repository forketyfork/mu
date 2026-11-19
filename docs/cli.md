# CLI reference

Run the Mu CLI from the Mu checkout as `node src/cli.mjs COMMAND` (or `npm run mu -- COMMAND`); no global installation is needed. `node src/cli.mjs --help` lists every command and option.

Agents run the same CLI: Mu gives each managed agent its path in `MU_CLI`, so they can call it from any working directory.

**Who you are.** In your shell, the CLI sends your credential from the data directory, so commands act as you. An agent's turn uses the credential in `MU_TOKEN_FILE`, and the agent always acts as itself. See [Security model](security.md#credentials).

**Which service.** The CLI talks to `http://127.0.0.1:4310` unless `MU_URL` or `--url` names another address.

## Agents

```bash
node src/cli.mjs spawn --id worker-one --adapter claude --cwd /path/to/project \
  --conversation issue-42 --task-id task-42 --task "Fix the failing test in the parser."
node src/cli.mjs agents                          # every agent, retired ones included
node src/cli.mjs agents --status working,idle
node src/cli.mjs agents --id worker-one,reviewer
node src/cli.mjs stop --id worker-one
node src/cli.mjs status --id worker-one --status idle
node src/cli.mjs configure --id worker-one --model sonnet --effort high
```

- `spawn` and `register` both create an agent and send it its initial task; `register` does not require `--task`, which suits a manual agent or an agent that waits for work. Both take `--id`, `--adapter`, `--cwd`, `--task`, and optionally `--model`, `--effort`, `--role` and `--conversation`. The task text is at most 1800 characters; post a longer brief with `say --file` first and point to its message.
- A worker that gets initial work needs a tracked task: `--task-id` for an existing task, or `--task-title` to create one in the chosen room.
- `status --status idle` lets a stopped or failed agent take its queued messages again. The statuses are `idle`, `working`, `blocked`, `done`, `stopped` and `error`.
- `configure` changes a stopped or failed agent: `--adapter`, `--cwd`, `--model` (or `default`), `--effort` (or `default`), and `--new-session` to forget its sessions. Only you can run it. See [The lead](lead.md#model-effort-and-context) and [Model and effort per agent](harnesses.md#model-and-effort-per-agent).

## Chat

```bash
node src/cli.mjs chat --to lead                  # interactive chat with the lead; /quit exits
node src/cli.mjs chat --conversation issue-42    # interactive chat in a room
node src/cli.mjs say --conversation dm-worker-one "Please report progress"
node src/cli.mjs say --conversation issue-42 "@all Coordinate ownership before editing shared files"
node src/cli.mjs say --conversation issue-42 --file brief.md
node src/cli.mjs say --conversation issue-42 --html pong.html "@lead The game is ready"
node src/cli.mjs attachment --message 120             # print the HTML attached to #120
node src/cli.mjs say --conversation dm-lead --choices "Merge|Wait" "The review passed. Merge it now?"
node src/cli.mjs history --conversation issue-42
node src/cli.mjs history --conversation issue-42 --after 120   # only messages after #120
node src/cli.mjs room create --name "Issue 42" --id issue-42 --members lead
node src/cli.mjs room invite --conversation issue-42 --members worker-two
node src/cli.mjs room list
```

- `chat` is a chat client for you in the terminal; it runs no model.
- `say` posts to `--conversation` (alias `--room`), else to `MU_CONVERSATION_ID`, else to the common room. A private chat with an agent is `dm-<agent id>`. Sending to an unknown conversation, or to a room you are not a member of, fails.
- `room create` records the conversation it was created from; `--source-conversation ID` sets it explicitly, so that the lead reports back to your original chat.
- Messages can hold up to 64 KiB of UTF-8 text.
- `say --html FILE` attaches a self-contained HTML page of at most 256 KiB, which the dashboard runs under the message after the user clicks **Run**. Its title is the file name without extension; `--title` sets another. Scripts and styles are inline, and images, fonts and sounds are `data:` URLs: the page loads no other file and has no network. Where it cannot run (IRC, turn prompts, `chat`), the message ends with a placeholder line; `history` lists its title and size. `say --html` fails when the service did not keep the page, as a service started before this feature does.
- `say --choices "A|B"` offers the user 2–6 answers of at most 60 characters each, separated by `|`, as buttons under the message. The user's click posts the user's answer to the sender: `> Re: <the last line of the text>` and the label. Put the question on the last line. Where buttons cannot be shown (IRC, turn prompts, `chat`), the message ends with a line that lists the choices; `history` lists them as `choices`, and the answer as `answers` (the question's ID) and `choice`. A final reply of an agent offers the same buttons with a last line `Choices: Yes | No`; see [Choices in messages](architecture.md#choices-in-messages). `say --choices` fails when the service did not keep the choices, as a service started before this feature does.

## Tasks

```bash
node src/cli.mjs task create --title "Resolve issue 42" --conversation issue-42
node src/cli.mjs task list                       # verified tasks are hidden
node src/cli.mjs task list --include-verified
node src/cli.mjs task list --conversation issue-42
node src/cli.mjs task update --id task-42 --result "The fix and its test are merged." --status ready
node src/cli.mjs task update --id task-42 --file result.md --status ready
node src/cli.mjs task retire --id task-42
```

`task update --status ready` records the result and asks you to verify it. Verifying is a dashboard action of yours; there is no CLI command for it. After you verify, Mu notifies the lead, which retires the workers. `task retire` is for the lead to retire workers that this skipped.

## Visuals

Agents write [visuals](visuals.md) with these commands; `FILE` is Markdown.

```bash
node src/cli.mjs visual create --file plan.md                 # "# Title" names it; --title overrides
node src/cli.mjs visual patch --id vis-1a2b3c4d --file changes.md
node src/cli.mjs visual patch --id vis-1a2b3c4d --file new.md --after overview
node src/cli.mjs visual patch --id vis-1a2b3c4d --remove draft,notes
node src/cli.mjs visual patch --id vis-1a2b3c4d --move risks --first
node src/cli.mjs visual patch --id vis-1a2b3c4d --file whole.md --replace
node src/cli.mjs visual show --id vis-1a2b3c4d                # outline: sections, sizes, block types
node src/cli.mjs visual show --id vis-1a2b3c4d --section overview [--version 2]
node src/cli.mjs visual show --id vis-1a2b3c4d --source       # the whole Markdown
node src/cli.mjs visual comments --id vis-1a2b3c4d            # the user's comments that wait for an answer
node src/cli.mjs visual comments --id vis-1a2b3c4d --all [--version 2]
node src/cli.mjs visual patch --id vis-1a2b3c4d --file changes.md --resolves vc-5e6f7a8b,vc-9c0d1e2f
node src/cli.mjs visual answers --id vis-1a2b3c4d [--version 2] # the answers the user sent to the visual's questions
node src/cli.mjs visual list [--task-id task-42] [--conversation issue-42] [--include-archived]
node src/cli.mjs visual archive --id vis-1a2b3c4d             # the user, or a lead on the user's request
node src/cli.mjs visual unarchive --id vis-1a2b3c4d
node src/cli.mjs visual guide                                 # the visuals skill; needs no running service
```

`visual create` links the visual to the conversation of the agent's turn and to its task; `--conversation` and `--task-id` name others. `visual patch` is for the author only. `visual list` leaves out archived visuals unless it gets `--include-archived`; `visual archive` and `visual unarchive` are for the user and for a lead acting on the user's request, and a worker is refused. In its file, a section whose ID exists replaces that section, and a new one is inserted after the section before it in the file, or where `--after`, `--before` or `--first` say. The changes of one managed turn make one version; a manual agent makes a version with each change, unless it passes `--amend` to change its newest version. `visual answers` prints `answers` (the sent answers by field ID: an option ID, a list of option IDs, text, a number, or true or false), `unanswered` (the field IDs without a sent answer) and `fields` (each question with its section, label and options, and for an answered one `sentAt` and `sentVersion`, the version on which the user sent the answer); it never shows an answer that the user has not sent.

## Waiting list and focus list

The lead uses these to maintain the [Waiting for you](dashboard.md#waiting-for-you) cards and the [focus list](dashboard.md#focus-list):

```bash
node src/cli.mjs waiting add --task-id task-42 --text "Release 1.2 waiting for your approval to push"
node src/cli.mjs waiting list
node src/cli.mjs waiting remove --id wait-1a2b3c4d

node src/cli.mjs activity add --lane focus --text "Decide on the release" --task-ids task-42,task-43
node src/cli.mjs activity list [--include-checked]
node src/cli.mjs activity edit --id act-1a2b3c4d --text "New text" --lane control --position 1
node src/cli.mjs activity check --id act-1a2b3c4d
node src/cli.mjs activity uncheck --id act-1a2b3c4d
node src/cli.mjs activity delete --id act-1a2b3c4d
node src/cli.mjs activity history --id act-1a2b3c4d
node src/cli.mjs activity link --id act-1a2b3c4d --task-id task-44
node src/cli.mjs activity unlink --id act-1a2b3c4d --task-id task-44
```

A waiting card is one plain sentence: Mu rejects message references, links and task IDs in its text.

## Service

```bash
node src/cli.mjs dashboard     # print your sign-in link
node src/cli.mjs service       # the running process, its code state, the home's role files
node src/cli.mjs restart       # checked restart; launchd only
node src/cli.mjs init [--dry-run] [--accept FILE] [--adopt]
node src/cli.mjs state         # the whole shared state, for diagnostics
```

See [Configuration](configuration.md#the-home-directory) for `init` and [launchd](launchd.md#restart) for `restart`.

## Manual agents

A manual agent is a CLI that you run yourself, registered with `--adapter manual`. Mu cannot start its turns, so it polls its inbox:

```bash
node "$MU_CLI" inbox --wait 25
node "$MU_CLI" say --conversation issue-42 "@lead The investigation is complete. Here is the evidence."
node "$MU_CLI" ack --message 42
node "$MU_CLI" status --status done
```

- `inbox --wait 25` waits up to 25 seconds for messages and prints them, each with its conversation ID.
- Reading the inbox does not remove messages. Acknowledge each message with `ack --message ID` and its exact number, after you recorded the result.
- The agent's identity comes from `MU_AGENT_ID` or `--id`.

Managed agents need none of this: Mu delivers their messages, posts their final answer, and acknowledges the messages itself. Messages that arrive for a busy managed agent are queued and delivered together in one turn after the current one, oldest first. An agent whose final answer is exactly `NO_REPLY` posts nothing, which prevents agents from acknowledging each other's acknowledgments in a loop. A `NO_REPLY` line after other text is dropped and the text is posted.
