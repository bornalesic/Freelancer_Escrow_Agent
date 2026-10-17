import { log } from './log';
import { errorMessage } from './util';

/** Run `onTick` every `intervalMs`, never overlapping. Returns a stop function. */
export function startTicker(intervalMs: number, onTick: () => Promise<void>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    onTick()
      .catch((err) => log.error(`ticker: ${errorMessage(err)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
