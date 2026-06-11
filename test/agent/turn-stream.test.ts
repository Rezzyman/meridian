/**
 * runTurn × onStreamEvent — the SSE seam. Deltas arrive raw and live;
 * reset fires when a provider dies after partial output; tool events fire
 * per tool call; the returned reply stays canonical (post-footer), which
 * is why stream consumers must replace their buffer on done.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tool, type LanguageModelV1StreamPart, type ToolSet } from 'ai';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { runTurn, type TurnContext, type TurnStreamEvent } from '../../src/agent/turn.js';
import {
  failingModel,
  makeConfig,
  mockCortex,
  mockRouter,
  silentLogger,
  textModel,
} from '../helpers/fixtures.js';

function makeCtx(over: Partial<TurnContext>): TurnContext {
  return {
    sessionId: 's',
    config: makeConfig(),
    cortex: mockCortex(),
    router: mockRouter(),
    logger: silentLogger,
    history: [],
    channel: 'gateway',
    systemBase: 'base',
    ...over,
  };
}

function collect(): { events: TurnStreamEvent[]; onStreamEvent: (ev: TurnStreamEvent) => void } {
  const events: TurnStreamEvent[] = [];
  return { events, onStreamEvent: (ev) => events.push(ev) };
}

/** Streams some text, then surfaces a provider error mid-stream. */
function midStreamFailureModel(prefix: string): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV1StreamPart>({
        chunks: [
          { type: 'text-delta', textDelta: prefix },
          { type: 'error', error: new Error('connection dropped mid-stream') },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

describe('runTurn streaming events', () => {
  it('forwards deltas live; joined deltas equal the raw reply', async () => {
    const { events, onStreamEvent } = collect();
    const res = await runTurn(
      makeCtx({ router: mockRouter(textModel('streamed reply text')), onStreamEvent }),
      'hi',
    );
    const deltas = events.filter((e) => e.type === 'delta');
    assert.ok(deltas.length > 1, 'arrived in multiple chunks');
    assert.equal(deltas.map((e) => (e as { text: string }).text).join(''), 'streamed reply text');
    assert.equal(res.reply, 'streamed reply text');
  });

  it('emits reset after a mid-stream provider death, then streams the fallback', async () => {
    const { events, onStreamEvent } = collect();
    const res = await runTurn(
      makeCtx({
        router: mockRouter(midStreamFailureModel('partial garbage'), textModel('clean')),
        onStreamEvent,
      }),
      'hi',
    );
    assert.equal(res.reply, 'clean');
    const types = events.map((e) => e.type);
    const resetIdx = types.indexOf('reset');
    assert.ok(resetIdx > 0, 'reset emitted after the partial deltas');
    // Everything after reset reassembles to the fallback's reply.
    const after = events
      .slice(resetIdx + 1)
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    assert.equal(after, 'clean');
  });

  it('a hard failure with no output emits no reset (nothing to discard)', async () => {
    const { events, onStreamEvent } = collect();
    await runTurn(
      makeCtx({ router: mockRouter(failingModel('dead'), textModel('ok')), onStreamEvent }),
      'hi',
    );
    assert.ok(!events.some((e) => e.type === 'reset'));
  });

  it('emits tool events when tools fire', async () => {
    const tools: ToolSet = {
      web_fetch: tool({
        description: 'fetch',
        parameters: z.object({}),
        execute: async () => ({ ok: true, body: 'data' }),
      }),
    };
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV1StreamPart>({
          chunks: [
            {
              type: 'tool-call',
              toolCallType: 'function',
              toolCallId: 'c1',
              toolName: 'web_fetch',
              args: '{}',
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const { events, onStreamEvent } = collect();
    await runTurn(makeCtx({ router: mockRouter(model), tools, onStreamEvent }), 'hi').catch(() => {
      // multi-step mock ends without text; the turn may throw on empty
      // reply — the tool event is what's under test here.
    });
    assert.ok(events.some((e) => e.type === 'tool' && e.name === 'web_fetch'));
  });

  it('canonical reply still carries post-stream mutations (commitment footer)', async () => {
    const { events, onStreamEvent } = collect();
    const res = await runTurn(
      makeCtx({
        router: mockRouter(textModel('Noted.')),
        channel: 'cli',
        onStreamEvent,
      }),
      'I will send the contract by Friday',
    );
    const streamed = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    assert.equal(streamed, 'Noted.');
    assert.match(res.reply, /✓ logged:/);
    assert.notEqual(res.reply, streamed, 'done-reply ≠ streamed buffer — clients must swap');
  });
});
