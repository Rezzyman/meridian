/**
 * `meridian import <openclaw|hermes>` — migrate a competitor agent home into a
 * Meridian seven-layer home, so someone coming from OpenClaw or Hermes is up and
 * running on Meridian in one command (the move Hermes made on OpenClaw with
 * `hermes claw migrate`).
 *
 * It reads a user-provided home directory (default `~/.openclaw` / `~/.hermes`,
 * override with `--from`) and maps the REAL on-disk anatomy of each source:
 *   SOUL.md / persona              → IDENTITY/AGENT.md   (hermes: LIVE-STATE block stripped)
 *   USER.md | memories/USER.md     → IDENTITY/USER.md   (+ operator name)
 *   MEMORY.md | memories/MEMORY.md → MEMORY/imported/MEMORY.md
 *   AGENTS.md / instructions       → CONTEXT/imported-instructions.md
 *   skills/                        → SKILLS/imported/<name>/  (registry + secret-named files excluded)
 *   hermes config/cron/channels    → CONTEXT/imported-hermes-*.{yaml,json}  (sanitized, for review)
 *   hermes plugins/                → CONTEXT/imported-hermes-plugins.md  (note only; Python plugins don't run here)
 *
 * The new agent is scaffolded in zero-config **embedded** memory by default, so
 * it boots immediately (no CORTEX server / keys). Pass `--cortex` for the full
 * backend.
 *
 * SECRETS ARE NEVER IMPORTED. Any `.env` / `*.key` / token-shaped values found
 * are detected and surfaced by NAME only — the operator re-adds them (in the new
 * `.env` or via `meridian skills setup`). We never copy a secret into the new
 * home, and `--dry-run` writes nothing at all.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ensureAgentHome, resolveHome, setActiveAgent, type MeridianHome } from '../config/home.js';
import { AgentConfigSchema, defaultAgentConfig } from '../config/schema.js';
import { embeddedEnvFileTemplate, envFileTemplate } from '../config/loader.js';
import { colors } from '../utils/truecolor.js';

const SKELETON_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../skeleton');

export type ImportSource = 'openclaw' | 'hermes';

export interface ImportOptions {
  from?: string;
  slug?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  cortex?: boolean;
}

/** Named content transforms applied by applyImport before writing. Named
 *  strings (not functions) keep ImportPlan JSON-serializable — the tests
 *  assert a serialized plan carries no secret values. */
export type ImportTransform = 'strip-live-state' | 'sanitize-config';

/** A single planned copy/transform — relative to the target agentRoot. */
export interface ImportStep {
  kind: 'file' | 'dir' | 'note';
  sourceAbs: string; // '' for kind 'note' (generated content, no source copy)
  targetRel: string;
  label: string;
  bytes: number;
  transform?: ImportTransform;
  content?: string; // kind 'note' only: generated markdown
  excludes?: string[]; // kind 'dir' only: entry names never copied
}

/** Secrets found in the source — surfaced by name, NEVER imported. */
export interface SecretFinding {
  file: string; // relative to source root
  keys: string[]; // env key names, or [] when only the file type is known
}

export interface ImportPlan {
  source: ImportSource;
  sourceRoot: string;
  steps: ImportStep[];
  secrets: SecretFinding[];
  operatorName?: string;
  notFound: string[];
}

interface SourceProfile {
  name: ImportSource;
  defaultRoot: string;
  /** candidate filenames (first match wins) per logical document. */
  persona: string[];
  user: string[];
  memory: string[];
  instructions: string[];
  skillsDirs: string[];
  /** transform applied to the persona document (e.g. strip a live-state block). */
  personaTransform?: ImportTransform;
  /** known-shape config files copied SANITIZED into CONTEXT/ for review. */
  configFiles: Array<{ candidates: string[]; target: string; label: string }>;
  /** dirs summarized as a generated note (contents not runnable in Meridian). */
  noteDirs: Array<{ dir: string; target: string; title: string }>;
  /** exact filenames that are secret stores, flagged by NAME even when their
   *  content evades the value regex (e.g. hermes auth.json credential pool). */
  secretFiles: string[];
  /** dir names whose entire contents are secret material (flagged by name). */
  secretDirs: string[];
  /** entry names excluded from the skills dir copy (machine registries). */
  skillsCopyExclude: string[];
}

