/**
 * generateStructured — schema-enforced JSON from the model chain with
 * repair-retries on mismatch and breaker-aware provider fallback.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LanguageModelV1 } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { z } from 'zod';
import { generateStructured, StructuredOutputError } from '../../src/agent/structured.js';
import { makeConfig, mockRouter, silentLogger } from '../helpers/fixtures.js';

const Person = z.object({ name: z.string(), age: z.number() });

/** Mock that answers each doGenerate call with the scripted payload (or throws). */
function jsonModel(script: Array<string | Error>): {
  model: LanguageModelV1;
  prompts: string[];
} {
  let call = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: 'json',
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const step = script[Math.min(call, script.length - 1)];
      call++;
      if (step instanceof Error) throw step;
      return {
        text: step,
        finishReason: 'stop' as const,
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  }) as unknown as LanguageModelV1;
  return { model, prompts };
}

function spyRouter(...models: LanguageModelV1[]) {
  const router = mockRouter(...models);
  const failures: string[] = [];
  const successes: string[] = [];
  (router as unknown as Record<string, unknown>).reportFailure = (ref: string) =>
    failures.push(ref);
  (router as unknown as Record<string, unknown>).reportSuccess = (ref: string) =>
    successes.push(ref);
  return { router, failures, successes };
}

const MODELS = makeConfig().models;

describe('generateStructured', () => {
  it('returns a typed object on first valid generation', async () => {
    const { model } = jsonModel(['{"name":"Rez","age":34}']);
    const { router, successes } = spyRouter(model);
    const res = await generateStructured({
      router,
      models: MODELS,
      schema: Person,
      prompt: 'who is the founder',
    });
    assert.deepEqual(res.object, { name: 'Rez', age: 34 });
    assert.equal(res.attempts, 1);
    assert.equal(res.model, 'anthropic/mock-0');
    assert.deepEqual(successes, ['anthropic/mock-0']);
  });

  it('repairs on schema mismatch: feeds validation issues back, succeeds on retry', async () => {
    const { model, prompts } = jsonModel([
      '{"name":"Rez","age":"thirty-four"}', // wrong type
      '{"name":"Rez","age":34}',
    ]);
    const { router, failures } = spyRouter(model);
    const res = await generateStructured({
      router,
      models: MODELS,
      schema: Person,
      prompt: 'who is the founder',
      logger: silentLogger,
    });
    assert.deepEqual(res.object, { name: 'Rez', age: 34 });
    assert.equal(res.attempts, 2);
    assert.match(prompts[1], /did not match the required JSON schema/);
    assert.deepEqual(failures, [], 'alive-but-nonconforming never trips the breaker');
  });

  it('non-JSON output is repairable too', async () => {
    const { model } = jsonModel(['I think the answer is Rez, 34.', '{"name":"Rez","age":34}']);
    const { router } = spyRouter(model);
    const res = await generateStructured({
      router,
      models: MODELS,
      schema: Person,
      prompt: 'who',
      logger: silentLogger,
    });
    assert.equal(res.attempts, 2);
  });

  it('persistent mismatch exhausts repairs then falls back down the chain', async () => {
    const bad = jsonModel(['{"wrong":true}']);
    const good = jsonModel(['{"name":"Rez","age":34}']);
    const { router, failures } = spyRouter(bad.model, good.model);
    const res = await generateStructured({
      router,
      models: MODELS,
      schema: Person,
      prompt: 'who',
      maxRepairAttempts: 1,
      logger: silentLogger,
    });
    assert.equal(res.model, 'anthropic/mock-1');
    assert.equal(res.attempts, 3); // 2 on bad (1+1 repair) + 1 on good
    assert.deepEqual(failures, [], 'schema mismatch alone never feeds the breaker');
  });

  it('transport failure feeds the breaker and falls back', async () => {
    const dead = jsonModel([new Error('ECONNREFUSED')]);
    const good = jsonModel(['{"name":"Rez","age":34}']);
    const { router, failures, successes } = spyRouter(dead.model, good.model);
    const res = await generateStructured({
      router,
      models: MODELS,
      schema: Person,
      prompt: 'who',
      logger: silentLogger,
    });
    assert.equal(res.model, 'anthropic/mock-1');
    assert.deepEqual(failures, ['anthropic/mock-0']);
    assert.deepEqual(successes, ['anthropic/mock-1']);
  });

  it('all providers exhausted → StructuredOutputError with attempt count', async () => {
    const bad = jsonModel(['{"wrong":1}']);
    const { router } = spyRouter(bad.model);
    await assert.rejects(
      () =>
        generateStructured({
          router,
          models: MODELS,
          schema: Person,
          prompt: 'who',
          maxRepairAttempts: 2,
          logger: silentLogger,
        }),
      (err: unknown) => {
        assert.ok(err instanceof StructuredOutputError);
        assert.equal(err.attempts, 3);
        return true;
      },
    );
  });
});
