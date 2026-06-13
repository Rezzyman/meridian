/**
 * SMS channel adapter — Twilio Programmable Messaging over the gateway webhook.
 *
 * Flow:
 *   1. Twilio POSTs an inbound SMS (application/x-www-form-urlencoded) to
 *      /twilio/sms on the gateway.
 *   2. We verify the X-Twilio-Signature (HMAC-SHA1 over the exact public URL +
 *      the POST params sorted by name, keyed by the account auth token).
 *   3. We ack immediately with empty TwiML (Twilio is happy) and run the turn
 *      ASYNC — so a slow agentic turn never blocks or times out the webhook —
 *      then deliver the reply via the Messages REST API.
 *
 * Trust model: an optional `allowedNumbers` allowlist restricts who can text
 * the agent. No new dependencies — `fetch` + `node:crypto` only.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';

/**
 * Verify an inbound Twilio request signature. The signature is the base64
 * HMAC-SHA1, keyed by the account auth token, over the full public request URL
 * concatenated with each POST parameter name+value in name-sorted order. Pure +
 * exported for testing.
 */
export function verifyTwilioSignature(input: {
  authToken: string;
  signature: string | undefined;
  /** The exact public URL Twilio was configured to POST to. */
  url: string;
  /** The raw application/x-www-form-urlencoded body. */
  rawBody: string;
}): boolean {
  const { authToken, signature, url, rawBody } = input;
  if (!signature) return false;
  const params = new URLSearchParams(rawBody);
  let data = url;
  for (const key of [...params.keys()].sort()) data += key + (params.get(key) ?? '');
  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type FetchLike = (
  url: string,
  init: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SmsChannelOptions {
  accountSid: string;
  authToken: string;
  /** The agent's Twilio number, used as the From on replies. */
  fromNumber: string;
  /** The exact public URL Twilio POSTs to — required for signature checks. */
  webhookUrl: string;
  /** Optional sender allowlist (E.164); empty = anyone. */
  allowedNumbers?: string[];
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface SmsHandleResult {
  status: number;
  /** TwiML ack body. */
  body: string;
  contentType: string;
  /** Resolves when the async turn + reply send is done (tests await it). */
  done: Promise<void>;
}

const ACK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const DONE = Promise.resolve();
const SMS_MAX = 1500; // keep replies to a few segments

export class SmsChannel implements ChannelAdapter {
  readonly name = 'sms';
  private handler: ((m: InboundMessage) => Promise<string>) | null = null;
  private readonly allow: Set<string>;
  private readonly fetchImpl: FetchLike;

  constructor(private opts: SmsChannelOptions) {
    this.allow = new Set((opts.allowedNumbers ?? []).filter(Boolean));
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  start(_c: unknown, opts: { onInbound: (m: InboundMessage) => Promise<string> }): void {
    this.handler = opts.onInbound;
    this.opts.logger.info({
      msg: 'sms channel started',
      from: this.opts.fromNumber,
      allowedNumbers: this.allow.size ? [...this.allow] : '(anyone)',
    });
  }

  stop(): void {
    this.handler = null;
  }

  verifySignature(rawBody: string, signature?: string): boolean {
    return verifyTwilioSignature({
      authToken: this.opts.authToken,
      signature,
      url: this.opts.webhookUrl,
      rawBody,
    });
  }

  /** Handle a verified inbound SMS (urlencoded body). Acks with TwiML now; runs
   *  the turn + reply async. Signature verification is the caller's job. */
  handleRequest(rawBody: string): SmsHandleResult {
    const params = new URLSearchParams(rawBody);
    const from = (params.get('From') ?? '').trim();
    const text = (params.get('Body') ?? '').trim();
    const ack: SmsHandleResult = { status: 200, body: ACK, contentType: 'text/xml', done: DONE };
    if (!from || !text || !this.handler) return ack;
    if (this.allow.size > 0 && !this.allow.has(from)) {
      this.opts.logger.warn({ msg: 'sms from non-allowlisted number ignored', from });
      return ack;
    }
    const done = (async () => {
      try {
        const reply = await this.handler!({
          channel: 'sms',
          from,
          text,
          meta: { messageSid: params.get('MessageSid') ?? undefined },
        });
        await this.sendSms(from, reply);
      } catch (err) {
        this.opts.logger.error({ msg: 'sms inbound error', err });
        await this.sendSms(from, 'Something went wrong on my end. I have logged it.').catch(() => {});
      }
    })();
    return { ...ack, done };
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.sendSms(msg.to, msg.text);
  }

  private async sendSms(to: string, text: string): Promise<void> {
    const body = (text ?? '').trim().slice(0, SMS_MAX) || '(empty reply)';
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64');
    const form = new URLSearchParams({ From: this.opts.fromNumber, To: to, Body: body });
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    if (!res.ok) {
      this.opts.logger.warn({ msg: 'twilio send failed', status: res.status, to });
    }
  }
}
