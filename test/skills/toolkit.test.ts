/**
 * defineTool — output-schema-validated tools. Valid results pass typed;
 * mismatches (and throws) come back as structured data so the model can
 * self-correct mid-turn; retries re-execute flaky sources.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Tool } from 'ai';
import { z } from 'zod';
import { defineTool } from '../../src/skills/toolkit.js';

const TOOL_OPTS = { toolCallId: 'c1', messages: [] };

const WeatherOut = z.object({
  city: z.string(),
  tempC: z.number(),
});

function make(execute: () => unknown, retries = 0): Required<Tool> {
  return defineTool({
    description: 'weather probe',
    parameters: z.object({ city: z.string() }),
    output: WeatherOut,
    retries,
    execute,
  }) as Required<Tool>;
}

describe('defineTool output validation', () => {
  it('valid output passes through typed and untouched', async () => {
    const t = make(() => ({ city: 'Austin', tempC: 31 }));
    const res = await t.execute({ city: 'Austin' }, TOOL_OPTS);
    assert.deepEqual(res, { city: 'Austin', tempC: 31 });
  });

  it('schema strips/normalizes per zod semantics (extra keys dropped)', async () => {
    const t = make(() => ({ city: 'Austin', tempC: 31, junk: 'extra' }));
    const res = await t.execute({ city: 'Austin' }, TOOL_OPTS);
    assert.deepEqual(res, { city: 'Austin', tempC: 31 });
  });

  it('mismatch returns structured output_validation failure with zod issues', async () => {
    const t = make(() => ({ city: 'Austin', tempC: 'hot' }));
    const res = (await t.execute({ city: 'Austin' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'output_validation');
    assert.equal(res.attempts, 1);
    const issues = res.issues as Array<{ path: string; message: string }>;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'tempC');
    assert.match(issues[0].message, /number/i);
  });

  it('retries re-execute a flaky source until the output conforms', async () => {
    let calls = 0;
    const t = make(() => {
      calls++;
      return calls < 3 ? { partial: true } : { city: 'Austin', tempC: 30 };
    }, 3);
    const res = await t.execute({ city: 'Austin' }, TOOL_OPTS);
    assert.deepEqual(res, { city: 'Austin', tempC: 30 });
    assert.equal(calls, 3);
  });

  it('retries exhausted → failure reports total attempts', async () => {
    let calls = 0;
    const t = make(() => {
      calls++;
      return { nope: true };
    }, 2);
    const res = (await t.execute({ city: 'x' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 3);
    assert.equal(calls, 3);
  });

  it('a throwing execute becomes structured execution failure, never a throw', async () => {
    const t = make(() => {
      throw new Error('upstream 503');
    });
    const res = (await t.execute({ city: 'x' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'execution');
    assert.match(String(res.message), /upstream 503/);
  });

  it('throw-then-succeed with retries recovers', async () => {
    let calls = 0;
    const t = make(() => {
      calls++;
      if (calls === 1) throw new Error('flaky');
      return { city: 'Austin', tempC: 28 };
    }, 1);
    const res = await t.execute({ city: 'Austin' }, TOOL_OPTS);
    assert.deepEqual(res, { city: 'Austin', tempC: 28 });
  });
});
