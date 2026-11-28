// A stand-in for an agent CLI in runner tests. The argument is the path of a JSON file that names what to write; a file
// rather than the JSON itself, because Linux refuses an argument of 128 KiB or more and some specs are larger:
// - `before`, `filler: {event, count}`, `after`: JSON events, one per line, with `filler.event` repeated `count` times between the others;
// - `chunks`: raw writes after those events, each a hex string of bytes, 50 ms apart so that each arrives as its own read;
// - `unterminated`: then writes without a newline until the process is killed;
// - `ignoreTerm`: ignores SIGTERM; `stderr`: text for stderr; `exitCode`: the exit status.
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (spec.ignoreTerm) process.on('SIGTERM', () => {});
for await (const _chunk of process.stdin);
const write = (data) =>
  new Promise((resolve, reject) => process.stdout.write(data, (error) => (error ? reject(error) : resolve())));
for (const event of spec.before || []) await write(JSON.stringify(event) + '\n');
if (spec.filler) {
  const line = JSON.stringify(spec.filler.event) + '\n';
  for (let index = 0; index < spec.filler.count; index++) await write(line);
}
for (const event of spec.after || []) await write(JSON.stringify(event) + '\n');
for (const chunk of spec.chunks || []) {
  await write(Buffer.from(chunk, 'hex'));
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (spec.stderr)
  await new Promise((resolve, reject) =>
    process.stderr.write(spec.stderr, (error) => (error ? reject(error) : resolve())),
  );
if (spec.unterminated) {
  const chunk = 'x'.repeat(1024 * 1024);
  await write('{"type":"user","content":"');
  for (;;) await write(chunk);
}
process.exitCode = spec.exitCode ?? 0;
