/**
 * `meridian import` — migrate an OpenClaw/Hermes home into a Meridian home.
 * Deterministic, isolated via a temp MERIDIAN_HOME; no network, no real homes.
 * Fixtures mirror the REAL on-disk anatomy (verified against live homes,
 * 2026-07): hermes keeps durable memory in state.db (NO memories/MEMORY.md),
 * auth.json pools are ARRAYS of prioritized keys, cron jobs carry object
 * schedules with enabled flags; openclaw keeps per-agent docs under
 * agents/<id>/agent/ and wires models/channels/mcp through openclaw.json.
 * The load-bearing guarantee under test: SECRETS ARE NEVER WRITTEN into the
 * new home — they're detected and surfaced by name only.
 */

import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { MeridianHome } from '../../src/config/home.js';
import { loadAutomationDefs } from '../../src/automations/manager.js';
import {
  applyImport,
  planImport,
  runImport,
  sanitizeConfigContent,
  stripLiveState,
} from '../../src/cli/import-cmd.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

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
// Bait planted in the committed state.db fixture — must never survive import.
const STATE_DB_BAIT = 'FIXTUREVALUE12345';
const DB_PASSWORD = 'SeCrEtPw1234567';

/** Build a LEGACY fake OpenClaw home (root-level docs — old layouts still
 *  import) and return its path. */
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

/** Build a fake OpenClaw home mirroring the REAL anatomy: openclaw.json wires
 *  agents/models/channels/mcp; per-agent docs live under agents/<id>/agent/;
 *  auth-profiles.json holds provider keys; memory/<id>.sqlite is a chunk store. */
function fixtureOpenclawRealHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-real-'));
  writeFileSync(
    join(root, 'openclaw.json'),
    JSON.stringify({
      agents: {
        list: [
          { id: 'main', model: 'openai/gpt-5.4-mini' },
          { id: 'aria', name: 'aria', model: 'openai/gpt-5.4' },
        ],
        defaults: {
          model: {
            primary: 'openai/gpt-5.4',
            fallbacks: ['openai/gpt-5.4-mini', 'openrouter/anthropic/claude-sonnet-4.6', 'openrouter/mistral/large'],
          },
          pdfModel: { primary: 'openai/gpt-5.4', fallbacks: ['openrouter/anthropic/claude-sonnet-4.6'] },
          pdfMaxPages: 50,
          pdfMaxBytesMb: 32,
        },
      },
      channels: { telegram: { name: 'aria-telegram', enabled: true, botToken: BOT_TOKEN } },
      gateway: { mode: 'local', auth: { mode: 'token', token: OR_KEY }, port: 18799 },
      mcp: {
        servers: {
          'cortex-v2': {
            command: '/usr/bin/tsx',
            args: ['/opt/cortex/src/mcp/server.ts'],
            env: {
              DATABASE_URL: `postgresql://neondb_owner:${DB_PASSWORD}@ep-fixture.aws.neon.tech/db`,
              VOYAGE_API_KEY: SECRET,
              EMBEDDING_PROVIDER: 'voyage',
              CORTEX_DEFAULT_AGENT: 'aria',
            },
          },
        },
      },
      tools: {
        media: {
          image: {
            enabled: true,
            prompt: 'You are a vision analyst for the Winn Methodology. Extract damage indicators.',
            models: [{ provider: 'openai', model: 'gpt-5.4', capabilities: ['image'] }],
          },
        },
      },
      env: { OPENAI_API_KEY: SECRET },
    }),
  );
  const agentDir = join(root, 'agents', 'aria', 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'IDENTITY.md'), '# Aria\nYou are Aria, the roofing intelligence.');
  writeFileSync(join(agentDir, 'PRIME-CONTEXT.md'), 'Prime directive: measure twice.');
  writeFileSync(join(agentDir, 'STANDING-ORDERS.md'), 'Standing order: Winn Reports come first.');
  writeFileSync(
    join(agentDir, 'auth-profiles.json'),
    JSON.stringify({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: SECRET },
        'openrouter:default': { type: 'api_key', provider: 'openrouter', key: OR_KEY },
      },
    }),
  );
  mkdirSync(join(root, 'agents', 'aria', 'sessions'), { recursive: true });
  writeFileSync(
    join(root, 'agents', 'aria', 'sessions', 'fixture-session.jsonl'),
    '{"role":"user","content":"hello"}\n',
  );
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'aria.sqlite'), 'not-actually-read-by-the-planner');
  mkdirSync(join(root, 'skills', 'roof-math'), { recursive: true });
  writeFileSync(join(root, 'skills', 'roof-math', 'SKILL.md'), '# roof math');
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

