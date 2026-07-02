/**
 * Gateway --web: serving the bundled chat UI at / and /chat.html, opt-in only.
 * The shipped file must be the STREAMING page (it references /chat/stream),
 * and enabling the web surface must not touch /chat auth.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { silentLogger } from '../helpers/fixtures.js';

const CHAT_HTML = resolve(dirname(fileURLToPath(import.meta.url)), '../../skeleton/web/chat.html');

const stubConversation = {
  sessionId: 'sess-web',
  agentSlug: 'stub',
  historyCount: 0,
  send: async () => ({
    id: 't_stub',
    sessionId: 'sess-web',
    role: 'assistant' as const,
    content: 'ok',
    channel: 'gateway' as const,
    ts: '2026-07-02T00:00:00.000Z',
  }),
} as unknown as Conversation;

const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

async function boot(opts: { web?: boolean; token?: string } = {}): Promise<string> {
  const app = await startGateway({
    port: 0,
    token: opts.token,
    logger: silentLogger,
    conversation: stubConversation,
    ...(opts.web ? { web: { htmlPath: CHAT_HTML } } : {}),
  });
  apps.push(app);
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

describe('gateway web chat serving', () => {
  it('GET / serves the streaming chat UI as text/html when armed', async () => {
    const base = await boot({ web: true });
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const body = await r.text();
    assert.match(body, /Meridian/);
    assert.match(body, /chat\/stream/, 'the shipped page is the streaming version');
  });

  it('GET /chat.html serves the same page', async () => {
    const base = await boot({ web: true });
    const r = await fetch(`${base}/chat.html`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /same-origin/i, 'autoconfig bootstrap is present');
  });

  it('stays API-only (404) when web is not armed', async () => {
    const base = await boot();
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/chat.html`)).status, 404);
  });

  it('serving the web page does not weaken /chat auth', async () => {
    const base = await boot({ web: true, token: 'gw-secret' });
    const unauth = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(unauth.status, 401);
    const authed = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer gw-secret' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(authed.status, 200);
  });
});
