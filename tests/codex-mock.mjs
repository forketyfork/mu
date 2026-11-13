import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { listenLocal } from './isolation.mjs';

export const codexInstalled = await promisify(execFile)('codex', ['--version']).then(
  () => true,
  () => false,
);

// A scripted Responses API: the turn's first request gets one exec_command call, a request with the
// command's output gets the final message, and every other request is the reviewer's, which allows.
export async function mockModel(t, call) {
  const seen = { reviews: 0, output: null };
  let started = false;
  const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const respond = (id, item) =>
    sse([
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      {
        type: 'response.completed',
        response: {
          id,
          usage: {
            input_tokens: 0,
            input_tokens_details: null,
            output_tokens: 0,
            output_tokens_details: null,
            total_tokens: 0,
          },
        },
      },
    ]);
  const message = (id, text) => ({ type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] });
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url.endsWith('/responses')) return response.writeHead(404).end();
      const input = JSON.parse(body).input;
      const output = input.find((item) => item.type === 'function_call_output');
      let item;
      if (output) {
        seen.output = typeof output.output === 'string' ? output.output : JSON.stringify(output.output);
        item = message('done', 'done');
      } else if (!started) {
        started = true;
        item = {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ yield_time_ms: 30000, ...call }),
        };
      } else {
        seen.reviews++;
        item = message('review', '{"outcome":"allow"}');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(respond(`response-${Date.now()}`, item));
    });
  });
  const port = await listenLocal(server);
  t.after(() => server.close());
  return { seen, port };
}

// Codex arguments that point a turn at the mock model. Plugins stay off: with them, a fresh CODEX_HOME starts a
// clone of OpenAI's plugin repository that outlives the turn and keeps writing into the directory the test removes.
export const mockProvider = (port) => [
  '-c',
  'model_provider="mock"',
  '-c',
  `model_providers.mock={name="mock", base_url="http://127.0.0.1:${port}/v1", wire_api="responses"}`,
  '-c',
  'features.plugins=false',
];
