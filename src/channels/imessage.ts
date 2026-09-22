/**
 * iMessage channel adapter (WS5c) over a BlueBubbles relay.
 *
 * BlueBubbles is a server that runs on a Mac signed into Messages. It exposes
 * a REST API and posts webhooks for new messages. Meridian speaks to it like
 * any other channel: verify the inbound, resolve the operator, run the turn,
 * reply as blue bubbles with a typing indicator between them.
 *
 * Trust: BlueBubbles cannot sign its webhooks, so the route requires a shared
 * secret (query `secret` or header `x-meridian-secret`) and fails closed
 * without one. Sender identity is the iMessage handle (phone or email) and
 * goes through the same operator resolution as every channel.
 *
 * Nothing here depends on the relay being a Mac Mini or a hosted box; the
 * base URL is configuration.
 */
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import {
  DEFAULT_TEXT_STYLE,
  humanDelayMs,
  shapeForText,
  type TextStylePolicy,
} from '../agent/text-style.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';

export type FetchLike = (
  url: string,
  init?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
}>;

export interface ImessageChannelOptions {
  /** BlueBubbles server base URL, e.g. http://127.0.0.1:1234 or a tunnel. */
  serverUrl: string;
  /** BlueBubbles server password (vault or env). */
  password: string;
  /** Shared secret the webhook must present. Required; no secret = no route. */
  webhookSecret: string;
  /** Optional sender allowlist (handles); empty = anyone reaches the turn
   *  (untrusted senders still get the untrusted path). */
  allowedHandles?: string[];
  logger: Logger;
  textStyle?: TextStylePolicy;
  /** Where inbound attachments land (MEMORY/media). No dir = attachments noted only. */
  mediaDir?: string;
  maxMediaBytes?: number;
  /** Optional SMS fallback when the relay cannot deliver. */
  smsFallback?: { send: (to: string, text: string) => Promise<void> };
  /** 'private-api' needs the BlueBubbles helper bundle; 'apple-script' works everywhere. */
  sendMethod?: 'private-api' | 'apple-script';
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface ImessageWebhookEvent {
  type: string;
  data?: {
    guid?: string;
    text?: string;
    isFromMe?: boolean;
    handle?: { address?: string; service?: string } | null;
    chats?: Array<{ guid?: string }>;
    attachments?: Array<{
      guid?: string;
      mimeType?: string;
      transferName?: string;
      totalBytes?: number;
    }>;
    dateCreated?: number;
  };
}

export interface ImessageHandleResult {
  status: number;
  body: { ok: boolean; ignored?: string };
  done: Promise<void>;
}

const DONE = Promise.resolve();
const IMESSAGE_MAX = 4000;

export function verifyWebhookSecret(expected: string, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `iMessage;-;+15551234567` -> `+15551234567`; SMS-forwarded chats too. */
export function handleFromChatGuid(chatGuid: string | undefined): string | undefined {
  if (!chatGuid) return undefined;
  const parts = chatGuid.split(';');
  return parts.length === 3 ? parts[2] : undefined;
}

export function chatGuidForHandle(handle: string, service = 'iMessage'): string {
  return `${service};-;${handle}`;
}

export class ImessageChannel implements ChannelAdapter {
  readonly name = 'imessage';
  private handler: ((m: InboundMessage) => Promise<string>) | null = null;
  private readonly allow: Set<string>;
  private readonly fetchImpl: FetchLike;
  private lastRelayHealth: { ok: boolean; checkedAt: string | null; detail?: string } = {
    ok: false,
    checkedAt: null,
  };

  constructor(private opts: ImessageChannelOptions) {
    this.allow = new Set(
      (opts.allowedHandles ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
    );
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!opts.webhookSecret) throw new Error('imessage channel requires a webhook secret');
  }

  start(_c: unknown, opts: { onInbound: (m: InboundMessage) => Promise<string> }): void {
    this.handler = opts.onInbound;
    this.opts.logger.info({
      msg: 'imessage channel started',
      relay: this.opts.serverUrl,
      allowedHandles: this.allow.size
        ? [...this.allow]
        : '(anyone; operator resolution decides trust)',
    });
  }

  stop(): void {
    this.handler = null;
  }

  verifySecret(presented: string | undefined): boolean {
    return verifyWebhookSecret(this.opts.webhookSecret, presented);
  }

  relayHealth(): { ok: boolean; checkedAt: string | null; detail?: string } {
    return this.lastRelayHealth;
  }

  /** GET /api/v1/ping on the relay; bounded; records the result for /health. */
  async probeRelay(timeoutMs = 5000): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url('/api/v1/ping'), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const ok = res.ok;
      this.lastRelayHealth = {
        ok,
        checkedAt: new Date().toISOString(),
        detail: ok ? undefined : `HTTP ${res.status}`,
      };
      return ok;
    } catch (err) {
      this.lastRelayHealth = {
        ok: false,
        checkedAt: new Date().toISOString(),
        detail: (err as Error).message,
      };
      return false;
    }
  }

