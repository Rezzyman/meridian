/**
 * runTurn() unit tests: recall wiring, system prompt assembly, provider
 * fallback, channel-scoped tool gating, the tool execution loop, encode
 * fire-and-forget, and the commitment footer. All providers are
 * MockLanguageModelV1 — no network, no ~/.meridian access.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tool, type LanguageModelV1, type LanguageModelV1StreamPart, type ToolSet } from 'ai';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { runTurn, type TurnContext } from '../../src/agent/turn.js';
import {
  failingModel,
  makeConfig,
  mockCortex,
  mockRouter,
  settle,
  silentLogger,
  textModel,
} from '../helpers/fixtures.js';

type StreamOptions = Parameters<LanguageModelV1['doStream']>[0];

const PERSONA_MARKER = 'PERSONA_BASE_MARKER persona text';

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    sessionId: 's-test',
    config: makeConfig(),
    cortex: mockCortex(),
    router: mockRouter(textModel('hello')),
    logger: silentLogger,
    history: [],
    channel: 'cli',
    systemBase: PERSONA_MARKER,
    ...overrides,
  };
}

/** Model that streams `text` and records every doStream call's options. */
function capturingModel(text: string): { model: MockLanguageModelV1; calls: StreamOptions[] } {
  const calls: StreamOptions[] = [];
  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: simulateReadableStream<LanguageModelV1StreamPart>({
          chunks: [
            { type: 'text-delta', textDelta: text },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, calls };
}

/** Extract the system prompt streamText sent to the model. */
function systemOf(call: StreamOptions): string {
  const first = call.prompt[0] as { role: string; content: string };
  assert.equal(first.role, 'system');
  return first.content;
}

/** Names of the tools that actually reached the model on this call. */
function toolNamesOf(call: StreamOptions): string[] {
  const mode = call.mode as { type: string; tools?: Array<{ name: string }> };
  return (mode.tools ?? []).map((t) => t.name).sort();
}

/** ToolSet with one tool per gating case. Executions land in `executed`. */
function makeTools(executed: string[]): ToolSet {
  const record = (name: string) =>
    tool({
      description: `${name} test tool`,
      parameters: z.object({ input: z.string() }),
      execute: async ({ input }: { input: string }) => {
        executed.push(`${name}:${input}`);
        return { ok: true, input };
      },
    });
  return {
    bash: record('bash'),
    web_fetch: record('web_fetch'),
    cortex_recall: record('cortex_recall'),
    custom_skill_tool: record('custom_skill_tool'),
  };
}

/** First step emits a web_fetch tool call; second step streams `text`. */
function toolCallThenTextModel(text: string): MockLanguageModelV1 {
  let call = 0;
  return new MockLanguageModelV1({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return {
          stream: simulateReadableStream<LanguageModelV1StreamPart>({
            chunks: [
              {
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: 'call-1',
                toolName: 'web_fetch',
                args: JSON.stringify({ input: 'https://example.test/page' }),
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { promptTokens: 5, completionTokens: 5 },
              },
            ],
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        stream: simulateReadableStream<LanguageModelV1StreamPart>({
          chunks: [
            { type: 'text-delta', textDelta: text },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { promptTokens: 5, completionTokens: 5 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

describe('runTurn happy path', () => {
  it('returns reply text, sets trace.model, recalls once with tokenBudget 1500', async () => {
    const cortex = mockCortex();
    const ctx = makeCtx({ cortex, router: mockRouter(textModel('hello there')) });
    const res = await runTurn(ctx, 'what do you remember?');
    assert.equal(res.reply, 'hello there');
    assert.equal(res.trace.model, 'anthropic/mock-0');
    assert.equal(cortex.recallCalls.length, 1);
    assert.equal(cortex.recallCalls[0].query, 'what do you remember?');
    assert.equal(cortex.recallCalls[0].opts?.tokenBudget, 1500);
    assert.equal(res.recallSummary, 'recalled context block');
    assert.deepEqual(res.trace.recallMemoryIds, [1]);
    assert.equal(res.trace.recallTokenCount, 42);
  });
});

describe('runTurn system prompt assembly', () => {
  it('orders runtime rules, then systemBase, then <cortex_recall>', async () => {
    const { model, calls } = capturingModel('ok');
    const ctx = makeCtx({ router: mockRouter(model) });
    await runTurn(ctx, 'hi');
    assert.equal(calls.length, 1);
    const system = systemOf(calls[0]);
    assert.ok(system.startsWith('<runtime_rules>'), 'system starts with <runtime_rules>');
    const iRulesEnd = system.indexOf('</runtime_rules>');
    const iBase = system.indexOf(PERSONA_MARKER);
    const iRecall = system.indexOf('<cortex_recall>');
    assert.ok(iRulesEnd > 0, 'runtime rules block closes');
    assert.ok(iBase > iRulesEnd, 'systemBase comes after runtime rules');
    assert.ok(iRecall > iBase, '<cortex_recall> comes after systemBase');
    assert.ok(system.includes('recalled context block'), 'recall context is injected');
  });
});

describe('runTurn channel sensitivity', () => {
  it('voice channel recalls with public-only sensitivity filter', async () => {
    const cortex = mockCortex();
    const ctx = makeCtx({ cortex, channel: 'voice' });
    await runTurn(ctx, 'hello');
    assert.deepEqual(cortex.recallCalls[0].opts?.sensitivityFilter, ['public']);
  });

  it('cli channel recalls with public+internal sensitivity filter', async () => {
    const cortex = mockCortex();
    const ctx = makeCtx({ cortex, channel: 'cli' });
    await runTurn(ctx, 'hello');
    assert.deepEqual(cortex.recallCalls[0].opts?.sensitivityFilter, ['public', 'internal']);
  });
});

describe('runTurn recall failure tolerance', () => {
  it('proceeds without memory when recall throws', async () => {
    const { model, calls } = capturingModel('still fine');
    const ctx = makeCtx({
      cortex: mockCortex({ recallError: new Error('cortex down') }),
      router: mockRouter(model),
    });
    const res = await runTurn(ctx, 'hi');
    assert.equal(res.reply, 'still fine');
    assert.equal(res.recallSummary, '');
    assert.deepEqual(res.trace.recallMemoryIds, []);
    const system = systemOf(calls[0]);
    assert.ok(!system.includes('<cortex_recall>'), 'no recall block in system prompt');
  });

  it('completes the turn when recall hangs (8s timeout race)', async () => {
    const ctx = makeCtx({
      cortex: mockCortex({ recallHangs: true }),
      router: mockRouter(textModel('survived')),
    });
    const started = Date.now();
    const res = await runTurn(ctx, 'hi');
    assert.equal(res.reply, 'survived');
    assert.equal(res.recallSummary, '');
    assert.ok(Date.now() - started >= 7500, 'waited for the recall timeout race');
  });
});

describe('runTurn provider fallback', () => {
  // streamText (ai@4.x) swallows doStream errors into its onError callback;
  // runTurn captures them there and rethrows so the chain advances. These
  // tests prove the fallback path stays alive.
  it('falls back to the second provider and records its ref in trace.model', async () => {
    const ctx = makeCtx({ router: mockRouter(failingModel('primary down'), textModel('ok')) });
    const res = await runTurn(ctx, 'hi');
    assert.equal(res.reply, 'ok');
    assert.equal(res.trace.model, 'anthropic/mock-1');
  });

  it('rejects with All providers failed carrying per-provider detail', async () => {
    const ctx = makeCtx({ router: mockRouter(failingModel('a'), failingModel('b')) });
    await assert.rejects(() => runTurn(ctx, 'hi'), /All providers failed.*mock-0.*mock-1/s);
  });
});

describe('runTurn tool gating', () => {
  it('cli channel exposes bash + web_fetch, never cortex_recall', async () => {
    const { model, calls } = capturingModel('ok');
    const ctx = makeCtx({ router: mockRouter(model), tools: makeTools([]), channel: 'cli' });
    await runTurn(ctx, 'hi');
    assert.deepEqual(toolNamesOf(calls[0]), ['bash', 'web_fetch']);
  });

  it('gateway channel (chat allowlist) exposes web_fetch only — no bash, no cortex_recall', async () => {
    const { model, calls } = capturingModel('ok');
    const ctx = makeCtx({ router: mockRouter(model), tools: makeTools([]), channel: 'gateway' });
    await runTurn(ctx, 'hi');
    assert.deepEqual(toolNamesOf(calls[0]), ['web_fetch']);
  });

  it('voice channel also uses the chat allowlist', async () => {
    const { model, calls } = capturingModel('ok');
    const ctx = makeCtx({ router: mockRouter(model), tools: makeTools([]), channel: 'voice' });
    await runTurn(ctx, 'hi');
    assert.deepEqual(toolNamesOf(calls[0]), ['web_fetch']);
  });

  it('skillToolNames union makes a non-allowlisted skill tool visible', async () => {
    const { model, calls } = capturingModel('ok');
    const ctx = makeCtx({
      router: mockRouter(model),
      tools: makeTools([]),
      channel: 'gateway',
      skillToolNames: new Set(['custom_skill_tool']),
    });
    await runTurn(ctx, 'hi');
    assert.deepEqual(toolNamesOf(calls[0]), ['custom_skill_tool', 'web_fetch']);
  });
});

describe('runTurn tool execution loop', () => {
  it('executes an allowed tool call and records it in trace.toolCalls', async () => {
    const executed: string[] = [];
    const ctx = makeCtx({
      router: mockRouter(toolCallThenTextModel('fetched and summarized')),
      tools: makeTools(executed),
      channel: 'cli',
    });
    const res = await runTurn(ctx, 'fetch that page');
    assert.deepEqual(executed, ['web_fetch:https://example.test/page']);
    assert.equal(res.reply, 'fetched and summarized');
    assert.equal(res.trace.toolCalls.length, 1);
    assert.equal(res.trace.toolCalls[0].name, 'web_fetch');
    assert.equal(typeof res.trace.toolCalls[0].stepType, 'string');
    assert.ok(res.trace.toolCalls[0].ts, 'tool call is timestamped');
  });
});

describe('runTurn encode fire-and-forget', () => {
  it('encodeOnTurn:true encodes one USER/ASSISTANT transcript after settle', async () => {
    const cortex = mockCortex();
    const ctx = makeCtx({
      cortex,
      config: makeConfig({ cortex: { encodeOnTurn: true } }),
      router: mockRouter(textModel('the reply body')),
    });
    await runTurn(ctx, 'remember this');
    await settle();
    assert.equal(cortex.encodeCalls.length, 1);
    assert.ok(cortex.encodeCalls[0].content.includes('USER: remember this'));
    assert.ok(cortex.encodeCalls[0].content.includes('the reply body'));
    assert.equal(cortex.encodeCalls[0].opts?.sensitivity, 'internal');
  });

  it('encodeOnTurn:false never encodes', async () => {
    const cortex = mockCortex();
    const ctx = makeCtx({ cortex });
    await runTurn(ctx, 'do not remember this');
    await settle();
    assert.equal(cortex.encodeCalls.length, 0);
  });
});

describe('runTurn commitment footer', () => {
  it('appends a ✓ logged footer on cli when the user commits', async () => {
    const ctx = makeCtx({ router: mockRouter(textModel('noted')), channel: 'cli' });
    const res = await runTurn(ctx, "I'll send the deck by Friday");
    assert.ok(res.reply.endsWith("✓ logged: I'll send the deck by Friday"), res.reply);
    assert.ok(res.reply.startsWith('noted'));
  });

  it('adds no footer on voice even when the user commits', async () => {
    const ctx = makeCtx({ router: mockRouter(textModel('noted')), channel: 'voice' });
    const res = await runTurn(ctx, "I'll send the deck by Friday");
    assert.equal(res.reply, 'noted');
    assert.ok(!res.reply.includes('✓ logged'));
  });
});
