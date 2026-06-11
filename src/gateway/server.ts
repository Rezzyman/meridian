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
import type { Conversation } from '../agent/conversation.js';
import type { TurnStreamEvent } from '../agent/turn.js';
import type { ProactiveSentinel } from '../proactive/sentinel.js';
import type { AutomationManager } from '../automations/manager.js';

export interface GatewayOptions {
  port: number;
  token?: string;
  logger: Logger;
  conversation: Conversation;
  vapi?: VapiChannel;
  sentinel?: ProactiveSentinel;
  automations?: AutomationManager;
}

export async function startGateway(opts: GatewayOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  app.get('/health', async () => ({
    ok: true,
    agent: opts.conversation.agentSlug,
    sessionId: opts.conversation.sessionId,
    ts: new Date().toISOString(),
  }));

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
