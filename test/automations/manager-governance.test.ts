import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ToolSet } from 'ai';
import type { MeridianHome } from '../../src/config/home.js';
import {
  AutomationManager,
  loadAutomationDefs,
  toolIsConsequential,
} from '../../src/automations/manager.js';
import { SessionStore } from '../../src/session/store.js';
import {
  makeConfig,
  mockCortex,
  mockRouter,
  silentLogger,
  textModel,
} from '../helpers/fixtures.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(frontmatter: string) {
  const root = mkdtempSync(join(tmpdir(), 'meridian-automation-'));
  roots.push(root);
  const agentRoot = join(root, 'arlo');
  const automations = join(agentRoot, 'AUTOMATIONS');
  mkdirSync(automations, { recursive: true });
  writeFileSync(
    join(automations, 'test.cron'),
    `---\n${frontmatter}\n---\nProduce a useful result.\n`,
  );
  const home = {
    root,
    agentSlug: 'arlo',
    agentRoot,
    configPath: join(agentRoot, 'config.yaml'),
    envPath: join(agentRoot, '.env'),
    vaultPath: join(agentRoot, 'vault.enc'),
    layer: (name: string) => join(agentRoot, name),
    sessions: join(agentRoot, 'sessions'),
    logs: join(agentRoot, 'logs'),
    checkpoints: join(agentRoot, 'checkpoints'),
    stateDb: join(agentRoot, 'state.db'),
  } as MeridianHome;
  const cortex = mockCortex();
  const config = makeConfig({
    operator: { id: 'atanasio', name: 'Rez', channels: { telegram: ['123'] } },
  });
  const sent: string[] = [];
  const channels = new Map([
    [
      'telegram',
      {
        name: 'telegram',
        start() {},
        stop() {},
        send: async (msg: { text: string }) => {
          sent.push(msg.text);
        },
      },
    ],
  ]);
  return { home, cortex, config, sent, channels, store: new SessionStore(home) };
}

function manager(f: ReturnType<typeof fixture>, tools?: ToolSet) {
  return new AutomationManager({
    home: f.home,
    config: f.config,
    cortex: f.cortex,
    router: mockRouter(textModel('evidence-backed result')),
    logger: silentLogger,
    systemBase: 'system',
    channels: f.channels as never,
    tools,
    store: f.store,
  });
}

describe('automation definition governance', () => {
  it('defaults legacy definitions to shadow, observe, no tools, and approval-required', () => {
    const f = fixture('name: test\nschedule: "0 8 * * *"');
    const [def] = loadAutomationDefs(f.home);
    assert.equal(def?.autonomyMode, 'shadow');
    assert.equal(def?.actionTier, 'observe');
    assert.deepEqual(def?.tools, []);
    assert.equal(def?.requiresApproval, true);
  });

  it('classifies mutating tools as consequential', () => {
    assert.equal(toolIsConsequential('gmail_send'), true);
    assert.equal(toolIsConsequential('cortex_encode'), true);
    assert.equal(toolIsConsequential('bash'), true);
    assert.equal(toolIsConsequential('gmail_recent'), false);
  });
});

describe('automation runtime enforcement', () => {
  it('shadow mode neither pushes nor encodes', async () => {
    const f = fixture(
      'name: test\nschedule: "0 8 * * *"\nautonomyMode: shadow\nactionTier: observe\nrequiresApproval: false\nmode: direct',
    );
    const m = manager(f);
    m.start();
    const result = await m.fire('test', new Date('2026-07-31T14:00:00Z'));
    m.stop();
    assert.equal(result?.outcome, 'shadow');
    assert.deepEqual(f.sent, []);
    assert.equal(f.cortex.encodeCalls.length, 0);
  });

  it('live direct mode pushes and records memory when explicitly configured', async () => {
    const f = fixture(
      'name: test\nschedule: "0 8 * * *"\nautonomyMode: live\nactionTier: observe\nrequiresApproval: false\nmode: direct',
    );
    const m = manager(f);
    m.start();
    const result = await m.fire('test', new Date('2026-07-31T14:00:00Z'));
    m.stop();
    assert.equal(result?.outcome, 'success');
    assert.equal(f.sent.length, 1);
    assert.equal(f.cortex.encodeCalls.length, 1);
  });

  it('requires a scoped owner grant when declared', async () => {
    const f = fixture(
      'name: test\nschedule: "0 8 * * *"\nautonomyMode: live\nactionTier: observe\nrequiresApproval: true\nmode: direct',
    );
    const m = manager(f);
    m.start();
    const result = await m.fire('test', new Date('2026-07-31T14:00:00Z'));
    m.stop();
    assert.equal(result?.outcome, 'awaiting_approval');
    assert.match(result?.reason ?? '', /\/approve automation:test/);
    // WS3: the operator is told once, with the exact command; nothing else is delivered.
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0] ?? '', /\/approve automation:test/);
  });

  it('consumes an owner-scoped automation grant exactly once', async () => {
    const f = fixture(
      'name: test\nschedule: "0 8 * * *"\nautonomyMode: live\nactionTier: observe\nrequiresApproval: true\nmode: direct',
    );
    f.store.grantApproval('op:atanasio', 'automation:test', 5);
    const m = manager(f);
    m.start();
    const result = await m.fire('test', new Date('2026-07-31T14:00:00Z'));
    m.stop();
    assert.equal(result?.outcome, 'success');
    assert.equal(f.sent.length, 1);
    assert.equal(f.store.listApprovals('op:atanasio')[0]?.remainingUses, 0);
  });

  it('refuses consequential tools outside execute tier', async () => {
    const f = fixture(
      'name: test\nschedule: "0 8 * * *"\nautonomyMode: shadow\nactionTier: observe\nrequiresApproval: false\ntools: [gmail_send]',
    );
    const tools = { gmail_send: { execute: async () => ({ ok: true }) } } as unknown as ToolSet;
    const m = manager(f, tools);
    m.start();
    const result = await m.fire('test', new Date('2026-07-31T14:00:00Z'));
    m.stop();
    assert.equal(result?.outcome, 'failed');
    assert.match(result?.reason ?? '', /read-only action tier/);
  });
});
