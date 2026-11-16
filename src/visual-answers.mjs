import { createHash } from 'node:crypto';
import { httpError as bad } from './http-error.mjs';
import { mentions } from './store.mjs';
import { MESSAGE_TITLE_CHARS, locator, quoted } from './visual-feedback.mjs';
import { FORM_LIMITS, answerOf, parseBlocks, parseForm } from './visual-format.mjs';

// The user's answers to the forms of a visual. An answer belongs to a question exactly as it was asked: it is stored
// under a hash of the field's definition, so a question that a new version repeats keeps its answer, and a question
// that the author changed starts without one. An answer is the user's until the user sends it; the author reads only
// what was sent. See "Visuals" in docs/architecture.md.

const FIELD_KEY = /^[0-9a-f]{16}$/;
const parseData = (row) => JSON.parse(/** @type {string} */ (row.data));
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// What makes an answer an answer to this question: every word of it that the user read, and the limits of a valid
// answer. Only the suggestion is left out: it proposes an answer and asks nothing. So an author that changes what a
// question means, even in its help or in the hint of an option, asks again.
/** @param {import('./visual-format.mjs').FormField} field */
const keyOf = ({ id, type, label, help, options, multiline, placeholder, maxLength, min, max, step, unit }) =>
  createHash('sha256')
    .update(JSON.stringify({ id, type, label, help, options, multiline, placeholder, maxLength, min, max, step, unit }))
    .digest('hex')
    .slice(0, 16);

/**
 * The forms in these sections, in the order of the document, each field with the key of its definition.
 * @param {{ id: string, body: string }[]} sections
 */
export function formsOf(sections) {
  const forms = [];
  for (const section of sections)
    parseBlocks(section.body).forEach((block, index) => {
      if (block.type !== 'form') return;
      forms.push({
        sectionId: section.id,
        block: index,
        fields: parseForm(block.text).fields.map((field) => ({ ...field, key: keyOf(field) })),
      });
    });
  return forms;
}

/** Checks the forms of one version together: a field ID names one question in the whole visual. */
export function checkForms(sections) {
  const seen = new Map();
  for (const form of formsOf(sections))
    for (const field of form.fields) {
      if (seen.has(field.id))
        throw bad(
          `Field ID ${field.id} is used in section ${seen.get(field.id)} and in section ${form.sectionId}; a field ID names one question in the whole visual`,
        );
      seen.set(field.id, form.sectionId);
    }
  if (seen.size > FORM_LIMITS.visualFields)
    throw bad(`A visual asks at most ${FORM_LIMITS.visualFields} questions in all its forms`);
}

/**
 * @param {object} options
 * @param {import('./store.mjs').Store} options.store
 * @param {{ get: (id: string) => any, save: (visual: any) => any, readVersion: (id: string, number: number) => any }} options.visuals
 */
