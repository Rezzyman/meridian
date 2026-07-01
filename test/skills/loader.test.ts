/**
 * Skill loader tests — loadSkills (src/skills/loader.ts) walks builtin /
 * global / agent skill dirs, parses SKILL.md frontmatter + manifest.yaml v2,
 * and dynamically imports tools.ts via the createTools(ctx) convention.
 *
 * Everything lives in a per-run tmpdir. HOME + MERIDIAN_HOME are redirected
 * BEFORE the loader is imported so the global ~/.meridian/skills scan can
 * never pick up skills installed on the developer machine. Each test gets a
 * fresh world (own HOME) so the shared global dir cannot leak across cases.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { makeEnv, mockCortex, silentLogger } from '../helpers/fixtures.js';
import type { MeridianHome } from '../../src/config/home.js';
import type { SkillToolContext } from '../../src/skills/runtime.js';
import type { AgentEnv } from '../../src/config/schema.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'meridian-loader-test-'));
process.env.HOME = RUN_ROOT;
process.env.MERIDIAN_HOME = join(RUN_ROOT, '.meridian');

// Import after the env redirect (homedir() is resolved at loadSkills call
// time, but keep the convention: never import before redirecting HOME).
const { loadSkills } = await import('../../src/skills/loader.js');

after(() => rmSync(RUN_ROOT, { recursive: true, force: true }));

// ─── World + fixture helpers ─────────────────────────────────────────────────

let worldCount = 0;

/** Fresh isolated world: own HOME (=> own global skills dir) + agent home. */
function makeWorld(): { home: MeridianHome; skillsDir: string; globalSkillsDir: string } {
  const root = join(RUN_ROOT, `world-${worldCount++}`);
  process.env.HOME = root; // tests run serially; loader reads homedir() per call
  const agentRoot = join(root, '.meridian', 'test-agent');
  const skillsDir = join(agentRoot, 'SKILLS');
  mkdirSync(skillsDir, { recursive: true });
  const home: MeridianHome = {
    root: join(root, '.meridian'),
    agentSlug: 'test-agent',
    agentRoot,
    configPath: join(agentRoot, 'config.yaml'),
    envPath: join(agentRoot, '.env'),
    vaultPath: join(agentRoot, 'vault.enc'),
    layer: (name) => join(agentRoot, name),
    sessions: join(agentRoot, 'sessions'),
    logs: join(agentRoot, 'logs'),
    checkpoints: join(agentRoot, 'checkpoints'),
    stateDb: join(agentRoot, 'state.db'),
  };
  return { home, skillsDir, globalSkillsDir: join(root, '.meridian', 'skills') };
}

function writeSkill(
  parentDir: string,
  dirName: string,
  files: { skillMd?: string; manifestYaml?: string; toolsTs?: string },
): void {
  const dir = join(parentDir, dirName);
  mkdirSync(dir, { recursive: true });
  if (files.skillMd !== undefined) writeFileSync(join(dir, 'SKILL.md'), files.skillMd);
  if (files.manifestYaml !== undefined) {
    writeFileSync(join(dir, 'manifest.yaml'), files.manifestYaml);
  }
  if (files.toolsTs !== undefined) writeFileSync(join(dir, 'tools.ts'), files.toolsTs);
}

function skillMd(
  name: string | null,
  opts: { category?: string; runtime?: string; description?: string } = {},
): string {
  const lines = ['---'];
  if (name) lines.push(`name: ${name}`);
  lines.push(
    `description: ${opts.description ?? `${name ?? 'unnamed'} description`}`,
    `category: ${opts.category ?? 'general'}`,
    `runtime: ${opts.runtime ?? 'markdown'}`,
    '---',
    '',
    `Instructions for ${name ?? 'unnamed'}.`,
  );
  return lines.join('\n');
}

const FIXTURE_MANIFEST = [
  'name: fixture-skill',
  'version: 0.1.0',
  'description: Fixture ts skill',
  'category: testing',
  '',
  'requires:',
  '  env:',
  '    - FIXTURE_KEY',
  '',
  'tools:',
  '  - name: fixture_tool',
  '    description: Echo input plus the declared env key',
].join('\n');

