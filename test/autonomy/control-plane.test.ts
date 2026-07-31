import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AutonomyControlPlane } from '../../src/autonomy/control-plane.js';
import type { MeridianHome } from '../../src/config/home.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { home: MeridianHome; plane: AutonomyControlPlane } {
  const root = mkdtempSync(join(tmpdir(), 'meridian-autonomy-'));
  roots.push(root);
  const agentRoot = join(root, 'arlo');
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
  return { home, plane: new AutonomyControlPlane(home) };
}

describe('AutonomyControlPlane', () => {
  it('persists one deterministic schedule occurrence and rejects duplicates', () => {
    const { home, plane } = fixture();
    const at = new Date('2026-07-31T14:00:00.000Z');
    const begun = plane.begin('morning-brief', at, 60_000, at);
    assert.equal(begun.acquired, true);
    plane.finish('morning-brief', begun.run!.runId, 'success', { output: 'done' }, at);

    const restarted = new AutonomyControlPlane(home);
    assert.deepEqual(restarted.begin('morning-brief', at, 60_000, at), {
      acquired: false,
      reason: 'duplicate',
    });
    assert.equal(restarted.runs('morning-brief')[0]?.outcome, 'success');
  });

  it('prevents overlap while a lease is active', () => {
    const { plane } = fixture();
    const at = new Date('2026-07-31T14:00:00.000Z');
    assert.equal(plane.begin('brief', at, 60_000, at).acquired, true);
    assert.equal(
      plane.begin('brief', new Date(at.getTime() + 1_000), 60_000, new Date(at.getTime() + 1_000)).reason,
      'lease_active',
    );
  });

  it('dead-letters an interrupted run after its lease expires', () => {
    const { plane } = fixture();
    const at = new Date('2026-07-31T14:00:00.000Z');
    plane.begin('brief', at, 1_000, at);
    const recovered = plane.recoverExpired(new Date(at.getTime() + 1_001));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.outcome, 'dead_letter');
    assert.match(recovered[0]?.reason ?? '', /lease expired/);
  });

  it('dead-letters an in-flight run immediately when a new runtime takes ownership', () => {
    const { home, plane } = fixture();
    const at = new Date('2026-07-31T14:00:00.000Z');
    plane.begin('brief', at, 15 * 60_000, at);
    const restarted = new AutonomyControlPlane(home);
    const recovered = restarted.recoverExpired(new Date(at.getTime() + 1_000));
    assert.equal(recovered[0]?.outcome, 'dead_letter');
    assert.match(recovered[0]?.reason ?? '', /runtime restarted/);
  });

  it('suppresses identical notifications during cooldown and persists the decision', () => {
    const { home, plane } = fixture();
    const at = new Date('2026-07-31T14:00:00.000Z');
    assert.equal(plane.shouldNotify('heartbeat', { summary: 'same' }, 60_000, at), true);
    const restarted = new AutonomyControlPlane(home);
    assert.equal(restarted.shouldNotify('heartbeat', { summary: 'same' }, 60_000, new Date(at.getTime() + 1_000)), false);
    assert.equal(restarted.shouldNotify('heartbeat', { summary: 'changed' }, 60_000, new Date(at.getTime() + 2_000)), true);
  });

  it('stores the next schedule boundary across process restarts', () => {
    const { home, plane } = fixture();
    const next = new Date('2026-08-01T14:00:00.000Z');
    plane.setNextScheduledAt('brief', next);
    assert.equal(new AutonomyControlPlane(home).getNextScheduledAt('brief')?.toISOString(), next.toISOString());
  });
});
