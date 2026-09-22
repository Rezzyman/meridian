import type { Logger } from 'pino';

/**
 * Process-level crash policy for the long-lived gateway.
 *
 * - unhandledRejection: log with the agent context and keep serving. A single
 *   rejected background turn must not take every channel down.
 * - uncaughtException: log at fatal and exit 1 so systemd restarts the process
 *   under its backoff ceiling. Continuing after a thrown exception leaves the
 *   process in an unknown state.
 *
 * Idempotent per emitter so tests and repeated boots cannot stack handlers.
 */
export interface CrashHandlerTarget {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (err: Error) => void): unknown;
  listenerCount(event: string): number;
  exit(code: number): never | void;
}

const INSTALLED = new WeakSet<object>();

export function installCrashHandlers(
  logger: Logger,
  target: CrashHandlerTarget = process,
  opts: { agentId?: string; exitOnException?: boolean } = {},
): boolean {
  if (INSTALLED.has(target)) return false;
  INSTALLED.add(target);
  const exitOnException = opts.exitOnException ?? true;
  target.on('unhandledRejection', (reason: unknown) => {
    logger.error({
      msg: 'unhandled rejection (gateway kept serving)',
      agentId: opts.agentId,
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });
  target.on('uncaughtException', (err: Error) => {
    logger.fatal({
      msg: 'uncaught exception (exiting for supervisor restart)',
      agentId: opts.agentId,
      err,
    });
    if (exitOnException) target.exit(1);
  });
  return true;
}

/**
 * Supervise a fire-and-forget promise. The HTTP handler has already answered;
 * the async turn continues in the background. A rejection is logged with its
 * route and never propagates to the process.
 */
export function settle(
  work: Promise<unknown>,
  logger: Logger,
  ctx: { route: string; channel?: string },
): void {
  work.then(
    () => undefined,
    (err: unknown) => {
      logger.error({
        msg: 'background turn failed after reply',
        route: ctx.route,
        channel: ctx.channel,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    },
  );
}
