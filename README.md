# Mu

Mu runs a team of AI coding agents on your Mac and lets you manage them from one place. You talk to one agent, the **lead**. The lead does not write code itself: it splits your request into tasks, starts **workers** (other agents) to do them, follows their progress, and tells you when a decision is yours. When a task is done, you check the result and mark it verified.

The agents are the command-line tools you already use: [Claude Code](https://code.claude.com/docs), [Codex](https://github.com/openai/codex) and [pi](https://github.com/badlogic/pi-mono). Mu runs each agent in its own working directory and resumes its session for every follow-up message. You can mix tools and models in one team, for example Codex for implementation and Claude Code for reviews.

Mu runs locally: the agents talk to each other through a chat server on your machine, and a browser dashboard shows the whole team: tasks, chat rooms, each agent's status, model and spend, and the decisions waiting for you.

![The Mu dashboard: decisions waiting for you, the focus list, and tasks](docs/images/dashboard.webp)

## How it works

- **You and the lead** have a private chat. You send requests there in plain words.
- **Tasks and rooms.** For each piece of work, the lead creates a task and a chat room for it, then starts one or more workers in that room. You can read every room and write in it.
- **Workers** do the work: investigations, code changes, tests, reviews. They report to the lead in the task room.
- **Verification.** When the lead marks a task ready, you review its result on the dashboard and mark it verified. Only you can do that. The lead then retires the task's workers; their history stays.
- **Instructions are plain Markdown.** What the lead and the workers do is defined by two skill files, which you can read and edit. Mu itself provides the mechanics: the chat server, the agent registry, the process runners and the dashboard.

![A task room: the lead hands work to a worker and a reviewer](docs/images/chat-room.webp)

## Requirements

- **macOS.** Mu uses macOS-only features: launchd to run it as a background service, and the Seatbelt sandbox for pi agents. Other systems are untested.
- **Docker** with Compose, to run the chat server.
- **Node.js 24** or newer, with npm.
- **git**, and the GitHub CLI `gh` if your agents are to open pull requests.
- **At least one agent CLI** (Claude Code, Codex or pi) on your `PATH`, signed in and able to reach its model. Mu uses the CLI's own credentials and settings; it does not manage them.

## Getting started

These steps use Claude Code as the lead. Run them in one shell.

1. Get Mu and install its dependencies:

   ```bash
   git clone https://github.com/forketyfork/mu.git
   cd mu
   npm ci
   ```

2. Create Mu's home directory, `~/.mu`. It holds the agents' instructions, your configuration and Mu's data:

   ```bash
   node src/cli.mjs init
   ```

3. Open `~/.mu/projects.md` and list the projects you want the team to work on: for each one, its path and a sentence about what it is. The lead reads this file to decide where a worker runs.

4. Start the chat server. The command waits until the server is ready and then returns:

   ```bash
   npm run chat:up
   ```

5. Start Mu. It keeps running in this shell; stop it with Ctrl-C.

   ```bash
   npm start
   ```

   Mu prints a sign-in link such as `http://127.0.0.1:4310/?token=…`.

6. Open the sign-in link in your browser. The browser keeps the credential, so later you can open `http://127.0.0.1:4310/` directly.

7. On the empty dashboard, choose **Create agent**. Keep the role **Team lead** (its name is always `lead`), choose **Claude Code**, and enter the absolute path of your Mu checkout as the working directory. As the initial task, write who you are and what you expect, for example: "Call me Fred and answer in English. Wait for my requests before you create tasks." Choose **Start agent**.

The dashboard opens your private chat with the lead, and the lead answers there. Later, the chat icon in the left rail brings you back to it.

To open the dashboard again later, run `node src/cli.mjs dashboard` in the Mu checkout; it prints the sign-in link. When you stop Mu and start it again, your agents, tasks and chats are kept; do not create the lead again. See [Running Mu](docs/operations.md).

The configuration that `init` created lets Claude Code work without asking you for permission on every step (Claude Code's `auto` permission mode). Read [Claude Code](docs/harnesses.md#claude-code) to understand what that allows.

## Tell the lead how you work

Write to the lead in plain words; nothing needs a special format. Tell it:

- **How to address you**, for example "Call me Fred, and answer in English."
- **Your CLIs and models**, and which to use for what: "Codex for implementation, Claude Code for reviews." The lead tests each model once with a short prompt and saves the result.
- **Your projects**, if `projects.md` does not say enough.
- **Standing permissions**: what the lead may do without asking. For example: "You may merge a reviewed change into `main`. Ask me before you publish a release."

![A first chat with the lead](docs/images/chat-lead.webp)

The lead saves these facts as Markdown files in `~/.mu/memory/lead/`. They survive restarts, and you can read and edit them. See [The lead](docs/lead.md).

Then give the lead its first job. Decisions that wait for you appear at the top of the dashboard; finished tasks wait for your verification on their cards. See [The dashboard](docs/dashboard.md).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Configuration](docs/configuration.md) | Mu's home directory, `config.json` keys, environment variables |
| [Running Mu](docs/operations.md) | Start and stop, the chat server, recovery after a failure, a fresh start, troubleshooting |
| [Run Mu as a launchd agent](docs/launchd.md) | Start Mu at login and restart it automatically |
| [The dashboard](docs/dashboard.md) | Chats, tasks and verification, the waiting list, the focus list, transcripts, the brag doc, themes |
| [The lead](docs/lead.md) | The lead's memory, its model and effort, an interactive lead in your own terminal |
| [Agent CLIs](docs/harnesses.md) | Claude Code, Codex and pi: permissions, sandboxes and setup; other CLIs |
| [Security model](docs/security.md) | Who may do what, and how strong each agent's isolation is |
| [CLI reference](docs/cli.md) | The `node src/cli.mjs` commands |
| [Development](docs/development.md) | Tests, checks, Git hooks, adding a dashboard theme |
| [Architecture](docs/architecture.md) | Design decisions and how the parts fit together |

## License

Mu is released under the [MIT License](LICENSE).
