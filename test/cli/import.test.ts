/**
 * `meridian import` — migrate an OpenClaw/Hermes home into a Meridian home.
 * Deterministic, isolated via a temp MERIDIAN_HOME; no network, no real homes.
 * The load-bearing guarantee under test: SECRETS ARE NEVER WRITTEN into the new
 * home — they're detected and surfaced by name only.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { MeridianHome } from '../../src/config/home.js';
import { applyImport, planImport, runImport } from '../../src/cli/import-cmd.js';

const SECRET = 'sk-DEADBEEFsecret0123456789abcdef';
const BOT_TOKEN = '1234567:ABCDEF_ghijklmnopqrstuvwxyz0123456789';

/** Build a fake OpenClaw home and return its path. */
function fixtureOpenclawHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-'));
  writeFileSync(join(root, 'SOUL.md'), '# Aria\nYou are Aria, a warm, concise assistant.');
  writeFileSync(join(root, 'USER.md'), '# Rez Juarez\nFounder of ATERNA. Address me as Rez.');
  writeFileSync(join(root, 'MEMORY.md'), '- The operator prefers morning meetings.');
  writeFileSync(join(root, 'AGENTS.md'), 'Always be concise. Never send before confirming.');
  mkdirSync(join(root, 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo-skill', 'SKILL.md'), '# demo skill\nDoes a thing.');
  writeFileSync(join(root, '.env'), `OPENAI_API_KEY=${SECRET}\nTELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`);
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ telegram_token: BOT_TOKEN, theme: 'dark' }));
  return root;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

describe('planImport (pure)', () => {
  it('maps the documented files and parses the operator name', () => {
    const root = fixtureOpenclawHome();
    try {
      const plan = planImport('openclaw', root);
      const targets = plan.steps.map((s) => s.targetRel.replace(/\\/g, '/'));
      assert.ok(targets.includes('IDENTITY/AGENT.md'), 'persona → AGENT.md');
      assert.ok(targets.includes('IDENTITY/USER.md'), 'user → USER.md');
      assert.ok(targets.includes('MEMORY/imported/MEMORY.md'), 'memory → MEMORY/imported');
      assert.ok(targets.includes('CONTEXT/imported-instructions.md'), 'AGENTS.md → CONTEXT');
      assert.ok(targets.some((t) => t.startsWith('SKILLS/imported/')), 'skills dir mapped');
      assert.equal(plan.operatorName, 'Rez Juarez');
      assert.deepEqual(plan.notFound, [], 'all documented docs present in the fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects secrets by NAME (env keys + config containing a secret) and never their values', () => {
    const root = fixtureOpenclawHome();
    try {
      const plan = planImport('openclaw', root);
      const envFinding = plan.secrets.find((s) => s.file === '.env');
      assert.ok(envFinding, '.env flagged');
      assert.deepEqual(envFinding.keys.sort(), ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN']);
      assert.ok(plan.secrets.some((s) => s.file === 'settings.json'), 'config with a secret value flagged');
      // The plan never carries secret VALUES.
      const serialized = JSON.stringify(plan);
      assert.ok(!serialized.includes(SECRET), 'no API key value in the plan');
      assert.ok(!serialized.includes(BOT_TOKEN), 'no bot token value in the plan');
      // Secrets are NOT copy steps.
      assert.ok(!plan.steps.some((s) => /\.env|settings\.json/.test(s.sourceAbs.split('/').pop() ?? '')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records not-found for absent documents', () => {
    const root = mkdtempSync(join(tmpdir(), 'openclaw-empty-'));
    try {
      writeFileSync(join(root, 'SOUL.md'), '# Bot');
      const plan = planImport('openclaw', root);
      assert.ok(plan.notFound.some((l) => /USER\.md/.test(l)));
      assert.ok(plan.notFound.some((l) => /MEMORY/.test(l)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('applyImport (overlay)', () => {
  it('writes mapped files with a provenance header and never the secrets', () => {
    const src = fixtureOpenclawHome();
    const agentRoot = mkdtempSync(join(tmpdir(), 'agent-'));
    try {
      const plan = planImport('openclaw', src);
      const written = applyImport(plan, { agentRoot } as unknown as MeridianHome);
      assert.ok(written.length >= 4);
      const agentMd = readFileSync(join(agentRoot, 'IDENTITY', 'AGENT.md'), 'utf8');
      assert.match(agentMd, /Imported from openclaw/);
      assert.match(agentMd, /You are Aria/);
      assert.ok(statSync(join(agentRoot, 'SKILLS', 'imported', 'skills', 'demo-skill', 'SKILL.md')).isFile());
      // No secret value anywhere in the imported tree.
      for (const f of walkFiles(agentRoot)) {
        const c = readFileSync(f, 'utf8');
        assert.ok(!c.includes(SECRET), `secret leaked into ${f}`);
        assert.ok(!c.includes(BOT_TOKEN), `bot token leaked into ${f}`);
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(agentRoot, { recursive: true, force: true });
    }
  });
});

describe('runImport (end-to-end, isolated MERIDIAN_HOME)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevAgent: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mhome-'));
    prevHome = process.env.MERIDIAN_HOME;
    prevAgent = process.env.MERIDIAN_AGENT;
    process.env.MERIDIAN_HOME = tmpHome;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.MERIDIAN_HOME;
    else process.env.MERIDIAN_HOME = prevHome;
    if (prevAgent === undefined) delete process.env.MERIDIAN_AGENT;
    else process.env.MERIDIAN_AGENT = prevAgent;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('dry-run writes nothing', async () => {
    const src = fixtureOpenclawHome();
    try {
      await runImport('openclaw', { from: src, slug: 'dry', dryRun: true });
      assert.ok(!statSync(join(tmpHome, 'dry')).isDirectory?.() || readdirSync(tmpHome).length === 0);
    } catch {
      // statSync throws if not created — that's the pass condition
      assert.ok(!readdirSync(tmpHome).some((e) => e === 'dry'));
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('full import scaffolds a bootable embedded home with imported content and no secrets', async () => {
    const src = fixtureOpenclawHome();
    try {
      await runImport('openclaw', { from: src, slug: 'fromclaw' });
      const agentRoot = join(tmpHome, 'fromclaw');
      assert.match(readFileSync(join(agentRoot, 'IDENTITY', 'AGENT.md'), 'utf8'), /You are Aria/);
      assert.match(readFileSync(join(agentRoot, 'CONTEXT', 'imported-instructions.md'), 'utf8'), /be concise/);
      assert.ok(statSync(join(agentRoot, 'MEMORY', 'imported', 'MEMORY.md')).isFile());
      // operator name patched into config
      assert.match(readFileSync(join(agentRoot, 'config.yaml'), 'utf8'), /Rez Juarez/);
      // embedded env scaffolded (zero-config), and NO secret value anywhere
      assert.ok(statSync(join(agentRoot, '.env')).isFile());
      for (const f of walkFiles(agentRoot)) {
        const c = readFileSync(f, 'utf8');
        assert.ok(!c.includes(SECRET) && !c.includes(BOT_TOKEN), `secret leaked into ${f}`);
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