/** Build a fully SYNTHETIC Hermes home mirroring the REAL anatomy (SOUL.md
 *  with a LIVE-STATE block, memories/USER.md but NO MEMORY.md — durable
 *  memory lives in state.db, committed as a tiny real sqlite fixture —
 *  config.yaml model pinning, cron jobs with enabled+disabled entries,
 *  channel directory, credential-pool ARRAYS, session JSONL, machine
 *  registries, runtime junk). Never real data. */
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
  // NO memories/MEMORY.md — real homes keep durable memory in state.db.
  copyFileSync(join(FIXTURES, 'hermes-state.db'), join(root, 'state.db'));
  writeFileSync(
    join(root, 'config.yaml'),
    [
      'model:',
      '  provider: anthropic',
      '  default: claude-haiku-4-5-20251001',
      'fallback_providers:',
      '- provider: openrouter',
      '  model: anthropic/claude-haiku-4.5',
      '- provider: openrouter',
      '  model: openai/gpt-5.1',
      '- provider: groq',
      '  model: llama-4-scout',
      'telegram:',
      '  enabled: true',
      'timezone: America/Denver',
      'smart_model_routing:',
      '  enabled: false',
      '  max_simple_chars: 200',
      '  max_simple_words: 35',
      '  cheap_model:',
      '    provider: anthropic',
      '    model: claude-haiku-4-5-20251001',
      "TELEGRAM_HOME_CHANNEL: '-1003915055148'",
      'mcp_servers:',
      '  cortex:',
      '    enabled: true',
      'memory:',
      '  memory_char_limit: 4000',
    ].join('\n'),
  );
  mkdirSync(join(root, 'cron'), { recursive: true });
  writeFileSync(
    join(root, 'cron', 'jobs.json'),
    JSON.stringify({
      jobs: [
        {
          id: 'j1',
          name: 'Randy — Morning Brief',
          schedule: { kind: 'cron', expr: '6 8 * * 1-5' },
          enabled: true,
          prompt: 'Deliver the morning brief. Plain text, under 200 words.',
          deliver: 'telegram:8421274536',
          last_status: 'ok',
        },
        {
          id: 'j2',
          name: 'Randy — Dream Cycle',
          schedule: { kind: 'cron', expr: '6 3 * * *' },
          enabled: false,
          prompt: 'Consolidate memories.',
        },
        {
          id: 'j3',
          name: 'Randy — Pulse',
          schedule: { kind: 'every', seconds: 900 },
          enabled: true,
          prompt: 'Pulse check.',
        },
      ],
      updated_at: 'x',
    }),
  );
  writeFileSync(
    join(root, 'channel_directory.json'),
    JSON.stringify({
      updated_at: 'x',
      platforms: {
        telegram: [
          { id: '8421274536', name: 'Rez', type: 'dm', thread_id: null },
          { id: '-100999', name: 'OPS ROOM', type: 'group', thread_id: null },
        ],
        whatsapp: [],
      },
    }),
  );
  mkdirSync(join(root, 'skills', 'demo-skill', 'sub-skill'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo-skill', 'DESCRIPTION.md'), '# demo skill\nDoes a thing.');
  writeFileSync(join(root, 'skills', 'demo-skill', 'sub-skill', 'SKILL.md'), '# sub skill');
  // Planted skill-level secret: must never be COPIED into the new home.
  writeFileSync(join(root, 'skills', 'demo-skill', '.env'), `SKILL_SECRET=${SECRET}\n`);
  mkdirSync(join(root, 'skills', '.hub'), { recursive: true });
  writeFileSync(join(root, 'skills', '.hub', 'audit.log'), 'machine registry noise');
  mkdirSync(join(root, 'skills', '.bundled_manifest'), { recursive: true });
  writeFileSync(join(root, 'skills', '.bundled_manifest', 'manifest.json'), '{"bundled":true}');
  mkdirSync(join(root, 'plugins', 'current-time'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'current-time', 'plugin.yaml'), 'name: current-time');
  writeFileSync(
    join(root, '.env'),
    `OPENROUTER_API_KEY=${OR_KEY}\nTELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nCORTEX_DEFAULT_AGENT_ID=fixture\n`,
  );
  // Credential pool with the REAL shape: ARRAYS of prioritized keys per
  // provider (oauth + api_key, priorities, expiry). NAMES surface; values never.
  writeFileSync(
    join(root, 'auth.json'),
    JSON.stringify({
      version: 1,
      credential_pool: {
        openrouter: [
          {
            id: 'or1',
            label: 'OR MAIN',
            auth_type: 'api_key',
            priority: 0,
            access_token: OR_KEY,
            base_url: 'https://openrouter.example/api/v1',
          },
        ],
        anthropic: [
          {
            id: 'a1',
            label: 'OAuth Home',
            auth_type: 'oauth',
            priority: 0,
            access_token: SECRET,
            refresh_token: SECRET,
            expires_at_ms: 1782957644638,
          },
          { id: 'a2', label: 'API backup', auth_type: 'api_key', priority: 1, access_token: SECRET },
        ],
      },
      updated_at: 'x',
    }),
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
  // Raw session transcripts (NOT copied unless --sessions).
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(
    join(root, 'sessions', '20260501_082603_fixture.jsonl'),
    '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n',
  );
  writeFileSync(join(root, 'sessions', '20260502_090000_fixture.jsonl'), '{"role":"user","content":"again"}\n');
  // Runtime debris inside sessions/ — raw request dumps can embed credentials
  // and must stay home even under --sessions.
  writeFileSync(
    join(root, 'sessions', 'request_dump_20260501.json'),
    JSON.stringify({ headers: { authorization: SECRET } }),
  );
  // Runtime junk that must never be planned.
  writeFileSync(join(root, 'gateway_state.json'), JSON.stringify({ pid: 123 }));
  return root;
}

/** systemd fixture: the unit matching the home + a decoy pointing elsewhere. */
function fixtureSystemdDir(hermesHome: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'systemd-'));
  writeFileSync(
    join(dir, 'hermes-gateway-fixture.service'),
    `[Service]\nEnvironment="HOME=/root"\nEnvironment="HERMES_HOME=${hermesHome}"\nExecStart=/usr/bin/python -m hermes\n`,
  );
  mkdirSync(join(dir, 'hermes-gateway-fixture.service.d'));
  writeFileSync(
    join(dir, 'hermes-gateway-fixture.service.d', 'anthropic-bridge.conf'),
    `[Service]\nEnvironment="ANTHROPIC_API_KEY=${SECRET}"\nEnvironment="ANTHROPIC_BASE_URL=http://127.0.0.1:4001"\n`,
  );
  writeFileSync(
    join(dir, 'hermes-gateway-decoy.service'),
    '[Service]\nEnvironment="HERMES_HOME=/root/.hermes-someone-else"\n',
  );
  mkdirSync(join(dir, 'hermes-gateway-decoy.service.d'));
  writeFileSync(
    join(dir, 'hermes-gateway-decoy.service.d', 'groq.conf'),
    '[Service]\nEnvironment="GROQ_API_KEY=decoy"\n',
  );
  return dir;
}