// Mirrors the bundled-skill convention (e.g. skeleton/SKILLS/web-search):
// a local structural Ctx interface + a `createTools(ctx)` named export that
// builds tools from ctx.tool / ctx.z so the skill never imports `ai` or `zod`.
const FIXTURE_TOOLS_TS = [
  'interface Ctx {',
  '  env: Record<string, string | undefined>;',
  '  tool: (def: unknown) => unknown;',
  '  z: {',
  '    object: (shape: Record<string, unknown>) => unknown;',
  '    string: () => { describe: (s: string) => unknown };',
  '  };',
  '}',
  '',
  'export function createTools(ctx: Ctx): Record<string, unknown> {',
  '  const { tool, z } = ctx;',
  '  return {',
  '    fixture_tool: tool({',
  "      description: 'Echo input plus the declared env key',",
  "      parameters: z.object({ input: z.string().describe('Free-form input') }),",
  '      execute: async (args: { input: string }) => ({',
  '        echoed: args.input,',
  '        fixtureKey: ctx.env.FIXTURE_KEY,',
  '      }),',
  '    }),',
  '  };',
  '}',
  '',
].join('\n');

function makeCtx(extraEnv: Record<string, string> = {}): SkillToolContext {
  const store = new Map<string, unknown>();
  return {
    cortex: mockCortex(),
    vault: {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => void store.set(k, v),
      setMany: (entries: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(entries)) store.set(k, v);
      },
      has: (k: string) => store.has(k),
      list: () => [...store.keys()],
      delete: (k: string) => void store.delete(k),
    },
    env: { ...makeEnv(), ...extraEnv } as AgentEnv,
    logger: silentLogger,
    requirePassphrase: () => {},
    hashPassphrase: (raw: string) => raw,
    grantPassphraseSession: () => {},
    tool,
    z,
    tools: {
      gog: {
        run: async () => ({ stdout: '', stderr: '', code: 0 }),
        runJson: async () => ({}),
        listAccounts: async () => [],
      },
    },
  } as unknown as SkillToolContext;
}

const EXEC_OPTS = { toolCallId: 'tc-1', messages: [] };

// ─── (1) Empty SKILLS layer ──────────────────────────────────────────────────

test('empty SKILLS layer loads zero skills and an empty tool surface', async () => {
  const { home } = makeWorld();
  const registry = await loadSkills(home);

  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.asTools(), {});
  assert.deepEqual(registry.byCategory(), {});
  assert.deepEqual(registry.declaredEnvKeys(), []);
  assert.equal(registry.byName('anything'), undefined);
});

// ─── (2) Markdown-only skill ─────────────────────────────────────────────────

test('markdown-only skill loads with manifest fields and a markdown wrapper tool', async () => {
  const { home, skillsDir } = makeWorld();
  writeSkill(skillsDir, 'note-taker', {
    skillMd: skillMd('note-taker', { category: 'writing' }),
  });
  // No `name` in frontmatter → loader defaults it to the directory name.
  writeSkill(skillsDir, 'dir-named', { skillMd: skillMd(null, { category: 'writing' }) });

  const registry = await loadSkills(home);
  assert.equal(registry.list().length, 2);

  const skill = registry.byName('note-taker');
  assert.ok(skill, 'note-taker present');
  assert.equal(skill.manifest.name, 'note-taker');
  assert.equal(skill.manifest.runtime, 'markdown');
  assert.equal(skill.category, 'writing');
  assert.equal(skill.source, 'agent');
  assert.equal(skill.manifestV2, undefined);
  assert.equal(skill.dynamicTools, undefined);

  assert.ok(registry.byName('dir-named'), 'frontmatter without name falls back to dir name');

  const tools = registry.asTools();
  assert.deepEqual(Object.keys(tools).sort(), ['dir-named', 'note-taker']);

  // The generic wrapper surfaces the SKILL.md instructions back to the model.
  const md = tools['note-taker'];
  assert.ok(md.execute);
  const result = (await md.execute({ input: 'hello' }, EXEC_OPTS)) as {
    skill: string;
    instructions: string;
    input: string;
  };
  assert.equal(result.skill, 'note-taker');
  assert.equal(result.input, 'hello');
  assert.match(result.instructions, /Instructions for note-taker/);
});

// ─── (3) v2 ts skill with manifest.yaml + tools.ts ───────────────────────────

