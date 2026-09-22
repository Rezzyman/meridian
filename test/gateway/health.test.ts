import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { HealthState } from '../../src/gateway/health.js';
import { ProviderRouter } from '../../src/providers/router.js';
import { makeEnv, silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

function stubConversation(): Conversation {
  return {
    sessionId: 'sess',
    agentSlug: 'arlo',
    historyCount: 0,
    send: async () => ({
      id: 't',
      sessionId: 'sess',
      role: 'assistant',
      content: 'ok',
      channel: 'gateway',
      ts: new Date().toISOString(),
    }),
  } as unknown as Conversation;
}

describe('runtime health state (WS5)', () => {
  it('counts last-hour turns and errors with a rolling window', () => {
    let now = 0;
    const h = new HealthState('1.5.0', () => now);
    h.recordTurn(true);
    h.recordTurn(false);
    now = 3599_000;
    assert.deepEqual(h.lastHourInference(), { turns: 2, errors: 1 });
    now = 3601_000;
    h.recordTurn(true);
    assert.deepEqual(h.lastHourInference(), { turns: 1, errors: 0 });
    assert.equal(h.uptimeSec(), 3601);
  });
});

describe('GET /health contract (WS5)', () => {
  it('returns every field the fleet check and meridian status read', async () => {
    const health = new HealthState('1.5.0');
    health.setCortex('ok', 'http://127.0.0.1:3101');
    const router = new ProviderRouter(makeEnv({ ROUTEXOR_API_KEY: 'rx-test-key-000000000000' }));
    router.reportFailure('routexor/claude-haiku-4.5');
    const app = await startGateway({
      port: 0,
      logger: silentLogger,
      conversation: stubConversation(),
      health,
      breaker: () => router.breakerSnapshot(),
      provider: {
        ok: true,
        primary: 'routexor/claude-haiku-4.5',
        provider: 'routexor',
        baseUrlHost: 'api.routexor.com',
      },
      spend: {
        today: () => ({ usd: 0.5, tokens: 10, calls: 1 }),
        month: () => ({ usd: 2, tokens: 40, calls: 4 }),
      },
    });
    apps.push(app);
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const body = (await (await fetch(`http://127.0.0.1:${addr.port}/health`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(body.ok, true);
    assert.equal(body.version, '1.5.0');
    assert.equal((body.cortex as { status: string }).status, 'ok');
    assert.deepEqual(body.lastHourInference, { turns: 0, errors: 0 });
    assert.deepEqual((body.breaker as Array<{ ref: string; state: string }>)[0], {
      ref: 'routexor/claude-haiku-4.5',
      state: 'half-open',
      consecutiveFailures: 1,
      openUntil: null,
    });
    assert.equal((body.spend as { today: { usd: number } }).today.usd, 0.5);
    assert.deepEqual(body.automations, []);
    assert.equal(body.lastProactiveDelivery, null);
    assert.ok(typeof body.uptimeSec === 'number');
  });

  it('ok flips false when CORTEX is down', async () => {
    const health = new HealthState('1.5.0');
    health.setCortex('down');
    const app = await startGateway({
      port: 0,
      logger: silentLogger,
      conversation: stubConversation(),
      health,
    });
    apps.push(app);
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const body = (await (await fetch(`http://127.0.0.1:${addr.port}/health`)).json()) as {
      ok: boolean;
    };
    assert.equal(body.ok, false);
  });
});
