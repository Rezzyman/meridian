import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import {
  createAttestedHarnessLoopAgentAdapter,
  LOOP_AGENT_CAPABILITIES,
  LOOP_HARNESS_TURN_REPLY_SCHEMA,
  LOOP_HARNESS_TURN_REQUEST_SCHEMA,
  type LoopAgentAdapter,
  type LoopHarnessKind,
  selectLoopAgentAdapter,
} from '../../src/gateway/loop-agent-adapter.js';
import { LOOP_REPLY_SCHEMA, LOOP_TURN_SCHEMA } from '../../src/gateway/loop-contract.js';
import { startGateway } from '../../src/gateway/server.js';
import { makeEnv, silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => Promise.all(apps.map((app) => app.close())));

const requestId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const segmentId = '33333333-3333-4333-8333-333333333333';
const lifelogId = '44444444-4444-4444-8444-444444444444';
const excerpt = 'The owner chose the blue launch plan.';

function loopRequest() {
  return {
    schemaVersion: LOOP_TURN_SCHEMA,
    requestId,
    threadId,
    question: 'Which launch plan did I choose?',
    sourceCorpusSha256: 'a'.repeat(64),
    intervalStart: '2026-09-03T06:00:00.000Z',
    intervalEnd: '2026-09-04T06:00:00.000Z',
    timeZoneIdentifier: 'America/Denver',
    evidence: [
      {
        lifelogId,
        segmentId,
        startedAt: '2026-09-03T15:00:00.000Z',
        endedAt: '2026-09-03T15:00:05.000Z',
        excerpt,
        sha256: createHash('sha256').update(excerpt).digest('hex'),
      },
    ],
  };
}

function fakeAgent(harness: LoopHarnessKind, calls: string[] = []): LoopAgentAdapter {
  return {
    harness,
    identity: { slug: 'arlo', displayName: 'Arlo' },
    capabilities: LOOP_AGENT_CAPABILITIES,
    async sendTurn(input) {
      calls.push(input.prompt);
      return {
        turnId: 'turn-agent-1',
        text: `You chose the blue plan. [segment:${segmentId}]`,
        generatedAt: '2026-09-03T15:01:00.000Z',
      };
    },
  };
}

const genericConversation = {
  sessionId: 'generic-http',
  agentSlug: 'generic',
  historyCount: 0,
  send: async () => {
    throw new Error('generic route must not handle Loop');
  },
} as unknown as Conversation;

async function boot(agent: LoopAgentAdapter): Promise<string> {
  const app = await startGateway({
    port: 0,
    token: 'operator-token',
    loop: { token: 'loop-token', agent },
    logger: silentLogger,
    conversation: genericConversation,
  });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('gateway did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('Loop harness-neutral agent boundary', () => {
  it('selects OpenClaw when typed server configuration selects OpenClaw', async () => {
    const env = makeEnv({
      ATERNA_LOOP_HARNESS: 'openclaw',
      ATERNA_LOOP_HARNESS_URL: 'https://harness.internal.example/v1/loop',
      ATERNA_LOOP_HARNESS_TOKEN: 'h'.repeat(32),
    });
    const openClawCalls: string[] = [];
    const meridianCalls: string[] = [];
    const selected = selectLoopAgentAdapter(env.ATERNA_LOOP_HARNESS, {
      openclaw: fakeAgent('openclaw', openClawCalls),
      meridian: fakeAgent('meridian', meridianCalls),
    });
    await selected.sendTurn({ requestId, threadId, prompt: 'hello', systemPolicy: 'safe' });
    assert.equal(selected.harness, 'openclaw');
    assert.deepEqual(openClawCalls, ['hello']);
    assert.deepEqual(meridianCalls, []);
  });

  it('requires complete external-harness configuration but preserves the Meridian default', () => {
    assert.equal(makeEnv().ATERNA_LOOP_HARNESS, 'meridian');
    assert.throws(
      () => makeEnv({ ATERNA_LOOP_HARNESS: 'openclaw' }),
      /attested bridge URL|dedicated bridge token/,
    );
  });

  it('requires an attested no-tools/no-write reply from the server-side bridge', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const adapter = createAttestedHarnessLoopAgentAdapter({
      harness: 'openclaw',
      identity: { slug: 'arlo', displayName: 'Arlo' },
      url: 'https://openclaw.internal.example/v1/loop',
      token: 'b'.repeat(32),
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: LOOP_HARNESS_TURN_REPLY_SCHEMA,
            requestId,
            threadId,
            turnId: 'openclaw-turn-1',
            text: `Blue. [segment:${segmentId}]`,
            generatedAt: '2026-09-03T15:01:00.000Z',
            executionPolicy: LOOP_AGENT_CAPABILITIES,
          }),
        };
      },
    });
    const result = await adapter.sendTurn({
      requestId,
      threadId,
      prompt: 'rendered evidence',
      systemPolicy: 'no tools and no memory writes',
    });
    assert.equal(capturedUrl, 'https://openclaw.internal.example/v1/loop');
    assert.equal(result.text, `Blue. [segment:${segmentId}]`);
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(body.schemaVersion, LOOP_HARNESS_TURN_REQUEST_SCHEMA);
    assert.equal(body.prompt, 'rendered evidence');
    assert.deepEqual(body.executionPolicy, LOOP_AGENT_CAPABILITIES);
    assert.equal('harness' in body, false);

    const unsafe = createAttestedHarnessLoopAgentAdapter({
      harness: 'openclaw',
      identity: { slug: 'arlo', displayName: 'Arlo' },
      url: 'http://127.0.0.1:18789/v1/loop',
      token: 'b'.repeat(32),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: LOOP_HARNESS_TURN_REPLY_SCHEMA,
          requestId,
          threadId,
          turnId: 'unsafe-turn',
          text: 'unsafe',
          generatedAt: '2026-09-03T15:01:00.000Z',
          executionPolicy: { ...LOOP_AGENT_CAPABILITIES, memoryWrite: 'enabled' },
        }),
      }),
    });
    await assert.rejects(
      unsafe.sendTurn({ requestId, threadId, prompt: 'x', systemPolicy: 'y' }),
      /invalid or unsafe reply/,
    );
  });

  it('keeps the public iOS request and response identical across all harnesses', async () => {
    const responses: unknown[] = [];
    for (const harness of ['openclaw', 'hermes', 'meridian'] as const) {
      const base = await boot(fakeAgent(harness));
      const response = await fetch(`${base}/v1/loop/turns`, {
        method: 'POST',
        headers: { authorization: 'Bearer loop-token', 'content-type': 'application/json' },
        body: JSON.stringify(loopRequest()),
      });
      assert.equal(response.status, 200);
      responses.push(await response.json());
    }
    assert.deepEqual(responses[0], responses[1]);
    assert.deepEqual(responses[1], responses[2]);
    const response = responses[0] as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(response).sort(),
      [
        'agentSlug',
        'citedSegmentIds',
        'generatedAt',
        'memoryWrite',
        'requestId',
        'schemaVersion',
        'sourceEvidenceSha256',
        'text',
        'threadId',
        'toolExecution',
        'turnId',
      ].sort(),
    );
    assert.equal(response.schemaVersion, LOOP_REPLY_SCHEMA);
    assert.doesNotMatch(JSON.stringify(response), /openclaw|hermes|meridian/i);
    assert.equal('harness' in loopRequest(), false);
  });
});
