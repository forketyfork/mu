# Dream

When the user asks you to dream, review how you and the workers have worked and turn the findings into improvements. A dream is a task like any other: create its room and task record, and delegate the inspection, the fixes, and the artifact to workers. Cover the period or work the user names; otherwise, the work since the last dream artifact.

## Evidence

- Chat and tasks: `room list`, `history --conversation ID` with `--before` for older messages, and the results and timestamps in `task list`.
- Agents and usage: `agents` shows each agent's adapter, status, `lastError`, and per-conversation `usage` with model, context tokens, spend, and native session IDs. The spend of a `claude` session is the CLI's own figure and includes its subagents: take every total from it, not from a script.
- Native transcripts, found by those session IDs: Claude Code in `~/.claude/projects/*/SESSION.jsonl`, with a worker's subagents in `SESSION/subagents/*.jsonl`; Codex in `$CODEX_HOME/sessions/**/rollout-*-THREAD.jsonl` (default `~/.codex`). Use them for the breakdown the totals lack, such as spend above a context size or per turn. Claude Code writes one line per content block and repeats the usage on each, so count every `message.id` once, include the subagent files, and price one-hour cache writes at their own rate. Check the sum against the recorded spend before reporting it: a script that counts lines doubles the figure, and one that skips the subagent files undercounts it.
- Delivery and inbox state in `mu.sqlite` in Mu's data directory (`MU_DATA_DIR`, default `~/.mu/data`). Read it only; the service owns it.
- Mu's Git history, for work done outside Mu tasks.

Only a `claude` worker can read native transcripts and `mu.sqlite`; `codex` and `pi` workers are denied them and every file in Mu's data directory, dream artifacts and brag pages included. Give them the parts that use the Mu commands, and paste into the brief any part of a file they need, such as the proposal to build.

## What to look for

- Spend: model or harness choice, context size, redundant or looping turns, stalled workers, and briefs that caused rework.
- Failures: coordination mistakes, lost or late messages, permission denials, and instructions that agents misread or ignored.
- Gaps in the lead and worker instructions or in Mu's tooling that would prevent these problems.

Start with the previous dream's artifact: which of its fixes held, and which of its proposals the user applied, declined or left open. Then check three standing directions, each only as far as the period's evidence reaches; a direction with nothing behind it reports "nothing found", not an invented improvement:

- **Local environment:** tools, CLIs, MCP servers, skills, plugins, permission rules and service configuration that would make agents faster or fail less. Evidence is a denial, a failed or missing command, a workaround, a lookup repeated across tasks, or a stale version. Each item is a proposal for the user with its cost and risk; the dream installs nothing.
- **Instructions:** the user's global agent instructions, the `CLAUDE.md` and `AGENTS.md` files of the repositories the team worked in, Mu's own `AGENTS.md`, the role skills, and the lead's memory. Look for contradictions, stale facts, text that duplicates a skill, rules agents misread or ignored, and missing rules whose absence caused rework. Mu's files are fixed on the branch; a file outside Mu gets a proposal with the exact text to change.
- **Communication:** lost or late reports, replies that only acknowledge, mentions that woke an agent for nothing, bursts of progress messages, corrections sent to the user, approvals requested for steps the request already covered, and superseded instructions a worker still followed. Propose changes to style, the skills, or Mu itself, ranked by expected effect.

Rank findings by expected effect on spend or failures times how often they occur. Back each with evidence (message, task and session IDs, transcript excerpts, cost or token figures), and state what was observed and what was inferred. Estimate savings from the observed figures and mark them as estimates. Search transcripts for the relevant events instead of reading them whole. Cite private conversations by ID and summarize them; do not copy their content into the task room.

## Brag pages

Every dream records the period's achievements in `brag/` in Mu's data directory, which the dashboard's brag view reads. Each page is one Markdown file of prose for the user, not a list of tasks:

- **Day:** `YYYY-MM-DD.md` (UTC), dated by when the work shipped or was decided. A few well-chosen sentences on what the team delivered that day, grouped by what matters to the user, with the key PRs and issues as full inline links and task IDs as code spans, such as `` `task-1a2b3c4d` ``. Include the user's own work that Mu's Git history shows outside any task. Leave out commit hashes, test counts, and how the team got there. When the day already has a file from an earlier dream, read it and rewrite the whole file as one summary of the day.
- **Week** `YYYY-Www.md` (ISO week, such as `2026-W45.md`) and **month** `YYYY-MM.md`: on the first dream after the period ended, from the day pages, a concise summary of what it achieved and decided, with the few links that matter. A running week or month gets no file. If no dream ran after a period ended, the next dream writes every missing page, days included.

## Memory audit

Every dream audits your memory in `memory/lead/`. Workers do not read it, which is a rule and not a wall: your transcripts hold the index and the fact files you opened, and a `claude` worker can read both.

- Give a `claude` dream worker the transcript part: for the period's lead sessions, how often you read and wrote the memory directory, and the files a lead session wrote anywhere else for the sake of memory, such as Claude Code's own `~/.claude/projects/<the Mu checkout's path with every non-alphanumeric character replaced by "-">/memory/`. That directory stays empty for the lead. Claude Code keys it to the checkout for every Mu worktree, so a file written by a worker session is not an error; one written by a lead session is.
- Do the content part yourself, because only you may read the memory. **Mechanics:** the index's size against the 16 KiB limit, a file for every index line and an index line for every file, front matter with a name, a one-line description and a type, and no secret value; search for the formats the transcript viewer masks (`SECRET_PATTERNS` and `LABELLED_SECRETS` in `src/transcripts.mjs`). **Content:** stale entries or ones that contradict the current code, configuration or skills; duplicates; facts the repository, the skills or project instructions already record; and facts from the period that deserve an entry, above all the user's preferences and corrections, and facts you looked up or relearned more than once.
- Apply the additions, updates and deletions yourself after the dream, and name the changed entries in your summary.

## Changes and the artifact

Fixes to Mu follow `mu-changes.md`. The artifact is a Markdown file in `dreams/` in Mu's data directory, named by its UTC date and time. The dream worker writes it and reports its path; workers cannot edit tasks, so you attach it as the dream task's result with `task update --id ID --file PATH`. It holds the scope and sources examined, the ranked findings with their evidence, the changes made with their branches and verification, the proposals for the user, the memory proposals, the expected savings, and a copy of the achievement entries. Summarize the main findings and proposals to the source conversation.
