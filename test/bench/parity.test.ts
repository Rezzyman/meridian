import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkReply,
  judgeParity,
  judgePrompt,
  parseJudge,
  percentile,
  type HarnessRun,
  type PromptCase,
} from '../../src/bench/parity.js';

const prompts = JSON.parse(
  readFileSync(join(process.cwd(), 'benchmarks/harness-parity-v1/prompts.json'), 'utf8'),
) as PromptCase[];

describe('harness parity bench helpers (WS6)', () => {
  it('ships 30 functional prompts and 20 memory cases with valid regexes', () => {
    assert.equal(prompts.length, 30);
    for (const p of prompts)
      for (const re of [...(p.mustMatch ?? []), ...(p.mustNotMatch ?? [])]) new RegExp(re, 'i');
    const memory = JSON.parse(
      readFileSync(join(process.cwd(), 'benchmarks/harness-parity-v1/memory.json'), 'utf8'),
    ) as Array<{ expect: string }>;
    assert.equal(memory.length, 20);
    for (const m of memory) new RegExp(m.expect, 'i');
  });

  it('checkReply catches the chatbot tells and honors must/must-not', () => {
    const c: PromptCase = {
      id: 'x',
      category: 't',
      prompt: 'p',
      mustMatch: ['\\b391\\b'],
      maxChars: 200,
    };
    assert.equal(checkReply(c, '391.').ok, true);
    assert.deepEqual(checkReply(c, '').failures, ['empty', 'missing /\\b391\\b/']);
    assert.ok(checkReply(c, "I'll compute that now.\n391").failures.includes('narration prefix'));
    assert.ok(checkReply(c, 'As an AI, the answer is 391.').failures.includes('assistant-speak'));
    assert.ok(checkReply(c, '# Answer\n- 391\n- done\n- yes').failures.includes('markdown wall'));
    assert.ok(
      checkReply({ ...c, mustNotMatch: ['secret'] }, '391 secret').failures.some((f) =>
        f.startsWith('forbidden'),
      ),
    );
  });

  it('percentile is deterministic', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
    assert.equal(percentile([], 95), 0);
  });

  it('judgeParity demands meet-or-beat on every axis with p95 slack', () => {
    const base = (over: Partial<HarnessRun> = {}): HarnessRun => ({
      name: 'x',
      functional: { total: 30, passed: 27, failures: {} },
      memory: { total: 20, hits: 18, misses: [] },
      reliability: { turns: 100, errors: 1, p50Ms: 900, p95Ms: 2000 },
      humanFeel: 'unmeasured',
      ...over,
    });
    assert.equal(judgeParity(base(), base()).ok, true);
    assert.equal(
      judgeParity(base({ reliability: { turns: 100, errors: 1, p50Ms: 900, p95Ms: 2300 } }), base())
        .ok,
      true,
      'within 20% slack',
    );
    const v = judgeParity(
      base({
        functional: { total: 30, passed: 20, failures: {} },
        reliability: { turns: 100, errors: 5, p50Ms: 900, p95Ms: 3000 },
      }),
      base(),
    );
    assert.equal(v.ok, false);
    assert.equal(v.reasons.length, 3);
    assert.equal(
      judgeParity(base({ humanFeel: { comparisons: 30, preferred: 15 } }), base()).ok,
      false,
      'human feel below 60%',
    );
    assert.equal(
      judgeParity(base({ humanFeel: { comparisons: 30, preferred: 20 } }), base()).ok,
      true,
    );
  });

  it('judge prompt is blind and the verdict parser is strict', () => {
    const p = judgePrompt('hey', 'A text', 'B text');
    assert.ok(!/meridian|openclaw/i.test(p));
    assert.equal(parseJudge('{"winner":"A","reason":"shorter"}'), 'A');
    assert.equal(parseJudge('sure: {"winner":"tie","reason":"same"}'), 'tie');
    assert.equal(parseJudge('{"winner":"C"}'), null);
    assert.equal(parseJudge('no json'), null);
  });
});
