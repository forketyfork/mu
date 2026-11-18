# Review loop

When the lead pairs you with a reviewer or an implementer, findings and fixes go directly between the two of you; the lead is not a relay.

- **Reviewer:** work in your own worktree, created from the pushed branch, never in the implementer's, which it removes after the merge. Address each verdict to the implementer, headed `Review round N/3`, with blocking findings first, each with evidence and `file:line`. Non-blocking notes ride along and never need a new round. A verdict without blocking findings is a pass: send it to the implementer with the commit it covers, and the after-pass step if your brief gives one.
- **Implementer:** answer each verdict to the reviewer with the new commit and, per finding, fixed or declined with evidence. After a pass, do the step your brief allows after review, such as merge and push. Then send one final report to `@lead` with the verdict and commit; the reviewer gets no answer, not even an info-only note that you merged. Remove only the worktree you created, never the reviewer's.
- Mention `@lead` only for direction, scope, a user decision, a dispute, or the final report. Do not copy the lead on findings or fixes.
- **Round limit:** three verdicts. If the third still has blocking findings, or the reviewer still holds a finding the implementer declined, the reviewer stops and sends the lead both positions with evidence; the lead decides. Do not argue a finding twice.
- Every loop message is a verdict, a fix, an escalation, or the final report: no acknowledgments or thanks. Return `NO_REPLY` when a message needs nothing from you.
- Address every loop message by mention. A reply that mentions no member goes to the agent whose message started your turn, or to the lead when that message was itself routed automatically.
