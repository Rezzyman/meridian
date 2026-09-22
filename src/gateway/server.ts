/**
 * HTTP gateway. Fastify on port 18889 by default. Hosts:
 *   /health        — public liveness probe
 *   /chat          — token-auth chat completion (blocking JSON)
 *   /chat/stream   — token-auth SSE: live token deltas + canonical done event
 *   /vapi/webhook  — VAPI voice events; routes to VapiChannel
 *   /heartbeat     — internal ping
 *
 * One above OpenClaw's 18789 by design.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { VapiChannel } from '../channels/vapi.js';
import type { SlackChannel } from '../channels/slack.js';
import type { DiscordChannel } from '../channels/discord.js';
import type { WhatsappChannel } from '../channels/whatsapp.js';
import type { SmsChannel } from '../channels/sms.js';
import type { Conversation } from '../agent/conversation.js';
import type { TurnStreamEvent } from '../agent/turn.js';
import type { ProactiveSentinel } from '../proactive/sentinel.js';
import type { AutomationManager } from '../automations/manager.js';
import { readWaitlist, recordWaitlist } from '../hosted/waitlist.js';
import { sanitizeUserFacingError } from '../safety/error-firewall.js';
import { settle } from './crash-safety.js';
import type { ImessageChannel } from '../channels/imessage.js';
import type { WeatherProvider } from './weather.js';
import { parseDeviceLookMultipart } from './device-media.js';
import type { AudioTranscriber, ImageDescriber } from './device-media.js';
import { registerLoopRoute } from './loop-contract.js';
import { registerLoopPairingRoute, type LoopPairingStore } from './loop-pairing.js';
import { createMeridianLoopAgentAdapter, type LoopAgentAdapter } from './loop-agent-adapter.js';

export interface GatewayOptions {
  port: number;
  token?: string;
  /** Dedicated first-party Loop capability and ephemeral conversation factory.
   *  The wearable client never receives `token`, and its submitted evidence
   *  never joins the operator's persistent cross-channel session. */
  loop?: {
    token: string;
    /** Stable runtime boundary used by OpenClaw, Hermes, or Meridian. */
    agent?: LoopAgentAdapter;
    /** @deprecated Existing embedded-Meridian configuration remains valid. */
    conversation?: Conversation;
    pairing?: { store: LoopPairingStore; publicBaseURL: string };
  };
  logger: Logger;
  conversation: Conversation;
  vapi?: VapiChannel;
  slack?: SlackChannel;
  discord?: DiscordChannel;
  whatsapp?: WhatsappChannel;
  sms?: SmsChannel;
  sentinel?: ProactiveSentinel;
  automations?: AutomationManager;
  /** Stateless completion (WS5d): a fresh conversation per request seeded
   *  with the caller's prior messages, exactly like the OpenAI contract.
   *  Absent = falls back to the shared conversation facade. */
  completions?: (
    input: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    sendOpts?: Parameters<Conversation['send']>[1],
  ) => Promise<{ id: string; content: string }>;
  /** Force every /v1/chat/completions turn into Loop isolation (no tools, no
   *  memory writes). Set on a gateway that serves only the Loop sidecar. */
  completionsIsolation?: 'loop';
  /** iMessage over BlueBubbles (WS5c). Route exists only when configured. */
  imessage?: ImessageChannel;
  /** Runtime health state (WS5): cortex probe, last-hour inference, uptime. */
  health?: import('./health.js').HealthState;
  /** Provider breaker snapshot (WS5). */
  breaker?: () => Array<{
    ref: string;
    state: string;
    consecutiveFailures: number;
    openUntil: string | null;
  }>;
  /** Spend totals (WS4) for /health.spend. */
  spend?: {
    today(): { usd: number; tokens: number; calls: number };
    month(): { usd: number; tokens: number; calls: number };
  };
  /** Boot-time provider posture (defect (h)); surfaced verbatim on /health. */
  provider?: {
    ok: boolean;
    primary: string;
    provider: string;
    baseUrlHost?: string;
    reason?: string;
  };
  /** Opt-in `POST /waitlist` capture (a landing page's signup target). The
   *  route exists ONLY when this is provided — a gateway must never grow an
   *  anonymous write endpoint silently. */
  waitlist?: { dbPath: string };
  /** Opt-in: serve the bundled web chat UI at GET / and /chat.html. The page
   *  auto-configures against THIS origin, so self-host web chat needs no
   *  manual URL/token paste. */
  web?: { htmlPath: string };
  /** Opt-in `POST /ingest`: accept a document and drop it into the agent's
   *  MEMORY/inbox for the ingest watcher. Built for external upload portals
   *  (a client dashboard POSTing survey PDFs) that must not hold the operator
   *  gateway token — `token` here is a DEDICATED ingest credential. The route
   *  exists only when this is provided, and never without a token. */
  ingest?: { inboxDir: string; token: string };
  /** Optional current-conditions adapter for the R1 lock screen. */
  weather?: WeatherProvider;
  /** Optional private speech-to-text adapter for hold-to-talk turns. */
  transcribeAudio?: AudioTranscriber;
  /** Optional local vision adapter for one-shot camera turns. */
  describeImage?: ImageDescriber;
}

