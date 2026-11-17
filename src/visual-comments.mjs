import { randomUUID } from 'node:crypto';
import { httpError as bad } from './http-error.mjs';
import { mentions } from './store.mjs';
import { MESSAGE_QUOTE_CHARS, feedbackText, locator, quoted } from './visual-feedback.mjs';
import {
  COMMENT_LIMITS,
  PATCH_LIMITS,
  SECTION_ID,
  parseBlocks,
  parsePatch,
  patchLine,
  unseen,
  visibleParts,
} from './visual-format.mjs';

// The user's comments on a visual. A comment belongs to one version and names the section, the block and the quoted
// text it is about; it is a draft until the user sends it, and then reaches the author as a chat message from the
// user in the visual's conversation. See "Visuals" in docs/architecture.md.

const COMMENT_ID = /^vc-[0-9a-f]{8}$/;
const parseData = (row) => JSON.parse(/** @type {string} */ (row.data));

/**
 * @param {object} options
 * @param {import('./store.mjs').Store} options.store
 * @param {{ get: (id: string) => any, save: (visual: any) => any, readVersion: (id: string, number: number) => any, readSection: (id: string, rev: string) => any }} options.visuals
 * @param {(text: string, conversationId: string) => Promise<{ id: number }>} options.sendAsUser
 *   Posts a chat message as the user, with the checks and the delivery notice of a message typed in the chat. An
 *   error that carries `saved` is about the notice only: that message is in the chat.
 */
