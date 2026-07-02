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
import {
  applyImport,
  planImport,
  runImport,
  sanitizeConfigContent,
  stripLiveState,
} from '../../src/cli/import-cmd.js';

const SECRET = 'sk-DEADBEEFsecret0123456789abcdef';
const BOT_TOKEN = '1234567:ABCDEF_ghijklmnopqrstuvwxyz0123456789';
// Hyphenated router-key family — the shape Hermes homes carry. The regression
// under test: a hyphen right after the `sk-` prefix defeated the OLD value
// regex (`sk-[A-Za-z0-9]{16,}`) and must be caught by the widened one.
// Deliberately NOT shaped like any real provider's key format, and assembled
// by join() so no contiguous key-like literal ever exists in this source file:
// GitHub push protection (correctly) blocks anything matching a real vendor
// pattern, and third-party scanners would flag it forever. Do not "simplify"
// this back to a single literal.
const OR_KEY = ['sk-or', 'fixture', 'FAKE0123456789abcdefFAKE0123456789abcdef'].join('-');

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

/** Build a fully SYNTHETIC Hermes home mirroring the real anatomy (SOUL.md
 *  with a LIVE-STATE block, memories/{USER,MEMORY}.md, config/cron/channels,
 *  skills with a .hub registry and a planted skill-level secret, plugins/,
 *  auth.json credential pool, secrets/ service account, runtime junk).
 *  Never real data. */
function fixtureHermesHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-'));
  writeFileSync(
    join(root, 'SOUL.md'),
    [
      '# Randy — Soul',
      'You are Randy, a dry-witted operations agent.',
      '',
      '<!-- LIVE-STATE-BEGIN (auto-refreshed by pulse, do not hand-edit) -->',
      'FIXTURE-LIVE-STATE battery 87%, focus mode on',
      '<!-- LIVE-STATE-END -->',
      '',
      '## Hard lines',
      'Never speak for the operator.',
    ].join('\n'),
  );
  mkdirSync(join(root, 'memories'), { recursive: true });
  writeFileSync(
    join(root, 'memories', 'USER.md'),
    '# USER.md — Randy Fixture\n\n**Full name:** Randy Fixture\nPrefers text over calls.',
  );
  writeFileSync(
    join(root, 'memories', 'MEMORY.md'),
    '§ Operator drinks flat whites.\n§ Staging port is 18891.',
  );
  writeFileSync(
    join(root, 'config.yaml'),
    'model: primary-model\nmcp_servers:\n  cortex:\n    enabled: true\nmemory:\n  memory_char_limit: 4000\n',
  );
  mkdirSync(join(root, 'cron'), { recursive: true });
  writeFileSync(
    join(root, 'cron', 'jobs.json'),
    JSON.stringify({
      jobs: [{ id: 'j1', name: 'morning-brief', prompt: 'Say hi', schedule: '0 7 * * *', enabled: true }],
      updated_at: 'x',
    }),
  );
  writeFileSync(
    join(root, 'channel_directory.json'),
    JSON.stringify({ updated_at: 'x', platforms: { telegram: {} } }),
  );
  mkdirSync(join(root, 'skills', 'demo-skill', 'sub-skill'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo-skill', 'DESCRIPTION.md'), '# demo skill\nDoes a thing.');
  writeFileSync(join(root, 'skills', 'demo-skill', 'sub-skill', 'SKILL.md'), '# sub skill');
  // Planted skill-level secret: must never be COPIED into the new home.
  writeFileSync(join(root, 'skills', 'demo-skill', '.env'), `SKILL_SECRET=${SECRET}\n`);
  mkdirSync(join(root, 'skills', '.hub'), { recursive: true });
  writeFileSync(join(root, 'skills', '.hub', 'audit.log'), 'machine registry noise');
  mkdirSync(join(root, 'plugins', 'current-time'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'current-time', 'plugin.yaml'), 'name: current-time');
  writeFileSync(
    join(root, '.env'),
    `OPENROUTER_API_KEY=${OR_KEY}\nTELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nCORTEX_DEFAULT_AGENT_ID=fixture\n`,
  );
  // Credential pool whose file NAME must be flagged even though key extraction
  // is best-effort (the real hermes auth.json shape).
  writeFileSync(
    join(root, 'auth.json'),
    JSON.stringify({ version: 1, credential_pool: { openrouter: { api_key: OR_KEY } }, updated_at: 'x' }),
  );
  // Service-account JSON whose PEM value evades the value regex (spaces inside)
  // — caught by the secrets/ DIR rule, not by content.
  mkdirSync(join(root, 'secrets'), { recursive: true });
  writeFileSync(
    join(root, 'secrets', 'service-account.json'),
    JSON.stringify({
      type: 'service_account',
      private_key: '-----BEGIN PRIVATE KEY-----\nFAKEFIXTUREKEYMATERIAL\n-----END PRIVATE KEY-----\n',
    }),
  );
  // Runtime junk that must never be planned.
  writeFileSync(join(root, 'state.db'), 'sqlite-junk');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(join(root, 'sessions', 'blob.jsonl'), '{"junk":true}');
  writeFileSync(join(root, 'gateway_state.json'), JSON.stringify({ pid: 123 }));
  return root;
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

describe('planImport (hermes, real anatomy)', () => {
  it('maps SOUL.md + memories/{USER,MEMORY}.md and plans config/cron/channels into CONTEXT', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      const byTarget = new Map(plan.steps.map((s) => [s.targetRel.replace(/\\/g, '/'), s]));
      const persona = byTarget.get('IDENTITY/AGENT.md');
      assert.ok(persona, 'SOUL.md → AGENT.md');
      assert.equal(persona.transform, 'strip-live-state', 'persona carries the live-state strip');
      const user = byTarget.get('IDENTITY/USER.md');
      assert.ok(user && /memories[\\/]USER\.md$/.test(user.sourceAbs), 'user comes from memories/USER.md');
      const memory = byTarget.get('MEMORY/imported/MEMORY.md');
      assert.ok(memory && /memories[\\/]MEMORY\.md$/.test(memory.sourceAbs), 'memory comes from memories/MEMORY.md');
      for (const t of [
        'CONTEXT/imported-hermes-config.yaml',
        'CONTEXT/imported-hermes-cron.json',
        'CONTEXT/imported-hermes-channels.json',
      ]) {
        const step = byTarget.get(t);
        assert.ok(step, `${t} planned`);
        assert.equal(step.transform, 'sanitize-config', `${t} is sanitized`);
      }
      const note = byTarget.get('CONTEXT/imported-hermes-plugins.md');
      assert.ok(note && note.kind === 'note', 'plugins summarized as a note');
      assert.match(note.content ?? '', /current-time/, 'note lists the plugin');
      const skills = plan.steps.find((s) => s.kind === 'dir');
      assert.ok(skills, 'skills dir planned');
      assert.deepEqual(skills.excludes, ['.hub'], 'registry excluded from the copy');
      // Runtime junk is never planned.
      assert.ok(
        !plan.steps.some((s) => /state\.db|sessions|gateway_state/.test(s.sourceAbs)),
        'state.db / sessions / gateway_state are not steps',
      );
      assert.equal(plan.operatorName, 'Randy Fixture', 'USER.md filename token stripped from the heading');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags .env keys, auth.json by NAME (pool key names), and secrets/ dir contents — values never serialize', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      const env = plan.secrets.find((s) => s.file === '.env');
      assert.ok(env, '.env flagged');
      assert.deepEqual(env.keys.sort(), ['CORTEX_DEFAULT_AGENT_ID', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN']);
      const auth = plan.secrets.find((s) => s.file === 'auth.json');
      assert.ok(auth, 'auth.json flagged by NAME even though its shape evades the env parser');
      assert.ok(auth.keys.includes('credential_pool.openrouter'), 'pool provider names surfaced');
      assert.ok(
        plan.secrets.some((s) => s.file.replace(/\\/g, '/') === 'secrets/service-account.json'),
        'service-account JSON flagged via the secrets/ dir rule',
      );
      const serialized = JSON.stringify(plan);
      for (const v of [OR_KEY, SECRET, BOT_TOKEN]) {
        assert.ok(!serialized.includes(v), 'no secret value in the serialized plan');
      }
      assert.ok(!plan.steps.some((s) => /auth\.json$|\.env$/.test(s.sourceAbs)), 'secrets are not copy steps');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stripLiveState and sanitizeConfigContent (pure)', () => {
    const soul = 'keep me\n<!-- LIVE-STATE-BEGIN (auto) -->\nvolatile\n<!-- LIVE-STATE-END -->\nand me';
    const stripped = stripLiveState(soul);
    assert.ok(!stripped.includes('volatile'), 'live-state content removed');
    assert.ok(stripped.includes('keep me') && stripped.includes('and me'), 'surrounding prose kept');
    // No END marker → conservative no-op.
    const dangling = 'a\n<!-- LIVE-STATE-BEGIN -->\nb';
    assert.equal(stripLiveState(dangling), dangling, 'dangling BEGIN leaves content untouched');
    const sanitized = sanitizeConfigContent(`api_key: "${OR_KEY}"\nplain: value`);
    assert.ok(!sanitized.includes(OR_KEY), 'hyphenated sk- key redacted');
    assert.ok(sanitized.includes('[redacted-on-import]') && sanitized.includes('plain: value'));
  });
});

describe('applyImport (hermes overlay)', () => {
  it('applies transforms + headers; copies skills without .hub, secret-named files, or symlinks', () => {
    const src = fixtureHermesHome();
    const agentRoot = mkdtempSync(join(tmpdir(), 'agent-'));
    try {
      const plan = planImport('hermes', src);
      applyImport(plan, { agentRoot } as unknown as MeridianHome);
      const agentMd = readFileSync(join(agentRoot, 'IDENTITY', 'AGENT.md'), 'utf8');
      assert.match(agentMd, /Imported from hermes/);
      assert.match(agentMd, /You are Randy/);
      assert.ok(!agentMd.includes('FIXTURE-LIVE-STATE'), 'live-state block stripped');
      assert.match(agentMd, /Hard lines/, 'content after the block survives');
      const cfg = readFileSync(join(agentRoot, 'CONTEXT', 'imported-hermes-config.yaml'), 'utf8');
      assert.match(cfg, /^# Imported from hermes/, 'yaml provenance header');
      const cron = readFileSync(join(agentRoot, 'CONTEXT', 'imported-hermes-cron.json'), 'utf8');
      assert.ok(JSON.parse(cron).jobs[0].name === 'morning-brief', 'json copied parseable (no header)');
      assert.match(
        readFileSync(join(agentRoot, 'CONTEXT', 'imported-hermes-plugins.md'), 'utf8'),
        /current-time/,
      );
      assert.ok(
        statSync(join(agentRoot, 'SKILLS', 'imported', 'skills', 'demo-skill', 'sub-skill', 'SKILL.md')).isFile(),
        'nested skills copied',
      );
      assert.throws(
        () => statSync(join(agentRoot, 'SKILLS', 'imported', 'skills', '.hub')),
        '.hub registry excluded',
      );
      assert.throws(
        () => statSync(join(agentRoot, 'SKILLS', 'imported', 'skills', 'demo-skill', '.env')),
        'skill-level .env never copied',
      );
      for (const f of walkFiles(agentRoot)) {
        const c = readFileSync(f, 'utf8');
        for (const v of [OR_KEY, SECRET, BOT_TOKEN]) {
          assert.ok(!c.includes(v), `secret leaked into ${f}`);
        }
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(agentRoot, { recursive: true, force: true });
    }
  });
});

describe('runImport hermes (end-to-end, isolated MERIDIAN_HOME)', () => {
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
    const src = fixtureHermesHome();
    try {
      await runImport('hermes', { from: src, slug: 'hermes-dry', dryRun: true });
      assert.ok(!readdirSync(tmpHome).some((e) => e === 'hermes-dry'));
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('full import scaffolds a bootable embedded home with hermes content and no secrets', async () => {
    const src = fixtureHermesHome();
    try {
      await runImport('hermes', { from: src, slug: 'fromhermes' });
      const agentRoot = join(tmpHome, 'fromhermes');
      assert.match(readFileSync(join(agentRoot, 'IDENTITY', 'AGENT.md'), 'utf8'), /You are Randy/);
      assert.match(readFileSync(join(agentRoot, 'IDENTITY', 'USER.md'), 'utf8'), /Randy Fixture/);
      assert.ok(statSync(join(agentRoot, 'MEMORY', 'imported', 'MEMORY.md')).isFile());
      assert.ok(statSync(join(agentRoot, 'CONTEXT', 'imported-hermes-config.yaml')).isFile());
      assert.match(readFileSync(join(agentRoot, 'config.yaml'), 'utf8'), /Randy Fixture/);
      assert.ok(statSync(join(agentRoot, '.env')).isFile());
      for (const f of walkFiles(agentRoot)) {
        const c = readFileSync(f, 'utf8');
        for (const v of [OR_KEY, SECRET, BOT_TOKEN]) {
          assert.ok(!c.includes(v), `secret leaked into ${f}`);
        }
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
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