export async function startGateway(opts: GatewayOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  // Keep the RAW JSON body alongside the parsed one. Slack's request signature
  // is computed over the exact bytes, so we cannot rely on a re-serialized body.
  // Other routes are unaffected — they still receive parsed JSON in req.body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    if (!body || (body as string).length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.addContentTypeParser(
    ['audio/wav', 'audio/x-wav', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );
  app.addContentTypeParser(/^multipart\/form-data/i, { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  // Twilio posts application/x-www-form-urlencoded; its signature is computed
  // over the URL + the raw params, so keep the raw body here too.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as unknown as { rawBody?: string }).rawBody = body as string;
      done(null, Object.fromEntries(new URLSearchParams((body as string) ?? '')));
    },
  );

  app.get('/health', async () => {
    const automations = opts.automations ? opts.automations.status() : [];
    const lastProactiveDelivery =
      automations
        .map((a) => a.lastDeliveredAt)
        .filter((x): x is string => !!x)
        .sort()
        .at(-1) ?? null;
    const cortex = opts.health?.cortex ?? { status: 'unknown', checkedAt: null };
    const providerOk = opts.provider ? opts.provider.ok : true;
    return {
      ok: providerOk && cortex.status !== 'down',
      agent: opts.conversation.agentSlug,
      sessionId: opts.conversation.sessionId,
      ts: new Date().toISOString(),
      version: opts.health?.version ?? null,
      startedAt: opts.health?.startedAt ?? null,
      uptimeSec: opts.health?.uptimeSec() ?? null,
      provider: opts.provider ?? null,
      cortex,
      breaker: opts.breaker ? opts.breaker() : [],
      lastHourInference: opts.health?.lastHourInference() ?? null,
      channels: {
        imessage: opts.imessage ? opts.imessage.relayHealth() : null,
      },
      automations,
      lastProactiveDelivery,
      spend: opts.spend ? { today: opts.spend.today(), month: opts.spend.month() } : null,
    };
  });

  // First-party Aterna AI Loop channel. The route imposes a stricter contract
  // than generic chat: exact request shape, mandatory bearer auth, no tools,
  // no durable memory write, and request-bound evidence identifiers.
  const loopAgent =
    opts.loop?.agent ??
    createMeridianLoopAgentAdapter(opts.loop?.conversation ?? opts.conversation);
  registerLoopRoute(app, {
    token: opts.loop?.token,
    authorizeToken: opts.loop?.pairing
      ? (token) => opts.loop!.pairing!.store.authenticateDeviceToken(token)
      : undefined,
    logger: opts.logger,
    agent: loopAgent,
  });
  if (opts.loop?.pairing) {
    registerLoopPairingRoute(app, {
      store: opts.loop.pairing.store,
      publicBaseURL: opts.loop.pairing.publicBaseURL,
      // The generic HTTP facade may deliberately omit agent identity. Pairing
      // is a Loop capability, so bind the receipt to the selected adapter.
      agentSlug: loopAgent.identity.slug,
      agentDisplayName: loopAgent.identity.displayName,
    });
  }

  app.get<{ Headers: { authorization?: string } }>('/v1/weather', async (req, reply) => {
    if (opts.token) {
      const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (got !== opts.token) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
    }
    if (!opts.weather) {
      reply.code(503);
      return { error: 'weather not configured' };
    }
    try {
      return await opts.weather();
    } catch (err) {
      opts.logger.warn({ err }, 'weather provider failed');
      reply.code(502);
      return { error: 'weather unavailable' };
    }
  });

  // ── Web chat (opt-in) ──
  // Cached at boot: the file ships in the package and doesn't change at
  // runtime. Registered only when provided; the default gateway stays
  // API-only. Deliberately NO CSP header — the page legitimately supports
  // pointing at a DIFFERENT gateway via its settings panel, and a
  // connect-src 'self' policy would break that documented feature (noted in
  // skeleton/web/README.md instead).
  if (opts.web) {
    const html = readFileSync(opts.web.htmlPath, 'utf8');
    const serveChat = async (
      _req: unknown,
      reply: { header: (k: string, v: string) => unknown },
    ) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      return html;
    };
    app.get('/', serveChat);
    app.get('/chat.html', serveChat);
  }

  // ── Waitlist capture (opt-in) ──
  // Deliberately NO bearer: a public landing page cannot hold a secret, and
  // gating signups behind the operator token would defeat the purpose.
  // Compensating controls instead: opt-in registration, a per-IP rate limit,
  // field length caps, a global cap, and duplicate answers that use the same
  // status code as success (no membership oracle via status).
  if (opts.waitlist) {
    const wl = opts.waitlist;
    const RATE_WINDOW_MS = 60_000;
    const RATE_MAX = 10;
    const GLOBAL_CAP = 5000;
    const hits = new Map<string, { count: number; windowStart: number }>();
    const allowed = (ip: string): boolean => {
      const now = Date.now();
      const h = hits.get(ip);
      if (!h || now - h.windowStart >= RATE_WINDOW_MS) {
        hits.set(ip, { count: 1, windowStart: now });
        return true;
      }
      h.count += 1;
      return h.count <= RATE_MAX;
    };

    // CORS is scoped to THIS route only (the landing page is cross-origin).
    app.options('/waitlist', async (_req, reply) => {
      await reply
        .code(204)
        .header('access-control-allow-origin', '*')
        .header('access-control-allow-methods', 'POST, OPTIONS')
        .header('access-control-allow-headers', 'content-type')
        .send();
    });

    app.post<{ Body: { email?: string; plan?: string; note?: string; source?: string } }>(
      '/waitlist',
      async (req, reply) => {
        reply.header('access-control-allow-origin', '*');
        if (!allowed(req.ip)) {
          reply.code(429);
          return { error: 'rate limited' };
        }
        const { email, plan, note, source } = req.body ?? {};
        const capped = (v: unknown): v is string | undefined =>
          v === undefined || (typeof v === 'string' && v.length <= 200);
        if (
          typeof email !== 'string' ||
          email.length > 254 ||
          !capped(plan) ||
          !capped(note) ||
          !capped(source)
        ) {
          reply.code(400);
          return { error: 'invalid fields' };
        }
        // recordWaitlist re-reads the JSONL per call (O(n) dedupe) — fine at
        // waitlist scale, unbounded is not.
        if (readWaitlist(wl.dbPath).length >= GLOBAL_CAP) {
          reply.code(503);
          return { error: 'waitlist full' };
        }
        try {
          const saved = recordWaitlist(
            { email, plan, note, source: source ?? 'gateway', ts: new Date().toISOString() },
            wl.dbPath,
          );
          return { ok: true, email: saved.email };
        } catch (err) {
          if (/already on the waitlist/.test((err as Error).message)) {
            // Same status code as success: the status line never confirms
            // whether an arbitrary email was already subscribed.
            return { ok: true, duplicate: true };
          }
          reply.code(400);
          return { error: 'invalid email' };
        }
      },
    );
  }

  // ── Document ingest (opt-in) ──
  // The public upload seam for external portals: a token-gated POST that drops
  // the document into MEMORY/inbox and lets the ingest watcher do the rest.
  // The bearer is a DEDICATED ingest token — a portal never holds the operator
  // gateway token, so leaking it exposes uploads, not chat. Files land via
  // tmp+rename so the watcher can never observe a half-written document.
  if (opts.ingest) {
    const ing = opts.ingest;
    const MAX_INGEST_BYTES = 48 * 1024 * 1024; // 32 MB binary survives base64 inflation
    app.post<{
      Body: { filename?: string; content?: string; encoding?: 'utf8' | 'base64' };
      Headers: { authorization?: string };
    }>('/ingest', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
      const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (got !== ing.token) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const { filename, content, encoding } = req.body ?? {};
      if (!filename || typeof filename !== 'string' || !content || typeof content !== 'string') {
        reply.code(400);
        return { error: 'filename and content required' };
      }
      // basename() + charset allowlist: an upload names a file, never a path.
      const safeName = basename(filename)
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 140);
      if (!safeName || safeName.startsWith('.')) {
        reply.code(400);
        return { error: 'invalid filename' };
      }
      const buf = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
      if (buf.byteLength === 0 || buf.byteLength > MAX_INGEST_BYTES) {
        reply.code(413);
        return { error: `content must be 1 byte to ${MAX_INGEST_BYTES} bytes` };
      }
      const stored = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
      try {
        await mkdir(ing.inboxDir, { recursive: true });
        const tmp = join(ing.inboxDir, `.${stored}.part`);
        await writeFile(tmp, buf);
        await rename(tmp, join(ing.inboxDir, stored));
      } catch (err) {
        opts.logger.error({ msg: 'ingest write failed', err });
        reply.code(500);
        return { error: 'ingest failed' };
      }
      opts.logger.info({ msg: 'document ingested', file: stored, bytes: buf.byteLength });
      return { ok: true, file: stored, bytes: buf.byteLength };
    });
  }

  app.post<{ Body: { input: string }; Headers: { authorization?: string } }>(
    '/chat',
    async (req, reply) => {
      if (opts.token) {
        const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (got !== opts.token) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
      }
      const { input } = req.body ?? { input: '' };
      if (!input || typeof input !== 'string') {
        reply.code(400);
        return { error: 'input required' };
      }
      const turn = await opts.conversation.send(input);
      return { reply: turn.content, turnId: turn.id, memoryId: turn.memoryId };
    },
  );

  // OpenAI-compatible chat completions (WS5d). The Loop sidecar and any
  // OpenAI-shaped client (including the parity bench) reach Meridian exactly
  // as they reach the other harness: bearer token, messages in, one
  // completion out. Non-streaming only. `x-meridian-isolation: loop` makes
  // the turn tool-free and memory-write-free and folds system messages into
  // a per-turn policy, which is the Loop contract's requirement.
  app.post<{
    Body: {
      model?: string;
      messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      stream?: boolean;
    };
    Headers: { authorization?: string; 'x-meridian-isolation'?: string };
  }>('/v1/chat/completions', async (req, reply) => {
    if (opts.token) {
      const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (got !== opts.token) {
        reply.code(401);
        return { error: { message: 'unauthorized', type: 'invalid_request_error' } };
      }
    }
    const body = req.body ?? {};
    if (body.stream) {
      reply.code(400);
      return {
        error: {
          message: 'stream is not supported on this endpoint; use /chat/stream',
          type: 'invalid_request_error',
        },
      };
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const textOf = (c: string | Array<{ type: string; text?: string }>): string =>
      typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      reply.code(400);
      return {
        error: { message: 'messages must include a user message', type: 'invalid_request_error' },
      };
    }
    const input = textOf(lastUser.content).trim();
    if (!input) {
      reply.code(400);
      return { error: { message: 'user message is empty', type: 'invalid_request_error' } };
    }
    const systemPolicy = messages
      .filter((m) => m.role === 'system')
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
    const isolated =
      opts.completionsIsolation === 'loop' ||
      (req.headers['x-meridian-isolation'] ?? '').toLowerCase() === 'loop';
    const started = Date.now();
    const isolation = isolated
      ? { disableTools: true, disableMemoryWrite: true, systemPolicy: systemPolicy || undefined }
      : systemPolicy
        ? { systemPolicy }
        : undefined;
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: textOf(m.content) }))
      .filter((m) => m.content.trim().length > 0);
    // Drop the final user message from history: it is the input.
    const lastIdx = history.map((m) => m.role).lastIndexOf('user');
    if (lastIdx >= 0) history.splice(lastIdx, 1);
    const sendOpts = isolation ? { isolation } : undefined;
    const turn = opts.completions
      ? await opts.completions(input, history, sendOpts)
      : await opts.conversation.send(input, sendOpts);
    return {
      id: `chatcmpl-${turn.id}`,
      object: 'chat.completion',
      created: Math.floor(started / 1000),
      model: body.model ?? 'meridian',
      choices: [
        { index: 0, message: { role: 'assistant', content: turn.content }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
      meridian: { turnId: turn.id, isolated, durationMs: Date.now() - started },
    };
  });

  // Native Meridian device contract. Keep /chat stable for web/CLI clients while the
  // child-safe Android shell gets a deliberately narrow, typed endpoint. Device identity,
  // session and memory controls arrive in X-Meridian-* headers; the gateway's operator-keyed
  // conversation facade remains the authority for recall and persistence.
  app.post<{ Body: { text?: string }; Headers: { authorization?: string } }>(
    '/v1/turns/text',
    async (req, reply) => {
      if (opts.token) {
        const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (got !== opts.token) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
      }
      const text = req.body?.text;
      if (!text || typeof text !== 'string') {
        reply.code(400);
        return { error: 'text required' };
      }
      const turn = await opts.conversation.send(text);
      return {
        text: turn.content,
        turnId: turn.id,
        memoryId: turn.memoryId,
      };
    },
  );

  app.post<{ Body: Buffer; Headers: { authorization?: string; 'content-type'?: string } }>(
    '/v1/turns/ptt',
    async (req, reply) => {
      if (opts.token) {
        const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (got !== opts.token) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
      }
      if (!opts.transcribeAudio) {
        reply.code(503);
        return { error: 'speech recognition not configured' };
      }
      if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
        reply.code(400);
        return { error: 'audio required' };
      }
      try {
        const transcript = await opts.transcribeAudio(
          req.body,
          req.headers['content-type']?.split(';')[0] ?? 'audio/wav',
        );
        const turn = await opts.conversation.send(transcript);
        return {
          text: turn.content,
          transcript,
          turnId: turn.id,
          memoryId: turn.memoryId,
        };
      } catch (err) {
        opts.logger.warn({ err }, 'R1 push-to-talk turn failed');
        reply.code(502);
        return { error: 'speech turn unavailable' };
      }
    },
  );

  app.post<{ Body: Buffer; Headers: { authorization?: string; 'content-type'?: string } }>(
    '/v1/turns/look',
    async (req, reply) => {
      if (opts.token) {
        const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (got !== opts.token) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
      }
      if (!opts.describeImage) {
        reply.code(503);
        return { error: 'vision not configured' };
      }
      try {
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] ?? '');
        const parts = parseDeviceLookMultipart(req.body, boundary?.[1] ?? boundary?.[2] ?? '');
        const observation = await opts.describeImage(parts.frame, parts.prompt);
        const turn = await opts.conversation.send(
          `${parts.prompt}\n\nVisual observation from the R1 camera:\n${observation}`,
        );
        return {
          text: turn.content,
          observation,
          turnId: turn.id,
          memoryId: turn.memoryId,
        };
      } catch (err) {
        opts.logger.warn({ err }, 'R1 camera turn failed');
        reply.code(502);
        return { error: 'vision turn unavailable' };
      }
    },
  );

  // ── SSE streaming chat ──
  // Same auth + body contract as /chat, but the model's tokens arrive live:
  //   event: delta  data: {"text":"..."}      raw model output, incremental
  //   event: reset  data: {}                  provider fell back mid-stream;
  //                                           client discards its buffer
  //   event: tool   data: {"name":"..."}      a tool call fired
  //   event: done   data: {"reply","turnId"}  CANONICAL post-processed reply —
  //                                           clients MUST replace their
  //                                           accumulated text with this
  //   event: error  data: {"error":"..."}     turn failed
  // /chat stays untouched for back-compat.
  app.post<{ Body: { input: string }; Headers: { authorization?: string } }>(
    '/chat/stream',
    async (req, reply): Promise<void> => {
      if (opts.token) {
        const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (got !== opts.token) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
      }
      const { input } = req.body ?? { input: '' };
      if (!input || typeof input !== 'string') {
        await reply.code(400).send({ error: 'input required' });
        return;
      }

      // From here we own the raw socket; Fastify must not serialize a body.
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const emit = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const turn = await opts.conversation.send(input, {
          onStreamEvent: (ev: TurnStreamEvent) => {
            if (ev.type === 'delta') emit('delta', { text: ev.text });
            else if (ev.type === 'reset') emit('reset', {});
            else emit('tool', { name: ev.name });
          },
        });
        emit('done', { reply: turn.content, turnId: turn.id, ts: turn.ts });
      } catch (err) {
        // RULE ZERO: the SSE consumer may render this to an end user. Full
        // detail goes to the operator log; the wire gets the safe surface.
        opts.logger.error({ msg: 'stream turn failed', err });
        emit('error', { error: sanitizeUserFacingError((err as Error).message) });
      }
      reply.raw.end();
    },
  );

  app.post<{
    Body: unknown;
    Headers: { 'x-vapi-secret'?: string };
  }>('/vapi/webhook', async (req, reply) => {
    if (!opts.vapi) {
      reply.code(404);
      return { error: 'vapi channel not configured' };
    }
    const ok = opts.vapi.verifyWebhook(req.headers['x-vapi-secret']);
    if (!ok) {
      reply.code(401);
      return { error: 'invalid vapi webhook signature' };
    }
    const event = req.body as Parameters<VapiChannel['dispatch']>[0];
    const result = await opts.vapi.dispatch(event);
    return result;
  });

  // Slack Events API. Verify the signature over the RAW body, then ack within
  // Slack's 3s window; the turn + reply happen async via chat.postMessage.
  app.post<{
    Headers: { 'x-slack-signature'?: string; 'x-slack-request-timestamp'?: string };
  }>('/slack/events', async (req, reply) => {
    if (!opts.slack) {
      reply.code(404);
      return { error: 'slack channel not configured' };
    }
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const ok = opts.slack.verifySignature(
      rawBody,
      req.headers['x-slack-signature'],
      req.headers['x-slack-request-timestamp'],
    );
    if (!ok) {
      reply.code(401);
      return { error: 'invalid slack signature' };
    }
    const result = opts.slack.handleRequest(rawBody);
    settle(result.done, opts.logger, { route: req.url, channel: 'slack' });
    reply.code(result.status);
    return result.body;
  });

  // Discord Interactions endpoint. Ed25519-verified; PING→PONG, slash command →
  // deferred ack then a follow-up edit with the reply.
  app.post<{
    Headers: { 'x-signature-ed25519'?: string; 'x-signature-timestamp'?: string };
  }>('/discord/interactions', async (req, reply) => {
    if (!opts.discord) {
      reply.code(404);
      return { error: 'discord channel not configured' };
    }
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const ok = opts.discord.verifySignature(
      rawBody,
      req.headers['x-signature-ed25519'],
      req.headers['x-signature-timestamp'],
    );
    if (!ok) {
      reply.code(401);
      return { error: 'invalid request signature' };
    }
    const result = opts.discord.handleRequest(rawBody);
    settle(result.done, opts.logger, { route: req.url, channel: 'discord' });
    reply.code(result.status);
    return result.body;
  });

  // WhatsApp (Meta Cloud API). GET = webhook verification handshake; POST =
  // signed inbound messages → ack, then reply via the Graph API.
  app.get<{
    Querystring: { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string };
  }>('/whatsapp/webhook', async (req, reply) => {
    if (!opts.whatsapp) {
      reply.code(404);
      return { error: 'whatsapp channel not configured' };
    }
    const q = req.query;
    const challenge = opts.whatsapp.handleVerification(
      q['hub.mode'],
      q['hub.verify_token'],
      q['hub.challenge'],
    );
    if (challenge === null) {
      reply.code(403);
      return { error: 'verification failed' };
    }
    reply.code(200).header('content-type', 'text/plain').send(challenge);
    return reply;
  });
  app.post<{ Headers: { 'x-hub-signature-256'?: string } }>(
    '/whatsapp/webhook',
    async (req, reply) => {
      if (!opts.whatsapp) {
        reply.code(404);
        return { error: 'whatsapp channel not configured' };
      }
      const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
      if (!opts.whatsapp.verifySignature(rawBody, req.headers['x-hub-signature-256'])) {
        reply.code(401);
        return { error: 'invalid signature' };
      }
      const result = opts.whatsapp.handleRequest(rawBody);
      settle(result.done, opts.logger, { route: req.url, channel: 'whatsapp' });
      reply.code(result.status);
      return result.body;
    },
  );

  // Twilio inbound SMS (application/x-www-form-urlencoded). Verify the
  // X-Twilio-Signature over the raw body, ack with TwiML, run the turn async.
  app.post<{ Headers: { 'x-twilio-signature'?: string } }>('/twilio/sms', async (req, reply) => {
    if (!opts.sms) {
      reply.code(404);
      return { error: 'sms channel not configured' };
    }
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    if (!opts.sms.verifySignature(rawBody, req.headers['x-twilio-signature'])) {
      reply.code(401);
      return { error: 'invalid twilio signature' };
    }
    const result = opts.sms.handleRequest(rawBody);
    settle(result.done, opts.logger, { route: req.url, channel: 'sms' });
    reply.code(result.status).header('content-type', result.contentType);
    return result.body;
  });

  // iMessage via BlueBubbles (WS5c). The relay cannot sign, so a shared secret
  // (query `secret` or header `x-meridian-secret`) gates the route and it
  // fails closed. Acks now, runs the turn async.
  app.post<{ Headers: { 'x-meridian-secret'?: string }; Querystring: { secret?: string } }>(
    '/imessage/webhook',
    async (req, reply) => {
      if (!opts.imessage) {
        reply.code(404);
        return { error: 'imessage channel not configured' };
      }
      const presented = req.headers['x-meridian-secret'] ?? req.query?.secret;
      if (!opts.imessage.verifySecret(presented)) {
        reply.code(401);
        return { error: 'invalid webhook secret' };
      }
      const result = opts.imessage.handleRequest(
        (req.body ?? {}) as Parameters<ImessageChannel['handleRequest']>[0],
      );
      settle(result.done, opts.logger, { route: req.url, channel: 'imessage' });
      reply.code(result.status);
      return result.body;
    },
  );

  // Place an outbound voice call via VAPI. Token-gated. Used by the
  // signup wizard's "agent calls you to introduce itself" moment, by
  // automations that should reach the operator by phone, and for ad-hoc
  // tests via `meridian voice call`.
  app.post<{
    Body: {
      to: string;
      assistantId?: string;
      phoneNumberId?: string;
      firstMessage?: string;
      customerName?: string;
      metadata?: Record<string, unknown>;
    };
    Headers: { authorization?: string };
  }>('/vapi/call', async (req, reply) => {
    if (opts.token) {
      const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (got !== opts.token) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
    }
    if (!opts.vapi) {
      reply.code(404);
      return { error: 'vapi channel not configured' };
    }
    const { to } = req.body ?? { to: '' };
    if (!to || typeof to !== 'string') {
      reply.code(400);
      return { error: 'to (E.164 phone number) required' };
    }
    try {
      const result = await opts.vapi.placeOutboundCall(req.body);
      return result;
    } catch (err) {
      // Token-gated, but responses get pasted into tickets and client chats.
      // Log the raw failure; answer with the leak-screened version.
      opts.logger.error({ msg: 'outbound call failed', err });
      reply.code(500);
      return { error: sanitizeUserFacingError((err as Error).message) };
    }
  });

  app.get('/heartbeat', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    historyTurns: opts.conversation.historyCount,
  }));

  // Trigger a proactive morning brief on demand. Token-gated (same as /chat).
  // The sentinel composes a brief and pushes it to the operator's primary
  // channel; we also return the body so /brief callers can inspect it.
  // List or fire automations. GET = list, POST { name } = fire on demand.
  app.get<{ Headers: { authorization?: string } }>('/automations', async (req, reply) => {
    if (opts.token) {
      const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (got !== opts.token) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
    }
    if (!opts.automations) {
      reply.code(404);
      return { error: 'automation manager not configured' };
    }
    return { automations: opts.automations.list() };
  });
  app.post<{ Body: { name: string }; Headers: { authorization?: string } }>(
    '/automations/run',
    async (req, reply) => {
      if (opts.token) {
        const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (got !== opts.token) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
      }
      if (!opts.automations) {
        reply.code(404);
        return { error: 'automation manager not configured' };
      }
      const name = req.body?.name;
      if (!name) {
        reply.code(400);
        return { error: 'name required' };
      }
      const result = await opts.automations.fire(name);
      if (!result) {
        reply.code(404);
        return { error: `automation "${name}" not found` };
      }
      return result;
    },
  );

  app.post<{ Headers: { authorization?: string } }>('/brief', async (req, reply) => {
    if (opts.token) {
      const got = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (got !== opts.token) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
    }
    if (!opts.sentinel) {
      reply.code(404);
      return { error: 'proactive sentinel not configured' };
    }
    const result = await opts.sentinel.fireMorningBrief();
    return result;
  });

  // Bind 127.0.0.1 by default — gateway must sit behind a reverse proxy
  // (Caddy/nginx) for HTTPS termination + auth. Override via MERIDIAN_GATEWAY_BIND
  // for dev or for hosts that handle TLS at the ingress.
  const host = process.env.MERIDIAN_GATEWAY_BIND || '127.0.0.1';
  await app.listen({ host, port: opts.port });
  opts.logger.info({ msg: 'gateway started', host, port: opts.port });
  return app;
}
