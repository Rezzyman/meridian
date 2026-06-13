/**
 * Discord channel — Interactions (slash command) endpoint.
 *
 * Discord has no inbound-message webhook the way Slack does; the HTTP path is
 * the Interactions endpoint (slash commands + components), so the operator
 * registers a command (e.g. `/meridian message:<text>`) and Discord POSTs each
 * invocation to /discord/interactions on the gateway. Flow:
 *   1. Verify the Ed25519 request signature against the app's public key.
 *   2. `PING` (type 1) → `PONG` (type 1).
 *   3. A command (type 2) is answered immediately with a DEFERRED response
 *      (type 5) — Discord shows "thinking…" — then we run the turn and edit the
 *      original response via the interaction webhook with the reply.
 *
 * No new dependencies: Ed25519 verification + `fetch` only. Full free-text chat
 * in any channel would need the Gateway WebSocket (discord.js) and the message-
 * content intent — that's a future enhancement; slash commands cover the
 * webhook-native path with zero deps.
 */

import { createPublicKey, verify as edVerify } from 'node:crypto';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import type { Logger } from 'pino';
import type { FetchLike } from './slack.js';

// SPKI DER header for an Ed25519 public key; prepend to the 32 raw bytes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromHex(hex: string) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Verify a Discord interaction signature (Ed25519 over timestamp+body). Pure. */
export function verifyDiscordSignature(input: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
}): boolean {
  const { publicKey, signature, timestamp, rawBody } = input;
  if (!publicKey || !signature || !timestamp) return false;
  try {
    const key = publicKeyFromHex(publicKey);
    const msg = Buffer.from(timestamp + rawBody, 'utf8');
    return edVerify(null, msg, key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

const INTERACTION = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const RESPONSE = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
} as const;

interface DiscordInteraction {
  type?: number;
  id?: string;
  token?: string;
  application_id?: string;
  data?: { name?: string; options?: Array<{ name?: string; type?: number; value?: unknown }> };
  member?: { user?: { id?: string; username?: string } };
  user?: { id?: string; username?: string };
  channel_id?: string;
}

export interface DiscordChannelOptions {
  publicKey: string;
  /** Used to build the follow-up webhook URL; the interaction payload also
   *  carries application_id, which is preferred when present. */
  applicationId?: string;
  logger: Logger;
  fetchImpl?: FetchLike;
}

export interface DiscordHandleResult {
  status: number;
  body: unknown;
  done: Promise<void>;
}

const DISCORD_MAX = 1900;
const DONE = Promise.resolve();

export class DiscordChannel implements ChannelAdapter {
  readonly name = 'discord';
  private handler: ((m: InboundMessage) => Promise<string>) | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(private opts: DiscordChannelOptions) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  start(_c: unknown, opts: { onInbound: (m: InboundMessage) => Promise<string> }): void {
    this.handler = opts.onInbound;
    this.opts.logger.info({ msg: 'discord channel started (POST /discord/interactions)' });
  }

  stop(): void {
    this.handler = null;
  }

  verifySignature(rawBody: string, signature?: string, timestamp?: string): boolean {
    return verifyDiscordSignature({ publicKey: this.opts.publicKey, signature, timestamp, rawBody });
  }

  handleRequest(rawBody: string): DiscordHandleResult {
    let body: DiscordInteraction;
    try {
      body = JSON.parse(rawBody) as DiscordInteraction;
    } catch {
      return { status: 400, body: { error: 'invalid json' }, done: DONE };
    }

    if (body.type === INTERACTION.PING) {
      return { status: 200, body: { type: RESPONSE.PONG }, done: DONE };
    }

    if (body.type !== INTERACTION.APPLICATION_COMMAND) {
      return { status: 200, body: { type: RESPONSE.CHANNEL_MESSAGE, data: { content: 'Unsupported interaction.' } }, done: DONE };
    }

    const text = extractCommandText(body);
    if (!text) {
      return {
        status: 200,
        body: { type: RESPONSE.CHANNEL_MESSAGE, data: { content: 'Usage: include a message, e.g. `/meridian message: …`' } },
        done: DONE,
      };
    }
    if (!this.handler || !body.token) {
      return { status: 200, body: { type: RESPONSE.CHANNEL_MESSAGE, data: { content: 'Agent not ready.' } }, done: DONE };
    }

    const appId = body.application_id ?? this.opts.applicationId;
    const token = body.token;
    const userId = body.member?.user?.id ?? body.user?.id ?? 'unknown';
    // Defer now (Discord requires a response within 3s); reply via the webhook.
    const done = (async () => {
      try {
        const reply = await this.handler!({
          channel: 'discord',
          from: userId,
          text,
          meta: { channelId: body.channel_id, username: body.member?.user?.username ?? body.user?.username },
        });
        if (appId) await this.followUp(appId, token, reply);
      } catch (err) {
        this.opts.logger.error({ msg: 'discord inbound error', err });
        if (appId) await this.followUp(appId, token, 'Something went wrong on my end. I have logged it.').catch(() => {});
      }
    })();
    return { status: 200, body: { type: RESPONSE.DEFERRED_CHANNEL_MESSAGE }, done };
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Discord follow-ups require an interaction token; a generic outbound send
    // is not supported by the interactions path.
    this.opts.logger.warn({ msg: 'discord send() is a no-op (interactions have no standalone outbound)', to: msg.to });
  }

  /** Edit the deferred response, then post any overflow as follow-up messages. */
  private async followUp(appId: string, token: string, text: string): Promise<void> {
    const chunks = splitForDiscord(text);
    const base = `https://discord.com/api/v10/webhooks/${appId}/${token}`;
    // First chunk edits the original "thinking…" response.
    await this.post(`${base}/messages/@original`, 'PATCH', chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await this.post(base, 'POST', chunks[i]);
    }
  }

  private async post(url: string, method: 'PATCH' | 'POST', content: string): Promise<void> {
    const res = await this.fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) this.opts.logger.warn({ msg: 'discord follow-up failed', status: res.status });
  }
}

function extractCommandText(body: DiscordInteraction): string {
  const options = body.data?.options ?? [];
  const named = options.find((o) => typeof o.value === 'string' && /message|prompt|text|q|ask/i.test(o.name ?? ''));
  const anyStr = options.find((o) => typeof o.value === 'string');
  return String((named ?? anyStr)?.value ?? '').trim();
}

/** Split a reply under Discord's 2000-char message limit. */
export function splitForDiscord(text: string, max: number = DISCORD_MAX): string[] {
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
