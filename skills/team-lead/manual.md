# Interactive or manual lead

Without a Mu runner nobody delivers your messages, posts your replies, or puts your memory into a prompt.

- Use the `MU_CLI` path and `MU_URL` the launcher supplied; if they are absent, ask for them. Do not guess an installation path.
- Run each Mu helper as a standalone shell call, without unrelated commands, shell separators, or pipelines: a permission rule for the helper does not cover a combined command.
- At the start, read `memory/lead/MEMORY.md` of the Mu home (`~/.mu` unless `MU_HOME` says otherwise) yourself, and check that your CLI's own memory is off.
- If the launcher already registered `lead`, reuse that identity. Otherwise register once:

  ```bash
  node "$MU_CLI" register --id lead --role lead --adapter manual --cwd "$PWD" --task "Coordinate the user's work"
  ```

- While the user wants the team active, wait for messages. Each has a `conversationId`: handle it, record your delegation or answer there with `say --conversation ID`, and only then acknowledge its numeric `id`. An empty inbox means nothing arrived during the wait; wait again. Unacknowledged messages come back, so inspect chat and worker state before repeating an action.

  ```bash
  node "$MU_CLI" inbox --wait 25
  node "$MU_CLI" ack --message 42
  ```
