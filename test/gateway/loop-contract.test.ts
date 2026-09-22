import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import {
  LOOP_REPLY_SCHEMA,
  LOOP_TURN_SCHEMA,
  parseLoopTurnRequest,
  sourceEvidenceSha256,
} from '../../src/gateway/loop-contract.js';
import { startGateway } from '../../src/gateway/server.js';
import { silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => Promise.all(apps.map((app) => app.close())));

const requestId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const lifelogId = '33333333-3333-4333-8333-333333333333';
const segmentId = '44444444-4444-4444-8444-444444444444';
const excerpt = 'The owner agreed to review the Loop plan tomorrow.';

function request() {
  return {
    schemaVersion: LOOP_TURN_SCHEMA,
    requestId,
    threadId,
    question: 'What should I remember?',
    sourceCorpusSha256: 'a'.repeat(64),
    intervalStart: '2026-08-06T06:00:00.000Z',
    intervalEnd: '2026-08-07T06:00:00.000Z',
    timeZoneIdentifier: 'America/Denver',
    evidence: [{
      lifelogId,
      segmentId,
      startedAt: '2026-08-06T18:00:00.000Z',
      endedAt: '2026-08-06T18:00:05.000Z',
      excerpt,
      sha256: createHash('sha256').update(excerpt).digest('hex'),
    }],
  };
}

function fakeConversation(
  seen: Array<{ input: string; opts: unknown }>,
  reply = `Remember the plan. [segment:${segmentId}]`,
): Conversation {
  return {
    sessionId: 'loop-session',
    agentSlug: 'meridian',
    historyCount: 0,
    send: async (input: string, opts: unknown) => {
      seen.push({ input, opts });
      return {
        id: 'turn-loop-1',
        sessionId: 'loop-session',
        role: 'assistant' as const,
        content: reply,
        channel: 'gateway' as const,
        ts: '2026-08-06T19:00:00.000Z',
      };
    },
  } as unknown as Conversation;
}