/** Minimal MeridianHome for overlay tests (applyImport + loadAutomationDefs). */
function bareHome(agentRoot: string): MeridianHome {
  return { agentRoot, layer: (name: string) => join(agentRoot, name) } as unknown as MeridianHome;
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
      // A legacy home has no openclaw.json — everything else must be present.
      assert.deepEqual(
        plan.notFound.filter((l) => !/openclaw\.json/.test(l)),
        [],
        'all documented docs present in the fixture',
      );
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
      const written = applyImport(plan, bareHome(agentRoot));
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
  it('maps SOUL.md + memories/USER.md and plans config/cron/channels into CONTEXT', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      const byTarget = new Map(plan.steps.map((s) => [s.targetRel.replace(/\\/g, '/'), s]));
      const persona = byTarget.get('IDENTITY/AGENT.md');
      assert.ok(persona, 'SOUL.md → AGENT.md');
      assert.equal(persona.transform, 'strip-live-state', 'persona carries the live-state strip');
      const user = byTarget.get('IDENTITY/USER.md');
      assert.ok(user && /memories[\\/]USER\.md$/.test(user.sourceAbs), 'user comes from memories/USER.md');
      // Real homes have NO MEMORY.md — memory extraction happens from state.db.
      assert.ok(!byTarget.has('MEMORY/imported/MEMORY.md'), 'no MEMORY.md step for the real anatomy');
      assert.ok(plan.notFound.some((l) => /MEMORY\.md/.test(l)), 'the absent MEMORY.md is logged');
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
      assert.deepEqual(skills.excludes, ['.hub', '.bundled_manifest'], 'registries excluded from the copy');
      // Runtime junk is never copied from the source.
      assert.ok(
        !plan.steps.some((s) => /state\.db|sessions|gateway_state/.test(s.sourceAbs)),
        'state.db / sessions / gateway_state are not copy steps',
      );
      assert.equal(plan.operatorName, 'Randy Fixture', 'USER.md filename token stripped from the heading');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('translates config.yaml model pinning into the models chain (openrouter remapped or dropped loudly)', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      assert.equal(plan.configPatch.models?.primary, 'anthropic/claude-haiku-4-5-20251001');
      assert.deepEqual(plan.configPatch.models?.fallbacks, [
        'routexor/claude-haiku-4.5',
        'groq/llama-4-scout',
      ]);
      assert.ok(
        plan.warnings.some((w) => /openrouter\/anthropic\/claude-haiku-4\.5 → routexor\/claude-haiku-4\.5/.test(w)),
        'openrouter→routexor remap warned for review',
      );
      assert.ok(
        plan.warnings.some((w) => /dropped openrouter\/openai\/gpt-5\.1/.test(w)),
        'non-anthropic openrouter fallback dropped with a warning',
      );
      const sr = plan.configPatch.models?.smartRouting;
      assert.ok(sr, 'smart routing translated');
      assert.equal(sr.enabled, false);
      assert.equal(sr.maxSimpleChars, 200);
      assert.equal(sr.maxSimpleWords, 35);
      assert.equal(sr.cheapModel, 'anthropic/claude-haiku-4-5-20251001');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('translates telegram wiring: enabled + defaultChatId from TELEGRAM_HOME_CHANNEL + a rewiring doc', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      assert.equal(plan.configPatch.telegramEnabled, true);
      assert.equal(plan.configPatch.telegramDefaultChatId, '-1003915055148');
      const doc = plan.steps.find((s) => s.targetRel.replace(/\\/g, '/') === 'CONNECTIONS/imported-channels.md');
      assert.ok(doc && doc.kind === 'note', 'channel doc planned');
      assert.match(doc.content ?? '', /8421274536.*Rez.*dm/, 'DM binding enumerated');
      assert.match(doc.content ?? '', /-100999.*OPS ROOM.*group/, 'group binding enumerated');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('translates cron/jobs.json into real AUTOMATIONS entries with faithful enabled state and tz', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      assert.equal(plan.automations.length, 3);
      const brief = plan.automations.find((a) => a.name === 'Randy — Morning Brief');
      assert.ok(brief, 'enabled job imported');
      assert.equal(brief.enabled, true);
      assert.equal(brief.schedule, '6 8 * * 1-5');
      assert.equal(brief.timezone, 'America/Denver', 'hermes cron fires in the agent LOCAL tz — preserved');
      assert.equal(brief.pushTo, 'telegram');
      assert.equal(brief.deliver, 'telegram:8421274536');
      const dream = plan.automations.find((a) => a.name === 'Randy — Dream Cycle');
      assert.ok(dream && dream.enabled === false, 'disabled job imports disabled');
      const pulse = plan.automations.find((a) => a.name === 'Randy — Pulse');
      assert.ok(pulse && pulse.enabled === false, 'unsupported schedule kind imports DISABLED');
      assert.ok(
        plan.warnings.some((w) => /Randy — Pulse.*unsupported schedule kind 'every'/.test(w)),
        'unsupported kind warned',
      );
      // The generated files are real automation entries (note steps under AUTOMATIONS/).
      const step = plan.steps.find((s) => s.targetRel === brief.fileRel);
      assert.ok(step?.content?.startsWith('---\n'), 'frontmatter file generated');
      assert.match(step.content ?? '', /schedule: 6 8 \* \* 1-5/);
      assert.match(step.content ?? '', /timezone: America\/Denver/);
      assert.match(step.content ?? '', /morning brief/i, 'prompt body preserved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extracts state.db memory tables and a compact session summary (native + pure readers)', () => {
    const prev = process.env.MERIDIAN_SQLITE_PURE;
    const root = fixtureHermesHome();
    try {
      for (const pure of ['0', '1']) {
        process.env.MERIDIAN_SQLITE_PURE = pure;
        const plan = planImport('hermes', root);
        const mem = plan.steps.find(
          (s) => s.targetRel.replace(/\\/g, '/') === 'MEMORY/imported/state-db-memories.md',
        );
        assert.ok(mem && mem.kind === 'note', `memories table lands (pure=${pure})`);
        assert.match(mem.content ?? '', /flat whites/, 'memory row content extracted');
        assert.match(mem.content ?? '', /LONGMEMSTART/, 'overflow-length row extracted');
        assert.ok(!(mem.content ?? '').includes(STATE_DB_BAIT), 'secret-shaped value redacted from memory dump');
        const ses = plan.steps.find(
          (s) => s.targetRel.replace(/\\/g, '/') === 'MEMORY/imported/sessions-summary.md',
        );
        assert.ok(ses && ses.kind === 'note', `session summary lands (pure=${pure})`);
        assert.match(ses.content ?? '', /Planning the roof bid/, 'session title indexed');
        assert.match(ses.content ?? '', /telegram=1/, 'per-source counts present');
      }
    } finally {
      if (prev === undefined) delete process.env.MERIDIAN_SQLITE_PURE;
      else process.env.MERIDIAN_SQLITE_PURE = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips raw session transcripts by default (logged) and copies them under --sessions', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      assert.ok(
        plan.skipped.some((s) => /sessions.*2 files.*--sessions/.test(s)),
        'skip is logged with the flag that reverses it',
      );
      assert.ok(
        !plan.steps.some((s) => s.targetRel.replace(/\\/g, '/') === 'MEMORY/imported/sessions'),
        'no raw copy by default',
      );
      const withSessions = planImport('hermes', root, { sessions: true });
      const dirStep = withSessions.steps.find(
        (s) => s.targetRel.replace(/\\/g, '/') === 'MEMORY/imported/sessions',
      );
      assert.ok(dirStep && dirStep.kind === 'dir', 'raw sessions dir planned under --sessions');
      assert.ok(
        dirStep.excludes?.includes('request_dump_20260501.json'),
        'non-JSONL runtime debris excluded from the raw copy',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches the systemd unit by HERMES_HOME and surfaces drop-in env VAR NAMES only', () => {
    const root = fixtureHermesHome();
    const systemdDir = fixtureSystemdDir(root);
    try {
      const plan = planImport('hermes', root, { systemdDir });
      assert.equal(plan.systemdUnit, 'hermes-gateway-fixture.service', 'the decoy unit is not matched');
      const dropin = plan.secrets.find((s) => s.file.includes('anthropic-bridge.conf'));
      assert.ok(dropin, 'drop-in surfaced');
      assert.deepEqual(dropin.keys, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
      assert.ok(!plan.secrets.some((s) => s.keys.includes('GROQ_API_KEY')), 'decoy drop-ins not scanned');
      assert.ok(!JSON.stringify(plan).includes(SECRET), 'drop-in values never serialize');
      const off = planImport('hermes', root, { systemdDir, systemd: false });
      assert.equal(off.systemdUnit, undefined, '--no-systemd skips the scan');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(systemdDir, { recursive: true, force: true });
    }
  });

  it('surfaces the FULL credential_pool structure by name — provider counts, labels, auth types, expiry', () => {
    const root = fixtureHermesHome();
    try {
      const plan = planImport('hermes', root);
      const auth = plan.secrets.find((s) => s.file === 'auth.json');
      assert.ok(auth, 'auth.json flagged by NAME');
      assert.ok(auth.keys.some((k) => k === 'credential_pool.openrouter: 1 key(s)'), 'provider count surfaced');
      assert.ok(auth.keys.some((k) => k === 'credential_pool.anthropic: 2 key(s)'), 'array pool counted');
      assert.ok(
        auth.keys.some((k) => /credential_pool\.anthropic\[\] label="OAuth Home" oauth priority=0 expires=\d{4}-\d{2}-\d{2}/.test(k)),
        'oauth entry described with priority + expiry',
      );
      assert.ok(
        auth.keys.some((k) => /credential_pool\.anthropic\[\] label="API backup" api_key priority=1/.test(k)),
        'api_key entry described',
      );
      const env = plan.secrets.find((s) => s.file === '.env');
      assert.ok(env, '.env flagged');
      assert.deepEqual(env.keys.sort(), ['CORTEX_DEFAULT_AGENT_ID', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN']);
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
  it('applies transforms + headers; copies skills without registries, secret-named files, or symlinks', () => {
    const src = fixtureHermesHome();
    const agentRoot = mkdtempSync(join(tmpdir(), 'agent-'));
    try {
      const plan = planImport('hermes', src);
      applyImport(plan, bareHome(agentRoot));
      const agentMd = readFileSync(join(agentRoot, 'IDENTITY', 'AGENT.md'), 'utf8');
      assert.match(agentMd, /Imported from hermes/);
      assert.match(agentMd, /You are Randy/);
      assert.ok(!agentMd.includes('FIXTURE-LIVE-STATE'), 'live-state block stripped');
      assert.match(agentMd, /Hard lines/, 'content after the block survives');
      const cfg = readFileSync(join(agentRoot, 'CONTEXT', 'imported-hermes-config.yaml'), 'utf8');
      assert.match(cfg, /^# Imported from hermes/, 'yaml provenance header');
      const cron = readFileSync(join(agentRoot, 'CONTEXT', 'imported-hermes-cron.json'), 'utf8');
      assert.ok(JSON.parse(cron).jobs[0].name === 'Randy — Morning Brief', 'json copied parseable (no header)');
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
        () => statSync(join(agentRoot, 'SKILLS', 'imported', 'skills', '.bundled_manifest')),
        '.bundled_manifest excluded',
      );
      assert.throws(
        () => statSync(join(agentRoot, 'SKILLS', 'imported', 'skills', 'demo-skill', '.env')),
        'skill-level .env never copied',
      );
      for (const f of walkFiles(agentRoot)) {
        const c = readFileSync(f, 'utf8');
        for (const v of [OR_KEY, SECRET, BOT_TOKEN, STATE_DB_BAIT]) {
          assert.ok(!c.includes(v), `secret leaked into ${f}`);
        }
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(agentRoot, { recursive: true, force: true });
    }
  });

  it('written automations round-trip through loadAutomationDefs — disabled entries never load', () => {
    const src = fixtureHermesHome();
    const agentRoot = mkdtempSync(join(tmpdir(), 'agent-'));
    try {
      const plan = planImport('hermes', src);
      applyImport(plan, bareHome(agentRoot));
      const defs = loadAutomationDefs(bareHome(agentRoot));
      const names = defs.map((d) => d.name);
      assert.ok(names.includes('Randy — Morning Brief'), 'enabled automation loads');
      assert.ok(!names.includes('Randy — Dream Cycle'), 'disabled automation does NOT load');
      assert.ok(!names.includes('Randy — Pulse'), 'unsupported-schedule automation stays parked');
      const brief = defs.find((d) => d.name === 'Randy — Morning Brief');
      assert.equal(brief?.schedule, '6 8 * * 1-5');
      assert.equal(brief?.timezone, 'America/Denver', 'tz travels into the runtime def');
      assert.equal(brief?.pushTo, 'telegram');
      assert.match(brief?.prompt ?? '', /morning brief/i);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(agentRoot, { recursive: true, force: true });
    }
  });
});

describe('planImport (openclaw, real anatomy)', () => {
  it('discovers per-agent docs and translates openclaw.json models/channels/mcp', () => {
    const root = fixtureOpenclawRealHome();
    try {
      const plan = planImport('openclaw', root);
      const byTarget = new Map(plan.steps.map((s) => [s.targetRel.replace(/\\/g, '/'), s]));
      const persona = byTarget.get('IDENTITY/AGENT.md');
      assert.ok(persona && /agents[\\/]aria[\\/]agent[\\/]IDENTITY\.md$/.test(persona.sourceAbs), 'persona from agents/<id>/agent/IDENTITY.md');
      const instructions = byTarget.get('CONTEXT/imported-instructions.md');
      assert.ok(instructions && /PRIME-CONTEXT\.md$/.test(instructions.sourceAbs), 'instructions from PRIME-CONTEXT.md');
      const standing = byTarget.get('CONTEXT/imported-standing-orders.md');
      assert.ok(standing && /STANDING-ORDERS\.md$/.test(standing.sourceAbs), 'standing orders preserved');

      // Models chain: the named agent's pin is primary; openrouter/anthropic
      // fallbacks remap to routexor; others drop loudly.
      assert.equal(plan.configPatch.models?.primary, 'openai/gpt-5.4');
      assert.deepEqual(plan.configPatch.models?.fallbacks, ['openai/gpt-5.4-mini', 'routexor/claude-sonnet-4.6']);
      assert.ok(plan.warnings.some((w) => /dropped openrouter\/mistral\/large/.test(w)));

      // Telegram: enabled travels; the token surfaces by NAME.
      assert.equal(plan.configPatch.telegramEnabled, true);
      const cfgSecrets = plan.secrets.find((s) => s.file === 'openclaw.json');
      assert.ok(cfgSecrets, 'openclaw.json secrets surfaced');
      assert.ok(cfgSecrets.keys.includes('channels.telegram.botToken'));
      assert.ok(cfgSecrets.keys.includes('gateway.auth.token'));
      assert.ok(cfgSecrets.keys.includes('env.OPENAI_API_KEY'));
      assert.ok(cfgSecrets.keys.includes('mcp.servers.cortex-v2.env.VOYAGE_API_KEY'));
      assert.ok(cfgSecrets.keys.includes('mcp.servers.cortex-v2.env.DATABASE_URL'), 'URL with userinfo is secret');

      // MCP servers land as a real CONNECTIONS/mcp.json (secret env stripped → disabled).
      const mcp = byTarget.get('CONNECTIONS/mcp.json');
      assert.ok(mcp && mcp.kind === 'note', 'mcp.json planned');
      const parsed = JSON.parse(mcp.content ?? '{}');
      assert.equal(parsed.servers.length, 1);
      const server = parsed.servers[0];
      assert.equal(server.name, 'cortex-v2');
      assert.equal(server.transport, 'stdio');
      assert.equal(server.command, '/usr/bin/tsx');
      assert.equal(server.env.EMBEDDING_PROVIDER, 'voyage', 'non-secret env copied');
      assert.equal(server.env.VOYAGE_API_KEY, undefined, 'secret env stripped');
      assert.equal(server.env.DATABASE_URL, undefined, 'credentialed URL stripped');
      assert.equal(server.enabled, false, 'stripped server imports disabled');

      // PDF + vision prompt reference docs.
      assert.match(byTarget.get('CONTEXT/imported-openclaw-pdf.md')?.content ?? '', /maxPages: 50/);
      assert.match(byTarget.get('CONTEXT/imported-vision-prompt.md')?.content ?? '', /Winn Methodology/);

      // The background `main` agent becomes a DISABLED heartbeat suggestion.
      const hb = plan.automations.find((a) => a.name === 'openclaw-main-heartbeat');
      assert.ok(hb, 'heartbeat suggestion planned');
      assert.equal(hb.enabled, false, 'never auto-armed');

      // auth-profiles.json providers by NAME; chunk stores logged as skipped.
      const authProfiles = plan.secrets.find((s) => /auth-profiles\.json$/.test(s.file));
      assert.ok(authProfiles, 'auth-profiles surfaced');
      assert.ok(authProfiles.keys.includes('profiles.openai:default (api_key)'));
      assert.ok(authProfiles.keys.includes('profiles.openrouter:default (api_key)'));
      assert.ok(plan.skipped.some((s) => /memory\/aria\.sqlite.*chunk store/.test(s)));

      // Per-agent transcripts skipped by default (logged), copied under --sessions.
      assert.ok(plan.skipped.some((s) => /sessions.*--sessions/.test(s)), 'agent sessions skip logged');
      const withSessions = planImport('openclaw', root, { sessions: true });
      assert.ok(
        withSessions.steps.some(
          (s) => s.kind === 'dir' && s.targetRel.replace(/\\/g, '/') === 'MEMORY/imported/sessions/aria',
        ),
        'per-agent transcripts planned under --sessions',
      );

      // No secret value anywhere in the serialized plan.
      const serialized = JSON.stringify(plan);
      for (const v of [SECRET, BOT_TOKEN, OR_KEY, DB_PASSWORD]) {
        assert.ok(!serialized.includes(v), 'no secret value in the serialized plan');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
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
      await runImport('hermes', { from: src, slug: 'hermes-dry', dryRun: true, systemd: false });
      assert.ok(!readdirSync(tmpHome).some((e) => e === 'hermes-dry'));
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('full import scaffolds a bootable embedded home with translated config and no secrets', async () => {
    const src = fixtureHermesHome();
    try {
      await runImport('hermes', { from: src, slug: 'fromhermes', systemd: false });
      const agentRoot = join(tmpHome, 'fromhermes');
      assert.match(readFileSync(join(agentRoot, 'IDENTITY', 'AGENT.md'), 'utf8'), /You are Randy/);
      assert.match(readFileSync(join(agentRoot, 'IDENTITY', 'USER.md'), 'utf8'), /Randy Fixture/);
      assert.ok(statSync(join(agentRoot, 'CONTEXT', 'imported-hermes-config.yaml')).isFile());
      // state.db memory + session summary landed.
      assert.match(
        readFileSync(join(agentRoot, 'MEMORY', 'imported', 'state-db-memories.md'), 'utf8'),
        /flat whites/,
      );
      assert.match(
        readFileSync(join(agentRoot, 'MEMORY', 'imported', 'sessions-summary.md'), 'utf8'),
        /Planning the roof bid/,
      );
      // Raw transcripts stayed home (no --sessions).
      assert.throws(() => statSync(join(agentRoot, 'MEMORY', 'imported', 'sessions')));
      // Model pinning + telegram wiring translated into config.yaml.
      const cfg = readFileSync(join(agentRoot, 'config.yaml'), 'utf8');
      assert.match(cfg, /Randy Fixture/);
      assert.match(cfg, /primary: anthropic\/claude-haiku-4-5-20251001/);
      assert.match(cfg, /routexor\/claude-haiku-4\.5/);
      assert.match(cfg, /defaultChatId: "-1003915055148"/);
      // Cron jobs became real automations with faithful enabled state.
      const autoDir = join(agentRoot, 'AUTOMATIONS');
      const briefFile = readdirSync(autoDir).find((f) => f.includes('morning-brief'));
      assert.ok(briefFile, 'imported automation file exists');
      assert.match(readFileSync(join(autoDir, briefFile), 'utf8'), /enabled: true/);
      const dreamFile = readdirSync(autoDir).find((f) => f.includes('dream-cycle'));
      assert.ok(dreamFile, 'disabled automation file exists');
      assert.match(readFileSync(join(autoDir, dreamFile), 'utf8'), /enabled: false/);
      // Channel rewiring doc landed.
      assert.match(readFileSync(join(agentRoot, 'CONNECTIONS', 'imported-channels.md'), 'utf8'), /OPS ROOM/);
      assert.ok(statSync(join(agentRoot, '.env')).isFile());
      for (const f of walkFiles(agentRoot)) {
        const c = readFileSync(f, 'utf8');
        for (const v of [OR_KEY, SECRET, BOT_TOKEN, STATE_DB_BAIT]) {
          assert.ok(!c.includes(v), `secret leaked into ${f}`);
        }
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('--sessions copies the raw transcripts', async () => {
    const src = fixtureHermesHome();
    try {
      await runImport('hermes', { from: src, slug: 'withsessions', sessions: true, systemd: false });
      const copied = join(tmpHome, 'withsessions', 'MEMORY', 'imported', 'sessions');
      assert.deepEqual(
        readdirSync(copied).sort(),
        ['20260501_082603_fixture.jsonl', '20260502_090000_fixture.jsonl'],
        'JSONL transcripts copied; request dumps stay home',
      );
      for (const f of walkFiles(join(tmpHome, 'withsessions'))) {
        assert.ok(!readFileSync(f, 'utf8').includes(SECRET), `secret leaked into ${f}`);
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});

describe('runImport openclaw (end-to-end, isolated MERIDIAN_HOME)', () => {
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
      assert.ok(!readdirSync(tmpHome).some((e) => e === 'dry'));
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('full import (legacy layout) scaffolds a bootable embedded home with imported content and no secrets', async () => {
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

  it('full import (real layout) lands mcp.json, translated models, and reference docs', async () => {
    const src = fixtureOpenclawRealHome();
    try {
      await runImport('openclaw', { from: src, slug: 'fromclaw2' });
      const agentRoot = join(tmpHome, 'fromclaw2');
      assert.match(readFileSync(join(agentRoot, 'IDENTITY', 'AGENT.md'), 'utf8'), /roofing intelligence/);
      const mcp = JSON.parse(readFileSync(join(agentRoot, 'CONNECTIONS', 'mcp.json'), 'utf8'));
      assert.equal(mcp.servers[0].name, 'cortex-v2');
      assert.equal(mcp.servers[0].enabled, false);
      const cfg = readFileSync(join(agentRoot, 'config.yaml'), 'utf8');
      assert.match(cfg, /primary: openai\/gpt-5\.4/);
      assert.match(cfg, /routexor\/claude-sonnet-4\.6/);
      assert.match(readFileSync(join(agentRoot, 'CONTEXT', 'imported-vision-prompt.md'), 'utf8'), /Winn/);
      const autoDir = join(agentRoot, 'AUTOMATIONS');
      const hb = readdirSync(autoDir).find((f) => f.includes('heartbeat'));
      assert.ok(hb, 'heartbeat suggestion written');
      assert.match(readFileSync(join(autoDir, hb), 'utf8'), /enabled: false/);
      for (const f of walkFiles(agentRoot)) {
        const c = readFileSync(f, 'utf8');
        for (const v of [SECRET, BOT_TOKEN, OR_KEY, DB_PASSWORD]) {
          assert.ok(!c.includes(v), `secret leaked into ${f}`);
        }
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
