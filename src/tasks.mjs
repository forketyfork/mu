import { randomUUID } from 'node:crypto';
import { MAX_MESSAGE_BYTES } from './chat.mjs';
import { httpError as bad } from './http-error.mjs';

function text(value, field, max = MAX_MESSAGE_BYTES) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max)
    throw bad(`${field} must be a string of at most ${max} UTF-8 bytes`);
  return value;
}

export function createTasks({ store, chat, runner }) {
  store.db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const verifying = new Map();
  const find = (id) => {
    const row = store.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    return row ? JSON.parse(/** @type {string} */ (row.data)) : null;
  };
  const get = (id) => {
    const task = find(id);
    if (!task) throw bad(`Unknown task ${id}`, 404);
    return task;
  };
  const list = () =>
    store.db
      .prepare('SELECT data FROM tasks ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.data));
  const save = (task) => {
    const updated = { ...task, updatedAt: new Date().toISOString() };
    store.db
      .prepare('INSERT INTO tasks (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(updated.id, JSON.stringify(updated));
    store.changed(['tasks', updated.id]);
    return updated;
  };
  const access = (task, from) => {
    if (typeof task.conversationId !== 'string') throw bad('conversationId is required');
    const conversation = store.conversation(task.conversationId);
    if (!conversation) throw bad(`Unknown conversation ${task.conversationId}`);
    if (from !== 'user' && !conversation.members.includes(from))
      throw bad(`@${from} is not a member of this task's conversation`, 403);
    return conversation;
  };
  const workers = (ids, conversation) => {
    if (!Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === 'string'))
      throw bad('agentIds must be an array of at most 50 worker IDs');
    for (const id of ids) {
      const agent = store.agent(id);
      if (!agent || agent.role === 'lead') throw bad(`Task workers must be registered workers; @${id} is not one`);
      if (!conversation.members.includes(id)) throw bad(`Invite @${id} to the task conversation before assigning it`);
    }
    return [...new Set(ids)];
  };
  // Task records decide who gets retired after verification, so workers report to the lead instead of editing them.
  const editor = (from) => {
    if (from !== 'user' && store.agent(from)?.role !== 'lead')
      throw bad('Only the user and the team lead create and edit tasks; report your result to the lead', 403);
  };
  const visible = (task, caller) =>
    caller === 'user' ||
    [task.conversationId, ...(caller === 'lead' ? [task.sourceConversationId] : [])].some((id) =>
      store.conversation(id)?.members.includes(caller),
    );
  const create = (input, from) => {
    editor(from);
    if ((input.status !== undefined && input.status !== 'active') || input.verifiedAt !== undefined)
      throw bad('Tasks are created active; only the user can verify a ready task', 403);
    const id = input.id || `task-${randomUUID().slice(0, 8)}`;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(id))
      throw bad('Task id must use 1–48 lowercase letters, digits or hyphens');
    if (store.db.prepare('SELECT id FROM tasks WHERE id=?').get(id)) throw bad(`Task ${id} already exists`, 409);
    const title = text(input.title, 'title', 160).trim();
    if (!title) throw bad('Task title is required');
    const conversation = access(input, from);
    if (!['common', 'room'].includes(conversation.kind) || !conversation.members.includes('lead'))
      throw bad('A task needs a room with @lead; existing Common assignments can also be tracked');
    const sourceConversationId = input.sourceConversationId ?? conversation.sourceConversationId ?? conversation.id;
    const source = access({ conversationId: sourceConversationId }, from);
    if (!source.members.includes('lead'))
      throw bad('The source conversation must include @lead so it can report the task outcome');
    return save({
      id,
      title,
      description: text(input.description ?? '', 'description'),
      result: text(input.result ?? '', 'result'),
      status: 'active',
      conversationId: conversation.id,
      sourceConversationId,
      agentIds: workers(input.agentIds || [], conversation),
      createdBy: from,
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      verificationNotice: null,
      retiredAgentIds: [],
      retirementIssues: [],
    });
  };
  const update = (id, input, from) => {
    editor(from);
    const task = get(id),
      conversation = access(task, from);
    if (input.status === 'verified' || input.verifiedAt !== undefined || input.verifiedBy !== undefined)
      throw bad('Only the user can verify a task through the verification action', 403);
    if (task.status === 'verified') throw bad('A verified task cannot be changed', 409);
    const patch = {};
    const allowed = new Set(['from', 'title', 'description', 'result', 'agentIds', 'status']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw bad(`Task field ${key} cannot be changed`);
    if (input.title !== undefined) {
      patch.title = text(input.title, 'title', 160).trim();
      if (!patch.title) throw bad('Task title is required');
    }
    for (const key of ['description', 'result']) if (input[key] !== undefined) patch[key] = text(input[key], key);
    if (input.agentIds !== undefined) patch.agentIds = workers(input.agentIds, conversation);
    if (input.status !== undefined) {
      if (!['active', 'ready'].includes(input.status))
        throw bad('Task status must be active or ready; verification belongs to the user');
      patch.status = input.status;
    }
    const updated = { ...task, ...patch };
    if (updated.status === 'ready' && !updated.result.trim())
      throw bad('Record the task result before marking it ready');
    return save(updated);
  };
  // Verification retires the task's workers itself, because it needs no judgment. The notice mentions @lead only when a worker was skipped,
  // so a routine verification does not start a lead turn that reads the whole lead context only to repeat the outcome.
  const verificationNotice = (task, { retiredAgentIds, alreadyRetiredAgentIds, skipped }) => {
    const retired = [...retiredAgentIds, ...alreadyRetiredAgentIds].join(', ');
    const head = `The user verified task ${task.id}: ${task.title.replaceAll('@', '＠')}. Authoritative task status is verified.`;
    const outcome = retired
      ? ` Mu retired its workers (${retired}); their history is kept.`
      : ' The task has no workers to retire.';
    if (!skipped.length) return `${head}${outcome}`;
    return `@lead ${head}${outcome} Mu did not retire ${skipped.map(({ agentId, reason }) => `${agentId} (${reason})`).join(', ')}. Retire ${skipped.length === 1 ? 'it' : 'them'} with task retire once the reason no longer holds, or tell the user why a worker stays.`;
  };
  const verify = async (id, from) => {
    if (from !== 'user') throw bad('Only the user can verify a task', 403);
    if (verifying.has(id)) return verifying.get(id);
    const operation = (async () => {
      let task = get(id);
      if (!['ready', 'verified'].includes(task.status))
        throw bad('The task must be ready for verification by the user', 409);
      if (task.status === 'verified' && task.verificationNotice?.state === 'sent') return task;
      const conversation = access(task, from);
      if (!conversation.members.includes('lead'))
        throw bad('The task room must include @lead to receive verification', 409);
      task = save({
        ...task,
        status: 'verified',
        verifiedAt: task.verifiedAt || new Date().toISOString(),
        verifiedBy: 'user',
        verificationNotice: { state: 'pending', messageId: null, error: null },
      });
      try {
        const notice = await chat.send('system', verificationNotice(task, retire(id, {}, 'lead')), task.conversationId);
        return save({ ...get(id), verificationNotice: { state: 'sent', messageId: notice.id, error: null } });
      } catch (error) {
        return save({ ...get(id), verificationNotice: { state: 'error', messageId: null, error: error.message } });
      }
    })();
    verifying.set(id, operation);
    try {
      return await operation;
    } finally {
      verifying.delete(id);
    }
  };
  const otherAssignments = (agentId, exceptTaskId) =>
    list().filter((task) => task.id !== exceptTaskId && task.status !== 'verified' && task.agentIds.includes(agentId));
  const verifiedRoom = (conversationId) => {
    const related = list().filter((task) => task.conversationId === conversationId);
    return related.length > 0 && related.every((task) => task.status === 'verified');
  };
  // A managed agent that failed runs no turn until someone resumes it, and resuming a stopped agent works the same way with the
  // same inbox. So when all its pending messages belong to work the user has verified, stopping it cancels nothing that could still
  // run; a message from anywhere else may be a request the user still wants answered, and a saved response is finished work.
  // The runner records lastError on every failure; a status set to error by hand carries none. A manual agent reads and
  // acknowledges its own inbox in any status, so its status says nothing about whether it is still working on a message.
  const onlyVerifiedWorkPending = (agent) => {
    if (agent.adapter === 'manual' || agent.status !== 'error' || !agent.lastError) return false;
    const inbox = store.inbox(agent.id);
    return inbox.length === agent.pending && inbox.every((message) => verifiedRoom(message.conversationId));
  };
  const busyReason = (id) => {
    const agent = store.agent(id);
    if (runner.active.has(id) || agent.activeMessageId) return 'Agent is processing a message';
    if (agent.pendingResult) return 'Agent has a saved response';
    if (agent.pending && !onlyVerifiedWorkPending(agent)) return 'Agent has pending work';
    return null;
  };
  const guardAgentStop = (from, id) => {
    if (from === 'user') return;
    if (from !== 'lead' || id === 'lead')
      throw bad('Only the user or the team lead can stop workers; the lead can be stopped only by the user', 403);
    const assignments = otherAssignments(id);
    if (assignments.length)
      throw bad(`@${id} still has unverified tasks: ${assignments.map((task) => task.id).join(', ')}`, 409);
    const reason = busyReason(id);
    if (reason) throw bad(`${reason}; the user can stop an agent explicitly if required`, 409);
  };
  const retire = (id, input, from) => {
    if (from !== 'lead') throw bad('Worker retirement is performed by @lead after the user verifies the task', 403);
    let task = get(id);
    access(task, from);
    if (task.status !== 'verified' || task.verifiedBy !== 'user' || !task.verifiedAt)
      throw bad('The user must verify this task before its workers can be retired', 409);
    const requested = input.agentIds === undefined ? task.agentIds : input.agentIds;
    if (
      !Array.isArray(requested) ||
      !requested.every(
        (agentId) => typeof agentId === 'string' && task.agentIds.includes(agentId) && agentId !== 'lead',
      )
    )
      throw bad("Only this verified task's assigned workers can be retired");
    const retiredAgentIds = [],
      alreadyRetiredAgentIds = [],
      skipped = [];
    for (const agentId of new Set(requested)) {
      if (task.retiredAgentIds.includes(agentId)) {
        alreadyRetiredAgentIds.push(agentId);
        continue;
      }
      const assignments = otherAssignments(agentId, id);
      const reason = assignments.length
        ? `Still assigned to unverified tasks: ${assignments.map((item) => item.id).join(', ')}`
        : busyReason(agentId);
      if (reason) {
        skipped.push({ agentId, reason });
        continue;
      }
      if (store.agent(agentId).status !== 'stopped') runner.stop(agentId);
      retiredAgentIds.push(agentId);
    }
    task = save({
      ...get(id),
      retiredAgentIds: [...new Set([...task.retiredAgentIds, ...retiredAgentIds])],
      retirementIssues: skipped,
    });
    return { task, retiredAgentIds, alreadyRetiredAgentIds, skipped };
  };
  const handle = async ({ request, response, pathname, body, send, actor }) => {
    const match = pathname.match(/^\/api\/tasks(?:\/([a-z][a-z0-9-]{0,47})(?:\/(verify|retire))?)?$/);
    if (!match) return false;
    const [, id, action] = match;
    if (request.method === 'GET' && !action) {
      if (!id) {
        const includeVerified = new URL(request.url, 'http://mu').searchParams.get('include') === 'verified';
        send(
          response,
          200,
          list().filter((task) => visible(task, request.caller) && (includeVerified || task.status !== 'verified')),
        );
        return true;
      }
      const task = get(id);
      if (!visible(task, request.caller))
        throw bad(`@${request.caller} is not a member of this task's conversation`, 403);
      send(response, 200, task);
      return true;
    }
    if (request.method === 'POST' && !id) {
      const input = await body(request);
      send(response, 201, create(input, actor(request, input)));
      return true;
    }
    if (request.method === 'PATCH' && id && !action) {
      const input = await body(request);
      send(response, 200, update(id, input, actor(request, input)));
      return true;
    }
    if (request.method === 'POST' && id && action) {
      const input = await body(request),
        from = actor(request, input);
      send(response, 200, action === 'verify' ? await verify(id, from) : retire(id, input, from));
      return true;
    }
    throw bad('Unsupported task operation', 405);
  };
  return { find, get, list, create, update, verify, retire, guardAgentStop, handle };
}
