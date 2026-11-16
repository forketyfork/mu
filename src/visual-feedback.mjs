import { httpError as bad } from './http-error.mjs';
import { mentions } from './store.mjs';

// The chat message that carries the user's feedback on a visual, comments and answers, to its author. A chat message
// starts every agent it mentions, and much of this one is text that an agent wrote, so the message is built here in
// one place that keeps it from mentioning anybody but the author. See "Visuals" in docs/architecture.md.

// A quote in the chat message is a locator; the comment itself keeps the whole quote.
export const MESSAGE_QUOTE_CHARS = 160;
export const MESSAGE_TITLE_CHARS = 80;

// Text that the user did not write (a quote from the frame, a title or a label from the agent), as one line of a chat
// message that can neither end its code span nor mention anybody.
export const locator = (text, max) => {
  const line = [...text.replace(/\s+/g, ' ').trim()];
  const cut = line.length > max ? `${line.slice(0, max).join('')}…` : line.join('');
  return `\`${cut.replaceAll('`', "'").replace(/@(?=[a-z])/gi, '@ ')}\``;
};

/** Text that the user wrote, quoted line by line. */
export const quoted = (text) =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

/**
 * @param {object} feedback
 * @param {{ id: string, agentId: string, title: string, version: number }} feedback.visual
 * @param {{ number: number }} feedback.version The version the feedback is about.
 * @param {string[] | null} feedback.answers The lines that state the user's answers, or null without answers.
 * @param {string[]} feedback.comments One numbered item per comment.
 */
export function feedbackText({ visual, version, answers, comments }) {
  const count = comments.length === 1 ? 'a comment' : `${comments.length} comments`;
  const what = !answers
    ? `${count[0].toUpperCase()}${count.slice(1)}`
    : comments.length
      ? `Answers and ${count}`
      : 'Answers';
  const newest = visual.version === version.number ? '' : `, the newest is ${visual.version}`;
  const instructions = [
    ...(answers ? [`Read the answers with \`visual answers --id ${visual.id}\`.`] : []),
    ...(comments.length
      ? [
          `Change the sections ${answers ? 'the comments' : 'these'} concern with \`visual patch --id ${visual.id}\`, and name the comments a change answers with \`--resolves\`. \`visual comments --id ${visual.id}\` shows each comment with its whole quote.`,
        ]
      : []),
  ];
  const text = [
    `@${visual.agentId} ${what} on visual \`${visual.id}\` ${locator(visual.title, MESSAGE_TITLE_CHARS)}, version ${version.number}${newest}:`,
    ...(answers ? [answers.join('\n')] : []),
    ...comments,
    instructions.join(' '),
  ].join('\n\n');
  // The parts were made safe one by one; this holds for the message they make together.
  const named = mentions(text).filter((name) => name !== visual.agentId);
  if (named.length)
    throw bad(
      answers
        ? `Together this feedback reads as a mention of @${named[0]}. Put the name in a code span.`
        : `Together these comments read as a mention of @${named[0]}. Send them one by one, or put the name in a code span.`,
    );
  return text;
}
