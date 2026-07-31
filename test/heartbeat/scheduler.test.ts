import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MeridianHome } from '../../src/config/home.js';
import {
  HEARTBEAT_PROMPT,
  HeartbeatScheduler,
  armHeartbeat,
  intervalToCron,
  parseHeartbeatAssessment,
  withinActiveHours,
  type HeartbeatAssessment,
} from '../../src/heartbeat/scheduler.js';
import { makeConfig, silentLogger } from '../helpers/fixtures.js';

const roots: string[] = [];
const schedulers: Array<HeartbeatScheduler | null> = [];
after(() => {
  for (const scheduler of schedulers) scheduler?.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function home(): MeridianHome {
  const root = mkdtempSync(join(tmpdir(), 'meridian-heartbeat-'));
  roots.push(root);
  const agentRoot = join(root, 'arlo');
  return {
    root, agentSlug: 'arlo', agentRoot,
    configPath: join(agentRoot, 'config.yaml'), envPath: join(agentRoot, '.env'), vaultPath: join(agentRoot, 'vault.enc'),
    layer: (name: string) => join(agentRoot, name), sessions: join(agentRoot, 'sessions'), logs: join(agentRoot, 'logs'),
    checkpoints: join(agentRoot, 'checkpoints'), stateDb: join(agentRoot, 'state.db'),
  } as MeridianHome;
}

const quiet: HeartbeatAssessment = { status: 'quiet', confidence: 0.9, summary: 'Nothing needs attention.', evidence: [], suggestedAction: '' };
const actionable: HeartbeatAssessment = { status: 'actionable', confidence: 0.91, summary: 'A deadline is due.', evidence: ['commitment #42'], suggestedAction: 'Review it.' };
const ALL_DAY = { start: '00:00', end: '23:59' };
const heartbeat = (overrides: Record<string, unknown> = {}) => makeConfig({ heartbeat: { activeHours: ALL_DAY, ...overrides } }).heartbeat;

describe('heartbeat governance', () => {
  it('shadow mode records judgment without pushing', async () => {
    const pushed: string[] = [];
    const hb = new HeartbeatScheduler({ home: home(), heartbeat: heartbeat({ enabled: true, mode: 'shadow' }), logger: silentLogger, assess: async () => actionable, onAck: (text) => { pushed.push(text); } });
    assert.equal(await hb.beat(new Date()), true);
    assert.deepEqual(pushed, []);
  });

  it('live mode pushes only novel actionable judgments above threshold', async () => {
    const pushed: string[] = [];
    const h = home();
    const cfg = heartbeat({ enabled: true, mode: 'live', minConfidence: 0.8, cooldownMinutes: 60 });
    const hb = new HeartbeatScheduler({ home: h, heartbeat: cfg, logger: silentLogger, assess: async () => actionable, onAck: (text) => { pushed.push(text); } });
    const now = new Date();
    assert.equal(await hb.beat(now), true);
    assert.equal(await hb.beat(new Date(now.getTime() + 1_000)), true);
    assert.equal(pushed.length, 1, 'identical judgment is suppressed during cooldown');
    assert.match(pushed[0]!, /deadline is due/);
  });

  it('quiet judgments never push in live mode', async () => {
    const pushed: string[] = [];
    const hb = new HeartbeatScheduler({ home: home(), heartbeat: heartbeat({ enabled: true, mode: 'live' }), logger: silentLogger, assess: async () => quiet, onAck: (text) => { pushed.push(text); } });
    assert.equal(await hb.beat(), true);
    assert.deepEqual(pushed, []);
  });

  it('does not run outside active hours', async () => {
    let calls = 0;
    const hb = new HeartbeatScheduler({ home: home(), heartbeat: heartbeat({ activeHours: { start: '09:00', end: '17:00' } }), logger: silentLogger, assess: async () => { calls++; return quiet; } });
    const at = new Date(); at.setHours(3, 0, 0, 0);
    assert.equal(await hb.beat(at), false);
    assert.equal(calls, 0);
  });

  it('enabled config arms and disabled config does not', () => {
    const enabled = armHeartbeat({ home: home(), heartbeat: heartbeat({ enabled: true, every: '30m' }), logger: silentLogger, assess: async () => quiet });
    schedulers.push(enabled);
    assert.equal(enabled?.running, true);
    const disabled = armHeartbeat({ home: home(), heartbeat: heartbeat({ enabled: false }), logger: silentLogger, assess: async () => quiet });
    assert.equal(disabled, null);
  });
});

describe('heartbeat parsing and schedule helpers', () => {
  it('parses a fenced or plain JSON assessment and rejects prose', () => {
    assert.deepEqual(parseHeartbeatAssessment(`\`\`\`json\n${JSON.stringify(actionable)}\n\`\`\``), actionable);
    assert.throws(() => parseHeartbeatAssessment('looks fine'), /did not return JSON/);
    assert.match(HEARTBEAT_PROMPT, /Return JSON only/);
  });

  it('supports overnight active-hour windows', () => {
    const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };
    assert.equal(withinActiveHours(at(23), '22:00', '06:00'), true);
    assert.equal(withinActiveHours(at(3), '22:00', '06:00'), true);
    assert.equal(withinActiveHours(at(12), '22:00', '06:00'), false);
  });

  it('translates intervals and safely falls back', () => {
    assert.equal(intervalToCron('30m'), '*/30 * * * *');
    assert.equal(intervalToCron('2h'), '0 */2 * * *');
    assert.equal(intervalToCron('1s'), '*/1 * * * * *');
    assert.equal(intervalToCron('whenever'), '0 */2 * * *');
  });
});
