import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { ToolSet } from 'ai';

/**
 * Structured diagnostics for every tool call (defect (g), July 2026).
 *
 * Tool failures used to surface as a generic hiccup with nothing in the log
 * an operator could act on. Every call now records tool name, wall time, an
 * error class, and a short digest of the arguments (never the arguments
 * themselves) to the log and to the turn trace. Errors are rethrown unchanged
 * so existing tool-error semantics stay exactly as they were.
 */
export interface ToolCallDiagnostic {
  name: string;
  ts: string;
  durationMs: number;
  ok: boolean;
  errorClass?: string;
  argsDigest: string;
}

export function digestArgs(args: unknown): string {
  try {
    return createHash('sha256')
      .update(JSON.stringify(args ?? null))
      .digest('hex')
      .slice(0, 12);
  } catch {
    return 'unserializable';
  }
}

export function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (/timed? ?out|etimedout|abort/.test(m)) return 'timeout';
    if (/401|403|unauthori[sz]ed|forbidden|invalid.*key/.test(m)) return 'auth';
    if (/429|rate limit|quota/.test(m)) return 'rate_limit';
    if (/enotfound|econnrefused|econnreset|fetch failed|network/.test(m)) return 'network';
    if (/not configured|missing .*(key|token)|vault/.test(m)) return 'not_configured';
    return err.name && err.name !== 'Error' ? err.name : 'error';
  }
  return 'non_error_throw';
}

export function diagnoseToolSet(
  tools: ToolSet,
  opts: {
    logger: Logger;
    onCall?: (d: ToolCallDiagnostic) => void;
    /** Runaway brake (WS4): the same tool with the same arguments more than
     *  this many times in one turn is quarantined (default 4). */
    repeatLimit?: number;
  },
): ToolSet {
  const out: ToolSet = {};
  const repeatLimit = opts.repeatLimit ?? 4;
  const seen = new Map<string, number>();
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as { execute?: (args: unknown, o: unknown) => Promise<unknown> };
    if (typeof t.execute !== 'function') {
      out[name] = tool;
      continue;
    }
    const original = t.execute.bind(tool);
    out[name] = {
      ...tool,
      execute: async (args: unknown, o: unknown) => {
        const started = Date.now();
        const argsDigest = digestArgs(args);
        const key = `${name}:${argsDigest}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > repeatLimit) {
          const d: ToolCallDiagnostic = {
            name,
            ts: new Date(started).toISOString(),
            durationMs: 0,
            ok: false,
            errorClass: 'repeat_quarantined',
            argsDigest,
          };
          opts.onCall?.(d);
          opts.logger.warn({ msg: 'repeated identical tool call quarantined', ...d, count });
          return {
            error: `Quarantined: ${name} was called ${count} times with identical arguments this turn. Stop and answer with what you have.`,
          };
        }
        try {
          const result = await original(args, o);
          const d: ToolCallDiagnostic = {
            name,
            ts: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            ok: true,
            argsDigest,
          };
          opts.onCall?.(d);
          opts.logger.debug({ msg: 'tool ok', ...d });
          return result;
        } catch (err) {
          const d: ToolCallDiagnostic = {
            name,
            ts: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            ok: false,
            errorClass: classifyError(err),
            argsDigest,
          };
          opts.onCall?.(d);
          opts.logger.warn({
            msg: 'tool failed',
            ...d,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          throw err;
        }
      },
    } as ToolSet[string];
  }
  return out;
}
