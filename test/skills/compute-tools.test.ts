/**
 * calculate (a real tokenizer + shunting-yard, never eval) and json_query
 * (dot/bracket path extraction). Precedence, associativity, unary minus,
 * functions/constants, and the structured error paths all pinned down.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Tool } from 'ai';
import {
  computeTools,
  evaluateExpression,
  queryPath,
} from '../../src/skills/builtin/compute-tools.js';

const TOOL_OPTS = { toolCallId: 'c1', messages: [] };
const calc = computeTools.calculate as Required<Tool>;
const jq = computeTools.json_query as Required<Tool>;

describe('evaluateExpression', () => {
  const cases: Array<[string, number]> = [
    ['2+2', 4],
    ['2+3*4', 14], // precedence
    ['(2+3)*4', 20],
    ['2*3+4', 10],
    ['10/4', 2.5],
    ['10%3', 1],
    ['2^3^2', 512], // right-associative
    ['-5+3', -2], // leading unary minus
    ['2 * -3', -6], // unary after operator
    ['(1+2)*(3+4)', 21],
    ['sqrt(16)', 4],
    ['abs(0-7)', 7],
    ['round(2.6)', 3],
    ['2^10', 1024],
    ['1.5e2', 150],
  ];
  for (const [expr, want] of cases) {
    it(`${expr} = ${want}`, () => {
      assert.equal(evaluateExpression(expr), want);
    });
  }

  it('pi is the constant', () => {
    assert.ok(Math.abs(evaluateExpression('pi') - Math.PI) < 1e-9);
  });

  const bad = ['2+', '2 + * 3', 'foo(2)', '(2+3', '2)', '@'];
  for (const expr of bad) {
    it(`rejects "${expr}"`, () => {
      assert.throws(() => evaluateExpression(expr));
    });
  }
});

describe('calculate tool', () => {
  it('returns a numeric result', async () => {
    const r = (await calc.execute({ expression: '3 * (4 + 5)' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.deepEqual(r, { ok: true, result: 27 });
  });

  it('reports a malformed expression as data', async () => {
    const r = (await calc.execute({ expression: '2 +' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  });

  it('flags a non-finite result (division by zero)', async () => {
    const r = (await calc.execute({ expression: '1/0' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(r.ok, false);
    assert.match(r.error as string, /finite|zero/);
  });
});

describe('queryPath', () => {
  const data = { a: { b: [10, 20], c: 'x' }, n: null };
  it('walks dot + bracket segments', () => {
    assert.deepEqual(queryPath(data, 'a.b[1]'), { found: true, value: 20 });
    assert.deepEqual(queryPath(data, 'a.c'), { found: true, value: 'x' });
    assert.deepEqual(queryPath(data, 'a.b'), { found: true, value: [10, 20] });
  });
  it('reports not-found for missing keys / out-of-range', () => {
    assert.equal(queryPath(data, 'a.z').found, false);
    assert.equal(queryPath(data, 'a.b[9]').found, false);
    assert.equal(queryPath(data, 'a.b.c.d').found, false);
  });
  it('finds an explicit null', () => {
    assert.deepEqual(queryPath(data, 'n'), { found: true, value: null });
  });
});

describe('json_query tool', () => {
  it('extracts a value and its type', async () => {
    const r = (await jq.execute(
      { json: '{"items":[{"name":"a"},{"name":"b"}]}', path: 'items[1].name' },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.deepEqual(r, { ok: true, value: 'b', type: 'string' });
  });

  it('labels arrays and null distinctly', async () => {
    const arr = (await jq.execute({ json: '{"x":[1,2]}', path: 'x' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(arr.type, 'array');
    const nul = (await jq.execute({ json: '{"x":null}', path: 'x' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.deepEqual(nul, { ok: true, value: null, type: 'null' });
  });

  it('errors on invalid JSON and on a missing path', async () => {
    const badJson = (await jq.execute({ json: 'not json', path: 'a' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(badJson.ok, false);
    assert.match(badJson.error as string, /invalid JSON/);
    const missing = (await jq.execute({ json: '{"a":1}', path: 'b' }, TOOL_OPTS)) as Record<string, unknown>;
    assert.equal(missing.ok, false);
    assert.match(missing.error as string, /not found/);
  });
});