const PROFILES: Record<ImportSource, SourceProfile> = {
  openclaw: {
    name: 'openclaw',
    defaultRoot: join(homedir(), '.openclaw'),
    persona: ['SOUL.md', 'soul.md', 'PERSONA.md'],
    user: ['USER.md', 'user.md'],
    memory: ['MEMORY.md', 'memory.md'],
    instructions: ['AGENTS.md', 'AGENT.md', 'agents.md'],
    skillsDirs: ['skills'],
    configFiles: [],
    noteDirs: [],
    secretFiles: [],
    secretDirs: [],
    skillsCopyExclude: [],
  },
  // Tuned against real Hermes homes (verified anatomy, 2026-07): SOUL.md at the
  // top level with an auto-refreshed LIVE-STATE block; USER.md and MEMORY.md
  // live under memories/; config.yaml + cron/jobs.json + channel_directory.json
  // define the harness wiring; auth.json holds a provider credential pool;
  // skills/.hub is a machine registry, not a skill.
  hermes: {
    name: 'hermes',
    defaultRoot: join(homedir(), '.hermes'),
    persona: ['SOUL.md', 'soul.md', 'PERSONA.md'],
    personaTransform: 'strip-live-state',
    user: [join('memories', 'USER.md'), 'USER.md', 'user.md'],
    memory: [join('memories', 'MEMORY.md'), 'MEMORY.md', 'memory.md'],
    instructions: ['AGENTS.md', 'AGENT.md'],
    skillsDirs: ['skills'],
    configFiles: [
      {
        candidates: ['config.yaml', 'config.yml'],
        target: join('CONTEXT', 'imported-hermes-config.yaml'),
        label: 'config.yaml → CONTEXT/imported-hermes-config.yaml (sanitized, for review)',
      },
      {
        candidates: [join('cron', 'jobs.json')],
        target: join('CONTEXT', 'imported-hermes-cron.json'),
        label: 'cron jobs → CONTEXT/imported-hermes-cron.json (sanitized, for review)',
      },
      {
        candidates: ['channel_directory.json'],
        target: join('CONTEXT', 'imported-hermes-channels.json'),
        label: 'channel directory → CONTEXT/imported-hermes-channels.json (sanitized, for review)',
      },
    ],
    noteDirs: [
      {
        dir: 'plugins',
        target: join('CONTEXT', 'imported-hermes-plugins.md'),
        title: 'Hermes plugins (not imported)',
      },
    ],
    secretFiles: ['auth.json'],
    secretDirs: ['secrets'],
    skillsCopyExclude: ['.hub'],
  },
};

