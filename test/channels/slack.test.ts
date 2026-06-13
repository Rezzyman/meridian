/**
 * Slack channel — Events API webhook. Deterministic; no real Slack, no network.
 * The security-critical part (request signature verification) is covered
 * exhaustively; the event→turn→reply flow is exercised with a mock fetch.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import {
  SlackChannel,
  splitForSlack,
  verifySlackSignature,
  type FetchLike,
} from '../../src/channels/slack.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as unknown as Logger;
const SECRET = 'top-secret-signing-key';

function sign(rawBody: string, ts: string, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
}

describe('verifySlackSignature', () => {
  const body = JSON.stringify({ type: 'event_callback' });
  const ts = '1700000000';

  it('accepts a correctly signed request', () => {
    assert.equal(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(body, ts), timestamp: ts, rawBody: body, nowSec: 1700000000 }),
      true,
    );
  });

  it('rejects a wrong signing secret', () => {
    assert.equal(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(body, ts, 'other'), timestamp: ts, rawBody: body, nowSec: 1700000000 }),
      false,
    );
  });

  it('rejects a tampered body', () => {
    const sig = sign(body, ts);
    assert.equal(
      verifySlackSignature({ signingSecret: SECRET, signature: sig, timestamp: ts, rawBody: `${body} `, nowSec: 1700000000 }),
      false,
    );
  });

  it('rejects a stale timestamp (replay protection)', () => {
    assert.equal(
      verifySlackSignature({ signingSecret: SECRET, signature: sign(body, ts), timestamp: ts, rawBody: body, nowSec: 1700000000 + 1000 }),
      false,
    );
  });

  it('rejects missing signature / timestamp / non-numeric ts', () => {
    assert.equal(verifySlackSignature({ signingSecret: SECRET, signature: undefined, timestamp: ts, rawBody: body }), false);
    assert.equal(verifySlackSignature({ signingSecret: SECRET, signature: sign(body, ts), timestamp: undefined, rawBody: body }), false);
    assert.equal(verifySlackSignature({ signingSecret: SECRET, signature: sign(body, 'abc'), timestamp: 'abc', rawBody: body, nowSec: 1700000000 }), false);
  });
});

function mockFetch(): { fetchImpl: FetchLike; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse((init.body as string) ?? '{}') });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { fetchImpl, calls };
}

function makeChannel(opts: { allowedChannels?: string[] } = {}) {
  const { fetchImpl, calls } = mockFetch();
  const seen: string[] = [];
  const ch = new SlackChannel({
    botToken: 'xoxb-test',
    signingSecret: SECRET,
    allowedChannels: opts.allowedChannels,
    logger: silent,
    fetchImpl,
  });
  ch.start(undefined, {
    onInbound: async (m) => {
      seen.push(`${m.from}:${m.text}`);
      return `echo: ${m.text}`;
    },
  });
  return { ch, calls, seen };
}

describe('SlackChannel.handleRequest', () => {
  it('answers the url_verification handshake', () => {
    const { ch } = makeChannel();
    const r = ch.handleRequest(JSON.stringify({ type: 'url_verification', challenge: 'abc123' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { challenge: 'abc123' });
  });

  it('runs the turn and posts the reply for a user message', async () => {
    const { ch, calls, seen } = makeChannel();
    const r = ch.handleRequest(
      JSON.stringify({ type: 'event_callback', event_id: 'Ev1', event: { type: 'message', user: 'U1', text: 'hello', channel: 'C1' } }),
    );
    assert.equal(r.status, 200);
    await r.done;
    assert.deepEqual(seen, ['U1:hello'], 'onInbound ran with the message');
    assert.equal(calls.length, 1, 'one chat.postMessage');
    assert.match(calls[0].url, /chat\.postMessage/);
    assert.deepEqual(calls[0].body, { channel: 'C1', text: 'echo: hello' });
  });

  it("ignores the bot's own messages and edits (no turn, no post)", async () => {
    const { ch, calls, seen } = makeChannel();
    const a = ch.handleRequest(JSON.stringify({ type: 'event_callback', event_id: 'b', event: { type: 'message', bot_id: 'B9', text: 'i am a bot', channel: 'C1' } }));
    const b = ch.handleRequest(JSON.stringify({ type: 'event_callback', event_id: 'e', event: { type: 'message', subtype: 'message_changed', text: 'edited', channel: 'C1' } }));
    await Promise.all([a.done, b.done]);
    assert.deepEqual(seen, []);
    assert.equal(calls.length, 0);
  });

  it('honors the channel allowlist', async () => {
    const { ch, seen } = makeChannel({ allowedChannels: ['CALLOWED'] });
    const blocked = ch.handleRequest(JSON.stringify({ type: 'event_callback', event_id: '1', event: { type: 'message', user: 'U', text: 'hi', channel: 'COTHER' } }));
    await blocked.done;
    assert.deepEqual(seen, [], 'non-allowlisted channel ignored');
    const ok = ch.handleRequest(JSON.stringify({ type: 'event_callback', event_id: '2', event: { type: 'message', user: 'U', text: 'hi', channel: 'CALLOWED' } }));
    await ok.done;
    assert.deepEqual(seen, ['U:hi']);
  });

  it('dedups Slack retries by event_id', async () => {
    const { ch, seen } = makeChannel();
    const ev = JSON.stringify({ type: 'event_callback', event_id: 'SAME', event: { type: 'message', user: 'U', text: 'once', channel: 'C1' } });
    const r1 = ch.handleRequest(ev);
    const r2 = ch.handleRequest(ev);
    await Promise.all([r1.done, r2.done]);
    assert.deepEqual(r2.body, { ok: true, dedup: true });
    assert.deepEqual(seen, ['U:once'], 'turn ran exactly once');
  });

  it('returns 400 on invalid JSON', () => {
    const { ch } = makeChannel();
    assert.equal(ch.handleRequest('{not json').status, 400);
  });
});

describe('splitForSlack', () => {
  it('keeps short text whole and splits long text', () => {
    assert.deepEqual(splitForSlack('hi'), ['hi']);
    const long = 'word '.repeat(2000);
    const parts = splitForSlack(long);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 3500));
  });
});