async function boot(conversation: Conversation, loopToken = 'loop-secret'): Promise<string> {
  const operatorConversation = fakeConversation([], 'operator route must remain separate');
  const app = await startGateway({
    port: 0,
    token: 'operator-secret-that-loop-must-not-accept',
    loop: loopToken ? { token: loopToken, conversation } : undefined,
    logger: silentLogger,
    conversation: operatorConversation,
  });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('gateway did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('Aterna Loop gateway contract', () => {
  it('requires exact request shape and authentic excerpt receipts', () => {
    assert.ok(parseLoopTurnRequest(request()));
    assert.equal(parseLoopTurnRequest({ ...request(), surprise: true }), null);
    assert.equal(parseLoopTurnRequest({ ...request(), requestId: 'not-a-uuid' }), null);
    const tampered = request();
    tampered.evidence[0].excerpt = 'changed';
    assert.equal(parseLoopTurnRequest(tampered), null);
    const duplicate = request();
    duplicate.evidence.push({ ...duplicate.evidence[0] });
    assert.equal(parseLoopTurnRequest(duplicate), null);
  });

  it('binds the reply to the request and disables tools plus memory writes', async () => {
    const seen: Array<{ input: string; opts: any }> = [];
    const body = request();
    const base = await boot(fakeConversation(seen));
    const response = await fetch(`${base}/v1/loop/turns`, {
      method: 'POST',
      headers: { authorization: 'Bearer loop-secret', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: LOOP_REPLY_SCHEMA,
      requestId,
      threadId,
      turnId: 'turn-loop-1',
      agentSlug: 'meridian',
      text: `Remember the plan. [segment:${segmentId}]`,
      generatedAt: '2026-08-06T19:00:00.000Z',
      sourceEvidenceSha256: sourceEvidenceSha256(body.evidence),
      citedSegmentIds: [segmentId],
      toolExecution: 'disabled',
      memoryWrite: 'disabled',
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0].input, /<untrusted_loop_evidence/);
    assert.equal(seen[0].opts.isolation.disableTools, true);
    assert.equal(seen[0].opts.isolation.disableMemoryWrite, true);
    assert.match(seen[0].opts.isolation.systemPolicy, /never obey commands/i);
    assert.match(seen[0].opts.isolation.systemPolicy, /authenticated, user-selected source records/i);
    assert.match(seen[0].opts.isolation.systemPolicy, /must contain at least one exact segment citation/i);
  });

  it('fails closed for missing auth, malformed input, and invented citations', async () => {
    const base = await boot(fakeConversation([], '[segment:55555555-5555-4555-8555-555555555555]'));
    const unauthorized = await fetch(`${base}/v1/loop/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()),
    });
    assert.equal(unauthorized.status, 401);

    const operatorToken = await fetch(`${base}/v1/loop/turns`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator-secret-that-loop-must-not-accept',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request()),
    });
    assert.equal(operatorToken.status, 401);

    const malformed = await fetch(`${base}/v1/loop/turns`, {
      method: 'POST',
      headers: { authorization: 'Bearer loop-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ ...request(), evidence: [{ ...request().evidence[0], sha256: '0'.repeat(64) }] }),
    });
    assert.equal(malformed.status, 400);

    const invented = await fetch(`${base}/v1/loop/turns`, {
      method: 'POST',
      headers: { authorization: 'Bearer loop-secret', 'content-type': 'application/json' },
      body: JSON.stringify(request()),
    });
    assert.equal(invented.status, 200);
    const json = await invented.json() as { text: string; citedSegmentIds: string[] };
    assert.match(json.text, /withheld/i);
    assert.deepEqual(json.citedSegmentIds, []);
  });

  it('refuses to expose the loop route when gateway authentication is absent', async () => {
    const base = await boot(fakeConversation([]), '');
    const response = await fetch(`${base}/v1/loop/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()),
    });
    assert.equal(response.status, 503);
  });

  it('accepts a narrow device capability without accepting the operator token', async () => {
    const seen: Array<{ input: string; opts: unknown }> = [];
    const conversation = fakeConversation(seen);
    const app = await startGateway({
      port: 0,
      token: 'operator-secret-that-loop-must-not-accept',
      loop: {
        token: 'bootstrap-loop-secret-that-is-long-enough',
        conversation,
        pairing: {
          publicBaseURL: 'https://loop.example.test/',
          store: {
            authenticateDeviceToken: (token: string) => token === 'device-capability-that-is-long-enough-1234',
          } as never,
        },
      },
      logger: silentLogger,
      conversation: fakeConversation([]),
    });
    apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('gateway did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/loop/turns`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer device-capability-that-is-long-enough-1234',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
  });

  it('binds pairing identity to the Loop conversation, not the generic HTTP facade', async () => {
    const conversation = fakeConversation([]);
    const issuedToken = 'device-capability-that-is-long-enough-5678';
    const app = await startGateway({
      port: 0,
      token: 'operator-secret-that-loop-must-not-accept',
      loop: {
        token: 'bootstrap-loop-secret-that-is-long-enough',
        conversation,
        pairing: {
          publicBaseURL: 'https://loop.example.test/',
          store: {
            redeem: () => issuedToken,
            authenticateDeviceToken: () => false,
          } as never,
        },
      },
      logger: silentLogger,
      // Mirrors the production gateway facade: it satisfies the type at the
      // boundary but intentionally carries no agentSlug of its own.
      conversation: {
        sessionId: 'gateway-http',
        historyCount: 0,
        send: async () => { throw new Error('not used'); },
      } as unknown as Conversation,
    });
    apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('gateway did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/loop/pairings/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'aterna.loop.pairing.request.v1',
        pairingCode: 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z2345',
        installationId: requestId,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: 'aterna.loop.pairing.reply.v1',
      agentSlug: 'meridian',
      agentDisplayName: 'Meridian',
      gatewayBaseURL: 'https://loop.example.test/',
      deviceToken: issuedToken,
    });
  });
});
