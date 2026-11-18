# Hand off a large session

Only a turn prompt that names the size of your session calls for a handoff. That notice means the session holds 300k tokens or more, and every model call now re-reads all of it. Without the notice, do the work the message asks, however long the session feels; a rebase or a merge alone is no reason to hand off.

With the notice, finish a small follow-up that needs what you already know. If the messages start a new phase, such as the fixes for a review verdict, a review of another change, a rebase, a merge, or cleanup, do not start it. Reply with a handoff for a fresh worker and mention `@lead`, who starts one. The handoff names the branch or PR and its head commit, the decisions made, each open finding with its evidence, and what remains. In a review loop the handoff takes the place of your fix or verdict for that round.