export function createVisualComments({ store, visuals, sendAsUser }) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS visual_comments (id TEXT PRIMARY KEY, visual_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visual_comments_version ON visual_comments (visual_id, version);`);

  const all = (visualId) =>
    store.db.prepare('SELECT data FROM visual_comments WHERE visual_id=? ORDER BY rowid').all(visualId).map(parseData);
  // An agent reads what the user sent; a draft is the user's until then.
  const visible = (comments, caller) =>
    caller === 'user' ? comments : comments.filter((comment) => comment.status === 'sent');
  // A new comment is inserted and never written over: an ID that another comment has must fail.
  const insert = (comment) =>
    store.db
      .prepare('INSERT INTO visual_comments (id,visual_id,version,data) VALUES (?,?,?,?)')
      .run(comment.id, comment.visualId, comment.version, JSON.stringify(comment));
  const write = (comment) =>
    store.db.prepare('UPDATE visual_comments SET data=? WHERE id=?').run(JSON.stringify(comment), comment.id);
  // The record of a visual carries the counts, so that a change of a comment reaches every open dashboard.
  const counted = (visual) => {
    const comments = all(visual.id);
    return {
      ...visual,
      commentRevision: (visual.commentRevision ?? 0) + 1,
      draftComments: comments.filter((comment) => comment.status === 'draft').length,
      openComments: comments.filter((comment) => comment.status === 'sent' && comment.answeredIn === null).length,
    };
  };
  const find = (visualId, id) => {
    const row = COMMENT_ID.test(id)
      ? store.db.prepare('SELECT data FROM visual_comments WHERE id=? AND visual_id=?').get(id, visualId)
      : null;
    if (!row) throw bad(`Visual ${visualId} has no comment ${id}`, 404);
    return parseData(row);
  };
  // The drafts whose message is on its way to the chat. They are neither sent again nor changed until the chat has
  // answered, or the author would get a comment twice, or in other words than the list shows. One service owns a
  // data directory, so the claim lives in the process, and a crash leaves no comment that is neither draft nor sent.
  const claimed = new Set();
  const draft = (visualId, id) => {
    const comment = find(visualId, id);
    if (comment.status !== 'draft') throw bad(`Comment ${id} was sent; only a draft changes`, 409);
    if (claimed.has(comment.id))
      throw bad(`Comment ${id} is being sent. Wait for the result, then read the comments again.`, 409);
    return comment;
  };

  const textOf = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || Buffer.byteLength(text) > COMMENT_LIMITS.textBytes)
      throw bad(`A comment must contain 1–${COMMENT_LIMITS.textBytes} UTF-8 bytes`);
    // The comment and its quote are sent as the user's words: they say what the user saw, and nothing else.
    const hidden = unseen(text, true);
    if (hidden) throw bad(`The comment holds a character that is not shown (${hidden}); write it without it`);
    const named = mentions(text);
    if (named.length)
      throw bad(
        `A comment goes to the author of the visual only. Write @${named[0]} in a code span, or mention the agent in the chat.`,
      );
    return text;
  };
  const quoteOf = (value) => {
    if (value === undefined || value === null) return null;
    const part = (key, max, needed) => {
      const text = value[key];
      if (typeof text !== 'string' || [...text].length > max || (needed && !text.trim()))
        throw bad(`quote.${key} must be text of at most ${max} characters`);
      const hidden = unseen(text, true);
      if (hidden)
        throw bad(
          `The selected text holds a character that is not shown (${hidden}). Select other text, or comment on the section.`,
        );
      return text;
    };
    if (typeof value !== 'object' || Array.isArray(value)) throw bad('quote must be an object');
    return {
      text: part('text', COMMENT_LIMITS.quoteChars, true),
      prefix: part('prefix', COMMENT_LIMITS.contextChars, false),
      suffix: part('suffix', COMMENT_LIMITS.contextChars, false),
    };
  };
  const lineOf = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw bad('line must be an object');
    for (const key of Object.keys(value))
      if (!['path', 'side', 'number'].includes(key)) throw bad(`line has no field ${key}; it takes path, side, number`);
    const { path, side, number } = value;
    if (typeof path !== 'string' || !path || [...path].length > PATCH_LIMITS.pathChars)
      throw bad(`line.path must be the path of a file of the patch`);
    if (side !== 'old' && side !== 'new') throw bad('line.side is old or new');
    if (!Number.isInteger(number) || number < 1 || number > PATCH_LIMITS.lineNumber)
      throw bad('line.number must be a line number');
    return { path, side, number };
  };
  // Where a comment points: the visual as a whole, a section, a block of it, a line of a patch, or quoted text in a
  // block.
  const targetOf = (input, version) => {
    const quote = quoteOf(input.quote);
    const line = lineOf(input.line);
    if (input.sectionId === undefined || input.sectionId === null) {
      if (quote || line || (input.block !== undefined && input.block !== null))
        throw bad('A quote, a line or a block needs the section it is in');
      return { sectionId: null, sectionRev: null, block: null, quote: null, line: null };
    }
    const section =
      typeof input.sectionId === 'string' && SECTION_ID.test(input.sectionId)
        ? version.sections.find((item) => item.id === input.sectionId)
        : null;
    if (!section) throw bad(`Version ${version.number} has no section ${input.sectionId}`);
    // The newest version changes while its turn runs. A comment is about the content its writer saw, so a section
    // that changed since then needs a new look, not a comment that points into other text.
    if (typeof input.sectionRev !== 'string')
      throw bad('sectionRev is needed with sectionId: the revision of the section as its reader saw it');
    if (input.sectionRev !== section.rev)
      throw bad(
        `Section ${section.id} of version ${version.number} changed while you wrote. Read it again, then select what the comment is about.`,
        409,
      );
    if (input.block === undefined || input.block === null) {
      if (quote || line) throw bad('A quote or a line needs the block it is in');
      return { sectionId: section.id, sectionRev: section.rev, block: null, quote: null, line: null };
    }
    const blocks = parseBlocks(section.body);
    if (!Number.isInteger(input.block) || input.block < 0 || input.block >= blocks.length)
      throw bad(`Section ${section.id} has ${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}`);
    if (line) {
      if (quote) throw bad('A comment names a line or a quote, not both');
      const block = blocks[input.block];
      if (block.type !== 'patch') throw bad(`Block ${input.block + 1} of section ${section.id} is no patch`);
      // The line is checked against the patch of the revision that the reader saw, like a quote's section.
      if (!patchLine(parsePatch(block.text), line))
        throw bad(
          `The patch in block ${input.block + 1} of section ${section.id} has no ${line.side} line ${line.number} in ${line.path}`,
        );
    }
    return { sectionId: section.id, sectionRev: section.rev, block: input.block, quote, line };
  };

  function create(visualId, input) {
    for (const key of Object.keys(input))
      if (!['from', 'version', 'sectionId', 'sectionRev', 'block', 'quote', 'line', 'text'].includes(key))
        throw bad(`Unknown comment field ${key}`);
    const visual = visuals.get(visualId);
    if (!Number.isInteger(input.version) || input.version < 1) throw bad('version must be a positive integer');
    const version = visuals.readVersion(visualId, input.version);
    const target = targetOf(input, version);
    const text = textOf(input.text);
    if (all(visualId).filter((comment) => comment.version === version.number).length >= COMMENT_LIMITS.perVersion)
      throw bad(`A version holds at most ${COMMENT_LIMITS.perVersion} comments`);
    const now = new Date().toISOString();
    const comment = {
      id: `vc-${randomUUID().slice(0, 8)}`,
      visualId,
      version: version.number,
      ...target,
      text,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      sentRevision: null,
      messageId: null,
      answeredIn: null,
    };
    store.transaction(() => {
      insert(comment);
      visuals.save(counted(visual));
    });
    return comment;
  }

  function update(visualId, id, input) {
    for (const key of Object.keys(input))
      if (!['from', 'text'].includes(key)) throw bad(`Unknown comment field ${key}`);
    const comment = { ...draft(visualId, id), text: textOf(input.text), updatedAt: new Date().toISOString() };
    store.transaction(() => {
      write(comment);
      visuals.save(counted(visuals.get(visualId)));
    });
    return comment;
  }

  function remove(visualId, id) {
    const comment = draft(visualId, id);
    store.transaction(() => {
      store.db.prepare('DELETE FROM visual_comments WHERE id=?').run(comment.id);
      visuals.save(counted(visuals.get(visualId)));
    });
    return { removed: comment.id };
  }

  /** The comments in the order of the document, and the numbered item that states each in the chat message. */
  function items(visual, version, comments) {
    const order = new Map(version.sections.map((section, index) => [section.id, index]));
    // The visual as a whole first, then in the order of the document; a section that the version lost comes last.
    const position = (comment) => [
      comment.sectionId === null ? -1 : (order.get(comment.sectionId) ?? order.size),
      comment.block ?? -1,
      comment.createdAt,
    ];
    const sorted = [...comments].sort((a, b) => {
      const [left, right] = [position(a), position(b)];
      return left[0] - right[0] || left[1] - right[1] || left[2].localeCompare(right[2]);
    });
    const where = (comment) => {
      if (comment.sectionId === null) return 'on the visual as a whole';
      // The author may have changed the section in the same turn, after the user read it.
      const now = version.sections.find((item) => item.id === comment.sectionId);
      const since = !now
        ? ', which you removed after the comment was written'
        : now.rev === comment.sectionRev
          ? ''
          : ', which you changed after the comment was written';
      const section = `on section \`${comment.sectionId}\`${since}`;
      if (comment.block === null) return `${section}${since ? '' : ' as a whole'}`;
      if (comment.quote) return `${section}, at ${locator(comment.quote.text, MESSAGE_QUOTE_CHARS)}`;
      const { body } = visuals.readSection(visual.id, comment.sectionRev);
      const block = parseBlocks(body)[comment.block];
      if (comment.line) {
        const { path, side, number } = comment.line;
        const { text } = patchLine(parsePatch(block.text), comment.line);
        // The line as the reader saw it: a character that is not shown is written as its code point.
        const shown = visibleParts(text)
          .map((part) => part.text)
          .join('');
        return `${section}, ${locator(path, MESSAGE_QUOTE_CHARS)} ${side === 'old' ? 'old line' : 'line'} ${number}${shown.trim() ? ` ${locator(shown, MESSAGE_QUOTE_CHARS)}` : ''}`;
      }
      return `${section}, block ${comment.block + 1} (${block.type})`;
    };
    // The message says what the user saw. A draft is checked where it is written, and here again: the store may
    // hold one that was saved under an older rule.
    for (const comment of sorted) {
      const { text, prefix, suffix } = comment.quote ?? {};
      const hidden = [comment.text, text, prefix, suffix]
        .map((part) => (typeof part === 'string' ? unseen(part, true) : null))
        .find(Boolean);
      if (hidden)
        throw bad(
          `Comment ${comment.id} holds a character that is not shown (${hidden}). Delete the draft and write it again.`,
        );
    }
    return {
      sorted,
      lines: sorted.map(
        (comment, index) => `${index + 1}. \`${comment.id}\` ${where(comment)}:\n${quoted(comment.text)}`,
      ),
    };
  }

  /** The drafts of a version that a message can take: none of them is on its way already. */
  const drafts = (visualId, number) =>
    all(visualId)
      .filter((comment) => comment.version === number && comment.status === 'draft')
      .map((comment) => draft(visualId, comment.id));

  /**
   * Posts one message of the user to the author, and records what it carried. The drafts, and whatever `claims`
   * names besides them, are claimed until the chat has answered. `record` gets the visual's record, the message ID
   * and the time inside the transaction that marks the drafts as sent, and returns the record to save.
   * @param {object} options
   * @param {any} options.visual
   * @param {any[]} options.drafts
   * @param {string} options.text
   * @param {string[]} [options.claims]
   * @param {(current: any, messageId: number, now: string) => any} [options.record]
   */
  async function deliver({ visual, drafts: sorted, text, claims = [], record = (current) => current }) {
    const keys = [...sorted.map((comment) => comment.id), ...claims];
    const taken = claims.find((key) => claimed.has(key));
    if (taken) throw bad('This feedback is being sent. Wait for the result, then read the visual again.', 409);
    for (const key of keys) claimed.add(key);
    let posted;
    let noticeFailure = null;
    try {
      posted = await sendAsUser(text, visual.conversationId);
    } catch (error) {
      // The author has the message when it is in the chat, whatever happened to its delivery notice.
      if (!error.saved) throw error;
      posted = error.saved;
      noticeFailure = error;
    } finally {
      for (const key of keys) claimed.delete(key);
    }
    const now = new Date().toISOString();
    let sent;
    store.transaction(() => {
      const current = visuals.get(visual.id);
      sent = sorted.map((comment) => ({
        ...comment,
        status: 'sent',
        sentAt: now,
        updatedAt: now,
        messageId: posted.id,
        // What the visual held when the author got the comment: only a later write answers it.
        sentRevision: current.revision,
      }));
      for (const comment of sent) write(comment);
      visuals.save(record(sent.length ? counted(current) : current, posted.id, now));
    });
    if (noticeFailure) throw noticeFailure;
    return { messageId: posted.id, comments: sent };
  }

  /** Sends the drafts of one version, all of them or the named ones, as one chat message to the author. */
  async function send(visualId, input) {
    for (const key of Object.keys(input))
      if (!['from', 'version', 'ids'].includes(key)) throw bad(`Unknown field ${key}`);
    const visual = visuals.get(visualId);
    if (!Number.isInteger(input.version) || input.version < 1) throw bad('version must be a positive integer');
    if (input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.length))
      throw bad('ids must be a list of comment IDs');
    const chosen = input.ids
      ? [...new Set(input.ids.map(String))].map((id) => draft(visualId, id))
      : drafts(visualId, input.version);
    if (chosen.some((comment) => comment.version !== input.version))
      throw bad(`Every comment of one message belongs to version ${input.version}`);
    if (!chosen.length) throw bad(`Version ${input.version} has no draft to send`);
    const version = visuals.readVersion(visualId, input.version);
    const { lines, sorted } = items(visual, version, chosen);
    return deliver({
      visual,
      drafts: sorted,
      text: feedbackText({ visual, version, answers: null, comments: lines }),
    });
  }

  /**
   * The sent comments that a change of the visual may answer. A comment is answered in a later version than its
   * own, by content that was written after the author got it: `revision` is the one of the write that answers.
   */
  function answerable(visualId, ids, number, revision) {
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string'))
      throw bad('resolves must be a list of comment IDs');
    return [...new Set(ids)].map((id) => {
      const comment = find(visualId, id);
      if (comment.status !== 'sent') throw bad(`Visual ${visualId} has no comment ${id}`, 404);
      if (comment.answeredIn !== null) throw bad(`Comment ${id} was answered in version ${comment.answeredIn}`, 409);
      if (comment.version >= number)
        throw bad(
          `Comment ${id} is on version ${comment.version}, which is the newest: change the visual, then name the comments the change answers`,
        );
      if (comment.sentRevision >= revision)
        throw bad(
          `Comment ${id} was sent after version ${number} was written, so that version does not answer it: change the visual, then name the comments the change answers`,
        );
      return comment;
    });
  }

  /** Marks comments as answered in a version. The caller saves the record with `counted` in the same transaction. */
  function markAnswered(comments, number) {
    const now = new Date().toISOString();
    for (const comment of comments) write({ ...comment, answeredIn: number, updatedAt: now });
  }

  return {
    create,
    update,
    remove,
    send,
    drafts,
    items,
    deliver,
    answerable,
    markAnswered,
    counted,
    list: (visualId, caller) => visible(all(visualId), caller),
    /** The sent comments without an answer that reached the author in one of these chat messages. */
    waitingIn: (visualId, messageIds) =>
      all(visualId).filter(
        (comment) => comment.status === 'sent' && comment.answeredIn === null && messageIds.includes(comment.messageId),
      ),
    ofVersion: (visualId, number, caller) =>
      visible(
        all(visualId).filter((comment) => comment.version === number),
        caller,
      ),
    answeredIn: (visualId, number) => all(visualId).filter((comment) => comment.answeredIn === number),
    perVersion: (visualId, caller) => {
      const counts = new Map();
      for (const comment of visible(all(visualId), caller))
        counts.set(comment.version, (counts.get(comment.version) ?? 0) + 1);
      return counts;
    },
  };
}
