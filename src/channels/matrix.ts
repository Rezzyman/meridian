/**
 * Matrix channel adapter — the open, federated, end-to-end-capable messenger.
 *
 * Unlike the webhook channels (Slack/Discord/WhatsApp), Matrix is a CLIENT: the
 * agent logs in with an access token and long-polls `/sync` for new events, then
 * posts replies with the client-server `send` API. That means NO public webhook
 * and NO inbound port — it works behind NAT, on a laptop, inside a home lab. For
 * an agent OS whose pitch is "memory you can trust", a channel you can self-host
 * on your own homeserver is the right kind of reach.
 *
 * Trust model: the bot only sees rooms it has joined. An optional `allowedRooms`
 * allowlist narrows that further. Its own messages are ignored (sender check) so
 * it never replies to itself, and `m.room.message` events are de-duplicated by
 * event id across sync batches. No new dependencies — `fetch` only.
 */

import type { Logger } from 'pino';
import type { ChannelAdapter, ChannelStartOptions, InboundMessage, OutboundMessage } from './types.js';

export interface MatrixEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  content?: { msgtype?: string; body?: string };
}

export interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> };
}

export interface MatrixMessage {
  roomId: string;
  eventId: string;
  sender: string;
  text: string;
}

/**
 * Extract the actionable `m.text` messages from a `/sync` response: joined
 * rooms only, skipping the bot's own posts, non-text message types, and (when
 * an allowlist is given) rooms outside it. Pure + exported for testing.
 */
export function parseSyncMessages(
  sync: MatrixSyncResponse,
  selfUserId: string,
  allowedRooms: ReadonlySet<string>,
): MatrixMessage[] {
  const out: MatrixMessage[] = [];
  const joined = sync.rooms?.join;
  if (!joined) return out;
  for (const [roomId, room] of Object.entries(joined)) {
    if (allowedRooms.size > 0 && !allowedRooms.has(roomId)) continue;
    for (const ev of room.timeline?.events ?? []) {
      if (ev.type !== 'm.room.message') continue;
      if (ev.content?.msgtype !== 'm.text') continue;
      if (!ev.sender || ev.sender === selfUserId) continue;
      const text = (ev.content?.body ?? '').trim();
      if (!text) continue;
      out.push({ roomId, eventId: ev.event_id ?? '', sender: ev.sender, text });
    }
  }
  return out;
}

export type FetchLike = (
  url: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface MatrixChannelOptions {
  /** e.g. https://matrix.org */
  homeserverUrl: string;
  /** A long-lived access token for the bot user. */
  accessToken: string;
  /** The bot's own MXID (@bot:server) — used to ignore its own messages. */
  userId: string;
  /** Optional room-id allowlist. Empty = any room the bot has joined. */
  allowedRooms?: string[];
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Seed for transaction ids (tests pass a fixed value; runtime uses boot ms). */
  txnSeed?: number;
}

const MATRIX_MAX = 40_000; // generous; Matrix events cap ~64KB, leave headroom

export class MatrixChannel implements ChannelAdapter {
  readonly name = 'matrix';
  private handler: ChannelStartOptions['onInbound'] | null = null;
  private readonly base: string;
  private readonly allow: Set<string>;
  private readonly fetchImpl: FetchLike;
  private readonly seen = new Set<string>();
  private running = false;
  private since: string | undefined;
  private txn: number;

  constructor(private opts: MatrixChannelOptions) {
    this.base = opts.homeserverUrl.replace(/\/$/, '');
    this.allow = new Set((opts.allowedRooms ?? []).filter(Boolean));
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.txn = opts.txnSeed ?? Date.now();
  }

  start(_c: unknown, opts: ChannelStartOptions): void {
    this.handler = opts.onInbound;
    this.running = true;
    this.opts.logger.info({
      msg: 'matrix channel started',
      homeserver: this.base,
      allowedRooms: this.allow.size ? [...this.allow] : '(any joined room)',
    });
    // Skip history: take an initial sync token without replaying old events,
    // then poll forward from there. Fire-and-forget the loop.
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.handler = null;
  }

  private async loop(): Promise<void> {
    try {
      this.since = await this.fetchSyncToken();
    } catch (err) {
      this.opts.logger.warn({ msg: 'matrix initial sync failed', err: (err as Error).message });
    }
    while (this.running) {
      try {
        this.since = await this.pollOnce(this.since);
      } catch (err) {
        this.opts.logger.warn({ msg: 'matrix sync error', err: (err as Error).message });
        // Brief backoff so a flapping homeserver doesn't spin the CPU.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /** One sync round: fetch, process new messages, return the next batch token.
   *  Exposed (not private) so tests can drive a single round deterministically. */
  async pollOnce(since?: string): Promise<string | undefined> {
    const sync = await this.fetchSync(since, this.running ? 30_000 : 0);
    const next = sync.next_batch ?? since;
    for (const m of parseSyncMessages(sync, this.opts.userId, this.allow)) {
      if (m.eventId && this.seen.has(m.eventId)) continue;
      if (m.eventId) {
        this.seen.add(m.eventId);
        if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
      }
      if (!this.handler) continue;
      const inbound: InboundMessage = {
        channel: 'matrix',
        from: m.sender,
        text: m.text,
        meta: { roomId: m.roomId, eventId: m.eventId },
      };
      try {
        const reply = await this.handler(inbound);
        await this.sendToRoom(m.roomId, reply);
      } catch (err) {
        this.opts.logger.error({ msg: 'matrix inbound error', err });
        await this.sendToRoom(m.roomId, 'Something went wrong on my end. I have logged it.').catch(
          () => {},
        );
      }
    }
    return next;
  }

  private async fetchSyncToken(): Promise<string | undefined> {
    const sync = await this.fetchSync(undefined, 0);
    return sync.next_batch;
  }

  private async fetchSync(since: string | undefined, timeoutMs: number): Promise<MatrixSyncResponse> {
    const params = new URLSearchParams({ timeout: String(timeoutMs) });
    if (since) params.set('since', since);
    const res = await this.fetchImpl(`${this.base}/_matrix/client/v3/sync?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.opts.accessToken}` },
    });
    if (!res.ok) throw new Error(`sync HTTP ${res.status}`);
    return (await res.json()) as MatrixSyncResponse;
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.sendToRoom(msg.to, msg.text);
  }

  private async sendToRoom(roomId: string, text: string): Promise<void> {
    const body = (text ?? '').trim().slice(0, MATRIX_MAX) || '(empty reply)';
    const txnId = `meridian-${this.txn++}`;
    const url = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
    const res = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.opts.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    });
    if (!res.ok) {
      this.opts.logger.warn({ msg: 'matrix send failed', status: res.status, roomId });
    }
  }
}
