/**
 * WS4 end to end at the turn loop: a capped agent refuses BEFORE any provider
 * call, and an uncapped turn lands a priced record in the ledger.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import type { LanguageModelV1StreamPart } from 'ai';
import { runTurn, type TurnContext } from '../../src/agent/turn.js';
import { SpendLedger } from '../../src/spend/ledger.js';
import { PricingCatalog } from '../../src/providers/pricing.js';
import { makeConfig, mockCortex, mockRouter, silentLogger } from '../helpers/fixtures.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function countingModel(text: string): { model: MockLanguageModelV1; calls: number } {
  const state = { calls: 0 };
  const model = new MockLanguageModelV1({
    doStream: async () => {
      state.calls += 1;
      return {
        stream: simulateReadableStream<LanguageModelV1StreamPart>({
          chunks: [
            { type: 'text-delta', textDelta: text },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 1000, completionTokens: 500 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return {
    model,
    get calls() {
      return state.calls;
    },
  };
}

function ctx(overrides: Partial<TurnContext>): TurnContext {
  return {
    sessionId: 's',
    config: makeConfig(),
    cortex: mockCortex(),
    router: mockRouter(),
    logger: silentLogger,
    history: [],
    channel: 'cli',
    systemBase: 'persona',
    ...overrides,
  };
}

describe('turn loop spend accounting (WS4)', () => {
  it('records a priced entry after a normal turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meridian-turnspend-'));
    roots.push(root);
    const ledger = new SpendLedger({ agentRoot: root });
    const pricing = new PricingCatalog({ 'anthropic/mock-0': { input: 1, output: 5 } });
    const m = countingModel('hello');
    const r = await runTurn(ctx({ router: mockRouter(m.model), spend: { ledger, pricing } }), 'hi');
    assert.equal(r.reply, 'hello');
    assert.deepEqual(r.trace.usage, { promptTokens: 1000, completionTokens: 500 });
    assert.equal(r.trace.usd, 0.0035);
    assert.equal(ledger.today().usd, 0.0035);
    assert.equal(ledger.today().calls, 1);
  });

  it('refuses at the daily cap without touching a provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meridian-turnspend-'));
    roots.push(root);
    const ledger = new SpendLedger({ agentRoot: root });
    ledger.record({
      agentId: 'test-agent',
      scope: 'turn',
      model: 'x',
      promptTokens: 1,
      completionTokens: 1,
      usd: 0.01,
    });
    const m = countingModel('should not run');
    const config = makeConfig({ spend: { dailyUsd: 0.01, onExceed: 'block' } });
    const r = await runTurn(ctx({ config, router: mockRouter(m.model), spend: { ledger } }), 'hi');
    assert.equal(m.calls, 0);
    assert.match(r.reply, /spend cap/);
    assert.equal(ledger.today().calls, 1, 'nothing new recorded');
  });

  it('unpriced models still record tokens with usd null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meridian-turnspend-'));
    roots.push(root);
    const ledger = new SpendLedger({ agentRoot: root });
    const m = countingModel('ok');
    await runTurn(ctx({ router: mockRouter(m.model), spend: { ledger } }), 'hi');
    const t = ledger.today();
    assert.equal(t.usd, 0);
    assert.equal(t.unpricedTokens, 1500);
  });
});
