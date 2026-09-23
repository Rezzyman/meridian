import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Conversation } from '../../src/agent/conversation.js';
import { startGateway } from '../../src/gateway/server.js';
import { HealthState } from '../../src/gateway/health.js';
import { CapabilityManifestSchema } from '../../src/certify/manifest.js';
import { certify, renderCard, runProbe } from '../../src/certify/runner.js';
import { silentLogger } from '../helpers/fixtures.js';

const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

function stubConversation(): Conversation {
  return {
    sessionId: 'sess',
    agentSlug: 'arlo',
    historyCount: 0,
    send: async (input: string) => ({
      id: 't',
      sessionId: 'sess',
      role: 'assistant',
      content: input.includes('breakfast') ? "I don't have that one." : `Yeah. ${input}`,
      channel: 'gateway',
      ts: new Date().toISOString(),
    }),
  } as unknown as Conversation;
}

async function boot(): Promise<string> {
  const health = new HealthState('1.5.0');
  health.setCortex('ok');
  // Memory stub: the fact becomes recallable on the third ask (background write).
  let asks = 0;
  let seeded = '';
  const app = await startGateway({
    port: 0,
    token: 'tok',
    logger: silentLogger,
    conversation: stubConversation(),
    health,
    timezone: 'America/Denver',
    spendCaps: { dailyUsd: 10, maxPromptTokensPerTurn: 150_000 },
    toolNames: ['gmail_search', 'gmail_recent', 'web_search'],
    provider: {
      ok: true,
      primary: 'routexor/claude-haiku-4.5',
      provider: 'routexor',
      baseUrlHost: 'api.routexor.com',
    },
    completions: async (input: string) => {
      const m = /marker is (cert-[a-z0-9]+)/i.exec(input);
      if (m) {
        seeded = m[1]!;
        return { id: 's', content: 'Got it.' };
      }
      asks += 1;
      return {
        id: 'a',
        content: asks >= 3 && seeded ? `It is ${seeded}.` : "I don't have that yet.",
      };
    },
  });
  apps.push(app);
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

describe('meridian certify (certification step 1)', () => {
  it('runs every probe kind against a live gateway and certifies only on all-green blocking claims', async () => {
    const base = await boot();
    const manifest = CapabilityManifestSchema.parse({
      schema: 'meridian.capabilities.v1',
      agent: 'arlo',
      audience: 'internal',
      capabilities: [
        { id: 'gateway.health', claim: 'ok', probe: { kind: 'health', field: 'ok', equals: true } },
        {
          id: 'provider.posture',
          claim: 'routexor',
          probe: { kind: 'health', field: 'provider.ok', equals: true },
        },
        {
          id: 'memory.reachable',
          claim: 'cortex',
          probe: { kind: 'health', field: 'cortex.status', equals: 'ok' },
        },
        {
          id: 'memory.roundtrip',
          claim: 'recall',
          probe: {
            kind: 'memory',
            seed: 'Remember: the certification marker is {{marker}}.',
            ask: 'What is the certification marker?',
            expect: '{{marker}}',
            withinMs: 60_000,
          },
        },
        {
          id: 'spend.caps',
          claim: 'caps',
          probe: { kind: 'health', field: 'spendCaps.dailyUsd', truthy: true },
        },
        {
          id: 'timezone',
          claim: 'tz',
          probe: { kind: 'health', field: 'timezone', equals: 'America/Denver' },
        },
        {
          id: 'chat.reply',
          claim: 'replies',
          probe: { kind: 'turn', input: 'hey', mustNotMatch: ['as an ai'] },
        },
        {
          id: 'chat.honest-empty',
          claim: 'honest',
          probe: { kind: 'turn', input: 'breakfast 2021?', mustMatch: ["don't"] },
        },
        {
          id: 'tools.gmail',
          claim: 'gmail',
          probe: { kind: 'tools', names: ['gmail_search', 'gmail_recent'] },
        },
        {
          id: 'tools.missing',
          claim: 'nope',
          severity: 'advisory',
          probe: { kind: 'tools', names: ['gmail_send'] },
        },
        { id: 'voice.line', claim: 'voice', probe: { kind: 'http', url: `${base}/health` } },
        {
          id: 'automation.morning-brief',
          claim: 'brief',
          severity: 'advisory',
          probe: { kind: 'automation', name: 'morning-brief' },
        },
        {
          id: 'telegram.operator',
          claim: 'telegram',
          probe: { kind: 'manual', instruction: 'send ping' },
        },
      ],
    });
    const sleeps: number[] = [];
    const report = await certify(manifest, {
      gateway: base,
      token: 'tok',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const by = Object.fromEntries(report.results.map((r) => [r.id, r]));
    assert.equal(by['gateway.health']?.status, 'green');
    assert.equal(by['memory.roundtrip']?.status, 'green');
    assert.match(by['memory.roundtrip']?.evidence ?? '', /3 asks/);
    assert.equal(by['chat.honest-empty']?.status, 'green');
    assert.equal(by['tools.gmail']?.status, 'green');
    assert.equal(by['tools.missing']?.status, 'red');
    assert.equal(by['automation.morning-brief']?.status, 'red', 'nothing armed on a stub gateway');
    assert.equal(by['telegram.operator']?.status, 'manual');
    assert.equal(report.certified, false);
    assert.ok(report.reasons.some((r) => r.includes('telegram.operator')));
    assert.ok(
      !report.reasons.some((r) => r.includes('tools.missing')),
      'advisory red is not a reason',
    );
    assert.match(renderCard(report), /NOT CERTIFIED/);

    const attested = await certify(manifest, {
      gateway: base,
      token: 'tok',
      sleep: async () => {},
      confirmed: new Set(['telegram.operator']),
    });
    assert.equal(attested.certified, true);
    assert.match(renderCard(attested), /CERTIFIED: every blocking claim is green/);
  });

  it('a manifest missing a required promise is never certified', async () => {
    const base = await boot();
    const manifest = CapabilityManifestSchema.parse({
      schema: 'meridian.capabilities.v1',
      agent: 'x',
      audience: 'client-facing',
      capabilities: [
        { id: 'gateway.health', claim: 'ok', probe: { kind: 'health', field: 'ok', equals: true } },
      ],
    });
    const report = await certify(manifest, { gateway: base, token: 'tok', sleep: async () => {} });
    assert.equal(report.certified, false);
    assert.ok(report.missingRequired.includes('brand.no-internal-names'));
  });

  it('a probe that throws is red with the reason, never a crash', async () => {
    const r = await runProbe(
      {
        id: 'x',
        claim: 'x',
        severity: 'blocking',
        probe: { kind: 'http', url: 'http://127.0.0.1:1/nothing', withinMs: 500 },
      },
      { gateway: 'http://127.0.0.1:1', sleep: async () => {} },
    );
    assert.equal(r.status, 'red');
    assert.ok(r.evidence.length > 0);
  });
});
