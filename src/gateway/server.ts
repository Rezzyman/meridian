/**
 * HTTP gateway. Fastify on port 18889 by default. Hosts:
 *   /health        — public liveness probe
 *   /chat          — token-auth chat completion
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
