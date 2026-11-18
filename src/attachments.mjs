// An HTML attachment of a chat message: a self-contained page that an agent wrote, which the dashboard runs in a
// sandboxed frame under the message. The page is hostile data; see "HTML attachments" in docs/architecture.md.
import { unseen } from './visual-spec.mjs';
import { httpError as bad } from './http-error.mjs';

export const MAX_HTML_BYTES = 256 * 1024;
export const MAX_TITLE_LENGTH = 80;
// A message with an attachment carries the page as JSON, where escaping can double its size.
export const MAX_MESSAGE_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The attachment that a request asks for, checked: `{ type: 'html', title, html }`.
 * @param {unknown} input
 * @returns {{ type: 'html', title: string, html: string }}
 */
export function validateAttachment(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw bad('An attachment must be an object with type, title and html');
  const { type, title, html, ...rest } = /** @type {Record<string, unknown>} */ (input);
  const unknown = Object.keys(rest);
  if (unknown.length) throw bad(`An attachment has no field ${unknown.map((key) => `"${key}"`).join(', ')}`);
  if (type !== 'html') throw bad('An attachment must have type "html"');
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > MAX_TITLE_LENGTH)
    throw bad(`An attachment's title must contain 1–${MAX_TITLE_LENGTH} characters`);
  // The dashboard draws the title as the name of what runs in the frame, so it says only what the reader sees.
  const hidden = unseen(title.trim());
  if (hidden) throw bad(`An attachment's title holds a character that is not shown (${hidden})`);
  if (typeof html !== 'string' || !html.trim()) throw bad('An HTML attachment must contain HTML');
  if (!html.isWellFormed()) throw bad('An HTML attachment must be valid Unicode text');
  // HTML reads these as parse errors, and `attachment` prints the page to a terminal, where they are escape sequences.
  // eslint-disable-next-line no-control-regex -- the pattern exists to find control characters
  const control = html.match(/[\0-\x08\v\x0E-\x1F\x7F-\x9F]/)?.[0];
  if (control)
    throw bad(
      `An HTML attachment cannot contain the control character U+${control.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    );
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_HTML_BYTES)
    throw bad(
      `An HTML attachment holds at most ${MAX_HTML_BYTES / 1024} KiB; this one has ${bytes} bytes. Inline only what the page needs, or write a visual.`,
    );
  return { type, title: title.trim(), html };
}

// As the dashboard writes a size.
/** @param {number} bytes */
const sizeLabel = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`);

/**
 * The line that stands for an attachment where it cannot run: IRC, a turn prompt, a terminal.
 * @param {{ type: string, title: string, bytes: number }} attachment
 */
export const attachmentPlaceholder = (attachment) =>
  `[HTML attachment "${attachment.title}", ${sizeLabel(attachment.bytes)}: open the message in the Mu dashboard to see it]`;

/**
 * The line that stands for the buttons of a question where they cannot be clicked.
 * @param {string[]} choices
 */
export const choicesPlaceholder = (choices) =>
  `[Choices for the user: ${choices.join(' | ')}; the user clicks one in the Mu dashboard or writes a reply]`;

/**
 * The text of a message as a reader without the dashboard gets it: its words, then the placeholders of its
 * attachment and its choices.
 * @param {{ text: string, attachment?: { type: string, title: string, bytes: number }, choices?: string[] }} message
 */
export const plainMessageText = (message) =>
  [
    message.text,
    ...(message.attachment ? [attachmentPlaceholder(message.attachment)] : []),
    ...(message.choices ? [choicesPlaceholder(message.choices)] : []),
  ].join('\n');
