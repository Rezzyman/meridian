/**
 * generateStructured — schema-enforced JSON from the agent's model chain.
 *
 * The missing half of structured output: tools validate what they RETURN
 * (skills/toolkit.ts); this validates what the MODEL produces. Callers get
 * a typed object or a thrown StructuredOutputError — never almost-JSON.
 *
 * Enforcement loop, per provider in the chain:
 *   1. generateObject against the Zod schema
 *   2. on schema mismatch / non-JSON → REPAIR retry on the same provider:
 *      the validation issues are appended to the prompt so the model can
 *      fix exactly what failed (up to maxRepairAttempts)
 *   3. on provider failure → next provider in the chain (breaker-aware
 *      via router.chainFor + report hooks, same as runTurn)
 */

import { generateObject } from 'ai';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { ModelChain } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';

export interface GenerateStructuredOptions<S extends z.ZodType> {
  router: ProviderRouter;
  models: ModelChain;
  schema: S;
  prompt: string;
  system?: string;
  logger?: Logger;
  /** Repair retries per provider after a schema mismatch (default 2). */
  maxRepairAttempts?: number;
  /** Output token cap. */
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export interface StructuredResult<S extends z.ZodType> {
  object: z.infer<S>;
  /** Which provider produced the valid object. */
  model: string;
  /** Total generation attempts across repairs + fallbacks. */
  attempts: number;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

function describeFailure(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } };
  return e.cause?.message ?? e.message ?? String(err);
}

/** Heuristic: schema/parse failures are repairable on the same provider;
 *  transport/auth failures are not — move down the chain instead. */
function isRepairable(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  return (
    name === 'AI_NoObjectGeneratedError' ||
    name === 'AI_TypeValidationError' ||
    name === 'AI_JSONParseError' ||
    name === 'ZodError'
  );
}

export async function generateStructured<S extends z.ZodType>(
  opts: GenerateStructuredOptions<S>,
): Promise<StructuredResult<S>> {
  const repairs = Math.max(0, opts.maxRepairAttempts ?? 2);
  const chain = opts.router.chainFor(opts.prompt, opts.models);
  let attempts = 0;
  let lastFailure = '';

  for (const provider of chain) {
    let repairNote = '';
    for (let attempt = 0; attempt <= repairs; attempt++) {
      attempts++;
      try {
        const { object } = await generateObject({
          model: provider.model,
          schema: opts.schema,
          system: opts.system,
          prompt: repairNote ? `${opts.prompt}\n\n${repairNote}` : opts.prompt,
          maxTokens: opts.maxTokens,
          abortSignal: opts.abortSignal,
          maxRetries: 0, // our loop owns retry policy
        });
        opts.router.reportSuccess?.(provider.ref);
        return { object, model: provider.ref, attempts };
      } catch (err) {
        lastFailure = describeFailure(err);
        if (isRepairable(err) && attempt < repairs) {
          // Feed the exact failure back — the model fixes what broke,
          // instead of regenerating blind.
          repairNote =
            'Your previous response did not match the required JSON schema. ' +
            `Validation said: ${lastFailure.slice(0, 500)}. ` +
            'Respond again with ONLY a JSON object that satisfies the schema.';
          opts.logger?.warn({
            msg: 'structured output mismatch; repairing',
            provider: provider.ref,
            attempt: attempt + 1,
            err: lastFailure.slice(0, 200),
          });
          continue;
        }
        // Schema mismatch with repairs exhausted: the provider is alive,
        // just non-conforming — fall back WITHOUT tripping the breaker.
        // Transport/auth failures DO feed the breaker, same as runTurn.
        if (!isRepairable(err)) opts.router.reportFailure?.(provider.ref);
        opts.logger?.warn({
          msg: 'structured output provider failed; trying fallback',
          provider: provider.ref,
          repairable: isRepairable(err),
          err: lastFailure.slice(0, 200),
        });
        break;
      }
    }
  }

  throw new StructuredOutputError(
    `Structured output failed after ${attempts} attempt(s): ${lastFailure}`,
    attempts,
  );
}
