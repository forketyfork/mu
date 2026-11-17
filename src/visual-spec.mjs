// What the JSON formats of rich blocks share. Pure text functions, served to the visual frame with the formats.

// The shape of every ID an author gives: a section, a form field, a part of a scene.
export const ID = /^[a-z][a-z0-9-]{0,47}$/;

export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Characters that a reader does not see: controls, format characters such as zero-width spaces, direction overrides
// and tag characters, private-use characters, separators of lines, lone surrogates, and every code point that fonts
// ignore. Text can hide in them, and some models read it. What goes into a chat message as the user's words, and
// the words of a question, hold none of them, so the message says what the user saw.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
// How emoji are written: a joiner between two pictographs, and a selector after a pictograph or in a keycap.
const EMOJI_GLUE =
  /(?<=\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})|(?<=\p{Extended_Pictographic})\uFE0F|(?<=[0-9#*])\uFE0F(?=\u20E3)/gu;
/**
 * The first character of a text that a reader does not see, as `U+200B`, or null. A text that spans lines may hold
 * line breaks and tabs.
 * @param {string} text
 * @param {boolean} [lines]
 */
export function unseen(text, lines = false) {
  const plain = text.replace(EMOJI_GLUE, '');
  const found = UNSEEN.exec(lines ? plain.replace(/[\n\t]/g, '') : plain);
  return found && `U+${found[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Throws when an object of a block has a property that its format does not know. */
export function onlyKeys(object, allowed, what) {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${what} has no property "${unknown}"; it takes ${allowed.join(', ')}`);
}
