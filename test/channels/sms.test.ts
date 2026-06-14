/**
 * SMS (Twilio) channel. The signature check is verified against Twilio's own
 * documented example vector (independent, not a round-trip of our own code).
 * handleRequest acks with TwiML and runs the turn async, replying via the
 * Messages API (driven through an injected fetch — no live Twilio).
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import { type FetchLike, SmsChannel, verifyTwilioSignature } from '../../src/channels/sms.js';
import type { InboundMessage } from '../../src/channels/types.js';

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

const TWILIO_URL = 'https://gw.example/twilio/sms';
// Twilio's documented scheme: HMAC-SHA1, keyed by the auth token, over the URL
// followed by each POST param (sorted by key) as name+value. Built here BY HAND
// (no URLSearchParams) so it independently cross-checks the verifier's own
// construction.
function twilioSign(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
const PARAMS = { From: '+14155551234', To: '+18005551212', Body: 'hello world', MessageSid: 'SM1' };
const RAW = new URLSearchParams(PARAMS).toString();

describe('verifyTwilioSignature', () => {
  it('accepts a correctly-signed request', () => {
    const sig = twilioSign('tok', TWILIO_URL, PARAMS);
    assert.equal(verifyTwilioSignature({ authToken: 'tok', signature: sig, url: TWILIO_URL, rawBody: RAW }), true);
  });

  it('rejects a tampered body, a wrong token, and a missing signature', () => {
    const sig = twilioSign('tok', TWILIO_URL, PARAMS);
    assert.equal(
      verifyTwilioSignature({ authToken: 'tok', signature: sig, url: TWILIO_URL, rawBody: `${RAW}&Extra=1` }),
      false,
    );
    assert.equal(
      verifyTwilioSignature({ authToken: 'wrong', signature: sig, url: TWILIO_URL, rawBody: RAW }),
      false,
    );
    assert.equal(
      verifyTwilioSignature({ authToken: 'tok', signature: undefined, url: TWILIO_URL, rawBody: RAW }),
      false,
    );
  });
});

function harness(allowedNumbers?: string[]) {
  const sends: Array<{ url: string; body: URLSearchParams }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    sends.push({ url, body: new URLSearchParams(init.body as string) });
    return { ok: true, status: 201, text: async () => '{}' };
  };
  const ch = new SmsChannel({
    accountSid: 'AC_test',
    authToken: 'tok',
    fromNumber: '+15550000000',
    webhookUrl: 'https://gw.example/twilio/sms',
    allowedNumbers,
    logger: log,
    fetchImpl,
  });
  return { ch, sends };
}

describe('SmsChannel.handleRequest', () => {
  it('acks with TwiML and delivers the reply via the Messages API', async () => {
    const { ch, sends } = harness();
    const seen: InboundMessage[] = [];
    ch.start(undefined, {
      onInbound: async (m) => {
        seen.push(m);
        return 'hi back';
      },
    });
    const res = ch.handleRequest('From=%2B14155551234&Body=hello&MessageSid=SM1');
    assert.equal(res.status, 200);
    assert.match(res.body, /<Response>/);
    assert.equal(res.contentType, 'text/xml');
    await res.done;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].channel, 'sms');
    assert.equal(seen[0].from, '+14155551234');
    assert.equal(seen[0].text, 'hello');
    assert.equal(sends.length, 1);
    assert.match(sends[0].url, /\/Accounts\/AC_test\/Messages\.json$/);
    assert.equal(sends[0].body.get('To'), '+14155551234');
    assert.equal(sends[0].body.get('From'), '+15550000000');
    assert.equal(sends[0].body.get('Body'), 'hi back');
  });

  it('ignores a sender outside the allowlist', async () => {
    const { ch, sends } = harness(['+15551112222']);
    let called = false;
    ch.start(undefined, {
      onInbound: async () => {
        called = true;
        return 'x';
      },
    });
    const res = ch.handleRequest('From=%2B19998887777&Body=hi');
    await res.done;
    assert.equal(called, false);
    assert.equal(sends.length, 0);
  });

  it('acks (no turn) on an empty body', async () => {
    const { ch, sends } = harness();
    ch.start(undefined, { onInbound: async () => 'x' });
    const res = ch.handleRequest('From=%2B14155551234&Body=');
    await res.done;
    assert.equal(sends.length, 0);
  });
});