// Filenames that indicate secret material. We never copy these and surface them
// by name so the operator re-enters them deliberately.
const SECRET_FILE_RE = /(^\.env)|(\.env$)|secret|credential|(\.key$)|(\.pem$)/i;
const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/;
// Config-like files may embed secrets; we content-scan (but never copy) them.
const CONFIG_FILE_RE = /\.(json|ya?ml|toml|ini|conf|cfg)$/i;
// Secret-SHAPED values (provider keys, bot tokens, "...token": "long...").
// sk- keys include the hyphenated router families (sk-or-v1-..., sk-proj-...),
// so the character class allows _ and - after the prefix.
const SECRET_VALUE_RE =
  /(sk-[A-Za-z0-9_-]{16,})|(ghp_[A-Za-z0-9]{20,})|(xox[baprs]-[A-Za-z0-9-]{10,})|(AIza[0-9A-Za-z_-]{20,})|(\b\d{6,}:[A-Za-z0-9_-]{30,}\b)|(["']?[A-Za-z0-9_]*(?:key|token|secret|password)["']?\s*[:=]\s*["'][^"'\s]{12,}["'])/i;

function firstExisting(root: string, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined;
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Best-effort operator name from a USER.md ("# Name", "# USER.md — Name",
 *  "**Full name:** X", "name: X"). */
function parseOperatorName(userMdPath: string): string | undefined {
  try {
    const text = readFileSync(userMdPath, 'utf8');
    // Hermes headings read "# USER.md — Actual Name"; strip the filename token.
    const heading = text
      .match(/^#\s+(.+)$/m)?.[1]
      ?.trim()
      .replace(/^USER\.md\s*[-:–—]?\s*/i, '')
      .trim();
    if (heading && heading.length <= 80 && !/^user$/i.test(heading)) return heading;
    const bold = text.match(/^\s*\*\*(?:full\s+)?name:?\*\*\s*(.+)$/im)?.[1]?.trim();
    if (bold) return bold.replace(/^["']|["']$/g, '');
    const named = text.match(/^\s*name\s*[:=]\s*(.+)$/im)?.[1]?.trim();
    if (named) return named.replace(/^["']|["']$/g, '');
  } catch {
    // ignore
  }
  return undefined;
}

/** Remove a Hermes auto-refreshed live-state block from a persona document.
 *  Matches `<!-- LIVE-STATE-BEGIN ... --> ... <!-- LIVE-STATE-END -->` and the
 *  bare `<!-- LIVE-STATE ...` variant; conservative when no END marker exists
 *  (leaves the content untouched rather than eating the rest of the file). */
export function stripLiveState(content: string): string {
  return content.replace(
    /<!--\s*LIVE-STATE(?:-BEGIN)?\b[\s\S]*?LIVE-STATE-END\s*-->\s*\n?/g,
    '',
  );
}

/** Redact secret-shaped values from config content copied for review. The
 *  hermes configs we map are clean in practice; this is the safety net that
 *  keeps the never-import-secrets promise true for arbitrary homes. */
export function sanitizeConfigContent(content: string): string {
  return content.replace(new RegExp(SECRET_VALUE_RE.source, 'gi'), '[redacted-on-import]');
}

/** Top-level key NAMES from a JSON secret store (values never read past parse).
 *  Hermes auth.json: {version, providers, credential_pool: {openrouter, ...}}
 *  → ['version', 'providers', 'credential_pool.openrouter', ...]. */
function jsonSecretKeyNames(abs: string): string[] {
  try {
    const obj = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    const keys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'credential_pool' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const p of Object.keys(v as Record<string, unknown>)) keys.push(`credential_pool.${p}`);
      } else {
        keys.push(k);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/** Scan the source root (top level + one dir deep) for secret material. */
function scanSecrets(sourceRoot: string, profile: SourceProfile): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const secretFileNames = new Set(profile.secretFiles);
  const secretDirNames = new Set(profile.secretDirs);
  const inSecretDir = (relPath: string) =>
    relPath
      .split(/[\\/]/)
      .slice(0, -1)
      .some((seg) => secretDirNames.has(seg));
  const visit = (dir: string, rel: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const relPath = rel ? join(rel, entry) : entry;
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < 1 && entry !== 'node_modules' && !entry.startsWith('.git')) {
          visit(abs, relPath, depth + 1);
        }
        continue;
      }
      if (SECRET_FILE_RE.test(entry)) {
        const keys: string[] = [];
        if (/env/i.test(entry)) {
          try {
            for (const line of readFileSync(abs, 'utf8').split('\n')) {
              const m = line.match(ENV_KEY_RE);
              if (m) keys.push(m[1]);
            }
          } catch {
            // unreadable; still report the file
          }
        }
        findings.push({ file: relPath, keys });
      } else if (secretFileNames.has(entry)) {
        // Known secret store flagged by NAME (content may evade the value
        // regex, e.g. a credential pool). Key NAMES only, never values.
        findings.push({ file: relPath, keys: jsonSecretKeyNames(abs) });
      } else if (inSecretDir(relPath)) {
        // Everything inside a declared secrets/ dir is secret material even
        // when its content dodges the value regex (service-account JSONs whose
        // PEM payload contains spaces, for example).
        findings.push({ file: relPath, keys: [] });
      } else if (CONFIG_FILE_RE.test(entry)) {
        // Config-like file: flag it only if it actually contains a secret value.
        try {
          if (SECRET_VALUE_RE.test(readFileSync(abs, 'utf8'))) findings.push({ file: relPath, keys: [] });
        } catch {
          // ignore unreadable
        }
      }
    }
  };
  visit(sourceRoot, '', 0);
  return findings;
}

/**
 * Build the import plan from a source home WITHOUT writing anything. Pure over
 * the filesystem of the SOURCE (reads only) — the unit-tested core.
 */
export function planImport(source: ImportSource, sourceRoot: string): ImportPlan {
  const profile = PROFILES[source];
  const steps: ImportStep[] = [];
  const notFound: string[] = [];

  const fileMap: Array<{
    candidates: string[];
    targetRel: string;
    label: string;
    transform?: ImportTransform;
  }> = [
    {
      candidates: profile.persona,
      targetRel: join('IDENTITY', 'AGENT.md'),
      label: 'persona → IDENTITY/AGENT.md',
      transform: profile.personaTransform,
    },
    { candidates: profile.user, targetRel: join('IDENTITY', 'USER.md'), label: 'operator profile → IDENTITY/USER.md' },
    { candidates: profile.memory, targetRel: join('MEMORY', 'imported', 'MEMORY.md'), label: 'memory → MEMORY/imported/MEMORY.md' },
    { candidates: profile.instructions, targetRel: join('CONTEXT', 'imported-instructions.md'), label: 'instructions → CONTEXT/imported-instructions.md' },
  ];
  for (const m of fileMap) {
    const hit = firstExisting(sourceRoot, m.candidates);
    if (hit)
      steps.push({
        kind: 'file',
        sourceAbs: hit,
        targetRel: m.targetRel,
        label: m.label,
        bytes: sizeOf(hit),
        ...(m.transform ? { transform: m.transform } : {}),
      });
    else notFound.push(m.label);
  }

  // Known-shape harness configs (profile.configFiles) are copied into CONTEXT/
  // for review, SANITIZED (secret-shaped values redacted at write time). All
  // other competitor config/settings files stay deliberately un-copied — they
  // frequently embed secrets — and are content-scanned by scanSecrets() instead.
  for (const cf of profile.configFiles) {
    const hit = firstExisting(sourceRoot, cf.candidates);
    if (hit)
      steps.push({
        kind: 'file',
        sourceAbs: hit,
        targetRel: cf.target,
        label: cf.label,
        bytes: sizeOf(hit),
        transform: 'sanitize-config',
      });
    else notFound.push(cf.label);
  }

  // Dirs that cannot run in Meridian (e.g. hermes Python plugins/) become a
  // generated note listing what was there and how to recreate the capability.
  for (const nd of profile.noteDirs) {
    const p = join(sourceRoot, nd.dir);
    if (existsSync(p) && statSync(p).isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(p).filter((e) => {
          if (e.startsWith('.') || e === '__pycache__') return false;
          try {
            return statSync(join(p, e)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        // unreadable plugins dir: skip the note
      }
      if (names.length > 0) {
        const content =
          `# ${nd.title}\n\n` +
          `Found in the ${profile.name} home (\`${nd.dir}/\`) but NOT imported — ` +
          `${profile.name} plugins are Python and do not run in Meridian:\n\n` +
          `${names.map((n) => `- ${n}`).join('\n')}\n\n` +
          'Recreate the capability with `meridian skills install <name>` or an MCP server (`meridian mcp add`).\n';
        steps.push({
          kind: 'note',
          sourceAbs: '',
          targetRel: nd.target,
          label: `${nd.dir}/ → ${nd.target} (summary note)`,
          bytes: content.length,
          content,
        });
      }
    }
  }

  // Skills directory → SKILLS/imported/<name>/
  for (const sd of profile.skillsDirs) {
    const p = join(sourceRoot, sd);
    if (existsSync(p) && statSync(p).isDirectory()) {
      steps.push({
        kind: 'dir',
        sourceAbs: p,
        targetRel: join('SKILLS', 'imported', basename(sd)),
        label: `skills → SKILLS/imported/${basename(sd)}/`,
        bytes: 0,
        ...(profile.skillsCopyExclude.length ? { excludes: profile.skillsCopyExclude } : {}),
      });
    }
  }

  const userHit = firstExisting(sourceRoot, profile.user);
  return {
    source,
    sourceRoot,
    steps,
    secrets: scanSecrets(sourceRoot, profile),
    operatorName: userHit ? parseOperatorName(userHit) : undefined,
    notFound,
  };
}

const IMPORT_HEADER = (source: ImportSource, file: string) =>
  `<!-- Imported from ${source} (${file}) by \`meridian import\`. Review and edit. -->\n\n`;

/** Extension-aware provenance header. JSON cannot carry comments, so JSON
 *  targets get none — their provenance is the CLI output label and the
 *  plugins/config note. */
function headerFor(targetRel: string, source: ImportSource, file: string): string {
  if (/\.md$/i.test(targetRel)) return IMPORT_HEADER(source, file);
  if (/\.ya?ml$/i.test(targetRel))
    return `# Imported from ${source} (${file}) by \`meridian import\`. Secret-shaped values were redacted. Review before use.\n\n`;
  return '';
}

function copyDirRecursive(
  from: string,
  to: string,
  opts: { excludes?: string[]; skipSecrets?: boolean } = {},
): number {
  let count = 0;
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    if (opts.excludes?.includes(entry)) continue;
    // The never-import-secrets promise must hold inside copied trees too:
    // a skill dir carrying its own .env / *.key never lands in the new home.
    if (opts.skipSecrets && SECRET_FILE_RE.test(entry)) continue;
    const f = join(from, entry);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(f);
    } catch {
      continue;
    }
    // Never follow symlinks out of the source home (a link could point at
    // /etc, another agent's home, or the harness install itself).
    if (st.isSymbolicLink()) continue;
    const t = join(to, entry);
    if (st.isDirectory()) count += copyDirRecursive(f, t, opts);
    else {
      copyFileSync(f, t);
      count++;
    }
  }
  return count;
}

/** Apply a plan into a scaffolded Meridian home (overlay). Returns written paths. */
export function applyImport(plan: ImportPlan, home: MeridianHome): string[] {
  const written: string[] = [];
  for (const step of plan.steps) {
    const target = join(home.agentRoot, step.targetRel);
    if (step.kind === 'dir') {
      const n = copyDirRecursive(step.sourceAbs, target, {
        excludes: step.excludes,
        skipSecrets: true,
      });
      if (n > 0) written.push(`${step.targetRel}/ (${n} files)`);
      continue;
    }
    mkdirSync(join(target, '..'), { recursive: true });
    if (step.kind === 'note') {
      writeFileSync(target, IMPORT_HEADER(plan.source, 'generated') + (step.content ?? ''));
      written.push(step.targetRel);
      continue;
    }
    let content = readFileSync(step.sourceAbs, 'utf8');
    // Named transforms run BEFORE the provenance header goes on.
    if (step.transform === 'strip-live-state') content = stripLiveState(content);
    if (step.transform === 'sanitize-config') content = sanitizeConfigContent(content);
    // Persona + instructions + memory + sanitized configs get a provenance header.
    if (
      /AGENT\.md$|imported-instructions\.md$|imported\/MEMORY\.md$/.test(step.targetRel) ||
      step.transform === 'sanitize-config'
    ) {
      content = headerFor(step.targetRel, plan.source, basename(step.sourceAbs)) + content;
    }
    writeFileSync(target, content);
    written.push(step.targetRel);
  }
  return written;
}

function patchOperatorName(home: MeridianHome, name: string): void {
  try {
    const raw = readFileSync(home.configPath, 'utf8');
    const obj = parseYaml(raw) as Record<string, unknown>;
    const operator = (obj.operator as Record<string, unknown> | undefined) ?? { id: 'primary' };
    operator.name = name;
    obj.operator = operator;
    // Validate before writing so we never persist an invalid config.
    AgentConfigSchema.parse(obj);
    writeFileSync(home.configPath, stringifyYaml(obj));
  } catch {
    // best-effort; a parse/validation hiccup must not abort the import
  }
}

/** Scaffold a fresh embedded (or cortex) home — the minimal, output-controlled
 *  equivalent of `meridian init --embedded --no-guided`. */
function scaffoldHome(slug: string, embedded: boolean): MeridianHome {
  const home = ensureAgentHome(slug);
  const config = defaultAgentConfig(slug, slug);
  if (!existsSync(home.configPath)) writeFileSync(home.configPath, stringifyYaml(config));
  if (!existsSync(home.envPath)) {
    writeFileSync(home.envPath, embedded ? embeddedEnvFileTemplate(slug) : envFileTemplate(slug));
  }
  const LAYERS = ['IDENTITY', 'CONTEXT', 'SKILLS', 'MEMORY', 'CONNECTIONS', 'VERIFICATION', 'AUTOMATIONS'] as const;
  if (existsSync(SKELETON_ROOT)) {
    for (const layer of LAYERS) {
      const from = join(SKELETON_ROOT, layer);
      if (existsSync(from)) copyDirRecursive(from, home.layer(layer));
    }
  }
  setActiveAgent(slug);
  return home;
}

export async function runImport(source: string, opts: ImportOptions): Promise<void> {
  if (source !== 'openclaw' && source !== 'hermes') {
    console.error(colors.err(`unknown source '${source}'. Use: meridian import <openclaw|hermes>`));
    process.exit(1);
  }
  const src = source as ImportSource;
  const profile = PROFILES[src];
  const sourceRoot = resolve(opts.from ?? profile.defaultRoot);

  if (!existsSync(sourceRoot)) {
    console.error(
      colors.err(`No ${src} home found at ${sourceRoot}.`) +
        colors.muted(`\n  Point at it explicitly:  meridian import ${src} --from /path/to/${src}-home`),
    );
    process.exit(1);
  }

  const slug = opts.slug ?? `${src}-import`;
  const plan = planImport(src, sourceRoot);

  console.log(colors.cyan(`Importing ${src} home: ${sourceRoot}`));
  console.log(colors.muted(`  → Meridian agent: ${slug}\n`));

  // What we'll bring over.
  for (const step of plan.steps) console.log(`  ${colors.ok('+')} ${step.label}`);
  for (const nf of plan.notFound) console.log(`  ${colors.muted('·')} ${colors.muted(`not found: ${nf}`)}`);
  if (plan.operatorName) console.log(`  ${colors.ok('+')} operator name: ${plan.operatorName}`);

  // Secrets — surfaced, never imported.
  if (plan.secrets.length > 0) {
    console.log(colors.warn('\n  🔑 Secrets detected (NOT imported — re-add them yourself):'));
    for (const s of plan.secrets) {
      const keys = s.keys.length ? `: ${s.keys.join(', ')}` : '';
      console.log(colors.warn(`     ${s.file}${keys}`));
    }
    console.log(colors.muted(`     Set them in ~/.meridian/${slug}/.env or via \`meridian skills setup\`.`));
  }

  if (opts.dryRun) {
    console.log(colors.muted('\n(dry run — nothing was written)'));
    return;
  }

  // Refuse to clobber an existing home unless asked.
  if (existsSync(resolveHome(slug).agentRoot) && !opts.overwrite) {
    console.error(
      colors.err(`\nAgent '${slug}' already exists.`) +
        colors.muted(`\n  Re-run with --overwrite, or choose another --slug.`),
    );
    process.exit(1);
  }

  const home = scaffoldHome(slug, !opts.cortex);
  const written = applyImport(plan, home);
  if (plan.operatorName) patchOperatorName(home, plan.operatorName);

  console.log(colors.ok(`\n✓ Imported ${written.length} item(s) into ${home.agentRoot}`));
  console.log(colors.muted(`  memory: ${opts.cortex ? 'CORTEX (set NEON/VOYAGE keys in .env)' : 'embedded (zero-config, ready now)'}`));
  if (src === 'hermes') {
    console.log(colors.muted('\n  Hermes config, cron, and channels were copied to CONTEXT/ for reference.'));
    console.log(colors.muted('  Recreate schedules as Meridian AUTOMATIONS and channels via .env keys.'));
  }
  console.log(colors.muted('\nNext:'));
  console.log(colors.muted(`  1. Review IDENTITY/AGENT.md and CONTEXT/ in ${home.agentRoot}`));
  if (plan.secrets.length) console.log(colors.muted('  2. Re-add the secrets listed above (they were not copied).'));
  console.log(colors.muted(`  ${plan.secrets.length ? 3 : 2}. meridian use ${slug} && meridian doctor && meridian`));
}
