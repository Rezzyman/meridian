/**
 * Skill loader v2. Walks builtin + global + per-agent skill dirs, parses
 * SKILL.md frontmatter (legacy markdown skill) AND manifest.yaml v2
 * (real skill with executable code in tools.ts), and registers each
 * skill's tools with the agent's tool surface.
 *
 * Per-agent skills override global skills override builtins (last write wins).
 *
 * v2 skill structure (per Tier 12 architecture):
 *   SKILLS/<name>/
 *     SKILL.md          — instructions the model reads (always required)
 *     manifest.yaml     — declarations: env, vault, oauth, passphrase, tools
 *     tools.ts          — exports `createTools(ctx)` returning Record<string, Tool>
 *     setup.md          — walkthrough markdown for `meridian skills setup <name>`
 *
 * v1 skills with only SKILL.md still work — they get a generic markdown
 * tool wrapper. v2 skills get their tools.ts-defined tools registered
 * directly into the agent's tool set.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { tool, type Tool } from 'ai';
import { parse as parseYaml } from 'yaml';
import type { MeridianHome } from '../config/home.js';
import {
  SkillManifestSchema,
  SkillManifestV2Schema,
  type SkillManifest,
  type SkillManifestV2,
} from '../config/schema.js';
import type { LoadedSkill, SkillRegistry } from './types.js';
import type { SkillToolContext } from './runtime.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function parseSkillMd(skillDir: string, file: string): SkillManifest | null {
  const text = readFileSync(file, 'utf8');
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  try {
    const data = parseYaml(m[1]) as Record<string, unknown>;
    if (!data.name) data.name = skillDir.split('/').pop();
    return SkillManifestSchema.parse(data);
  } catch {
    return null;
  }
}

function parseManifestYaml(file: string, defaultName: string): SkillManifestV2 | null {
  if (!existsSync(file)) return null;
  try {
    const data = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!data.name) data.name = defaultName;
    return SkillManifestV2Schema.parse(data);
  } catch {
    return null;
  }
}

/**
 * Resolve a skill's executable module, preferring the PRECOMPILED output.
 *
 * The shipped runtime is `node dist/…` with no tsx loader, and plain Node <22
 * (the documented floor is >=20) throws ERR_UNKNOWN_FILE_EXTENSION on
 * `import('tools.ts')`. That failure used to be swallowed, so every skill's
 * real tools silently vanished for anyone on Node 20. `pnpm build` now emits a
 * `tools.mjs` next to each `tools.ts` (scripts/build-skills.mjs), which loads on
 * any Node. We prefer it; the raw `.ts` is only a dev/Node-22 fallback.
 */
export function resolveToolsModule(
  skillDir: string,
): { path: string; compiled: boolean } | undefined {
  const mjs = join(skillDir, 'tools.mjs');
  if (existsSync(mjs)) return { path: mjs, compiled: true };
  const js = join(skillDir, 'tools.js');
  if (existsSync(js)) return { path: js, compiled: true };
  const ts = join(skillDir, 'tools.ts');
  if (existsSync(ts)) return { path: ts, compiled: false };
  return undefined;
}

async function loadDynamicTools(
  skillDir: string,
  ctx: SkillToolContext | undefined,
): Promise<Record<string, Tool> | undefined> {
  if (!ctx) return undefined;
  const resolved = resolveToolsModule(skillDir);
  if (!resolved) return undefined;
  try {
    const url = pathToFileURL(resolved.path).href;
    const mod = (await import(url)) as {
      createTools?: (ctx: SkillToolContext) => Record<string, Tool>;
    };
    if (typeof mod.createTools !== 'function') {
      ctx.logger.warn({
        msg: 'skill tools module missing createTools export',
        path: resolved.path,
      });
      return undefined;
    }
    return mod.createTools(ctx);
  } catch (err) {
    // A raw .ts that can't load on this runtime is the classic silent failure.
    // Make it LOUD and actionable rather than dropping the skill's tools.
    const hint = !resolved.compiled
      ? ' — run `pnpm build` to emit tools.mjs, or use a TypeScript-capable runtime'
      : '';
    ctx.logger.warn({
      msg: `skill tools failed to load${hint}`,
      path: resolved.path,
      err: (err as Error).message,
    });
    return undefined;
  }
}

