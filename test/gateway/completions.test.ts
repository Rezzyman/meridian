import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

function stub(): { conversation: Conversation; calls: Array<{ input: string; opts: unknown }> } {
  const calls: Array<{ input: string; opts: unknown }> = [];
  const conversation = {
    sessionId: 'sess',
    agentSlug: 'arlo',
    historyCount: 0,
    send: async (input: string, opts: unknown) => {
      calls.push({ input, opts });
      return {
        id: 't1',
        sessionId: 'sess',
        role: 'assistant',
        content: `echo: ${input}`,
        channel: 'gateway',
        ts: new Date().toISOString(),
      };
    },
  } as unknown as Conversation;
  return { conversation, calls };
}

async function boot(
  conversation: Conversation,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const app = await startGateway({
    port: 0,
    token: 'tok',
    logger: silentLogger,
    conversation,
    ...extra,
  });
  apps.push(app);
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok', ...headers },
    body: JSON.stringify(body),
  });

describe('OpenAI-compatible /v1/chat/completions (WS5d)', () => {
  it('requires the bearer and rejects streaming', async () => {
    const { conversation } = stub();
    const base = await boot(conversation);
    const unauth = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauth.status, 401);
    const streaming = await post(base, {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(streaming.status, 400);
    const noUser = await post(base, { messages: [{ role: 'system', content: 'x' }] });
    assert.equal(noUser.status, 400);
  });

  it('answers in the OpenAI shape from the last user message', async () => {
    const { conversation, calls } = stub();
    const base = await boot(conversation);
    const res = await post(base, {
      model: 'anything',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'what day is the lawn service?' }] },
      ],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      meridian: { isolated: boolean };
    };
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0]?.message.role, 'assistant');
    assert.equal(body.choices[0]?.message.content, 'echo: what day is the lawn service?');
    assert.equal(body.choices[0]?.finish_reason, 'stop');
    assert.equal(body.meridian.isolated, false);
    assert.equal(calls[0]?.input, 'what day is the lawn service?');
    assert.equal(calls[0]?.opts, undefined);
  });

  it('the isolation header makes the turn tool-free and memory-write-free with system messages as policy', async () => {
    const { conversation, calls } = stub();
    const base = await boot(conversation);
    const res = await post(
      base,
      {
        messages: [
          { role: 'system', content: 'Cite only [segment:UUID].' },
          { role: 'user', content: 'q' },
        ],
      },
      { 'x-meridian-isolation': 'loop' },
    );
    assert.equal(res.status, 200);
    const opts = calls[0]?.opts as {
      isolation: { disableTools: boolean; disableMemoryWrite: boolean; systemPolicy: string };
    };
    assert.equal(opts.isolation.disableTools, true);
    assert.equal(opts.isolation.disableMemoryWrite, true);
    assert.match(opts.isolation.systemPolicy, /segment:UUID/);
  });

  it('a dedicated Loop gateway forces isolation without any header', async () => {
    const { conversation, calls } = stub();
    const base = await boot(conversation, { completionsIsolation: 'loop' });
    await post(base, { messages: [{ role: 'user', content: 'q' }] });
    const opts = calls[0]?.opts as { isolation: { disableTools: boolean } };
    assert.equal(opts.isolation.disableTools, true);
  });
});

describe('stateless completions (WS5d)', () => {
  it('uses a fresh conversation seeded with prior messages, never the shared session', async () => {
    const seen: Array<{ input: string; history: Array<{ role: string; content: string }> }> = [];
    const { conversation, calls } = stub();
    const base = await boot(conversation, {
      completions: async (
        input: string,
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
      ) => {
        seen.push({ input, history });
        return { id: 'c1', content: `fresh: ${input}` };
      },
    });
    const res = await post(base, {
      messages: [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    });
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, 'fresh: second');
    assert.equal(calls.length, 0, 'shared session untouched');
    assert.equal(seen[0]?.input, 'second');
    assert.deepEqual(seen[0]?.history, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});
