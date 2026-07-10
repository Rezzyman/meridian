/**
 * delegate — bounded sub-agent tool. Hard bounds under test: depth is
 * structural (child toolset only contains delegate while depth remains),
 * output tokens cap rides streamText maxTokens, wall-clock cap rides the
 * child config, denylisted tools never cross, failures return as data.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tool, type LanguageModelV1StreamPart, type Tool, type ToolSet } from 'ai';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { DelegationConfigSchema } from '../../src/config/schema.js';
import { builtinTools } from '../../src/skills/builtin/index.js';
import { type DelegateDeps, delegateTools } from '../../src/skills/builtin/delegate-tools.js';
import type { CortexBind } from '../../src/cortex/bind.js';
import {
  failingModel,
  makeConfig,
  mockCortex,
  mockRouter,
  settle,
  silentLogger,
  textModel,
} from '../helpers/fixtures.js';

const TOOL_OPTS = { toolCallId: 'call-1', messages: [] };

function noop(description: string) {
  return tool({ description, parameters: z.object({}), execute: async () => ({ ok: true }) });
}

const PARENT_TOOLS: ToolSet = {
  web_fetch: noop('fetch'),
  read: noop('read'),
  bash: noop('shell'),
  delegate: noop('parent delegate placeholder'),
};

function makeDeps(over: Partial<DelegateDeps> = {}): DelegateDeps {
  return {
    config: makeConfig(),
    memory: mockCortex(),
    router: mockRouter(textModel('child result')),
    logger: silentLogger,
    getParentTools: () => PARENT_TOOLS,
    ...over,
  };
}

function delegateOf(deps: DelegateDeps): Required<Tool> {
  const set = delegateTools(deps);
  assert.ok(set.delegate, 'delegate registered');
  return set.delegate as Required<Tool>;
}

/** Model capturing offered tool names + maxTokens per doStream call. */
function capturingModel(replies: Array<'text' | 'call-delegate'>) {
  const offered: string[][] = [];
  const maxTokens: Array<number | undefined> = [];
  let call = 0;
  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      const mode = options.mode as { tools?: Array<{ name: string }> };
      offered.push((mode.tools ?? []).map((t) => t.name).sort());
      maxTokens.push(options.maxTokens);
      const script = replies[Math.min(call, replies.length - 1)];
      call++;
      const chunks: LanguageModelV1StreamPart[] =
        script === 'call-delegate'
          ? [
              {
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: `c${call}`,
                toolName: 'delegate',
                args: JSON.stringify({ task: 'grandchild task goes here' }),
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { promptTokens: 1, completionTokens: 1 },
              },
            ]
          : [
              { type: 'text-delta', textDelta: 'done' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { promptTokens: 1, completionTokens: 1 },
              },
            ];
      return {
        stream: simulateReadableStream<LanguageModelV1StreamPart>({ chunks }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  return { model, offered, maxTokens };
}

describe('delegate happy path', () => {
  it('runs a sub-turn and returns a structured non-empty result', async () => {
    const memory = mockCortex();
    const del = delegateOf(makeDeps({ memory }));
    const res = (await del.execute(
      { task: 'summarize the quarterly numbers' },
      TOOL_OPTS,
    )) as Record<string, unknown>;
    assert.equal(res.ok, true);
    assert.equal(res.result, 'child result');
    assert.equal(res.depth, 1);
    assert.equal(typeof res.durationMs, 'number');
    // The sub-turn ran the real spine: recall happened against the memory provider.
    assert.equal(memory.recallCalls.length, 1);
  });

  it('failures come back as data, never a throw', async () => {
    const del = delegateOf(makeDeps({ router: mockRouter(failingModel('provider dead')) }));
    const res = (await del.execute({ task: 'doomed task here' }, TOOL_OPTS)) as Record<
      string,
      unknown
    >;
    assert.equal(res.ok, false);
    // RULE ZERO: the delegate surfaces the client-safe generic, never raw provider text.
    assert.match(String(res.error), /Quick hiccup on my end/);
    assert.doesNotMatch(String(res.error), /provider dead/);
    assert.equal(res.depth, 1);
  });
});

describe('delegate tool granting', () => {
  it('default grant is delegation.childTools ∩ parent surface, denylist enforced', async () => {
    const { model, offered } = capturingModel(['text']);
    const del = delegateOf(makeDeps({ router: mockRouter(model) }));
    await del.execute({ task: 'inspect granted tools' }, TOOL_OPTS);
    // defaults: ['web_fetch','read']; never delegate (maxDepth 1), never bash.
    assert.deepEqual(offered[0], ['read', 'web_fetch']);
  });

  it('explicit grants pass through; delegate/cortex_* never do', async () => {
    const { model, offered } = capturingModel(['text']);
    const del = delegateOf(makeDeps({ router: mockRouter(model) }));
    await del.execute(
      { task: 'use the shell please', tools: ['bash', 'delegate', 'cortex_recall', 'nonexistent'] },
      TOOL_OPTS,
    );
    assert.deepEqual(offered[0], ['bash']);
  });
});

describe('delegate depth bound (structural)', () => {
  it('maxDepth=1: child has no delegate tool', async () => {
    const { model, offered } = capturingModel(['text']);
    const del = delegateOf(makeDeps({ router: mockRouter(model) }));
    await del.execute({ task: 'depth one inspection' }, TOOL_OPTS);
    assert.ok(!offered[0].includes('delegate'));
  });

  it('maxDepth=2: child may delegate, grandchild may not', async () => {
    const config = makeConfig({ delegation: DelegationConfigSchema.parse({ maxDepth: 2 }) });
    // Call order: child step1 (calls delegate) → grandchild (text) → child step2 (text).
    const { model, offered } = capturingModel(['call-delegate', 'text', 'text']);
    const del = delegateOf(makeDeps({ config, router: mockRouter(model) }));
    const res = (await del.execute({ task: 'two level task here' }, TOOL_OPTS)) as Record<
      string,
      unknown
    >;
    assert.equal(res.ok, true);
    assert.ok(offered[0].includes('delegate'), 'child (depth 1) may re-delegate');
    assert.ok(!offered[1].includes('delegate'), 'grandchild (depth 2) may not');
  });
});

describe('delegate budget + memory bounds', () => {
  it('output-token cap rides streamText maxTokens', async () => {
    const config = makeConfig({
      delegation: DelegationConfigSchema.parse({ maxOutputTokens: 777 }),
    });
    const { model, maxTokens } = capturingModel(['text']);
    const del = delegateOf(makeDeps({ config, router: mockRouter(model) }));
    await del.execute({ task: 'budgeted task here' }, TOOL_OPTS);
    assert.equal(maxTokens[0], 777);
  });

  it('parent turns carry no cap (regression: limits only apply to sub-turns)', async () => {
    const { model, maxTokens } = capturingModel(['text']);
    const { runTurn } = await import('../../src/agent/turn.js');
    await runTurn(
      {
        sessionId: 's',
        config: makeConfig(),
        cortex: mockCortex(),
        router: mockRouter(model),
        logger: silentLogger,
        history: [],
        channel: 'cli',
        systemBase: 'base',
      },
      'hi',
    );
    assert.equal(maxTokens[0], undefined);
  });

  it('wall-clock cap: a hung child provider is killed at timeoutSec', async () => {
    const config = makeConfig({
      delegation: DelegationConfigSchema.parse({ timeoutSec: 5 }), // schema minimum
    });
    // Hangs forever but honors abortSignal — like every fetch-based
    // provider. The bound under test is ours: config timeout → signal → kill.
    const hangingModel = new MockLanguageModelV1({
      doStream: (options) =>
        new Promise((_, reject) => {
          options.abortSignal?.addEventListener('abort', () =>
            reject(options.abortSignal?.reason ?? new Error('aborted')),
          );
        }),
    });
    const del = delegateOf(makeDeps({ config, router: mockRouter(hangingModel) }));
    // AbortSignal.timeout timers are unref'd; hold the loop open ourselves.
    const keepAlive = setTimeout(() => {}, 15_000);
    try {
      const started = Date.now();
      const res = (await del.execute({ task: 'this child hangs forever' }, TOOL_OPTS)) as Record<
        string,
        unknown
      >;
      const elapsed = Date.now() - started;
      assert.equal(res.ok, false);
      assert.ok(elapsed >= 4900 && elapsed < 8000, `killed at ~5s (took ${elapsed}ms)`);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('child turns do not encode by default; encodeSubTurns opts in', async () => {
    const memory = mockCortex();
    const del = delegateOf(makeDeps({ memory }));
    await del.execute({ task: 'scratch work task' }, TOOL_OPTS);
    await settle();
    assert.equal(memory.encodeCalls.length, 0, 'no memory pollution by default');

    const memory2 = mockCortex();
    const config = makeConfig({
      delegation: DelegationConfigSchema.parse({ encodeSubTurns: true }),
    });
    const del2 = delegateOf(makeDeps({ memory: memory2, config }));
    await del2.execute({ task: 'memorable task here' }, TOOL_OPTS);
    await settle();
    assert.equal(memory2.encodeCalls.length, 1);
  });
});

describe('delegate registration', () => {
  const bindStub = mockCortex() as unknown as CortexBind;

  it('registers in builtinTools only when delegation deps are provided', () => {
    const withoutDeps = builtinTools({ cortex: bindStub, env: envStub() });
    assert.ok(!withoutDeps.delegate);
    const withDeps = builtinTools({
      cortex: bindStub,
      env: envStub(),
      delegation: makeDeps(),
    });
    assert.ok(withDeps.delegate);
  });

  it('delegation.enabled=false removes the tool entirely', () => {
    const config = makeConfig({ delegation: DelegationConfigSchema.parse({ enabled: false }) });
    assert.deepEqual(delegateTools(makeDeps({ config })), {});
  });
});

function envStub() {
  return {
    MERIDIAN_AGENT: 'test-agent',
    CORTEX_AGENT_ID: 'test-agent',
    NEON_DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    VOYAGE_API_KEY: 'voyage-test-key-0000000000000000',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    MERIDIAN_GATEWAY_PORT: 18889,
    MERIDIAN_MEMORY_PROVIDER: 'cortex' as const,
  };
}
