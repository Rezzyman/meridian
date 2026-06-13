/**
 * Discord channel — Interactions endpoint. Deterministic; no real Discord.
 * Ed25519 signature verification is covered with a generated keypair; the
 * PING/PONG and deferred-command-then-follow-up flow with a mock fetch.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import type { FetchLike } from '../../src/channels/slack.js';
import { DiscordChannel, splitForDiscord, verifyDiscordSignature } from '../../src/channels/discord.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as unknown as Logger;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_HEX = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(12).toString('hex');
function signReq(ts: string, body: string): string {
  return Buffer.from(edSign(null, Buffer.from(ts + body), privateKey)).toString('hex');
}

describe('verifyDiscordSignature', () => {
  const body = JSON.stringify({ type: 1 });
  const ts = '1700000000';

  it('accepts a correctly signed request', () => {
    assert.equal(verifyDiscordSignature({ publicKey: PUB_HEX, signature: signReq(ts, body), timestamp: ts, rawBody: body }), true);
  });
  it('rejects a tampered body', () => {
    assert.equal(verifyDiscordSignature({ publicKey: PUB_HEX, signature: signReq(ts, body), timestamp: ts, rawBody: `${body} ` }), false);
  });
  it('rejects a foreign key', () => {
    const other = generateKeyPairSync('ed25519');
    const otherHex = Buffer.from(other.publicKey.export({ type: 'spki', format: 'der' })).subarray(12).toString('hex');
    assert.equal(verifyDiscordSignature({ publicKey: otherHex, signature: signReq(ts, body), timestamp: ts, rawBody: body }), false);
  });
  it('rejects missing parts / bad hex', () => {
    assert.equal(verifyDiscordSignature({ publicKey: PUB_HEX, signature: undefined, timestamp: ts, rawBody: body }), false);
    assert.equal(verifyDiscordSignature({ publicKey: 'zz', signature: signReq(ts, body), timestamp: ts, rawBody: body }), false);
  });
});

function mockFetch(): { fetchImpl: FetchLike; calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: String(init.method), body: JSON.parse((init.body as string) ?? '{}') });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

function makeChannel() {
  const { fetchImpl, calls } = mockFetch();
  const seen: string[] = [];
  const ch = new DiscordChannel({ publicKey: PUB_HEX, applicationId: 'app-default', logger: silent, fetchImpl });
  ch.start(undefined, {
    onInbound: async (m) => {
      seen.push(`${m.from}:${m.text}`);
      return `echo: ${m.text}`;
    },
  });
  return { ch, calls, seen };
}

describe('DiscordChannel.handleRequest', () => {
  it('answers PING with PONG', () => {
    const { ch } = makeChannel();
    const r = ch.handleRequest(JSON.stringify({ type: 1 }));
    assert.deepEqual(r.body, { type: 1 });
  });

  it('defers a slash command and edits the original with the reply', async () => {
    const { ch, calls, seen } = makeChannel();
    const r = ch.handleRequest(
      JSON.stringify({
        type: 2,
        token: 'tok',
        application_id: 'app123',
        data: { name: 'meridian', options: [{ name: 'message', type: 3, value: 'hello there' }] },
        member: { user: { id: 'U1', username: 'rez' } },
        channel_id: 'C1',
      }),
    );
    assert.deepEqual(r.body, { type: 5 }, 'immediate deferred ack');
    await r.done;
    assert.deepEqual(seen, ['U1:hello there'], 'turn ran with the command text');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.match(calls[0].url, /webhooks\/app123\/tok\/messages\/@original$/);
    assert.deepEqual(calls[0].body, { content: 'echo: hello there' });
  });

  it('prompts for usage when the command has no text', async () => {
    const { ch, seen } = makeChannel();
    const r = ch.handleRequest(JSON.stringify({ type: 2, token: 't', application_id: 'a', data: { name: 'x', options: [] } }));
    assert.equal((r.body as { type: number }).type, 4);
    await r.done;
    assert.deepEqual(seen, []);
  });

  it('returns 400 on invalid JSON', () => {
    const { ch } = makeChannel();
    assert.equal(ch.handleRequest('{bad').status, 400);
  });
});

describe('splitForDiscord', () => {
  it('respects the 2000-char limit', () => {
    const parts = splitForDiscord('x '.repeat(2000));
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1900));
  });
});
