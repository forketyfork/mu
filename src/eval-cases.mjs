import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value) => Array.isArray(value) && value.every(text);
const protocol = 'mu-json-v1';

function validOptions(options) {
  if (
    !object(options) ||
    !Object.entries(options).every(
      ([name, option]) =>
        idPattern.test(name) &&
        object(option) &&
        ['string', 'boolean'].includes(option.type) &&
        Object.keys(option).every((key) => ['type', 'short', 'default', 'multiple'].includes(key)),
    )
  )
    return false;
  try {
    parseArgs({ args: [], options, strict: true });
    return true;
  } catch {
    return false;
  }
}

function matchesInvocation(options, argv, expected) {
  try {
    return isDeepStrictEqual({ ...parseArgs({ args: argv, options, strict: true }).values }, expected);
  } catch {
    return false;
  }
}

export function validateCase(value) {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !idPattern.test(value.id) ||
    !text(value.title) ||
    !text(value.skill) ||
    !text(value.prompt)
  )
    throw new Error('A case needs a lowercase id, title, skill and prompt');
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 50)
    throw new Error('A case needs 1–50 checks');
  if (
    !value.checks.every(
      (check) =>
        object(check) &&
        text(check.label) &&
        text(check.field) &&
        ((check.type === 'equals' && Object.hasOwn(check, 'value')) ||
          (check.type === 'cli' && strings(check.argv) && object(check.values)) ||
          (check.type === 'cli-regression' &&
            validOptions(check.reference) &&
            typeof check.lastOnly === 'string' &&
            Object.hasOwn(check.reference, check.lastOnly) &&
            check.reference[check.lastOnly].multiple === true) ||
          (check.type === 'brief' &&
            Number.isInteger(check.maxWords) &&
            check.maxWords > 0 &&
            strings(check.require) &&
            check.require.length &&
            strings(check.forbid))),
    )
  )
    throw new Error('Invalid equals, cli, cli-regression or brief check');
  const weight = value.weight === undefined ? 1 : value.weight;
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100)
    throw new Error('A case weight must be greater than 0 and at most 100');
  const digest = createHash('sha256')
    .update(JSON.stringify([protocol, value]))
    .digest('hex');
  return { ...value, weight, digest };
}

async function directoryCases(directory, optional) {
  let entries;
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error(`${directory} must be a real directory`);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT') return [];
    throw error;
  }
  const cases = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      if (!entry.isFile()) throw new Error('Expected a regular file, not a link or directory');
      const file = await open(
        join(directory, entry.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Expected a file no larger than 128 KiB');
        cases.push(validateCase(JSON.parse(await file.readFile('utf8'))));
      } finally {
        await file.close();
      }
    } catch (error) {
      throw new Error(`${entry.name}: ${error.message}`, { cause: error });
    }
  }
  return cases;
}

export async function loadCases(samples, personal) {
  const cases = [...(await directoryCases(samples, false)), ...(await directoryCases(personal, true))];
  const ids = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate eval case: ${item.id}`);
    ids.add(item.id);
  }
  return cases;
}

export const caseInfo = ({ id, title, skill, digest, weight }) => ({ id, title, skill, digest, weight });
export const casePrompt = ({ prompt }) =>
  `${prompt}\n\nReturn one JSON object, without a Markdown fence or commentary.`;

// A whole word or phrase, ignoring case and the amount of space between its words: "port" is not in "support".
function mentions(field, phrase) {
  const words = phrase
    .trim()
    .split(/\s+/)
    .map((word) => RegExp.escape(word));
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(field);
}

function checkField(check, answer) {
  if (!object(answer) || !Object.hasOwn(answer, check.field)) return false;
  const field = answer[check.field];
  if (check.type === 'equals') return isDeepStrictEqual(field, check.value);
  if (check.type === 'brief') {
    if (!text(field) || field.trim().split(/\s+/).length > check.maxWords) return false;
    return (
      check.require.every((phrase) => mentions(field, phrase)) &&
      !check.forbid.some((phrase) => mentions(field, phrase))
    );
  }
  if (check.type === 'cli-regression') {
    if (
      !object(field) ||
      !strings(field.argv) ||
      !object(field.values) ||
      !matchesInvocation(check.reference, field.argv, field.values)
    )
      return false;
    const repeat = field.values[check.lastOnly];
    return Array.isArray(repeat) && !isDeepStrictEqual(repeat, repeat.slice(-1));
  }
  return validOptions(field) && matchesInvocation(field, check.argv, check.values);
}

export function grade(item, reply) {
  let answer;
  try {
    answer = JSON.parse(reply);
  } catch {
    return {
      earned: 0,
      possible: item.checks.length,
      checks: item.checks.map(({ label }) => ({ label, passed: false })),
      note: 'Reply is not JSON',
    };
  }
  const checks = item.checks.map((check) => ({ label: check.label, passed: checkField(check, answer) }));
  return { earned: checks.filter(({ passed }) => passed).length, possible: checks.length, checks };
}
