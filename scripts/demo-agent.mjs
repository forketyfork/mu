import { main } from '../src/cli.mjs';

if (!process.env.MU_AGENT_ID || !process.env.MU_MESSAGE_ID || !process.env.MU_ROLE) {
  throw new Error('The demo adapter must be launched by Mu with an agent identity and message.');
}

// Drain the same prompt pipe a real command adapter receives.
for await (const _chunk of process.stdin) {
  /* Input is intentionally not interpreted as instructions. */
}

await main(['status', '--status', 'done']);
process.stdout.write(
  `Demo process ${process.env.MU_AGENT_ID} received message ${process.env.MU_MESSAGE_ID}. Chat delivery and process execution verified; no AI task work was performed.\n`,
);