test('ts skill registers dynamic tools via createTools(ctx) and sees declared env', async () => {
  const { home, skillsDir } = makeWorld();
  writeSkill(skillsDir, 'fixture-skill', {
    skillMd: skillMd('fixture-skill', { category: 'testing', runtime: 'ts' }),
    manifestYaml: FIXTURE_MANIFEST,
    toolsTs: FIXTURE_TOOLS_TS,
  });

  const ctx = makeCtx({ FIXTURE_KEY: 'fixture-key-value' });
  const registry = await loadSkills(home, { ctx });

  const skill = registry.byName('fixture-skill');
  assert.ok(skill, 'fixture-skill present');
  assert.ok(skill.manifestV2, 'v2 manifest parsed');
  assert.deepEqual(skill.manifestV2.requires.env, ['FIXTURE_KEY']);
  assert.equal(skill.manifestV2.tools[0]?.name, 'fixture_tool');
  assert.equal(skill.category, 'testing');
  assert.ok(skill.dynamicTools, 'tools.ts loaded');
  assert.deepEqual(Object.keys(skill.dynamicTools), ['fixture_tool']);
  assert.deepEqual(registry.declaredEnvKeys(), ['FIXTURE_KEY']);

  const tools = registry.asTools();
  assert.ok(tools['fixture-skill'], 'markdown wrapper registered under the skill name');
  assert.ok(tools.fixture_tool, 'dynamic tool registered under its declared name');

  const exec = tools.fixture_tool.execute;
  assert.ok(exec);
  const result = (await exec({ input: 'ping' }, EXEC_OPTS)) as {
    echoed: string;
    fixtureKey: string | undefined;
  };
  assert.equal(result.echoed, 'ping');
  assert.equal(result.fixtureKey, 'fixture-key-value', 'ctx.env exposes the declared key');
});

test('ts skill loaded without a SkillToolContext gets no dynamic tools', async () => {
  const { home, skillsDir } = makeWorld();
  writeSkill(skillsDir, 'fixture-skill', {
    skillMd: skillMd('fixture-skill', { category: 'testing', runtime: 'ts' }),
    manifestYaml: FIXTURE_MANIFEST,
    toolsTs: FIXTURE_TOOLS_TS,
  });

  const registry = await loadSkills(home); // no opts.ctx
  const skill = registry.byName('fixture-skill');
  assert.ok(skill);
  assert.equal(skill.dynamicTools, undefined);
  // Markdown wrapper is still always available.
  assert.ok(registry.asTools()['fixture-skill']);
  assert.equal(registry.asTools().fixture_tool, undefined);
});

// ─── (4) Malformed inputs are skipped/degraded without sinking the rest ──────

test('malformed skills are skipped or degraded silently; healthy skills still load', async () => {
  const { home, skillsDir } = makeWorld();
  // Frontmatter fails schema (missing required `description`) → skipped.
  writeSkill(skillsDir, 'broken-frontmatter', {
    skillMd: '---\nname: broken-frontmatter\n---\n\nBody.',
  });
  // Frontmatter is unparseable YAML → skipped.
  writeSkill(skillsDir, 'broken-yaml', {
    skillMd: '---\nname: [::unclosed\n---\n\nBody.',
  });
  // No frontmatter at all → skipped.
  writeSkill(skillsDir, 'no-frontmatter', { skillMd: 'Just markdown, no fence.' });
  // Valid SKILL.md but malformed manifest.yaml → still loads as a v1
  // markdown skill (manifestV2 dropped, no dynamic tools).
  writeSkill(skillsDir, 'degraded', {
    skillMd: skillMd('degraded'),
    manifestYaml: 'name: degraded\nrequires: [::unclosed',
  });
  writeSkill(skillsDir, 'healthy', { skillMd: skillMd('healthy') });

  const registry = await loadSkills(home);
  const names = registry
    .list()
    .map((s) => s.manifest.name)
    .sort();
  assert.deepEqual(names, ['degraded', 'healthy']);

  const degraded = registry.byName('degraded');
  assert.ok(degraded, 'malformed manifest.yaml does not sink the skill');
  assert.equal(degraded.manifestV2, undefined);
  assert.equal(degraded.dynamicTools, undefined);
  assert.ok(registry.asTools().healthy, 'healthy neighbor unaffected');
});

// ─── (5) byCategory / byName + layer precedence ──────────────────────────────