  /**
   * Handle a secret-verified webhook. Acks now, runs the turn async. Ignores
   * our own outbound echoes, non-message events, and empty messages.
   */
  handleRequest(event: ImessageWebhookEvent): ImessageHandleResult {
    const ack = (ignored?: string): ImessageHandleResult => ({
      status: 200,
      body: ignored ? { ok: true, ignored } : { ok: true },
      done: DONE,
    });
    if (event.type !== 'new-message') return ack('event type');
    const d = event.data;
    if (!d || d.isFromMe) return ack('own message');
    const chatGuid = d.chats?.[0]?.guid;
    const from = (d.handle?.address ?? handleFromChatGuid(chatGuid) ?? '').trim();
    const text = (d.text ?? '').trim();
    const attachments = d.attachments ?? [];
    if (!from || !this.handler) return ack('no sender');
    if (!text && attachments.length === 0) return ack('empty');
    if (this.allow.size > 0 && !this.allow.has(from.toLowerCase())) {
      this.opts.logger.warn({ msg: 'imessage from non-allowlisted handle ignored', from });
      return ack('not allowlisted');
    }
    const replyChat = chatGuid ?? chatGuidForHandle(from, d.handle?.service ?? 'iMessage');
    const done = (async () => {
      try {
        const notes: string[] = [];
        const saved: Array<{ path: string; mimeType?: string }> = [];
        for (const a of attachments) {
          const note = await this.pullAttachment(a, saved);
          if (note) notes.push(note);
        }
        const turnText = [text || '(The user sent an attachment with no text.)', ...notes].join(
          '\n\n',
        );
        const reply = await this.handler!({
          channel: 'imessage',
          from,
          text: turnText,
          meta: {
            messageGuid: d.guid,
            chatGuid: replyChat,
            attachments: saved.length ? saved : undefined,
          },
        });
        await this.deliver(replyChat, from, reply);
      } catch (err) {
        this.opts.logger.error({ msg: 'imessage inbound error', err });
        await this.deliver(
          replyChat,
          from,
          'Something went wrong on my end. I have logged it.',
        ).catch(() => {});
      }
    })();
    return { ...ack(), done };
  }

  async send(msg: OutboundMessage): Promise<void> {
    const to = msg.to;
    const chatGuid = to.includes(';-;') ? to : chatGuidForHandle(to);
    await this.deliver(chatGuid, handleFromChatGuid(chatGuid) ?? to, msg.text);
  }

  /** Reply as a few human bubbles with a typing indicator between them. */
  private async deliver(chatGuid: string, handle: string, text: string): Promise<void> {
    const style = this.opts.textStyle ?? DEFAULT_TEXT_STYLE;
    const shaped = shapeForText(text, style);
    const bubbles = (shaped.length ? shaped : [text]).flatMap((b) => splitForImessage(b));
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < bubbles.length; i += 1) {
      const b = bubbles[i]!;
      if (i > 0) {
        await this.typing(chatGuid, true).catch(() => {});
        await sleep(humanDelayMs(b, style));
      }
      const sent = await this.sendText(chatGuid, b);
      if (!sent) {
        if (this.opts.smsFallback && /^\+?\d{7,15}$/.test(handle)) {
          this.opts.logger.warn({ msg: 'imessage relay failed; falling back to sms', handle });
          await this.opts.smsFallback.send(handle, bubbles.slice(i).join('\n\n'));
          return;
        }
        throw new Error('imessage relay could not deliver');
      }
    }
    await this.typing(chatGuid, false).catch(() => {});
  }

  private url(path: string): string {
    const base = this.opts.serverUrl.replace(/\/$/, '');
    const sep = path.includes('?') ? '&' : '?';
    return `${base}${path}${sep}password=${encodeURIComponent(this.opts.password)}`;
  }

  private async sendText(chatGuid: string, message: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url('/api/v1/message/text'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatGuid,
          tempGuid: `meridian-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          message,
          method: this.opts.sendMethod ?? 'private-api',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.opts.logger.warn({ msg: 'bluebubbles send failed', status: res.status, chatGuid });
        return false;
      }
      return true;
    } catch (err) {
      this.opts.logger.warn({ msg: 'bluebubbles send threw', err, chatGuid });
      return false;
    }
  }

  private async typing(chatGuid: string, on: boolean): Promise<void> {
    await this.fetchImpl(this.url(`/api/v1/chat/${encodeURIComponent(chatGuid)}/typing`), {
      method: on ? 'POST' : 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
  }

  /** Tapback on a message: love, like, dislike, laugh, emphasize, question. */
  async react(chatGuid: string, messageGuid: string, reaction: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url('/api/v1/message/react'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatGuid, selectedMessageGuid: messageGuid, reaction }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async pullAttachment(
    a: NonNullable<ImessageWebhookEvent['data']>['attachments'] extends Array<infer T> | undefined
      ? T
      : never,
    saved: Array<{ path: string; mimeType?: string }>,
  ): Promise<string | null> {
    if (!a.guid) return null;
    const name = a.transferName ?? a.guid;
    if (!this.opts.mediaDir)
      return `[Attachment "${name}" (${a.mimeType ?? 'unknown type'}) was sent; media handling is not configured, so it was not saved.]`;
    const max = this.opts.maxMediaBytes ?? 25 * 1024 * 1024;
    if (a.totalBytes && a.totalBytes > max)
      return `[Attachment "${name}" was too large to take (limit ${Math.floor(max / (1024 * 1024))} MB).]`;
    try {
      const res = await this.fetchImpl(
        this.url(`/api/v1/attachment/${encodeURIComponent(a.guid)}/download`),
        {
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > max) return `[Attachment "${name}" was too large to take.]`;
      mkdirSync(this.opts.mediaDir, { recursive: true });
      const safe = name.replace(/[^\w.\-]+/g, '_');
      const path = join(this.opts.mediaDir, `im-${Date.now().toString(36)}-${safe}`);
      writeFileSync(path, buf);
      saved.push({ path, mimeType: a.mimeType });
      return `[Attachment "${name}" (${a.mimeType ?? 'unknown type'}) saved to ${path}.]`;
    } catch (err) {
      this.opts.logger.warn({ msg: 'imessage attachment download failed', err, guid: a.guid });
      return `[Attachment "${name}" could not be downloaded from the relay.]`;
    }
  }
}

export function splitForImessage(text: string, max: number = IMESSAGE_MAX): string[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];
  const out: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
