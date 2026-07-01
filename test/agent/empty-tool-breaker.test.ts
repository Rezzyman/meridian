/**
 * withEmptyResultBreaker enforces the "don't hammer an empty tool and fabricate
 * results" rule at the tool boundary: a tool that returns empty `threshold`
 * times in a turn is short-circuited on the next call, returning a terminal
 * notice instead of executing. This is real enforcement (the old code only
 * logged), and it is verifiable without a live model.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolSet } from 'ai';
import { isEmptyToolResult, withEmptyResultBreaker } from '../../src/agent/turn.js';

const OPTS = { toolCallId: 'c', messages: [] };

function toolReturning(sequence: unknown[]): { tool: ToolSet; calls: () => number } {
  let i = 0;
  const set = {
    probe: {
      description: 'test',
      parameters: {},
      execute: async () => sequence[Math.min(i++, sequence.length - 1)],
    },
  } as unknown as ToolSet;
  return { tool: set, calls: () => i };
}

async function run(tool: ToolSet, name: string, times: number): Promise<unknown[]> {
  const exec = (tool[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute;
  const out: unknown[] = [];
  for (let n = 0; n < times; n++) out.push(await exec({}, OPTS));
  return out;
}

describe('isEmptyToolResult', () => {
  it('treats null/empty-string/[]/{} as empty', () => {
    for (const v of [null, undefined, '', '   ', [], {}]) {
      assert.equal(isEmptyToolResult(v), true, `${JSON.stringify(v)} is empty`);
    }
  });
  it('treats real values (incl. 0 and false) as non-empty', () => {
    for (const v of ['x', [1], { a: 1 }, 0, false]) {
      assert.equal(isEmptyToolResult(v), false, `${JSON.stringify(v)} is not empty`);
    }
  });
});

describe('withEmptyResultBreaker', () => {
  it('short-circuits a tool after it returns empty twice; underlying tool stops being called', async () => {
    const { tool, calls } = toolReturning([[], [], [], []]);
    const tripped: string[] = [];
    const wrapped = withEmptyResultBreaker(tool, { threshold: 2, onTrip: (n) => tripped.push(n) });

    const results = await run(wrapped, 'probe', 4);

    // First two execute (empty), then the breaker takes over.
    assert.deepEqual(results[0], []);
    assert.deepEqual(results[1], []);
    assert.equal((results[2] as { error?: string }).error, 'no_results');
    assert.equal((results[3] as { error?: string }).error, 'no_results');
    assert.equal(calls(), 2, 'underlying tool executed only twice, then was gated');
    assert.deepEqual(tripped, ['probe', 'probe'], 'onTrip fired for each empty');
  });

  it('never short-circuits a tool that returns data', async () => {
    const { tool, calls } = toolReturning([{ hit: 1 }]);
    const wrapped = withEmptyResultBreaker(tool, { threshold: 2 });
    const results = await run(wrapped, 'probe', 5);
    assert.ok(results.every((r) => (r as { hit?: number }).hit === 1));
    assert.equal(calls(), 5, 'a productive tool keeps executing');
  });

  it('recovers within the threshold: one empty then data does not trip', async () => {
    const { tool } = toolReturning([[], { hit: 1 }, { hit: 2 }]);
    const wrapped = withEmptyResultBreaker(tool, { threshold: 2 });
    const results = await run(wrapped, 'probe', 3);
    assert.deepEqual(results[0], []);
    assert.deepEqual(results[1], { hit: 1 });
    assert.deepEqual(results[2], { hit: 2 }, 'a single empty never triggers the breaker');
  });

  it('passes through tools that have no execute (markdown-only)', () => {
    const set = { note: { description: 'md' } } as unknown as ToolSet;
    const wrapped = withEmptyResultBreaker(set);
    assert.equal((wrapped.note as { execute?: unknown }).execute, undefined);
  });

  it('counts per tool — one dead tool does not gate a healthy sibling', async () => {
    const set = {
      dead: { description: 'd', parameters: {}, execute: async () => [] },
      live: { description: 'l', parameters: {}, execute: async () => ({ ok: 1 }) },
    } as unknown as ToolSet;
    const wrapped = withEmptyResultBreaker(set, { threshold: 2 });
    await run(wrapped, 'dead', 3); // trip the dead one
    const liveResults = await run(wrapped, 'live', 3);
    assert.ok(liveResults.every((r) => (r as { ok?: number }).ok === 1), 'healthy tool unaffected');
  });
});
