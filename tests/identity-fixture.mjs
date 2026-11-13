import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Identity } from '../src/identity.mjs';
import { ROOT } from '../src/server.mjs';

// An identity service with its own data directory, for runners built without createApp.
export function testIdentity(t) {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const dataDir = mkdtempSync(join(ROOT, '.tmp/identity-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return new Identity({ dataDir });
}

// Headers of a request made with the user credential of an app created by createApp.
/** @returns {Record<string, string>} */
export const userHeaders = (app) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${app.identity.token}`,
});
