// What the dashboard tells the user about feedback on a visual: before a comment is sent, whether its author can take it,
// and after it, what the service did to make that happen. See "Visuals" in docs/architecture.md.

const FAILURE_CHARS = 200;

/**
 * The author of a visual as the dashboard needs it.
 * @typedef {object} Author
 * @property {string} id
 * @property {string} status An agent status, or `missing` for an agent that the workspace no longer has.
 * @property {number | null} turn The message that its running turn is on.
 * @property {string | null} error What its last turn failed with.
 * @property {string | null} lead The lead of the visual's conversation that takes feedback for an author that failed.
 */

/** What to tell the user before a send, or null when the author takes the feedback by itself. */
export function authorNote(/** @type {Author | null} */ author) {
  if (!author) return null;
  if (author.status === 'stopped')
    return `@${author.id} is stopped. Sending a comment wakes it, so that it takes the comment.`;
  if (!['error', 'missing'].includes(author.status)) return null;
  const failed =
    author.status === 'missing'
      ? `@${author.id} is not registered any more.`
      : `@${author.id} failed${author.error ? `: ${[...author.error].slice(0, FAILURE_CHARS).join('').trimEnd()}.` : '.'}`;
  return author.lead
    ? `${failed} A comment does not resume it: sending goes to @${author.lead}, who can resume @${author.id}.`
    : `${failed} No lead of this conversation can take a comment instead. Resume @${author.id} from its card; sending is refused until then.`;
}

/**
 * What the service answered to a send of feedback: a line for a toast, and a warning that stays on the page.
 * @param {{ woke?: string, routedTo?: string, notice?: string }} result
 */
export function deliveryReport(result) {
  const done = result.routedTo
    ? `Sent to @${result.routedTo}: the author cannot run.`
    : result.woke
      ? `@${result.woke} was stopped and runs again to take it.`
      : null;
  // The notice is addressed to the user in the chat; here the user is the reader.
  const warning = result.notice ? result.notice.replace(/^@user /, '') : null;
  return { done, warning };
}