export function createVisualAnswers({ store, visuals }) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS visual_answers (visual_id TEXT NOT NULL, field_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(visual_id, field_key));',
  );
  /** @returns {Map<string, any>} */
  const rows = (visualId) =>
    new Map(
      store.db
        .prepare('SELECT field_key, data FROM visual_answers WHERE visual_id=?')
        .all(visualId)
        .map((row) => [/** @type {string} */ (row.field_key), parseData(row)]),
    );
  const write = (visualId, key, data) =>
    store.db
      .prepare(
        'INSERT INTO visual_answers (visual_id,field_key,data) VALUES (?,?,?) ON CONFLICT(visual_id,field_key) DO UPDATE SET data=excluded.data',
      )
      .run(visualId, key, JSON.stringify(data));

  // Where a question stands: the answer that would be sent now (the user's own, else the author's suggestion), the
  // answer the author has, and whether the two differ, which is what waits for the user's click.
  const stateOf = (field, row) => {
    const own = row !== undefined && row.value !== undefined;
    const value = own ? row.value : field.default;
    // A suggestion that the user kept was the author's word. When the author takes the suggestion away, the user
    // has taken nothing back: the question is open again.
    const dropped = !own && field.default === undefined && row?.sent?.source === 'default';
    const sent = dropped ? null : (row?.sent ?? null);
    return {
      value,
      source: own ? 'user' : value === undefined ? null : 'default',
      sent,
      unsent: value === undefined ? sent !== null : sent === null || !same(sent.value, value),
    };
  };
  const statesOf = (visualId, sections) => {
    const stored = rows(visualId);
    return formsOf(sections).map((form) => ({
      ...form,
      fields: form.fields.map((field) => ({ field, ...stateOf(field, stored.get(field.key)) })),
    }));
  };

  // The record of a visual carries the count, so that an answer reaches every open dashboard.
  const counted = (visual, sections = visuals.readVersion(visual.id, visual.version).sections) => ({
    ...visual,
    answerRevision: (visual.answerRevision ?? 0) + 1,
    // The questions of the newest version that the author has no current answer to.
    openQuestions: statesOf(visual.id, sections)
      .flatMap((form) => form.fields)
      .filter((state) => state.value === undefined || state.unsent).length,
  });

  /** The forms of a version with the state of each question, as the caller may see it. */
  const view = (visualId, version, caller) =>
    statesOf(visualId, version.sections).map((form) => ({
      ...form,
      fields: form.fields.map(({ field, value, source, sent, unsent }) => ({
        ...field,
        // An answer is the user's until it is sent, like a draft comment.
        ...(caller === 'user' ? { answer: value === undefined ? null : { value, source }, unsent } : {}),
        sent: sent && { value: sent.value, source: sent.source, at: sent.at, version: sent.version },
      })),
    }));

  /**
   * What the author knows: the sent answers of a version's questions. `sentVersion` is the version that the user
   * answered on: the text around a question is no part of its key, and a reader can look up what it said there.
   */
  const report = (visualId, version) => {
    const fields = statesOf(visualId, version.sections).flatMap((form) =>
      form.fields.map(({ field, sent }) => ({
        id: field.id,
        sectionId: form.sectionId,
        type: field.type,
        label: field.label,
        ...(field.options ? { options: field.options.map(({ id, label }) => ({ id, label })) } : {}),
        answered: sent !== null,
        ...(sent ? { value: sent.value, source: sent.source, sentAt: sent.at, sentVersion: sent.version } : {}),
      })),
    );
    return {
      version: version.number,
      answers: Object.fromEntries(fields.filter((field) => field.answered).map((field) => [field.id, field.value])),
      unanswered: fields.filter((field) => !field.answered).map((field) => field.id),
      fields,
    };
  };

  // A version before the newest never changes, and its questions may be asked differently now.
  const newest = (visual, number) => {
    if (!Number.isInteger(number) || number < 1) throw bad('version must be a positive integer');
    if (number !== visual.version)
      throw bad(
        `Version ${number} is not the newest version of this visual; answer the questions of version ${visual.version}`,
        409,
      );
  };

  /** Sets or takes back the user's answers to questions of the newest version; nothing is sent. */
  function set(visualId, input) {
    for (const key of Object.keys(input))
      if (!['from', 'version', 'answers'].includes(key)) throw bad(`Unknown field ${key}`);
    const visual = visuals.get(visualId);
    newest(visual, input.version);
    if (!Array.isArray(input.answers) || !input.answers.length || input.answers.length > FORM_LIMITS.visualFields)
      throw bad('answers must be a list of {key, value}');
    const version = visuals.readVersion(visualId, visual.version);
    const fields = new Map(formsOf(version.sections).flatMap((form) => form.fields.map((field) => [field.key, field])));
    const stored = rows(visualId);
    const now = new Date().toISOString();
    const changes = input.answers.map((entry) => {
      if (!isObject(entry) || typeof entry.key !== 'string' || !FIELD_KEY.test(entry.key) || !('value' in entry))
        throw bad('answers must be a list of {key, value}');
      const field = fields.get(entry.key);
      // The newest version changes while its turn runs. An answer is to the question its writer saw.
      if (!field)
        throw bad(
          `A question of version ${visual.version} changed while you answered. Read it again, then answer.`,
          409,
        );
      const { key, ...definition } = field;
      let value;
      if (entry.value !== null) {
        try {
          value = answerOf(definition, entry.value);
        } catch (error) {
          throw bad(`Question ${field.id}: ${error.message}`);
        }
        const named = typeof value === 'string' ? mentions(value) : [];
        if (named.length)
          throw bad(
            `An answer goes to the author of the visual only. Write @${named[0]} in a code span, or mention the agent in the chat.`,
          );
      }
      return {
        key,
        data: {
          fieldId: field.id,
          ...(value === undefined ? {} : { value }),
          sent: stored.get(key)?.sent ?? null,
          updatedAt: now,
        },
      };
    });
    store.transaction(() => {
      for (const change of changes) write(visualId, change.key, change.data);
      visuals.save(counted(visuals.get(visualId), version.sections));
    });
    return view(visualId, version, 'user');
  }

  const shownAnswer = (field, value) => {
    const option = (id) =>
      `\`${id}\` ${locator(field.options.find((item) => item.id === id).label, MESSAGE_TITLE_CHARS)}`;
    if (field.type === 'choice') return option(value);
    if (field.type === 'multi') return value.length ? value.map(option).join(', ') : 'none of the options';
    if (field.type === 'toggle') return value ? 'yes' : 'no';
    if (field.type === 'number') return String(value);
    return `\n${quoted(value)}`;
  };

  /**
   * The answers of the newest version as the lines of a chat message, when the author lacks any of them; null when
   * the author has them all. `reviewed` is what the dashboard showed the user, by field key: the user sends exactly
   * that, so a question or an answer that changed since then refuses the send.
   */
  function compose(visual, version, reviewed) {
    newest(visual, version.number);
    if (!isObject(reviewed)) throw bad('answers must be an object of the reviewed answers by field key');
    const states = statesOf(visual.id, version.sections).flatMap((form) => form.fields);
    const current = states.filter((state) => state.value !== undefined);
    const sorted = (entries) => [...entries].sort(([left], [right]) => left.localeCompare(right));
    if (!same(sorted(Object.entries(reviewed)), sorted(current.map((state) => [state.field.key, state.value]))))
      throw bad('The questions or your answers changed since you reviewed them. Review them again, then send.', 409);
    if (!states.some((state) => state.unsent)) return null;
    const named = (list) => list.map((state) => `\`${state.field.id}\``).join(', ');
    const withdrawn = states.filter((state) => state.value === undefined && state.sent);
    const unanswered = states.filter((state) => state.value === undefined && !state.sent);
    const lines = [
      'Answers:',
      ...current.map(({ field, value, source, sent }) => {
        const note =
          source === 'default' ? ' (your suggestion, kept)' : sent && !same(sent.value, value) ? ' (changed)' : '';
        const answer = shownAnswer(field, value);
        const head = `- \`${field.id}\` ${locator(field.label, MESSAGE_TITLE_CHARS)}${note}:`;
        return answer.startsWith('\n') ? `${head}${answer}` : `${head} ${answer}`;
      }),
      ...(withdrawn.length ? [`Taken back: ${named(withdrawn)}`] : []),
      ...(unanswered.length ? [`Not answered: ${named(unanswered)}`] : []),
    ];
    return {
      lines,
      /** Records that the author has these answers. The caller saves the record with `counted`. */
      mark(messageId, now) {
        const stored = rows(visual.id);
        for (const { field, value, source, sent } of states) {
          if (value === undefined && !sent) continue;
          write(visual.id, field.key, {
            fieldId: field.id,
            updatedAt: now,
            ...stored.get(field.key),
            sent: value === undefined ? null : { value, source, at: now, messageId, version: version.number },
          });
        }
      },
    };
  }

  return { set, view, report, compose, counted };
}
