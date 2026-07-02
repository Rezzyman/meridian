/**
 * Gateway POST /waitlist — the opt-in landing-page signup target, over a real
 * listening socket. The load-bearing guarantees: the route exists ONLY when
 * armed, it needs no bearer (compensating controls instead), and duplicates
 * answer with the same status code as success.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { silentLogger } from '../helpers/fixtures.js';

const stubConversation = {
  sessionId: 'sess-wl',
  agentSlug: 'stub',
  historyCount: 0,
  send: async () => {
    throw new Error('waitlist tests never run a turn');
  },
} as unknown as Conversation;

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function boot(opts: { armed?: boolean; token?: string } = {}): Promise<{
  base: string;
  dbPath: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wl-'));
  dirs.push(dir);
  const dbPath = join(dir, 'waitlist.jsonl');
  const app = await startGateway({
    port: 0,
    token: opts.token,
    logger: silentLogger,
    conversation: stubConversation,
    ...(opts.armed === false ? {} : { waitlist: { dbPath } }),
  });
  apps.push(app);
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, dbPath };
}

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/waitlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /waitlist', () => {
  it('records a valid signup and persists the normalized entry', async () => {
    const { base, dbPath } = await boot();
    const r = await post(base, { email: 'You@Example.COM', plan: 'secure-memory', note: 'from HN' });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; email: string };
    assert.equal(body.ok, true);
    assert.equal(body.email, 'you@example.com');
    const line = JSON.parse(readFileSync(dbPath, 'utf8').trim()) as Record<string, string>;
    assert.equal(line.email, 'you@example.com');
    assert.equal(line.plan, 'secure-memory');
    assert.equal(line.source, 'gateway');
  });

  it('rejects an invalid email with 400', async () => {
    const { base } = await boot();
    const r = await post(base, { email: 'not-an-email' });
    assert.equal(r.status, 400);
  });

  it('answers a duplicate with the SAME status as success (no membership oracle)', async () => {
    const { base, dbPath } = await boot();
    assert.equal((await post(base, { email: 'dup@example.com' })).status, 200);
    const r2 = await post(base, { email: 'DUP@example.com' });
    assert.equal(r2.status, 200, 'duplicate uses the success status code');
    const body = (await r2.json()) as { ok: boolean; duplicate?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.duplicate, true);
    const lines = readFileSync(dbPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'still exactly one stored entry');
  });

  it('caps field lengths (oversized note → 400)', async () => {
    const { base } = await boot();
    const r = await post(base, { email: 'long@example.com', note: 'x'.repeat(201) });
    assert.equal(r.status, 400);
  });

  it('rate-limits the 11th request in a window from one IP with 429', async () => {
    const { base } = await boot();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await post(base, { email: `user${i}@example.com` });
      last = r.status;
    }
    assert.equal(last, 429);
  });

  it('is a 404 when the gateway is not armed (opt-in, fail closed)', async () => {
    const { base } = await boot({ armed: false });
    const r = await post(base, { email: 'nobody@example.com' });
    assert.equal(r.status, 404);
  });

  it('serves a CORS preflight and marks the POST response cross-origin-readable', async () => {
    const { base } = await boot();
    const pre = await fetch(`${base}/waitlist`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/);
    const r = await post(base, { email: 'cors@example.com' });
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });

  it('needs NO bearer even when the gateway has a token (deliberate decoupling)', async () => {
    const { base } = await boot({ token: 'gw-secret' });
    // No Authorization header on purpose — a landing page cannot hold one.
    const r = await post(base, { email: 'open@example.com' });
    assert.equal(r.status, 200);
    // /chat with the same missing header stays locked (auth untouched).
    const chat = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(chat.status, 401);
  });
});
