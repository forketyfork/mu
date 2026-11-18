import { httpError as bad } from './http-error.mjs';
import { CODE, MENTION, mentions } from './store.mjs';
import { unseen } from './visual-spec.mjs';

export const MAX_CHOICES = 6;
export const MAX_CHOICE_LENGTH = 60;
const MAX_QUOTE = 200;

/**
 * The labelled answers that an agent's message offers the user, checked and trimmed.
 * @param {unknown} value
 * @returns {string[]}
 */
export function validChoices(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_CHOICES)
    throw bad(`choices must be a list of 2–${MAX_CHOICES} labels`);
  const labels = value.map((label) => {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > MAX_CHOICE_LENGTH)
      throw bad(`Each choice must be 1–${MAX_CHOICE_LENGTH} characters`);
    const text = label.trim();
    if (/[\r\n]/.test(text)) throw bad(`Choice "${text}" must be a single line`);
    const hidden = unseen(text);
    if (hidden) throw bad(`Choice "${text}" holds ${hidden}, a character that the dashboard does not show`);
    // The answer is the label in the user's message, so a label that mentions an agent would wake it.
    if (mentions(text).length) throw bad(`Choice "${text}" mentions an agent; a label is the user's words`);
    return text;
  });
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label.toLowerCase())) throw bad(`Choice "${label}" is offered twice`);
    seen.add(label.toLowerCase());
  }
  return labels;
}

/**
 * The quote repeats the asker's words; without the @ a mention there wakes nobody a second time. Only what `mentions`
 * counts loses it, so a code span, an email or a scoped package reads as the asker wrote it.
 * @param {string} text
 */
function withoutMentions(text) {
  let result = '';
  let from = 0;
  for (const code of text.matchAll(CODE)) {
    result += text.slice(from, code.index).replace(MENTION, '$1$2') + code[0];
    from = code.index + code[0].length;
  }
  return result + text.slice(from).replace(MENTION, '$1$2');
}

/**
 * The user's message that answers a choice: in a room it mentions the asker, who alone receives it; it quotes the
 * question's last line, the way a reply to a waiting card quotes the card, and ends with the label.
 * @param {{ id: number, from: string, text: string }} question
 * @param {string} choice
 * @param {boolean} direct
 */
export function answerText(question, choice, direct) {
  // A fence line quotes nothing, and in the answer it would turn the label into code.
  const lines = question.text.split('\n').filter((line) => line.trim() && !/^\s*(```|~~~)/.test(line));
  const quote = withoutMentions((lines.at(-1) ?? '').trim().replace(/^(?:>\s*)+/, ''));
  const cut = quote.length > MAX_QUOTE ? `${quote.slice(0, MAX_QUOTE - 1).trimEnd()}…` : quote;
  return `${direct ? '' : `@${question.from}\n\n`}> Re: \`#${question.id}\` ${cut}\n\n${choice}`;
}
