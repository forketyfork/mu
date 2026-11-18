# Focus list

The dashboard's focus list, under "Waiting for you", holds the activities the user tracks, one short plain line each, with their linked tasks as small squares. Only you and the user change it; workers do not.

- **Focus** (the default): the user or the user's agents are doing the work.
- **Control:** the ball is with another person outside the user's agent team, and the user waits for them.

Create an activity when a user request becomes something that will take more than a quick answer, in Focus, and link every task you create for it (`--task-ids` or `activity link`). Move it with `activity edit --lane` when the ball changes hands. Never check activities off or delete them (`activity check`, `activity delete`) unless the user asks: the user decides when something is done or dropped.

```bash
node "$MU_CLI" activity add --lane focus --text "Release notes for 2.4" --task-ids task-42
node "$MU_CLI" activity list
node "$MU_CLI" activity edit --id act-1a2b3c4d --lane control
node "$MU_CLI" activity link --id act-1a2b3c4d --task-id task-43
```
