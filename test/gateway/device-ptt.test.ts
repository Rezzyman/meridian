import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => Promise.all(apps.map((app) => app.close())));

async function boot(opts: { configured?: boolean } = {}): Promise<string> {
  const conversation = {
    sessionId: 'ptt-test',
    agentSlug: 'jira',
    historyCount: 0,
    send: async (input: string) => ({
      id: 'ptt-turn-1',
      sessionId: 'ptt-test',
      role: 'assistant' as const,
      content: `JIRA says: ${input}`,
      channel: 'gateway' as const,
      ts: '2026-07-29T15:00:00.000Z',
    }),
  } as unknown as Conversation;
  const app = await startGateway({
    port: 0,
    token: 'device-token',
    logger: silentLogger,
    conversation,
    transcribeAudio: opts.configured === false
      ? undefined
      : async (audio, mime) => {
          assert.equal(mime, 'audio/wav');
          assert.equal(audio.length, 64);
          return 'what time is it';
        },
  });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('gateway did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('POST /v1/turns/ptt', () => {
  it('transcribes one held-button WAV and sends the transcript through JIRA', async () => {
    const base = await boot();
    const response = await fetch(`${base}/v1/turns/ptt`, {
      method: 'POST',
      headers: { authorization: 'Bearer device-token', 'content-type': 'audio/wav' },
      body: Buffer.alloc(64),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: 'JIRA says: what time is it',
      transcript: 'what time is it',
      turnId: 'ptt-turn-1',
    });
  });

  it('fails closed for unauthorized, missing, or unconfigured audio', async () => {
    const base = await boot();
    assert.equal((await fetch(`${base}/v1/turns/ptt`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.alloc(64),
    })).status, 401);
    assert.equal((await fetch(`${base}/v1/turns/ptt`, {
      method: 'POST',
      headers: { authorization: 'Bearer device-token', 'content-type': 'audio/wav' },
      body: Buffer.alloc(12),
    })).status, 400);

    const unconfigured = await boot({ configured: false });
    assert.equal((await fetch(`${unconfigured}/v1/turns/ptt`, {
      method: 'POST',
      headers: { authorization: 'Bearer device-token', 'content-type': 'audio/wav' },
      body: Buffer.alloc(64),
    })).status, 503);
  });
});
