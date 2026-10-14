export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | unknown;
}

/**
 * Run shutdown steps in order, then exit. A step that throws is logged and the
 * rest still run; a hard timer exits regardless so a hung step (a stuck
 * worker, an unreachable database) can't leave a SIGTERM-overridden process
 * running until the orchestrator SIGKILLs it.
 */
export function createShutdown(
  steps: ShutdownStep[],
  opts: { timeoutMs?: number; exit?: (code: number) => void; log?: (msg: string, err?: unknown) => void } = {}
): () => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((msg: string, err?: unknown) => console.error(msg, err ?? ''));
  const timeoutMs = opts.timeoutMs ?? 8000;
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => {
      log(`Shutdown did not finish in ${timeoutMs}ms; forcing exit`);
      exit(1);
    }, timeoutMs);
    timer.unref?.();
    let failed = false;
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        failed = true;
        log(`Shutdown step "${step.name}" failed:`, err);
      }
    }
    clearTimeout(timer);
    exit(failed ? 1 : 0);
  };
}
