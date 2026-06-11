/**
 * CortexBind — HTTP surface tests with an injected fake fetch. No network,
 * no module mocking: dispatch on `${method} ${pathname}` and record every
 * call so body fields (agentId, tokenBudget, valence, …) can be asserted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CortexBind } from '../../src/cortex/bind.js';

// ─── Local helpers ───────────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

type RouteHandler = (call: RecordedCall) => Response;

/** Fake fetch keyed on `${method} ${pathname}`; records {url, method, parsed body}. */
function fakeFetch(routes: Record<string, RouteHandler>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const call: RecordedCall = { url, method, body };
    calls.push(call);
    const key = `${method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`fakeFetch: no route for ${key}`);
    return route(call);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bindWith(routes: Record<string, RouteHandler>, agentId = 'iso-a') {
  const { impl, calls } = fakeFetch(routes);
  const bind = new CortexBind({ agentId, baseUrl: 'http://cortex.test', fetchImpl: impl });
  return { bind, calls };
}

const recallPayload = {
  context: 'ctx-block',
  memories: [{ id: 7, content: 'a fact', source: 'chat', score: 0.91 }],
  artifacts: [{ id: 3, type: 'dream_insight', content: { note: 'x' } }],
  tokenCount: 120,
  tokenBudget: 1234,
};

// ─── recall ──────────────────────────────────────────────────────────────────

test('recall() POSTs /api/v1/recall with agentId + tokenBudget and parses RecallResult', async () => {
  const { bind, calls } = bindWith({
    'POST /api/v1/recall': () => jsonResponse(recallPayload),
  });

  const result = await bind.recall('what happened?', { tokenBudget: 1234 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://cortex.test/api/v1/recall');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body?.query, 'what happened?');
  assert.equal(calls[0].body?.agentId, 'iso-a');
  assert.equal(calls[0].body?.tokenBudget, 1234);
  assert.deepEqual(result, recallPayload);
});

test('recall() defaults tokenBudget to 4000 and serializes Date since to ISO', async () => {
  const { bind, calls } = bindWith({
    'POST /api/v1/recall': () => jsonResponse(recallPayload),
  });

  await bind.recall('q', { since: new Date('2026-01-02T03:04:05Z') });

  assert.equal(calls[0].body?.tokenBudget, 4000);
  assert.equal(calls[0].body?.since, '2026-01-02T03:04:05.000Z');
});

test('recall() on 500 throws CORTEX error with status', async () => {
  const { bind } = bindWith({
    'POST /api/v1/recall': () => new Response('boom', { status: 500 }),
  });

  await assert.rejects(bind.recall('q'), /CORTEX .* 500/);
});

// ─── encode ──────────────────────────────────────────────────────────────────

test('encode() POSTs /api/v1/ingest with content, valence, and explicit options', async () => {
  const encodeResult = { memoryId: 55, novelty: 0.7, encoded: true };
  const { bind, calls } = bindWith({
    'POST /api/v1/ingest': () => jsonResponse(encodeResult),
  });

  const result = await bind.encode('user prefers dark mode', {
    source: 'telegram:chat',
    priority: 3,
    valence: { arousal: 0.5, pleasantness: 0.8 },
    channel: 'telegram',
    sensitivity: 'sacred',
  });

  assert.equal(calls[0].url, 'http://cortex.test/api/v1/ingest');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    agentId: 'iso-a',
    content: 'user prefers dark mode',
    source: 'telegram:chat',
    priority: 3,
    valence: { arousal: 0.5, pleasantness: 0.8 },
    channel: 'telegram',
    sensitivity: 'sacred',
  });
  assert.deepEqual(result, encodeResult);
});

test('encode() applies defaults: meridian:turn source, priority 2, internal sensitivity', async () => {
  const { bind, calls } = bindWith({
    'POST /api/v1/ingest': () => jsonResponse({ memoryId: 1, novelty: 0.1, encoded: true }),
  });

  await bind.encode('plain note');

  assert.equal(calls[0].body?.source, 'meridian:turn');
  assert.equal(calls[0].body?.priority, 2);
  assert.equal(calls[0].body?.sensitivity, 'internal');
});

// ─── agent isolation ─────────────────────────────────────────────────────────

test('two binds with different agentIds send their own agentId in every body', async () => {
  const { impl, calls } = fakeFetch({
    'POST /api/v1/recall': () => jsonResponse(recallPayload),
  });
  const bindA = new CortexBind({ agentId: 'iso-a', baseUrl: 'http://cortex.test', fetchImpl: impl });
  const bindB = new CortexBind({ agentId: 'iso-b', baseUrl: 'http://cortex.test', fetchImpl: impl });

  await bindA.recall('shared query');
  await bindB.recall('shared query');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body?.agentId, 'iso-a');
  assert.equal(calls[1].body?.agentId, 'iso-b');
});

// ─── health ──────────────────────────────────────────────────────────────────

test('health() GETs /api/v1/health with snake_case agent_id query', async () => {
  const { bind, calls } = bindWith({
    'GET /api/v1/health': () => jsonResponse({ status: 'ok', database: 'connected' }),
  });

  const result = await bind.health();

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://cortex.test/api/v1/health?agent_id=iso-a');
  assert.deepEqual(result, { status: 'ok', database: 'connected' });
});

test('health() swallows fetch throw and reports down instead of rejecting', async () => {
  const impl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const bind = new CortexBind({ agentId: 'iso-a', baseUrl: 'http://cortex.test', fetchImpl: impl });

  const result = await bind.health();

  assert.deepEqual(result, { status: 'down', database: 'disconnected' });
});

// ─── dream / reconsolidate / artifacts ───────────────────────────────────────

test('dream() POSTs /api/v1/dream with agentId and cycleType', async () => {
  const dreamResult = { cycleType: 'rem_only', durationMs: 12, insights: ['i1'], stats: {} };
  const { bind, calls } = bindWith({
    'POST /api/v1/dream': () => jsonResponse(dreamResult),
  });

  const result = await bind.dream('rem_only');

  assert.deepEqual(calls[0].body, { agentId: 'iso-a', cycleType: 'rem_only' });
  assert.deepEqual(result, dreamResult);

  await bind.dream();
  assert.equal(calls[1].body?.cycleType, 'full');
});

test('reconsolidate() POSTs /api/v1/reconsolidate with agentId, memoryId, content', async () => {
  const { bind, calls } = bindWith({
    'POST /api/v1/reconsolidate': () => jsonResponse({ ok: true }),
  });

  const result = await bind.reconsolidate(42, 'edited content');

  assert.deepEqual(calls[0].body, { agentId: 'iso-a', memoryId: 42, content: 'edited content' });
  assert.deepEqual(result, { ok: true });
});

test('listArtifacts() GETs /api/v1/artifacts with agentId and default window params', async () => {
  const payload = {
    agentId: 'iso-a',
    sinceHours: 48,
    cutoff: '2026-06-09T00:00:00Z',
    count: 1,
    artifacts: [{ id: 9, type: 'reflector_cluster', content: {}, createdAt: '2026-06-10' }],
  };
  const { bind, calls } = bindWith({
    'GET /api/v1/artifacts': () => jsonResponse(payload),
  });

  const result = await bind.listArtifacts();

  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('agentId'), 'iso-a');
  assert.equal(params.get('sinceHours'), '48');
  assert.equal(params.get('limit'), '20');
  assert.deepEqual(result, payload);

  await bind.listArtifacts({ sinceHours: 6, limit: 5 });
  const params2 = new URL(calls[1].url).searchParams;
  assert.equal(params2.get('sinceHours'), '6');
  assert.equal(params2.get('limit'), '5');
});

// ─── stats ───────────────────────────────────────────────────────────────────

test('stats() maps the agents endpoint row for this agent, coercing string counts', async () => {
  const { bind } = bindWith({
    'GET /api/v1/memories/agents': () =>
      jsonResponse({
        agents: [
          {
            external_id: 'iso-a',
            active_memories: '12',
            total_memories: '20',
            synapse_count: '3',
            last_memory_at: '2026-06-10T08:00:00Z',
          },
          { external_id: 'other', active_memories: 99, total_memories: 99 },
        ],
      }),
  });

  assert.deepEqual(await bind.stats(), {
    memoryCount: 12,
    synapseCount: 3,
    artifactCount: 0,
    lastDreamAt: '2026-06-10T08:00:00Z',
    agentId: 'iso-a',
  });
});

test('stats() returns null on transport failure instead of throwing', async () => {
  const impl = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const bind = new CortexBind({ agentId: 'iso-a', baseUrl: 'http://cortex.test', fetchImpl: impl });

  assert.equal(await bind.stats(), null);
});

// ─── construction ────────────────────────────────────────────────────────────

test('trailing slash in baseUrl is trimmed before building request URLs', async () => {
  const { impl, calls } = fakeFetch({
    'POST /api/v1/recall': () => jsonResponse(recallPayload),
  });
  const bind = new CortexBind({
    agentId: 'iso-a',
    baseUrl: 'http://cortex.test/',
    fetchImpl: impl,
  });

  await bind.recall('q');

  assert.equal(calls[0].url, 'http://cortex.test/api/v1/recall');
});