test('byName resolves layer precedence (agent over global) and byCategory groups', async () => {
  const { home, skillsDir, globalSkillsDir } = makeWorld();
  mkdirSync(globalSkillsDir, { recursive: true });
  writeSkill(globalSkillsDir, 'shared', { skillMd: skillMd('shared', { category: 'global-cat' }) });
  writeSkill(globalSkillsDir, 'global-only', {
    skillMd: skillMd('global-only', { category: 'ops' }),
  });
  writeSkill(skillsDir, 'shared', { skillMd: skillMd('shared', { category: 'agent-cat' }) });
  writeSkill(skillsDir, 'research-a', { skillMd: skillMd('research-a', { category: 'research' }) });
  writeSkill(skillsDir, 'research-b', { skillMd: skillMd('research-b', { category: 'research' }) });

  const registry = await loadSkills(home);
  assert.equal(registry.list().length, 4, 'name collision deduped, last layer wins');

  const shared = registry.byName('shared');
  assert.ok(shared);
  assert.equal(shared.source, 'agent', 'agent skill overrides global skill of the same name');
  assert.equal(shared.category, 'agent-cat');
  assert.equal(registry.byName('global-only')?.source, 'global');
  assert.equal(registry.byName('nope'), undefined);

  const byCat = registry.byCategory();
  assert.deepEqual(Object.keys(byCat).sort(), ['agent-cat', 'ops', 'research']);
  assert.deepEqual(byCat.research.map((s) => s.manifest.name).sort(), ['research-a', 'research-b']);
  assert.equal(byCat['agent-cat'].length, 1);
});

test('builtinDir param loads builtin skills, overridden by agent layer', async () => {
  const { home, skillsDir } = makeWorld();
  const builtinDir = join(home.root, 'builtin-skills');
  writeSkill(builtinDir, 'core', { skillMd: skillMd('core', { category: 'core' }) });
  writeSkill(builtinDir, 'shared', { skillMd: skillMd('shared', { category: 'builtin-cat' }) });
  writeSkill(skillsDir, 'shared', { skillMd: skillMd('shared', { category: 'agent-cat' }) });

  const registry = await loadSkills(home, {}, builtinDir);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.byName('core')?.source, 'builtin');
  assert.equal(registry.byName('shared')?.source, 'agent');
  assert.equal(registry.byName('shared')?.category, 'agent-cat');
});

// ─── compiled tools.mjs is preferred over raw tools.ts ───────────────────────
// The shipped runtime (`node dist/…`) can't import raw .ts on Node 20, so
// `pnpm build` emits a tools.mjs the loader must prefer. These guard both the
// preference and the compiled-only path (what a Node 20 user actually runs).

const MJS_TOOL = (toolName: string) =>
  [
    '// compiled skill module (plain ESM, loads on any Node)',
    'export function createTools(ctx) {',
    '  const { tool, z } = ctx;',
    '  return {',
    `    ${toolName}: tool({`,
    `      description: 'compiled tool ${toolName}',`,
    "      parameters: z.object({ input: z.string() }),",
    '      execute: async (args) => ({ echoed: args.input, via: "mjs" }),',
    '    }),',
    '  };',
    '}',
  ].join('\n');

test('loader prefers a compiled tools.mjs over raw tools.ts', async () => {
  const { home, skillsDir } = makeWorld();
  const dir = join(skillsDir, 'dual-skill');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd('dual-skill', { category: 'testing', runtime: 'ts' }));
  // tools.ts declares a tool that must NOT win; tools.mjs declares the winner.
  writeFileSync(join(dir, 'tools.ts'), FIXTURE_TOOLS_TS); // exports `fixture_tool`
  writeFileSync(join(dir, 'tools.mjs'), MJS_TOOL('compiled_tool'));

  const registry = await loadSkills(home, { ctx: makeCtx() });
  const skill = registry.byName('dual-skill');
  assert.ok(skill?.dynamicTools, 'dynamic tools loaded');
  assert.deepEqual(Object.keys(skill.dynamicTools), ['compiled_tool'], 'tools.mjs won over tools.ts');
  assert.equal(registry.asTools().fixture_tool, undefined, 'the tools.ts tool did not leak in');
});

test('a compiled-only skill (tools.mjs, no tools.ts) loads its tools', async () => {
  const { home, skillsDir } = makeWorld();
  const dir = join(skillsDir, 'compiled-only');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    skillMd('compiled-only', { category: 'testing', runtime: 'ts' }),
  );
  writeFileSync(join(dir, 'tools.mjs'), MJS_TOOL('only_tool'));

  const registry = await loadSkills(home, { ctx: makeCtx() });
  const tools = registry.asTools();
  assert.ok(tools.only_tool, 'compiled tool registered under its declared name');
  const out = (await tools.only_tool.execute!({ input: 'hi' }, EXEC_OPTS)) as {
    echoed: string;
    via: string;
  };
  assert.deepEqual(out, { echoed: 'hi', via: 'mjs' });
});
