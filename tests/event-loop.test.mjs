import test from 'node:test';
import assert from 'node:assert/strict';
import { startEventLoopMonitor } from '../src/event-loop-monitor.mjs';

test('event loop monitor warns once during a stall and rearms after the loop recovers', async (t) => {
  let blocked = false;
  const histogram = {
    max: 0,
    enable() {
      return true;
    },
    disable() {
      return true;
    },
    reset() {
      if (!blocked) this.max = 0;
    },
  };
  const warnings = [];
  const stop = startEventLoopMonitor({
    histogram,
    intervalMs: 5,
    warn: (durationMs) => warnings.push(durationMs),
  });
  t.after(stop);

  histogram.max = 999_999_999;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(warnings, []);

  blocked = true;
  histogram.max = 1_100_000_000;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(warnings, [1100]);

  blocked = false;
  histogram.max = 0;
  await new Promise((resolve) => setTimeout(resolve, 15));
  blocked = true;
  histogram.max = 1_250_000_000;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(warnings, [1100, 1250]);
});
