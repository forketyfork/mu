import { monitorEventLoopDelay } from 'node:perf_hooks';

/** @typedef {Pick<ReturnType<typeof monitorEventLoopDelay>, 'max' | 'enable' | 'disable' | 'reset'>} EventLoopHistogram */

const BLOCKED_THRESHOLD_NS = 1_000_000_000;

/**
 * @param {{ histogram?: EventLoopHistogram, intervalMs?: number, warn?: (durationMs: number) => void }} [options]
 */
export function startEventLoopMonitor({
  histogram = monitorEventLoopDelay({ resolution: 20 }),
  intervalMs = 1000,
  warn = (durationMs) => console.error(`${new Date().toISOString()} WARNING: event loop blocked for ${durationMs} ms`),
} = {}) {
  histogram.enable();
  let blocked = false;
  const timer = setInterval(() => {
    const durationNs = histogram.max;
    histogram.reset();
    if (durationNs > BLOCKED_THRESHOLD_NS) {
      if (!blocked) warn(Math.round(durationNs / 1_000_000));
      blocked = true;
    } else {
      blocked = false;
    }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
