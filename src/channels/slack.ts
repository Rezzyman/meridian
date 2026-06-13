/**
 * Slack channel adapter — Events API over the gateway webhook.
 *
 * Flow:
 *   1. Slack POSTs events to /slack/events on the gateway.
 *   2. We verify the request signature (HMAC over the raw body with the app's
 *      signing secret) and reject replays older than 5 minutes.
 *   3. `url_verification` handshakes return the challenge.
 *   4. A user `message` event is acked immediately (Slack requires < 3s), then
 *      processed async: run the turn, post the reply via chat.postMessage.
 *
 * Trust model: the bot only receives events for channels it has been invited to
 * (workspace-scoped by Slack). An optional `allowedChannels` allowlist narrows
 * it further. The bot's own messages (and edits/joins) are ignored so it never
 * talks to itself. No new dependencies — `fetch` + `node:crypto` only.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import type { Logger } from 'pino';

/** Verify a Slack request signature (v0 scheme). Pure + exported for testing. */
export function verifySlackSignature(input: {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  /** seconds; injectable for deterministic tests. Defaults to now. */
  nowSec?: number;
  /** max age before a request is treated as a replay (default 300s). */
  toleranceSec?: number;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody } = input;
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSec ?? 300;
  if (Math.abs(now - ts) > tolerance) return false; // stale → replay
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface SlackEventBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
  };
}

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SlackChannelOptions {
  botToken: string;
  signingSecret: string;
  /** Optional channel-id allowlist. Empty = any channel the bot is in. */
  allowedChannels?: string[];
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface SlackHandleResult {
  status: number;
  body: unknown;
  /** Resolves when async processing (turn + postMessage) is done. Tests await
   *  this; the gateway route fires-and-forgets it after acking. */
  done: Promise<void>;
}

const SLACK_MAX = 3500;
const DONE = Promise.resolve();

export class SlackChannel implements ChannelAdapter {
  readonly name = 'slack';
  private handler: ((m: InboundMessage) => Promise<string>) | null = null;
  private readonly allow: Set<string>;
  private readonly seen = new Set<string>(); // event_id dedup (Slack retries)
  private readonly fetchImpl: FetchLike;

  constructor(private opts: SlackChannelOptions) {
    this.allow = new Set((opts.allowedChannels ?? []).filter(Boolean));
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  start(_c: unknown, opts: { onInbound: (m: InboundMessage) => Promise<string> }): void {
    this.handler = opts.onInbound;
    this.opts.logger.info({
      msg: 'slack channel started',
      allowedChannels: this.allow.size ? [...this.allow] : '(any channel the bot is in)',
    });
  }

  stop(): void {
    this.handler = null;
  }

  verifySignature(rawBody: string, signature?: string, timestamp?: string, nowSec?: number): boolean {
    return verifySlackSignature({ signingSecret: this.opts.signingSecret, signature, timestamp, rawBody, nowSec });
  }

  /**
   * Handle a verified Slack request. Returns the synchronous ack plus a `done`
   * promise for the async turn. Signature verification is the caller's job (the
   * gateway route), but `handleRequest` re-checks nothing — pass only verified
   * requests. (Use `verifySignature` first.)
   */
  handleRequest(rawBody: string): SlackHandleResult {
    let body: SlackEventBody;
    try {
      body = JSON.parse(rawBody) as SlackEventBody;
    } catch {
      return { status: 400, body: { error: 'invalid json' }, done: DONE };
    }

    // URL verification handshake.
    if (body.type === 'url_verification' && body.challenge) {
      return { status: 200, body: { challenge: body.challenge }, done: DONE };
    }

    if (body.type !== 'event_callback' || !body.event) {
      return { status: 200, body: { ok: true }, done: DONE };
    }

    // Dedup Slack's at-least-once retries.
    if (body.event_id) {
      if (this.seen.has(body.event_id)) return { status: 200, body: { ok: true, dedup: true }, done: DONE };
      this.seen.add(body.event_id);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
    }

    const ev = body.event;
    // Only plain user messages. Ignore the bot's own posts, edits, joins, etc.
    if ((ev.type !== 'message' && ev.type !== 'app_mention') || ev.subtype || ev.bot_id) {
      return { status: 200, body: { ok: true, ignored: true }, done: DONE };
    }
    const text = (ev.text ?? '').trim();
    const channel = ev.channel ?? '';
    if (!text || !channel) return { status: 200, body: { ok: true, ignored: true }, done: DONE };
    if (this.allow.size > 0 && !this.allow.has(channel)) {
      this.opts.logger.warn({ msg: 'slack message from non-allowlisted channel ignored', channel });
      return { status: 200, body: { ok: true, ignored: true }, done: DONE };
    }
    if (!this.handler) return { status: 200, body: { ok: true }, done: DONE };

    // Ack now; run the turn async and post the reply when it's ready.
    const done = (async () => {
      try {
        const reply = await this.handler!({
          channel: 'slack',
          from: ev.user ?? 'unknown',
          text,
          meta: { slackChannel: channel, ts: ev.ts },
        });
        await this.postMessage(channel, reply);
      } catch (err) {
        this.opts.logger.error({ msg: 'slack inbound error', err });
        await this.postMessage(channel, 'Something went wrong on my end. I have logged it.').catch(() => {});
      }
    })();
    return { status: 200, body: { ok: true }, done };
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.postMessage(msg.to, msg.text);
  }

  private async postMessage(channel: string, text: string): Promise<void> {
    for (const chunk of splitForSlack(text)) {
      const res = await this.fetchImpl('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text: chunk }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) {
        this.opts.logger.warn({ msg: 'slack postMessage failed', status: res.status, error: json.error });
      }
    }
  }
}

/** Split a reply under Slack's per-message limit, on paragraph/word boundaries. */
export function splitForSlack(text: string, max: number = SLACK_MAX): string[] {
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
