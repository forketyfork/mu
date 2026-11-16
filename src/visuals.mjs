import { createHash, randomUUID } from 'node:crypto';
import { httpError as bad } from './http-error.mjs';
import { createVisualComments } from './visual-comments.mjs';
import { LIMITS, SECTION_ID, parseDocument, validateSection } from './visual-format.mjs';

// Visuals: documents that agents write for the user, stored as versions of section revisions.
// See "Visuals" in docs/architecture.md.

const VISUAL_ID = /^[a-z][a-z0-9-]{0,47}$/;
const parseData = (row) => JSON.parse(/** @type {string} */ (row.data));
const bytes = (text) => Buffer.byteLength(text);
const rev = (section) =>
  createHash('sha256')
    .update(JSON.stringify([section.id, section.title, section.body]))
    .digest('hex')
    .slice(0, 16);

/**
 * @param {object} options
 * @param {import('./store.mjs').Store} options.store
 * @param {{active: Map<string, object>}} options.runner
 * @param {{find: (id: string) => any, list: () => any[]}} options.tasks
 * @param {(text: string, conversationId: string) => Promise<{ id: number }>} options.sendAsUser
 *   Posts a chat message as the user; the user's comments reach the author of a visual through it.
 */
export function createVisuals({ store, runner, tasks, sendAsUser }) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS visuals (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS visual_versions (visual_id TEXT NOT NULL, number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(visual_id, number));
    -- A section's content is stored once per distinct content; a version names the revision of each of its sections.
    CREATE TABLE IF NOT EXISTS visual_sections (visual_id TEXT NOT NULL, rev TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(visual_id, rev));`);
  // The version that a running turn created for each visual, keyed by the runner's entry for that turn, so that
  // every change of one turn goes into one version. The entry is gone when the turn ends, and so is this record.
  /** @type {WeakMap<object, Map<string, number>>} */
  const turnVersions = new WeakMap();

  const find = (id) => {
    const row = store.db.prepare('SELECT data FROM visuals WHERE id=?').get(id);
    return row ? parseData(row) : null;
  };
  const get = (id) => {
    const visual = find(id);
    if (!visual) throw bad(`Unknown visual ${id}`, 404);
    return visual;
  };
  const list = () => store.db.prepare('SELECT data FROM visuals ORDER BY rowid').all().map(parseData);
  // A new visual is inserted and never written over: its ID is a short random number, and an ID that another visual
  // already has must fail instead of replacing that visual.
  const insert = (visual) => {
    store.db.prepare('INSERT INTO visuals (id,data) VALUES (?,?)').run(visual.id, JSON.stringify(visual));
    store.changed(['visuals', visual.id]);
  };
  const save = (visual) => {
    store.db.prepare('UPDATE visuals SET data=? WHERE id=?').run(JSON.stringify(visual), visual.id);
    store.changed(['visuals', visual.id]);
  };
  const canRead = (visual, caller) =>
    caller === 'user' || Boolean(store.conversation(visual.conversationId)?.members.includes(caller));
  const readable = (id, caller) => {
    const visual = get(id);
    if (!canRead(visual, caller)) throw bad(`@${caller} is not a member of this visual's conversation`, 403);
    return visual;
  };

  const storedVersion = (id, number) => {
    const row = store.db.prepare('SELECT data FROM visual_versions WHERE visual_id=? AND number=?').get(id, number);
    if (!row) throw bad(`Visual ${id} has no version ${number}`, 404);
    return parseData(row);
  };
  // A version with the content of its sections.
  const readVersion = (id, number) => {
    const version = storedVersion(id, number);
    const content = store.db.prepare('SELECT data FROM visual_sections WHERE visual_id=? AND rev=?');
    return {
      ...version,
      sections: version.sections.map((entry) => ({ ...parseData(content.get(id, entry.rev)), rev: entry.rev })),
    };
  };
  const writeVersion = (id, version, sections) => {
    const insertSection = store.db.prepare('INSERT OR IGNORE INTO visual_sections (visual_id,rev,data) VALUES (?,?,?)');
    const entries = sections.map((section) => {
      const { id: sectionId, title, body } = section;
      const hash = rev(section);
      insertSection.run(id, hash, JSON.stringify({ id: sectionId, title, body }));
      return { id: sectionId, rev: hash };
    });
    store.db
      .prepare(
        'INSERT INTO visual_versions (visual_id,number,data) VALUES (?,?,?) ON CONFLICT(visual_id,number) DO UPDATE SET data=excluded.data',
      )
      .run(id, version.number, JSON.stringify({ ...version, sections: entries }));
  };
  const versions = (id) =>
    store.db
      .prepare('SELECT data FROM visual_versions WHERE visual_id=? ORDER BY number')
      .all(id)
      .map(parseData)
      .map(({ number, createdAt, updatedAt }) => ({ number, createdAt, updatedAt }));
  // The content of a section as it was under one revision; null for a revision this visual never had.
  const readSection = (id, hash) => {
    const row = store.db.prepare('SELECT data FROM visual_sections WHERE visual_id=? AND rev=?').get(id, hash);
    return row ? parseData(row) : null;
  };
  const comments = createVisualComments({ store, visuals: { get, save, readVersion, readSection }, sendAsUser });
  // The sections of `version` that differ from the version before it, by ID.
  const difference = (id, version) => {
    if (version.number === 1) return { changed: [], added: [], removed: [] };
    return compare(storedVersion(id, version.number - 1).sections, version.sections);
  };
  const compare = (before, after) => {
    const previous = new Map(before.map((section) => [section.id, section.rev ?? rev(section)]));
    const next = new Map(after.map((section) => [section.id, section.rev ?? rev(section)]));
    return {
      changed: [...next].filter(([key, hash]) => previous.has(key) && previous.get(key) !== hash).map(([key]) => key),
      added: [...next.keys()].filter((key) => !previous.has(key)),
      removed: [...previous.keys()].filter((key) => !next.has(key)),
    };
  };

  const titleOf = (value) => {
    if (typeof value !== 'string' || !value.trim() || bytes(value.trim()) > LIMITS.titleBytes)
      throw bad(`A visual's title must contain 1–${LIMITS.titleBytes} UTF-8 bytes`);
    return value.trim();
  };
  const parse = (source) => {
    let document;
    try {
      document = parseDocument(source);
      for (const section of document.sections) validateSection(section);
    } catch (error) {
      throw bad(`Invalid visual source: ${error.message}`);
    }
    return document;
  };
  const sectionIds = (value, field) => {
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && SECTION_ID.test(id)))
      throw bad(`${field} must be a list of section IDs`);
    return value;
  };
  const checkSize = (sections) => {
    if (!sections.length) throw bad('A visual needs at least one section');
    if (sections.length > LIMITS.sections) throw bad(`A visual holds at most ${LIMITS.sections} sections`);
    const size = sections.reduce((total, section) => total + bytes(section.title) + bytes(section.body), 0);
    if (size > LIMITS.documentBytes)
      throw bad(
        `A visual holds at most ${LIMITS.documentBytes / 1024} KiB of text in all its sections; this one would hold ${Math.ceil(size / 1024)} KiB`,
      );
  };
  // The task a visual is listed under: the one given, else the author's assigned task when it belongs to the
  // conversation, else the only unverified task of that conversation.
  const taskFor = (input, agent, conversationId, from) => {
    if (input.taskId !== undefined) {
      const task = typeof input.taskId === 'string' ? tasks.find(input.taskId) : null;
      if (!task) throw bad(`Unknown task ${input.taskId}`);
      const rooms = [task.conversationId, ...(from === 'lead' ? [task.sourceConversationId] : [])];
      if (!rooms.some((room) => store.conversation(room)?.members.includes(from)))
        throw bad(`@${from} is not a member of the conversation of task ${task.id}`, 403);
      return task.id;
    }
    if (agent.taskId && tasks.find(agent.taskId)?.conversationId === conversationId) return agent.taskId;
    const open = tasks.list().filter((task) => task.conversationId === conversationId && task.status !== 'verified');
    return open.length === 1 ? open[0].id : null;
  };
  const author = (from) => {
    const agent = from === 'user' ? null : store.agent(from);
    if (!agent) throw bad('A visual is written by an agent; the user comments on it and answers its forms', 403);
    return agent;
  };

  const create = (input, from) => {
    const agent = author(from);
    for (const key of Object.keys(input))
      if (!['from', 'title', 'source', 'conversationId', 'taskId'].includes(key))
        throw bad(`Unknown visual field ${key}`);
    const turn = runner.active.get(from) ?? null;
    const conversationId = input.conversationId ?? turn?.conversationId ?? agent.conversationId;
    const conversation = typeof conversationId === 'string' ? store.conversation(conversationId) : null;
    if (!conversation) throw bad(`Unknown conversation ${conversationId}`);
    if (!conversation.members.includes(from)) throw bad(`@${from} is not a member of ${conversationId}`, 403);
    // Parsing is the costly part of the request, so it comes after the checks of who asks.
    const document = parse(input.source);
    checkSize(document.sections);
    const title = titleOf(input.title ?? document.title);
    const id = `vis-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const visual = {
      id,
      title,
      agentId: from,
      conversationId,
      // The author's native session for that conversation, when its CLI has reported one.
      sessionId: agent.sessionIds?.[conversationId] ?? null,
      taskId: taskFor(input, agent, conversationId, from),
      version: 1,
      revision: 1,
      commentRevision: 0,
      draftComments: 0,
      openComments: 0,
      sectionCount: document.sections.length,
      createdAt: now,
      updatedAt: now,
    };
    store.transaction(() => {
      insert(visual);
      writeVersion(id, { number: 1, title, createdAt: now, updatedAt: now }, document.sections);
    });
    if (turn) turnVersions.set(turn, new Map([...(turnVersions.get(turn) ?? []), [id, 1]]));
    return { ...visual, sections: document.sections.map((section) => ({ id: section.id, title: section.title })) };
  };

  // The sections after a change: removals first, then the sent sections, each replacing the section with its ID or
  // inserted after the section sent before it, then the move.
  const apply = (current, input, document) => {
    let next = [...current];
    const index = (id, what) => {
      const found = next.findIndex((section) => section.id === id);
      if (found === -1)
        throw bad(
          `${what}: this visual has no section ${id}. Its sections: ${next.map((section) => section.id).join(', ') || 'none'}`,
        );
      return found;
    };
    const anchor = () => {
      const given = ['after', 'before', 'first'].filter((key) => input[key] !== undefined);
      if (given.length > 1) throw bad('Use only one of after, before and first');
      if (input.first !== undefined && input.first !== true) throw bad('first must be true');
      for (const key of ['after', 'before'])
        if (input[key] !== undefined && typeof input[key] !== 'string') throw bad(`${key} must be a section ID`);
      if (input.first) return 0;
      if (input.before !== undefined) return index(input.before, 'before');
      if (input.after !== undefined) return index(input.after, 'after') + 1;
      return null;
    };
    for (const id of sectionIds(input.remove ?? [], 'remove')) next.splice(index(id, 'remove'), 1);
    if (input.move !== undefined) {
      if (document) throw bad('Move a section in a call of its own, without source');
      if (typeof input.move !== 'string') throw bad('move must be a section ID');
      const [section] = next.splice(index(input.move, 'move'), 1);
      const target = anchor();
      if (target === null) throw bad('Say where the section moves: after, before or first');
      next.splice(target, 0, section);
    } else if (document) {
      if (input.replace) next = document.sections;
      else {
        let cursor = anchor();
        for (const section of document.sections) {
          const existing = next.findIndex((item) => item.id === section.id);
          if (existing !== -1) {
            next[existing] = section;
            cursor = existing + 1;
          } else {
            const at = cursor ?? next.length;
            next.splice(at, 0, section);
            cursor = at + 1;
          }
        }
      }
    } else if (['after', 'before', 'first'].some((key) => input[key] !== undefined))
      throw bad('after, before and first place the sections of a source, or the section named by move');
    checkSize(next);
    return next;
  };

  const patch = (id, input, from) => {
    author(from);
    const visual = get(id);
    if (visual.agentId !== from)
      throw bad(`Only @${visual.agentId}, which wrote this visual, changes it; write your own with visual create`, 403);
    for (const key of Object.keys(input))
      if (
        ![
          'from',
          'title',
          'source',
          'replace',
          'remove',
          'move',
          'after',
          'before',
          'first',
          'amend',
          'resolves',
        ].includes(key)
      )
        throw bad(`Unknown visual field ${key}`);
    for (const flag of ['replace', 'amend'])
      if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw bad(`${flag} must be a boolean`);
    if (input.replace && input.source === undefined) throw bad('replace needs the whole document as source');
    const document = input.source === undefined ? null : parse(input.source);
    const current = readVersion(id, visual.version);
    const sections = apply(
      current.sections.map(({ id: sectionId, title, body }) => ({ id: sectionId, title, body })),
      input,
      document,
    );
    const title = input.title !== undefined || document?.title ? titleOf(input.title ?? document.title) : visual.title;
    const changes = compare(current.sections, sections);
    const reordered = sections.map((section) => section.id).join('\n') !== current.sections.map((s) => s.id).join('\n');
    const turn = runner.active.get(from) ?? null;
    if (input.amend && turn) throw bad('A managed turn needs no amend: every change of one turn goes into one version');
    const unchanged =
      !reordered &&
      title === visual.title &&
      !changes.changed.length &&
      !changes.added.length &&
      !changes.removed.length;
    const amend = turn ? turnVersions.get(turn)?.get(id) === visual.version : input.amend === true;
    const number = unchanged || amend ? visual.version : visual.version + 1;
    // The comments this change answers. Named without a change, they are answered by the newest version, which an
    // earlier call made.
    const answered = input.resolves === undefined ? [] : comments.answerable(id, input.resolves, number);
    const response = (extra) => ({
      id,
      title,
      version: number,
      ...changes,
      ...(answered.length ? { resolved: answered.map((comment) => comment.id) } : {}),
      ...extra,
    });
    if (unchanged) {
      if (answered.length)
        store.transaction(() => {
          comments.markAnswered(answered, number);
          save(comments.counted(visual));
        });
      return response({ unchanged: true });
    }
    const now = new Date().toISOString();
    store.transaction(() => {
      writeVersion(id, { number, title, createdAt: amend ? current.createdAt : now, updatedAt: now }, sections);
      comments.markAnswered(answered, number);
      const next = {
        ...visual,
        title,
        sessionId: store.agent(from).sessionIds?.[visual.conversationId] ?? visual.sessionId,
        version: number,
        revision: visual.revision + 1,
        sectionCount: sections.length,
        updatedAt: now,
      };
      save(answered.length ? comments.counted(next) : next);
    });
    if (turn) turnVersions.set(turn, new Map([...(turnVersions.get(turn) ?? []), [id, number]]));
    return response({ newVersion: !amend });
  };

  const read = (id, caller, number) => {
    const visual = readable(id, caller);
    const version = readVersion(id, number ?? visual.version);
    const counts = comments.perVersion(id, caller);
    return {
      ...visual,
      shown: {
        ...version,
        ...difference(id, version),
        comments: comments.ofVersion(id, version.number, caller),
        // The comments on earlier versions that this version answers.
        answers: comments.answeredIn(id, version.number),
      },
      versions: versions(id).map((item) => ({ ...item, comments: counts.get(item.number) ?? 0 })),
    };
  };

  const handle = async ({ request, response, pathname, body, send, actor }) => {
    const match = pathname.match(/^\/api\/visuals(?:\/([^/]+)(\/comments(?:\/([^/]+))?)?)?$/);
    if (!match) return false;
    const [, id, commentsPath, commentId] = match;
    if (id !== undefined && !VISUAL_ID.test(id)) throw bad(`Unknown visual ${id}`, 404);
    const query = new URL(request.url, 'http://mu').searchParams;
    if (commentsPath) {
      if (request.method === 'GET' && !commentId) {
        readable(id, request.caller);
        send(response, 200, comments.list(id, request.caller));
        return true;
      }
      // A comment is the user's word to an agent, so only the user writes and sends one.
      const input = await body(request);
      if (request.caller !== 'user' || actor(request, input) !== 'user')
        throw bad(
          'Only the user comments on a visual; an agent reads the comments and answers them with a change',
          403,
        );
      get(id);
      if (request.method === 'POST' && !commentId) {
        send(response, 201, comments.create(id, input));
      } else if (request.method === 'POST' && commentId === 'send') send(response, 200, await comments.send(id, input));
      else if (request.method === 'PATCH' && commentId) send(response, 200, comments.update(id, commentId, input));
      else if (request.method === 'DELETE' && commentId) send(response, 200, comments.remove(id, commentId));
      else throw bad('Unsupported comment operation', 405);
      return true;
    }
    if (request.method === 'GET' && !id) {
      const filters = [
        ['task', 'taskId'],
        ['conversation', 'conversationId'],
        ['agent', 'agentId'],
      ].filter(([name]) => query.has(name));
      send(
        response,
        200,
        list().filter(
          (visual) =>
            canRead(visual, request.caller) && filters.every(([name, field]) => visual[field] === query.get(name)),
        ),
      );
      return true;
    }
    if (request.method === 'GET') {
      const raw = query.get('version');
      if (raw !== null && !/^[1-9]\d{0,8}$/.test(raw)) throw bad('version must be a positive integer');
      send(response, 200, read(id, request.caller, raw === null ? undefined : Number(raw)));
      return true;
    }
    if (request.method === 'POST' && !id) {
      const input = await body(request);
      send(response, 201, create(input, actor(request, input)));
      return true;
    }
    if (request.method === 'PATCH' && id) {
      const input = await body(request);
      send(response, 200, patch(id, input, actor(request, input)));
      return true;
    }
    throw bad('Unsupported visual operation', 405);
  };

  return { find, get, list, create, patch, read, handle, comments };
}
