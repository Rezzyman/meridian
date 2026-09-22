import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PricingCatalog } from '../../src/providers/pricing.js';
import { SpendLedger } from '../../src/spend/ledger.js';
import { checkSpend, spendRefusal } from '../../src/spend/guard.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function ledger(now?: () => Date): { ledger: SpendLedger; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'meridian-spend-'));
  roots.push(root);
  return { ledger: new SpendLedger({ agentRoot: root }, now), root };
}

describe('pricing catalog (WS4)', () => {
  const cat = new PricingCatalog({ 'routexor/claude-haiku-4.5': { input: 1, output: 5 } });
  it('prices usage per million tokens and rounds to micro-dollars', () => {
    assert.equal(
      cat.price('routexor/claude-haiku-4.5', {
        promptTokens: 1_000_000,
        completionTokens: 200_000,
      }),
      2,
    );
    assert.equal(
      cat.price('routexor/claude-haiku-4.5', { promptTokens: 10, completionTokens: 10 }),
      0.00006,
    );
  });
  it('never guesses: unknown model or missing usage is null', () => {
    assert.equal(cat.price('routexor/mystery', { promptTokens: 10, completionTokens: 10 }), null);
    assert.equal(cat.price('routexor/claude-haiku-4.5', undefined), null);
  });
  it('treats the doubled routexor prefix as the same model', () => {
    assert.equal(cat.has('routexor/routexor/claude-haiku-4.5'), true);
  });
  it('parses the live catalog shape and skips entries without numeric pricing', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'routexor/a', pricing: { input: 2, output: 8, unit: 'per_1M_tokens' } },
            { id: 'routexor/b', pricing: { input: 'n/a' } },
            { id: 'routexor/c' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const live = await PricingCatalog.fromRoutexor({ fetchImpl });
    assert.equal(live.size, 1);
    assert.equal(live.price('routexor/a', { promptTokens: 500_000, completionTokens: 0 }), 1);
  });
});

describe('spend ledger (WS4)', () => {
  it('appends per-day files and totals today, month, and job; unpriced tokens stay visible', () => {
    const { ledger: l, root } = ledger();
    l.record({
      agentId: 'arlo',
      scope: 'turn',
      model: 'm',
      promptTokens: 100,
      completionTokens: 50,
      usd: 0.01,
    });
    l.record({
      agentId: 'arlo',
      scope: 'automation',
      jobId: 'automation:brief',
      model: 'm',
      promptTokens: 10,
      completionTokens: 5,
      usd: 0.002,
    });
    l.record({
      agentId: 'arlo',
      scope: 'turn',
      model: 'ollama/x',
      promptTokens: 7,
      completionTokens: 3,
      usd: null,
    });
    const t = l.today();
    assert.equal(t.calls, 3);
    assert.equal(t.usd, 0.012);
    assert.equal(t.tokens, 175);
    assert.equal(t.unpricedTokens, 10);
    assert.equal(l.month().usd, 0.012);
    assert.equal(l.job('automation:brief').usd, 0.002);
    const files = readdirSync(join(root, 'LEDGER'));
    assert.equal(files.length, 1);
    assert.match(files[0] ?? '', /^spend-\d{4}-\d{2}-\d{2}\.jsonl$/);
    assert.ok(existsSync(join(root, 'LEDGER', files[0] ?? '')));
  });
  it('survives a restart: a fresh ledger over the same home reads the same totals', () => {
    const { ledger: l, root } = ledger();
    l.record({
      agentId: 'arlo',
      scope: 'turn',
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
      usd: 0.5,
    });
    const again = new SpendLedger({ agentRoot: root });
    assert.equal(again.today().usd, 0.5);
  });
  it('a day boundary starts a new file and today resets', () => {
    let now = new Date('2026-09-22T23:59:00Z');
    const { ledger: l } = ledger(() => now);
    l.record({
      agentId: 'arlo',
      scope: 'turn',
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
      usd: 1,
    });
    now = new Date('2026-09-23T00:01:00Z');
    assert.equal(l.today().usd, 0);
    assert.equal(l.month().usd, 1);
  });
});

describe('spend guard (WS4)', () => {
  it('allows with no policy and below caps', () => {
    const { ledger: l } = ledger();
    assert.equal(checkSpend(l, undefined).action, 'allow');
    assert.equal(checkSpend(l, { dailyUsd: 1, onExceed: 'block' }).action, 'allow');
  });
  it('blocks at the daily cap and the refusal is plain language', () => {
    const { ledger: l } = ledger();
    l.record({
      agentId: 'arlo',
      scope: 'turn',
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
      usd: 0.01,
    });
    const v = checkSpend(l, { dailyUsd: 0.01, onExceed: 'block' });
    assert.equal(v.action, 'block');
    assert.equal(v.ok, false);
    assert.match(spendRefusal(v), /spend cap/);
    assert.match(spendRefusal(v), /config\.yaml/);
  });
  it('degrade mode proceeds with a warning verdict', () => {
    const { ledger: l } = ledger();
    l.record({
      agentId: 'arlo',
      scope: 'turn',
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
      usd: 5,
    });
    const v = checkSpend(l, { monthlyUsd: 5, onExceed: 'degrade' });
    assert.equal(v.action, 'degrade');
    assert.equal(v.ok, true);
  });
  it('per-run cap is scoped to the job', () => {
    const { ledger: l } = ledger();
    l.record({
      agentId: 'arlo',
      scope: 'automation',
      jobId: 'automation:a',
      model: 'm',
      promptTokens: 1,
      completionTokens: 1,
      usd: 0.5,
    });
    assert.equal(
      checkSpend(l, { perRunUsd: 0.5, onExceed: 'block' }, { jobId: 'automation:a' }).action,
      'block',
    );
    assert.equal(
      checkSpend(l, { perRunUsd: 0.5, onExceed: 'block' }, { jobId: 'automation:b' }).action,
      'allow',
    );
  });
});
