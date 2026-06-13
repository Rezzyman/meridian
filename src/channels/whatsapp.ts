/**
 * WhatsApp channel — Meta WhatsApp Cloud API.
 *
 * Flow:
 *   1. Meta verifies the webhook with a GET (hub.mode/verify_token/challenge).
 *   2. Inbound messages POST to /whatsapp/webhook, signed with
 *      X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app_secret, rawBody).
 *   3. We verify the signature, ack 200 immediately, then run the turn and send
 *      the reply via the Graph API (POST /{phone_number_id}/messages).
 *
 * No new dependencies — `fetch` + `node:crypto` only.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import type { Logger } from 'pino';
import type { FetchLike } from './slack.js';

const GRAPH_VERSION = 'v21.0';

/** Verify a Meta webhook signature (sha256= HMAC over the raw body). Pure. */
export function verifyWhatsappSignature(input: {
  appSecret: string;
  signature: string | undefined;
  rawBody: string;
}): boolean {
  const { appSecret, signature, rawBody } = input;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface WaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<{ from?: string; id?: string; type?: string; text?: { body?: string } }>;
        statuses?: unknown[];
      };
    }>;
  }>;
}

export interface WhatsappChannelOptions {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  /** Optional sender allowlist (wa_id / phone). Empty = anyone who messages. */
  allowedNumbers?: string[];
  logger: Logger;
  fetchImpl?: FetchLike;
}

export interface WaHandleResult {
  status: number;
  body: unknown;
  done: Promise<void>;
}

const WA_MAX = 4000;
const DONE = Promise.resolve();

export class WhatsappChannel implements ChannelAdapter {
  readonly name = 'whatsapp';
  private handler: ((m: InboundMessage) => Promise<string>) | null = null;
  private readonly allow: Set<string>;
  private readonly seen = new Set<string>(); // message-id dedup
  private readonly fetchImpl: FetchLike;

  constructor(private opts: WhatsappChannelOptions) {
    this.allow = new Set((opts.allowedNumbers ?? []).filter(Boolean));
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  start(_c: unknown, opts: { onInbound: (m: InboundMessage) => Promise<string> }): void {
    this.handler = opts.onInbound;
    this.opts.logger.info({
      msg: 'whatsapp channel started (GET+POST /whatsapp/webhook)',
      allowedNumbers: this.allow.size ? [...this.allow] : '(any sender)',
    });
  }

  stop(): void {
    this.handler = null;
  }

  verifySignature(rawBody: string, signature?: string): boolean {
    return verifyWhatsappSignature({ appSecret: this.opts.appSecret, signature, rawBody });
  }

  /** Webhook verification handshake (GET). Returns the challenge to echo, or
   *  null if the verify token does not match. */
  handleVerification(mode?: string, token?: string, challenge?: string): string | null {
    return mode === 'subscribe' && token === this.opts.verifyToken ? (challenge ?? '') : null;
  }

  handleRequest(rawBody: string): WaHandleResult {
    let body: WaWebhookBody;
    try {
      body = JSON.parse(rawBody) as WaWebhookBody;
    } catch {
      return { status: 400, body: { error: 'invalid json' }, done: DONE };
    }

    const jobs: Array<Promise<void>> = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue; // delivery statuses etc. → ignore
        for (const msg of value.messages) {
          if (msg.type !== 'text' || !msg.text?.body || !msg.from) continue;
          if (msg.id) {
            if (this.seen.has(msg.id)) continue;
            this.seen.add(msg.id);
            if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
          }
          if (this.allow.size > 0 && !this.allow.has(msg.from)) {
            this.opts.logger.warn({ msg: 'whatsapp message from non-allowlisted number ignored', from: msg.from });
            continue;
          }
          if (!this.handler) continue;
          const from = msg.from;
          const text = msg.text.body.trim();
          const name = value.contacts?.find((c) => c.wa_id === from)?.profile?.name;
          jobs.push(
            (async () => {
              try {
                const reply = await this.handler!({ channel: 'whatsapp', from, text, meta: { name } });
                await this.sendMessage(from, reply);
              } catch (err) {
                this.opts.logger.error({ msg: 'whatsapp inbound error', err });
                await this.sendMessage(from, 'Something went wrong on my end. I have logged it.').catch(() => {});
              }
            })(),
          );
        }
      }
    }
    return { status: 200, body: { ok: true }, done: jobs.length ? Promise.all(jobs).then(() => undefined) : DONE };
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.sendMessage(msg.to, msg.text);
  }

  private async sendMessage(to: string, text: string): Promise<void> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.opts.phoneNumberId}/messages`;
    for (const chunk of splitForWhatsapp(text)) {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: chunk } }),
      });
      if (!res.ok) this.opts.logger.warn({ msg: 'whatsapp send failed', status: res.status });
    }
  }
}

/** Split a reply under WhatsApp's ~4096-char message limit. */
export function splitForWhatsapp(text: string, max: number = WA_MAX): string[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return ['(empty reply)'];
  if (trimmed.length <= max) return [trimmed];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
