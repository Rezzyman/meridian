import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => Promise.all(apps.map((app) => app.close())));

function conversation(seen: string[]): Conversation {
  return {
    sessionId: 'device-session',
    agentSlug: 'jira',
    historyCount: 0,
    send: async (input: string) => {
      seen.push(input);
      return {
        id: 'turn-device-1',
        sessionId: 'device-session',
        role: 'assistant' as const,
        content: `JIRA heard: ${input}`,
        channel: 'gateway' as const,
        ts: '2026-07-29T00:00:00.000Z',
        memoryId: 'memory-device-1',
      };
    },
  } as unknown as Conversation;
}

async function boot(seen: string[], token?: string): Promise<string> {
  const app = await startGateway({
    port: 0,
    token,
    logger: silentLogger,
    conversation: conversation(seen),
  });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('gateway did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('POST /v1/turns/text', () => {
  it('adapts the Android device body and response to the canonical conversation', async () => {
    const seen: string[] = [];
    const base = await boot(seen, 'device-token');
    const response = await fetch(`${base}/v1/turns/text`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer device-token',
        'content-type': 'application/json',
        'x-meridian-device': 'rabbit-r1',
      },
      body: JSON.stringify({ text: 'hello from the R1', device_model: 'rabbit-r1' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: 'JIRA heard: hello from the R1',
      turnId: 'turn-device-1',
      memoryId: 'memory-device-1',
    });
    assert.deepEqual(seen, ['hello from the R1']);
  });

  it('fails closed for a missing token or missing text', async () => {
    const base = await boot([], 'device-token');
    const unauthorized = await fetch(`${base}/v1/turns/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'no token' }),
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(`${base}/v1/turns/text`, {
      method: 'POST',
      headers: { authorization: 'Bearer device-token', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);
  });
});
