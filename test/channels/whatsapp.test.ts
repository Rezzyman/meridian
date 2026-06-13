/**
 * WhatsApp channel — Meta Cloud API webhook. Deterministic; no real Meta.
 * Covers the HMAC signature, the GET verification handshake, and the
 * message→turn→Graph-send flow with a mock fetch.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import type { FetchLike } from '../../src/channels/slack.js';
import {
  WhatsappChannel,
  splitForWhatsapp,
  verifyWhatsappSignature,
} from '../../src/channels/whatsapp.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as unknown as Logger;
const APP_SECRET = 'meta-app-secret';

function sign(rawBody: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function textPayload(from: string, body: string, id = 'wamid.1'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'PNID' },
      contacts: [{ profile: { name: 'Rez' }, wa_id: from }],
      messages: [{ from, id, type: 'text', text: { body } }],
    } }] }],
  });
}

describe('verifyWhatsappSignature', () => {
  const body = textPayload('15551230000', 'hi');
  it('accepts a correct sha256= signature', () => {
    assert.equal(verifyWhatsappSignature({ appSecret: APP_SECRET, signature: sign(body), rawBody: body }), true);
  });
  it('rejects wrong secret / tampered body / no prefix / missing', () => {
    assert.equal(verifyWhatsappSignature({ appSecret: APP_SECRET, signature: sign(body, 'other'), rawBody: body }), false);
    assert.equal(verifyWhatsappSignature({ appSecret: APP_SECRET, signature: sign(body), rawBody: `${body} ` }), false);
    assert.equal(verifyWhatsappSignature({ appSecret: APP_SECRET, signature: createHmac('sha256', APP_SECRET).update(body).digest('hex'), rawBody: body }), false);
    assert.equal(verifyWhatsappSignature({ appSecret: APP_SECRET, signature: undefined, rawBody: body }), false);
  });
});

function makeChannel(opts: { allowedNumbers?: string[] } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse((init.body as string) ?? '{}') });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const seen: string[] = [];
  const ch = new WhatsappChannel({
    phoneNumberId: 'PNID', accessToken: 'tok', appSecret: APP_SECRET, verifyToken: 'verify-me',
    allowedNumbers: opts.allowedNumbers, logger: silent, fetchImpl,
  });
  ch.start(undefined, { onInbound: async (m) => { seen.push(`${m.from}:${m.text}`); return `echo: ${m.text}`; } });
  return { ch, calls, seen };
}

describe('WhatsappChannel.handleVerification', () => {
  it('echoes the challenge on a matching verify token', () => {
    const { ch } = makeChannel();
    assert.equal(ch.handleVerification('subscribe', 'verify-me', 'CHAL'), 'CHAL');
  });
  it('returns null on a mismatched token or wrong mode', () => {
    const { ch } = makeChannel();
    assert.equal(ch.handleVerification('subscribe', 'wrong', 'CHAL'), null);
    assert.equal(ch.handleVerification('unsubscribe', 'verify-me', 'CHAL'), null);
  });
});

describe('WhatsappChannel.handleRequest', () => {
  it('runs the turn and sends the reply via the Graph API', async () => {
    const { ch, calls, seen } = makeChannel();
    const r = ch.handleRequest(textPayload('15551230000', 'hello'));
    assert.equal(r.status, 200);
    await r.done;
    assert.deepEqual(seen, ['15551230000:hello']);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/PNID\/messages$/);
    assert.deepEqual(calls[0].body, { messaging_product: 'whatsapp', to: '15551230000', type: 'text', text: { body: 'echo: hello' } });
  });

  it('ignores delivery-status payloads (no messages)', async () => {
    const { ch, seen } = makeChannel();
    const r = ch.handleRequest(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] }));
    await r.done;
    assert.deepEqual(seen, []);
  });

  it('honors the number allowlist', async () => {
    const { ch, seen } = makeChannel({ allowedNumbers: ['15550001111'] });
    await ch.handleRequest(textPayload('15559999999', 'blocked')).done;
    assert.deepEqual(seen, []);
    await ch.handleRequest(textPayload('15550001111', 'allowed', 'wamid.2')).done;
    assert.deepEqual(seen, ['15550001111:allowed']);
  });

  it('dedups by message id', async () => {
    const { ch, seen } = makeChannel();
    const p = textPayload('15551230000', 'once', 'wamid.SAME');
    await ch.handleRequest(p).done;
    await ch.handleRequest(p).done;
    assert.deepEqual(seen, ['15551230000:once']);
  });

  it('returns 400 on invalid JSON', () => {
    const { ch } = makeChannel();
    assert.equal(ch.handleRequest('{bad').status, 400);
  });
});

describe('splitForWhatsapp', () => {
  it('respects the ~4096-char limit', () => {
    const parts = splitForWhatsapp('w '.repeat(3000));
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4000));
  });
});
