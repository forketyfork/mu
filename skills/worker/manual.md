# Interactive or manual worker

Without a Mu runner nobody delivers your messages or posts your replies; you poll and post yourself.

Run each Mu helper as a standalone shell call, without unrelated commands, shell separators, or pipelines: a permission rule for the helper does not cover a combined command. All follow-ups go through Mu conversations; do not use terminal injection or another agent messaging system.

If not already registered, register with the identity, directory, and task the lead supplied; a work assignment must belong to a tracked task:

```bash
node "$MU_CLI" register --id "$MU_AGENT_ID" --role worker --adapter manual --cwd "$PWD" --conversation "$MU_CONVERSATION_ID" --task-id task-42 --task "The task supplied by the lead"
```

Wait for tasks and follow-ups, and check again at meaningful work boundaries:

```bash
node "$MU_CLI" inbox --wait 25
```

Do the work each message asks in its `conversationId`, record the result there with `say --conversation ID`, then acknowledge the message's numeric `id`:

```bash
node "$MU_CLI" ack --message 42
```

Reading the inbox consumes nothing, so an interrupted turn can see a message again: inspect earlier chat and workspace state before repeating a change. Answer a burst of messages in one reply, and never reply only to acknowledge another agent's acknowledgment; post nothing when no response is needed.