interface LoadOptions {
  ctx?: SkillToolContext;
}

async function tryLoadDir(
  dir: string,
  source: LoadedSkill['source'],
  opts: LoadOptions,
): Promise<LoadedSkill[]> {
  if (!existsSync(dir)) return [];
  const out: LoadedSkill[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const skillMd = join(full, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const manifest = parseSkillMd(full, skillMd);
    if (!manifest) continue;

    // v2 manifest + executable tools (optional). Prefer the compiled tools.mjs
    // over raw tools.ts so executable skills work under the shipped node runtime.
    const manifestV2 = parseManifestYaml(join(full, 'manifest.yaml'), manifest.name);
    const dynamicTools = await loadDynamicTools(full, opts.ctx);

    // Generic markdown tool (always available — the agent can ALWAYS read
    // a skill's instructions even when its dynamic tools are not loaded).
    const markdownTool = tool({
      description: `[${manifest.category}] ${manifest.description}`,
      parameters: z.object({
        input: z.string().describe('Free-form input passed to the skill'),
      }),
      execute: async ({ input }: { input: string }) => ({
        skill: manifest.name,
        instructions: readFileSync(skillMd, 'utf8'),
        input,
      }),
    });

    out.push({
      manifest,
      manifestV2: manifestV2 ?? undefined,
      path: full,
      tool: markdownTool,
      dynamicTools,
      source,
      category: manifestV2?.category ?? manifest.category,
    });
  }
  return out;
}

/**
 * Walk every skill directory (builtin / global / agent) and collect the
 * union of `requires.env[]` keys declared in v2 manifests. Used by boot
 * to merge skill-declared env keys into SkillToolContext.env BEFORE any
 * skill's tools.ts runs createTools(). Pure manifest read; no code load,
 * no createTools invocation.
 */
export function prescanManifestEnvKeys(home: MeridianHome, builtinDir?: string): string[] {
  const dirs = [builtinDir, join(homedir(), '.meridian', 'skills'), home.layer('SKILLS')].filter(
    (d): d is string => !!d && existsSync(d),
  );
  const set = new Set<string>();
  for (const dir of dirs) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      const manifest = parseManifestYaml(join(full, 'manifest.yaml'), entry);
      if (!manifest) continue;
      for (const k of manifest.requires.env ?? []) set.add(k);
    }
  }
  return [...set];
}

export async function loadSkills(
  home: MeridianHome,
  opts: LoadOptions = {},
  builtinDir?: string,
): Promise<SkillRegistry> {
  const builtin = builtinDir ? await tryLoadDir(builtinDir, 'builtin', opts) : [];
  const globalDir = join(homedir(), '.meridian', 'skills');
  const global = await tryLoadDir(globalDir, 'global', opts);
  const agent = await tryLoadDir(home.layer('SKILLS'), 'agent', opts);

  const map = new Map<string, LoadedSkill>();
  for (const s of [...builtin, ...global, ...agent]) {
    map.set(s.manifest.name, s);
  }
  const list = [...map.values()];

  return {
    list: () => list,
    byName: (n) => map.get(n),
    byCategory: () => {
      const out: Record<string, LoadedSkill[]> = {};
      for (const s of list) {
        if (!out[s.category]) out[s.category] = [];
        out[s.category].push(s);
      }
      return out;
    },
    asTools: () => {
      const out: Record<string, Tool> = {};
      // Generic markdown wrapper indexed by skill name (legacy + v2 skills).
      for (const s of list) out[s.manifest.name] = s.tool;
      // V2 skills also expose their declared tools by tool name. These
      // override the generic wrapper if there is a name collision (the
      // tools.ts implementations are richer than the markdown wrappers).
      for (const s of list) {
        if (s.dynamicTools) {
          for (const [toolName, t] of Object.entries(s.dynamicTools)) {
            out[toolName] = t;
          }
        }
      }
      return out;
    },
    declaredEnvKeys: () => {
      const set = new Set<string>();
      for (const s of list) {
        for (const k of s.manifestV2?.requires.env ?? []) set.add(k);
      }
      return [...set];
    },
  };
}
