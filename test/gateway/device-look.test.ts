import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { localOllamaImageDescriber, parseDeviceLookMultipart } from '../../src/gateway/device-media.js';
import { silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => Promise.all(apps.map((app) => app.close())));

function multipart(boundary: string, prompt: string, frame: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ prompt })}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="frame"; filename="frame.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    frame,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function boot(): Promise<string> {
  const conversation = {
    sessionId: 'look-test',
    agentSlug: 'jira',
    historyCount: 0,
    send: async (input: string) => ({
      id: 'look-turn-1',
      sessionId: 'look-test',
      role: 'assistant' as const,
      content: `JIRA combined: ${input}`,
      channel: 'gateway' as const,
      ts: '2026-07-29T15:00:00.000Z',
    }),
  } as unknown as Conversation;
  const app = await startGateway({
    port: 0,
    token: 'device-token',
    logger: silentLogger,
    conversation,
    describeImage: async (frame, prompt) => {
      assert.equal(frame.toString('hex'), Buffer.alloc(32, 7).toString('hex'));
      assert.equal(prompt, 'What is this?');
      return 'A red toy rabbit on a table.';
    },
  });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('gateway did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('POST /v1/turns/look', () => {
  it('parses the Android frame, describes it locally, and sends the observation through JIRA', async () => {
    const base = await boot();
    const boundary = 'meridian-test-boundary';
    const response = await fetch(`${base}/v1/turns/look`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer device-token',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipart(boundary, 'What is this?', Buffer.alloc(32, 7)),
    });
    assert.equal(response.status, 200);
    const json = await response.json() as { text: string; observation: string; turnId: string };
    assert.equal(json.observation, 'A red toy rabbit on a table.');
    assert.match(json.text, /Visual observation from the R1 camera/);
    assert.equal(json.turnId, 'look-turn-1');
  });
});

describe('local Ollama vision adapter', () => {
  it('sends base64 image bytes using Ollama’s native vision contract', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const describe = localOllamaImageDescriber({
      model: 'vision-test',
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ message: { content: 'A cat.' } }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(await describe(Buffer.from('this-is-image-bytes'), 'What do you see?'), 'A cat.');
    assert.equal(requestBody?.model, 'vision-test');
    const messages = requestBody?.messages as Array<{ images: string[] }>;
    assert.equal(messages[0].images[0], Buffer.from('this-is-image-bytes').toString('base64'));
  });

  it('rejects malformed multipart instead of guessing', () => {
    assert.throws(() => parseDeviceLookMultipart(Buffer.from('garbage'), 'boundary'));
  });
});
