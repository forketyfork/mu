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

const CHOICES_LINE = /^Choices:[ \t]+(\S.*?)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Whether the last of `lines` sits inside a fenced code block that an earlier line opened and nothing closed.
 * @param {string[]} lines
 */
function endsInFence(lines) {
  let open = null;
  for (const line of lines.slice(0, -1)) {
    const fence = FENCE.exec(line);
    if (!fence) continue;
    const [, marks, rest] = fence;
    if (!open) {
      // An info string of a backtick fence cannot hold a backtick, so the line is inline code.
      if (marks[0] !== '`' || !rest.includes('`')) open = marks;
    } else if (marks[0] === open[0] && marks.length >= open.length && !rest.trim()) open = null;
  }
  return open !== null;
}

/**
 * Splits the choices off the final reply of an agent. The reply offers choices when its last line, from the first
 * column, is `Choices: Yes | No` and reads as the choices of `say --choices`, and when words precede it. Any other
 * reply is text, as written: a line in a code block, a quote, a list item or a sentence, a list that `validChoices`
 * refuses, and a line without a question above it.
 * @param {string} text the reply, trimmed, without a final NO_REPLY line
 * @returns {{ text: string, choices?: string[] }}
 */
export function splitChoices(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const match = CHOICES_LINE.exec(lines.at(-1) ?? '');
  if (!match || endsInFence(lines)) return { text };
  const body = lines.slice(0, -1).join('\n').trimEnd();
  // A reply of NO_REPLY above the line would post as the sentinel, and the service would drop the reply.
  if (!body.trim() || body.trim() === 'NO_REPLY') return { text };
  try {
    return { text: body, choices: validChoices(match[1].split('|').map((label) => label.trim())) };
  } catch (error) {
    if (error.status !== 400) throw error;
    return { text };
  }
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
