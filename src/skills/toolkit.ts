/**
 * defineTool — tools with a validated OUTPUT contract.
 *
 * Inputs have always been Zod-validated (AI SDK `parameters`); this closes
 * the other half of the loop. A tool declares `output: z.ZodType` and every
 * execute result crosses that schema before reaching the model:
 *
 *   valid   → returned as-is (typed)
 *   invalid → optional re-execute (`retries`, for flaky upstream sources),
 *             then a STRUCTURED failure:
 *               { ok: false, error: 'output_validation', issues: [...] }
 *
 * Failures are data, never throws — a thrown execute aborts the model's
 * step, while a structured failure lets it read the issues and
 * self-correct within its remaining steps (house convention, same shape
 * the MCP client and delegate use).
 */

import { tool, type Tool } from 'ai';
import type { z } from 'zod';

export interface OutputValidationFailure {
  ok: false;
  error: 'output_validation';
  /** Flattened zod issues: path + message per offence. */
  issues: Array<{ path: string; message: string }>;
  /** How many execute attempts were made (1 + retries). */
  attempts: number;
}

export interface ExecutionFailure {
  ok: false;
  error: 'execution';
  message: string;
  attempts: number;
}

export interface DefineToolOptions<P extends z.ZodType, O extends z.ZodType> {
  description: string;
  /** Input schema — same contract as the AI SDK `tool()` parameters. */
  parameters: P;
  /** Output schema — every execute result is validated against this. */
  output: O;
  /** Re-execute on validation failure this many times (default 0). Only
   *  useful when the tool's upstream is nondeterministic (an API that
   *  sometimes returns partial payloads, an LLM-backed source, ...). */
  retries?: number;
  execute: (args: z.infer<P>) => Promise<unknown> | unknown;
}

function flattenIssues(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

export function defineTool<P extends z.ZodType, O extends z.ZodType>(
  opts: DefineToolOptions<P, O>,
): Tool {
  const retries = Math.max(0, opts.retries ?? 0);
  return tool({
    description: opts.description,
    parameters: opts.parameters,
    execute: async (
      args: z.infer<P>,
    ): Promise<z.infer<O> | OutputValidationFailure | ExecutionFailure> => {
      let lastIssues: Array<{ path: string; message: string }> = [];
      let lastThrow: string | undefined;
      let attempts = 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        attempts = attempt + 1;
        let raw: unknown;
        try {
          raw = await opts.execute(args);
        } catch (err) {
          // A thrown execute would abort the model's whole step (AI SDK
          // ToolExecutionError); surface it as data instead, retrying first
          // if the budget allows.
          lastThrow = (err as Error).message;
          continue;
        }
        lastThrow = undefined;
        const parsed = opts.output.safeParse(raw);
        if (parsed.success) return parsed.data;
        lastIssues = flattenIssues(parsed.error);
      }
      if (lastThrow !== undefined) {
        return { ok: false, error: 'execution', message: lastThrow, attempts };
      }
      return { ok: false, error: 'output_validation', issues: lastIssues, attempts };
    },
  });
}
