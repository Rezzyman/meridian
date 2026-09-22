import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tool, type LanguageModelV1StreamPart } from 'ai';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { estimateTokens, measurePromptBudget } from '../../src/agent/prompt-budget.js';
import { runTurn, type TurnContext } from '../../src/agent/turn.js';
import { makeConfig, mockCortex, mockRouter, silentLogger } from '../helpers/fixtures.js';

describe('prompt budget measurement', () => {
  it('counts identity+context and tool schemas separately and ranks tools', () => {
    const tools = {
      big: tool({
        description: 'x'.repeat(2000),
        parameters: z.object({ a: z.string() }),
        execute: async () => 'ok',
      }),
      small: tool({ description: 'tiny', parameters: z.object({}), execute: async () => 'ok' }),
    };
    const r = measurePromptBudget('You are Arlo. '.repeat(100), tools);
    assert.ok(r.systemBaseTokens > 100);
    assert.equal(r.toolCount, 2);
    assert.equal(r.largestTools[0]?.name, 'big');
    assert.equal(r.totalStaticTokens, r.systemBaseTokens + r.toolSchemaTokens);
    assert.equal(estimateTokens(''), 0);
  });
});

describe('per-turn prompt-token ceiling (found on the bench: 241k-token turns)', () => {
  it('cuts a tool loop once cumulative prompt tokens pass the ceiling and keeps what it has', async () => {
    let step = 0;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        // A real provider refuses a call whose signal is already aborted.
        if (options.abortSignal?.aborted) throw new Error('aborted');
        step += 1;
        const chunks: LanguageModelV1StreamPart[] =
          step < 6
            ? [
                {
                  type: 'tool-call',
                  toolCallType: 'function',
                  toolCallId: `c${step}`,
                  toolName: 'probe',
                  args: JSON.stringify({ q: String(step) }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { promptTokens: 60_000, completionTokens: 5 },
                },
              ]
            : [
                { type: 'text-delta', textDelta: 'final answer' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { promptTokens: 60_000, completionTokens: 5 },
                },
              ];
        return {
          stream: simulateReadableStream({ chunks }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const config = makeConfig({
      spend: { maxPromptTokensPerTurn: 150_000, onExceed: 'block' },
      tools: { cli: ['probe'] },
    });
    const ctx: TurnContext = {
      sessionId: 's',
      config,
      cortex: mockCortex(),
      router: mockRouter(model),
      logger: silentLogger,
      history: [],
      channel: 'cli',
      systemBase: 'persona',
      tools: {
        probe: tool({
          description: 'probe',
          parameters: z.object({ q: z.string() }),
          execute: async ({ q }) => ({ q }),
        }),
      },
    };
    const r = await runTurn(ctx, 'loop please');
    assert.ok(step <= 4, `expected the loop to be cut early, ran ${step} steps`);
    assert.match(r.reply, /budget|stopped this one early/i);
    assert.ok((r.trace.usage?.promptTokens ?? 0) >= 120_000);
  });
});

describe('multi-step text: only the final step is the answer (bench finding)', () => {
  it('drops pre-tool planning text and keeps the final step text', async () => {
    let step = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        step += 1;
        const chunks: LanguageModelV1StreamPart[] =
          step === 1
            ? [
                { type: 'text-delta', textDelta: 'Let me get the real-time context first.' },
                {
                  type: 'tool-call',
                  toolCallType: 'function',
                  toolCallId: 'c1',
                  toolName: 'clock',
                  args: '{}',
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { promptTokens: 100, completionTokens: 10 },
                },
              ]
            : [
                { type: 'text-delta', textDelta: "Yeah, I'm here. What's up?" },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { promptTokens: 100, completionTokens: 10 },
                },
              ];
        return {
          stream: simulateReadableStream({ chunks }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const ctx: TurnContext = {
      sessionId: 's',
      config: makeConfig({ tools: { cli: ['clock'] } }),
      cortex: mockCortex(),
      router: mockRouter(model),
      logger: silentLogger,
      history: [],
      channel: 'cli',
      systemBase: 'persona',
      tools: {
        clock: tool({
          description: 'clock',
          parameters: z.object({}),
          execute: async () => ({ now: 'Monday' }),
        }),
      },
    };
    const r = await runTurn(ctx, 'hey');
    assert.equal(r.reply, "Yeah, I'm here. What's up?");
    assert.equal(r.trace.toolCalls.length, 1);
  });
});
