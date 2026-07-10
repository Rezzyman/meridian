/**
 * Gateway /ingest — the opt-in, token-gated document drop for external upload
 * portals. Covers: route absent unless armed, dedicated-token auth (gateway
 * token must NOT work), path-traversal-proof filenames, base64 decode, size
 * caps, and atomic landing in the inbox dir (no .part files left behind).
 * Also: /chat/stream error frames carry the sanitized message, never raw
 * provider text.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { GENERIC_HICCUP_MESSAGE } from '../../src/safety/error-firewall.js';
import { silentLogger } from '../helpers/fixtures.js';

const stubConversation = (send?: () => Promise<never>): Conversation =>
  ({
    sessionId: 'sess-1',
    agentSlug: 'stub',
    historyCount: 0,
    send:
      send ??
      (async () => {
        throw new Error('unused');
      }),
  }) as unknown as Conversation;

const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

async function boot(opts: Partial<Parameters<typeof startGateway>[0]> = {}): Promise<string> {
  const app = await startGateway({
    port: 0,
    logger: silentLogger,
    conversation: stubConversation(),
    ...opts,
  });
  apps.push(app);
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

const post = (
  base: string,
  body: unknown,
  token?: string,
): Promise<Response> =>
  fetch(`${base}/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe('gateway /ingest', () => {
  it('is absent when not armed', async () => {
    const base = await boot();
    const res = await post(base, { filename: 'a.txt', content: 'hi' }, 'x');
    assert.equal(res.status, 404);
  });

  it('rejects a missing or WRONG token — the operator gateway token does not open it', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'ingest-'));
    const base = await boot({
      token: 'operator-token',
      ingest: { inboxDir, token: 'ingest-token' },
    });
    const anon = await post(base, { filename: 'a.txt', content: 'hi' });
    assert.equal(anon.status, 401);
    const opTok = await post(base, { filename: 'a.txt', content: 'hi' }, 'operator-token');
    assert.equal(opTok.status, 401);
  });

  it('lands a utf8 document in the inbox with a traversal-proof name', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'ingest-'));
    const base = await boot({ ingest: { inboxDir, token: 'tok' } });
    const res = await post(
      base,
      { filename: '../../etc/passwd', content: 'survey text' },
      'tok',
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; file: string };
    assert.ok(body.ok);
    assert.ok(!body.file.includes('/') && !body.file.includes('..'));
    const files = readdirSync(inboxDir);
    assert.equal(files.length, 1);
    assert.ok(!files[0].endsWith('.part'));
    assert.equal(readFileSync(join(inboxDir, files[0]), 'utf8'), 'survey text');
  });

  it('decodes base64 content', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'ingest-'));
    const base = await boot({ ingest: { inboxDir, token: 'tok' } });
    const res = await post(
      base,
      {
        filename: 'report.pdf',
        content: Buffer.from('binary-ish').toString('base64'),
        encoding: 'base64',
      },
      'tok',
    );
    assert.equal(res.status, 200);
    const files = readdirSync(inboxDir);
    assert.equal(readFileSync(join(inboxDir, files[0]), 'utf8'), 'binary-ish');
  });

  it('rejects empty content and dotfile names', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'ingest-'));
    const base = await boot({ ingest: { inboxDir, token: 'tok' } });
    assert.equal((await post(base, { filename: 'a.txt', content: '' }, 'tok')).status, 400);
    assert.equal(
      (await post(base, { filename: '...', content: 'x' }, 'tok')).status,
      400,
    );
  });
});

describe('gateway /chat/stream error frame', () => {
  it('carries the sanitized message, never raw provider text', async () => {
    const base = await boot({
      conversation: stubConversation(async () => {
        throw new Error('anthropic 402: insufficient credits at api.anthropic.com');
      }),
    });
    const res = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    const raw = await res.text();
    assert.ok(raw.includes('event: error'));
    assert.ok(raw.includes(JSON.stringify(GENERIC_HICCUP_MESSAGE).slice(1, 20)));
    assert.ok(!raw.includes('anthropic'));
    assert.ok(!raw.includes('402'));
  });
});
