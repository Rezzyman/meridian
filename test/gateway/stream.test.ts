/**
 * Gateway /chat/stream — live SSE over a real listening socket. A stub
 * Conversation drives the event sequence; assertions cover frame format,
 * ordering, the canonical done event, auth parity with /chat, and
 * back-compat of the blocking endpoint.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import type { TurnStreamEvent } from '../../src/agent/turn.js';
import { startGateway } from '../../src/gateway/server.js';
import { silentLogger } from '../helpers/fixtures.js';

type SendOpts = { onStreamEvent?: (ev: TurnStreamEvent) => void };

function stubConversation(
  script: (input: string, emit: (ev: TurnStreamEvent) => void) => Promise<string>,
): Conversation {
  return {
    sessionId: 'sess-1',
    agentSlug: 'stub',
    historyCount: 0,
    send: async (input: string, opts?: SendOpts) => {
      const reply = await script(input, (ev) => opts?.onStreamEvent?.(ev));
      return {
        id: 't_stub',
        sessionId: 'sess-1',
        role: 'assistant' as const,
        content: reply,
        channel: 'gateway' as const,
        ts: '2026-06-11T00:00:00.000Z',
      };
    },
  } as unknown as Conversation;
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(raw: string): Frame[] {
  return raw
    .split('\n\n')
    .filter((f) => f.trim())
    .map((frame) => {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      return { event, data: data ? JSON.parse(data) : {} };
    });
}

const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

async function boot(conversation: Conversation, token?: string): Promise<string> {
  const app = await startGateway({ port: 0, token, logger: silentLogger, conversation });
  apps.push(app);
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

describe('POST /chat/stream', () => {
  it('streams deltas then a canonical done event', async () => {
    const base = await boot(
      stubConversation(async (_input, emit) => {
        emit({ type: 'delta', text: 'Hel' });
        emit({ type: 'delta', text: 'lo' });
        return 'Hello\n\n✓ logged: canonical';
      }),
    );
    const res = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const frames = parseSse(await res.text());
    assert.deepEqual(
      frames.map((f) => f.event),
      ['delta', 'delta', 'done'],
    );
    assert.equal(frames[0].data.text, 'Hel');
    assert.equal(frames[1].data.text, 'lo');
    // done carries the post-processed reply, not the concatenated deltas.
    assert.equal(frames[2].data.reply, 'Hello\n\n✓ logged: canonical');
    assert.equal(frames[2].data.turnId, 't_stub');
  });

  it('forwards reset and tool events in order', async () => {
    const base = await boot(
      stubConversation(async (_input, emit) => {
        emit({ type: 'delta', text: 'doomed partial' });
        emit({ type: 'reset' });
        emit({ type: 'tool', name: 'web_fetch' });
        emit({ type: 'delta', text: 'final' });
        return 'final';
      }),
    );
    const res = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    const frames = parseSse(await res.text());
    assert.deepEqual(
      frames.map((f) => f.event),
      ['delta', 'reset', 'tool', 'delta', 'done'],
    );
    assert.equal(frames[2].data.name, 'web_fetch');
  });

  it('a failing turn emits an error event, not a broken socket', async () => {
    const base = await boot(
      stubConversation(async () => {
        throw new Error('All providers failed. boom');
      }),
    );
    const res = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(res.status, 200);
    const frames = parseSse(await res.text());
    assert.deepEqual(
      frames.map((f) => f.event),
      ['error'],
    );
    // RULE ZERO: the frame carries the sanitized surface, never provider text.
    assert.match(String(frames[0].data.error), /Quick hiccup on my end/);
    assert.doesNotMatch(String(frames[0].data.error), /providers failed|boom/);
  });

  it('enforces the same bearer auth as /chat', async () => {
    const base = await boot(
      stubConversation(async () => 'never'),
      'sekrit-token',
    );
    const unauth = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(unauth.status, 401);

    const authed = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sekrit-token',
      },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(authed.status, 200);
  });

  it('rejects a missing input with 400 JSON (no stream started)', async () => {
    const base = await boot(stubConversation(async () => 'x'));
    const res = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'input required' });
  });

  it('/chat back-compat is untouched: blocking JSON in one shot', async () => {
    const base = await boot(stubConversation(async () => 'blocking reply'));
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { reply: string; turnId: string };
    assert.equal(json.reply, 'blocking reply');
    assert.equal(json.turnId, 't_stub');
  });
});
