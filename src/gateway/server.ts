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

export interface GatewayOptions {
  port: number;
  token?: string;
  logger: Logger;
  conversation: Conversation;
  vapi?: VapiChannel;
  slack?: SlackChannel;
  discord?: DiscordChannel;
  whatsapp?: WhatsappChannel;
  sms?: SmsChannel;
  sentinel?: ProactiveSentinel;
  automations?: AutomationManager;
  /** Opt-in `POST /waitlist` capture (a landing page's signup target). The
   *  route exists ONLY when this is provided — a gateway must never grow an
   *  anonymous write endpoint silently. */
  waitlist?: { dbPath: string };
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

  app.get('/health', async () => ({
    ok: true,
    agent: opts.conversation.agentSlug,
    sessionId: opts.conversation.sessionId,
    ts: new Date().toISOString(),
  }));

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
        emit('error', { error: (err as Error).message });
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
    void result.done; // fire-and-forget the async turn + reply
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
    void result.done; // fire-and-forget the async turn + follow-up
    reply.code(result.status);
    return result.body;
  });

  // WhatsApp (Meta Cloud API). GET = webhook verification handshake; POST =
  // signed inbound messages → ack, then reply via the Graph API.
  app.get<{ Querystring: { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string } }>(
    '/whatsapp/webhook',
    async (req, reply) => {
      if (!opts.whatsapp) {
        reply.code(404);
        return { error: 'whatsapp channel not configured' };
      }
      const q = req.query;
      const challenge = opts.whatsapp.handleVerification(q['hub.mode'], q['hub.verify_token'], q['hub.challenge']);
      if (challenge === null) {
        reply.code(403);
        return { error: 'verification failed' };
      }
      reply.code(200).header('content-type', 'text/plain').send(challenge);
      return reply;
    },
  );
  app.post<{ Headers: { 'x-hub-signature-256'?: string } }>('/whatsapp/webhook', async (req, reply) => {
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
    void result.done; // fire-and-forget the async turn + reply
    reply.code(result.status);
    return result.body;
  });

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
    void result.done; // fire-and-forget the async turn + reply
    reply.code(result.status).header('content-type', result.contentType);
    return result.body;
  });

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
      reply.code(500);
      return { error: (err as Error).message };
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
