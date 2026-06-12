/**
 * createMemoryProvider + QuartzMemoryProvider — selection, fallback, and the
 * quartz/cortex recall merge. baseUrl/cortex are always passed explicitly so
 * nothing depends on MERIDIAN_CORTEX_URL captured at module load.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CortexBind } from '../../src/cortex/bind.js';
import { createMemoryProvider } from '../../src/memory/factory.js';
import { EmbeddedMemoryProvider } from '../../src/memory/embedded-memory-provider.js';
import { QuartzMemoryProvider } from '../../src/memory/quartz-memory-provider.js';
import type { QuartzPipeline } from '../../src/memory/quartz-memory-provider.js';
import { makeEnv, mockCortex, mockRouter, textModel } from '../helpers/fixtures.js';
import type { MockCortex } from '../helpers/fixtures.js';

// ─── Local helpers ───────────────────────────────────────────────────────────

function logCapture() {
  const entries: Array<{ level: 'info' | 'warn'; msg: string }> = [];
  return {
    entries,
    log: (level: 'info' | 'warn', msg: string) => {
      entries.push({ level, msg });
    },
  };
}

/** The factory/wrapper only use the MemoryProvider surface; mockCortex satisfies it. */
function asBind(mock: MockCortex): CortexBind {
  return mock as unknown as CortexBind;
}

type PipelineRecallInput = Parameters<QuartzPipeline['recall']>[0];

// ─── createMemoryProvider ────────────────────────────────────────────────────

test('default env selects cortex with the agent id from CORTEX_AGENT_ID', async () => {
  const { entries, log } = logCapture();

  const result = await createMemoryProvider({
    env: makeEnv(),
    cortexBaseUrl: 'http://cortex.test',
    log,
  });

  assert.equal(result.selected, 'cortex');
  assert.equal(result.fallbackReason, undefined);
  assert.ok(result.provider instanceof CortexBind);
  assert.equal(result.provider.agentId, 'test-agent');
  assert.equal((result.provider as CortexBind).baseUrl, 'http://cortex.test');
  assert.ok(entries.some((e) => e.level === 'info' && /cortex/.test(e.msg)));
});

test('a pre-built cortex bind passed in opts is reused as the provider', async () => {
  const cortex = mockCortex({ agentId: 'boot-agent' });
  const { log } = logCapture();

  const result = await createMemoryProvider({ env: makeEnv(), cortex: asBind(cortex), log });

  assert.equal(result.selected, 'cortex');
  assert.equal(result.provider, cortex);
  assert.equal(result.provider.agentId, 'boot-agent');
});

test('provider=quartz without a router falls back to cortex with a ProviderRouter reason', async () => {
  const cortex = mockCortex({ agentId: 'q-agent' });
  const { entries, log } = logCapture();

  const result = await createMemoryProvider({
    env: makeEnv({ MERIDIAN_MEMORY_PROVIDER: 'quartz' }),
    cortex: asBind(cortex),
    log,
  });

  assert.equal(result.selected, 'cortex');
  assert.equal(result.provider, cortex);
  assert.match(result.fallbackReason ?? '', /ProviderRouter/);
  assert.ok(entries.some((e) => e.level === 'warn' && /ProviderRouter/.test(e.msg)));
});

test('provider=quartz with router falls back when @aterna/quartz cannot be imported', async () => {
  const cortex = mockCortex({ agentId: 'q-agent' });
  const { entries, log } = logCapture();

  const result = await createMemoryProvider({
    env: makeEnv({ MERIDIAN_MEMORY_PROVIDER: 'quartz' }),
    router: mockRouter(textModel('ok')),
    cortex: asBind(cortex),
    log,
  });

  assert.equal(result.selected, 'cortex');
  assert.equal(result.provider, cortex);
  assert.match(result.fallbackReason ?? '', /quartz unavailable/);
  assert.match(result.fallbackReason ?? '', /falling back to cortex/);
  assert.ok(entries.some((e) => e.level === 'warn' && /quartz unavailable/.test(e.msg)));
});

test('provider=embedded selects the zero-config embedded provider (no server/keys)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-factory-'));
  try {
    const { entries, log } = logCapture();
    const result = await createMemoryProvider({
      env: makeEnv({ MERIDIAN_MEMORY_PROVIDER: 'embedded', CORTEX_AGENT_ID: 'emb-agent' }),
      embeddedDbPath: join(dir, 'memory.jsonl'),
      log,
    });
    assert.equal(result.selected, 'embedded');
    assert.ok(result.provider instanceof EmbeddedMemoryProvider);
    assert.equal(result.provider.agentId, 'emb-agent');
    assert.ok(entries.some((e) => e.level === 'info' && /embedded/.test(e.msg)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider=embedded without embeddedDbPath throws a clear error', async () => {
  await assert.rejects(
    () => createMemoryProvider({ env: makeEnv({ MERIDIAN_MEMORY_PROVIDER: 'embedded' }) }),
    /embeddedDbPath/,
  );
});

// ─── QuartzMemoryProvider ────────────────────────────────────────────────────

test('QuartzMemoryProvider.recall merges quartz context with cortex memories and budget', async () => {
  const cortex = mockCortex({ agentId: 'qz-agent' });
  const pipelineCalls: PipelineRecallInput[] = [];
  const pipeline: QuartzPipeline = {
    async recall(input) {
      pipelineCalls.push(input);
      return { context: 'q-ctx', retrievedSessionIds: [], tokenCount: 7 };
    },
  };
  const provider = new QuartzMemoryProvider({ cortex: asBind(cortex), lib: { pipeline } });

  assert.equal(provider.agentId, 'qz-agent');

  const result = await provider.recall('what changed?', { tokenBudget: 999 });

  // Quartz wins context + tokenCount; cortex supplies memories/artifacts/budget.
  assert.equal(result.context, 'q-ctx');
  assert.equal(result.tokenCount, 7);
  assert.equal(result.tokenBudget, 999);
  assert.deepEqual(result.memories, [
    { id: 1, content: 'remembered fact', source: 'test', score: 0.9 },
  ]);
  assert.deepEqual(result.artifacts, []);

  // Double-hit contract: one cortex.recall and one pipeline.recall per recall().
  assert.equal(cortex.recallCalls.length, 1);
  assert.equal(cortex.recallCalls[0].query, 'what changed?');
  assert.deepEqual(cortex.recallCalls[0].opts, { tokenBudget: 999 });
  assert.equal(pipelineCalls.length, 1);
  assert.equal(pipelineCalls[0].agentId, 'qz-agent');
  assert.equal(pipelineCalls[0].question, 'what changed?');
  assert.equal(pipelineCalls[0].store, null);
  assert.ok(pipelineCalls[0].sessionDates instanceof Map);
});

test('QuartzMemoryProvider delegates encode and health straight to the cortex bind', async () => {
  const cortex = mockCortex({ agentId: 'qz-agent' });
  const pipeline: QuartzPipeline = {
    async recall() {
      return { context: '', retrievedSessionIds: [], tokenCount: 0 };
    },
  };
  const provider = new QuartzMemoryProvider({ cortex: asBind(cortex), lib: { pipeline } });

  await provider.encode('a note', { priority: 1 });

  assert.equal(cortex.encodeCalls.length, 1);
  assert.equal(cortex.encodeCalls[0].content, 'a note');
  assert.deepEqual(cortex.encodeCalls[0].opts, { priority: 1 });
  assert.deepEqual(await provider.health(), { status: 'ok', database: 'connected' });
});
