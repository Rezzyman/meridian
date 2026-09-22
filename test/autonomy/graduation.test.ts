import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeridianHome } from '../../src/config/home.js';
import { AutonomyControlPlane } from '../../src/autonomy/control-plane.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function plane(): AutonomyControlPlane {
  const root = mkdtempSync(join(tmpdir(), 'meridian-grad-'));
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
  return new AutonomyControlPlane(home);
}

let tick = 0;
function run(
  p: AutonomyControlPlane,
  job: string,
  outcome: 'success' | 'failed' | 'awaiting_approval' | 'skipped',
) {
  // Distinct scheduledAt per run: the control plane dedupes an occurrence by
  // its scheduled time, and CI can call this twice in the same millisecond.
  tick += 1;
  const at = new Date(Date.UTC(2026, 8, 22, 12, tick, 0));
  const begun = p.begin(job, at, 60_000, at);
  assert.ok(begun.acquired && begun.run);
  p.finish(job, begun.run!.runId, outcome, {}, new Date(at.getTime() + 1));
}

describe('trust graduation bookkeeping (WS3)', () => {
  it('counts trailing approved runs and resets on a gate stop', () => {
    const p = plane();
    run(p, 'brief', 'success');
    run(p, 'brief', 'skipped');
    assert.equal(p.consecutiveApprovedRuns('brief'), 2);
    run(p, 'brief', 'awaiting_approval');
    assert.equal(p.consecutiveApprovedRuns('brief'), 0);
    run(p, 'brief', 'success');
    assert.equal(p.consecutiveApprovedRuns('brief'), 1);
  });
  it('graduation is durable and revocable', () => {
    const p = plane();
    assert.equal(p.graduatedAt('brief'), null);
    p.setGraduated('brief', new Date('2026-09-22T15:00:00Z'));
    assert.equal(p.graduatedAt('brief'), '2026-09-22T15:00:00.000Z');
    p.setGraduated('brief', null);
    assert.equal(p.graduatedAt('brief'), null);
  });
});
