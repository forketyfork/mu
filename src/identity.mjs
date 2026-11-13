import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const USER_TOKEN_FILE = 'user-token';
const TOKEN = /^[0-9a-f]{64}$/;
// sockaddr_un holds 104 bytes on macOS and 108 on Linux, including the terminating NUL.
const MAX_SOCKET_PATH_BYTES = 103;

const newToken = () => randomBytes(32).toString('hex');
function same(a, b) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// The user's credential lives in the data directory, readable only by the operating-system user.
// Agent sandboxes deny reading it; see "Caller identity" in docs/architecture.md.
export function loadUserToken(dataDir) {
  const file = join(dataDir, USER_TOKEN_FILE);
  try {
    writeFileSync(file, `${newToken()}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error(`The Mu user credential ${file} is not a regular file; inspect and remove it`);
  if (stat.mode & 0o077) chmodSync(file, 0o600);
  const token = readFileSync(file, 'utf8').trim();
  if (!TOKEN.test(token))
    throw new Error(`The Mu user credential ${file} is malformed; delete it and restart Mu to create a new one`);
  return { file, token };
}

// Callers are the user, who holds the user credential, and agents, which hold a credential that
// Mu issues for one managed turn and revokes when the turn ends.
// A turn's credential reaches its process in a file, never in the environment: a sandboxed process
// can read any other process's environment through sysctl KERN_PROCARGS2, while each agent's sandbox
// can read only its own credential file.
export class Identity {
  constructor({ dataDir }) {
    const { token } = loadUserToken(dataDir);
    this.dataDir = dataDir;
    this.credentialDir = join(dataDir, 'credentials');
    this.token = token;
    this.agentTokens = new Map();
  }
  // A socket-bound credential is valid only on the agent's own socket.
  issue(agentId, { socket = false, file = null } = {}) {
    const token = newToken();
    this.agentTokens.set(token, { agentId, socket, file });
    return token;
  }
  credentialFile(agentId) {
    return join(this.credentialDir, agentId);
  }
  // Writes the credential to the agent's file; one turn per agent runs at a time.
  issueFile(agentId, options = {}) {
    mkdirSync(this.credentialDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.credentialDir).isDirectory())
      throw new Error(
        `The Mu credential directory ${this.credentialDir} is not a plain directory; inspect and remove it`,
      );
    chmodSync(this.credentialDir, 0o700);
    const file = this.credentialFile(agentId);
    try {
      unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const token = this.issue(agentId, { ...options, file });
    writeFileSync(file, `${token}\n`, { flag: 'wx', mode: 0o600 });
    return { token, file };
  }
  revoke(token) {
    const entry = this.agentTokens.get(token);
    this.agentTokens.delete(token);
    if (entry?.file) {
      try {
        unlinkSync(entry.file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  // Returns {agentId: null} for the user, {agentId, socket} for an agent, or null for an unknown credential.
  resolve(token) {
    if (typeof token !== 'string') return null;
    if (same(token, this.token)) return { agentId: null, socket: false };
    return this.agentTokens.get(token) ?? null;
  }
}

export function bearer(request) {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization || '');
  return match ? match[1] : null;
}

// A sandboxed agent reaches Mu only through its own socket: its sandbox allows connections to that
// path and to no TCP port of Mu. The socket directory is in the data directory, which the sandbox
// keeps read-only, so the agent cannot replace its socket.
export class AgentSockets {
  constructor({ dataDir, handler }) {
    this.dir = join(dataDir, 'sockets');
    this.handler = handler;
    this.servers = new Map();
  }
  path(agentId) {
    const path = join(this.dir, `${agentId}.sock`);
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)
      throw new Error(`The socket path ${path} exceeds ${MAX_SOCKET_PATH_BYTES} bytes; use a shorter MU_DATA_DIR`);
    return path;
  }
  ensure(agentId) {
    if (!this.servers.has(agentId)) {
      const listening = this.listen(agentId);
      this.servers.set(agentId, listening);
      listening.catch(() => this.servers.delete(agentId));
    }
    return this.servers.get(agentId).then(({ path }) => path);
  }
  async listen(agentId) {
    const path = this.path(agentId);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.dir).isDirectory())
      throw new Error(`The Mu socket directory ${this.dir} is not a plain directory; inspect and remove it`);
    chmodSync(this.dir, 0o700);
    let existing = null;
    try {
      existing = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing && !existing.isSocket()) throw new Error(`${path} exists and is not a socket; inspect and remove it`);
    // A socket left by an earlier service has no listener; a new one must take its place.
    if (existing) unlinkSync(path);
    const server = http.createServer((request, response) => this.handler(request, response, { agentId }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    chmodSync(path, 0o600);
    return { server, path };
  }
  async close() {
    const listening = await Promise.allSettled(this.servers.values());
    this.servers.clear();
    await Promise.all(
      listening
        .filter((result) => result.status === 'fulfilled')
        .map(
          ({ value: { server } }) =>
            new Promise((resolve) => {
              server.closeAllConnections();
              server.close(resolve);
            }),
        ),
    );
  }
}
