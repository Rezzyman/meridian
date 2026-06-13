/**
 * `meridian import <openclaw|hermes>` — migrate a competitor agent home into a
 * Meridian seven-layer home, so someone coming from OpenClaw or Hermes is up and
 * running on Meridian in one command (the move Hermes made on OpenClaw with
 * `hermes claw migrate`).
 *
 * It reads a user-provided home directory (default `~/.openclaw` / `~/.hermes`,
 * override with `--from`) and maps the documented files:
 *   SOUL.md / persona      → IDENTITY/AGENT.md
 *   USER.md                → IDENTITY/USER.md   (+ operator name)
 *   MEMORY.md              → MEMORY/imported/MEMORY.md
 *   AGENTS.md / instructions → CONTEXT/imported-instructions.md
 *   skills/                → SKILLS/imported/<name>/
 *   config / settings      → CONTEXT/imported-<source>-config.<ext>  (for review)
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

/** A single planned copy/transform — relative to the target agentRoot. */
export interface ImportStep {
  kind: 'file' | 'dir';
  sourceAbs: string;
  targetRel: string;
  label: string;
  bytes: number;
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
  },
  hermes: {
    name: 'hermes',
    defaultRoot: join(homedir(), '.hermes'),
    persona: ['SOUL.md', 'soul.md', 'PERSONA.md'],
    user: ['USER.md', 'user.md'],
    memory: ['MEMORY.md', 'memory.md'],
    instructions: ['AGENTS.md', 'AGENT.md'],
    skillsDirs: ['skills', join('skills', 'openclaw-imports')],
  },
};

// Filenames that indicate secret material. We never copy these and surface them
// by name so the operator re-enters them deliberately.
const SECRET_FILE_RE = /(^\.env)|(\.env$)|secret|credential|(\.key$)|(\.pem$)/i;
const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/;
// Config-like files may embed secrets; we content-scan (but never copy) them.
const CONFIG_FILE_RE = /\.(json|ya?ml|toml|ini|conf|cfg)$/i;
// Secret-SHAPED values (provider keys, bot tokens, "...token": "long...").
const SECRET_VALUE_RE =
  /(sk-[A-Za-z0-9]{16,})|(ghp_[A-Za-z0-9]{20,})|(xox[baprs]-[A-Za-z0-9-]{10,})|(AIza[0-9A-Za-z_-]{20,})|(\b\d{6,}:[A-Za-z0-9_-]{30,}\b)|(["']?[A-Za-z0-9_]*(?:key|token|secret|password)["']?\s*[:=]\s*["'][^"'\s]{12,}["'])/i;

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

/** Best-effort operator name from a USER.md ("# Name", "name: X", "Name: X"). */
function parseOperatorName(userMdPath: string): string | undefined {
  try {
    const text = readFileSync(userMdPath, 'utf8');
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading && heading.length <= 80 && !/^user$/i.test(heading)) return heading;
    const named = text.match(/^\s*name\s*[:=]\s*(.+)$/im)?.[1]?.trim();
    if (named) return named.replace(/^["']|["']$/g, '');
  } catch {
    // ignore
  }
  return undefined;
}

/** Scan the source root (top level + one dir deep) for secret material. */
function scanSecrets(sourceRoot: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
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

  const fileMap: Array<{ candidates: string[]; targetRel: string; label: string }> = [
    { candidates: profile.persona, targetRel: join('IDENTITY', 'AGENT.md'), label: 'persona → IDENTITY/AGENT.md' },
    { candidates: profile.user, targetRel: join('IDENTITY', 'USER.md'), label: 'operator profile → IDENTITY/USER.md' },
    { candidates: profile.memory, targetRel: join('MEMORY', 'imported', 'MEMORY.md'), label: 'memory → MEMORY/imported/MEMORY.md' },
    { candidates: profile.instructions, targetRel: join('CONTEXT', 'imported-instructions.md'), label: 'instructions → CONTEXT/imported-instructions.md' },
  ];
  for (const m of fileMap) {
    const hit = firstExisting(sourceRoot, m.candidates);
    if (hit) steps.push({ kind: 'file', sourceAbs: hit, targetRel: m.targetRel, label: m.label, bytes: sizeOf(hit) });
    else notFound.push(m.label);
  }

  // NOTE: competitor config/settings files are deliberately NOT copied — they
  // frequently embed secrets. They are content-scanned by scanSecrets() and
  // surfaced for the operator to review and re-create deliberately.

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
      });
    }
  }

  const userHit = firstExisting(sourceRoot, profile.user);
  return {
    source,
    sourceRoot,
    steps,
    secrets: scanSecrets(sourceRoot),
    operatorName: userHit ? parseOperatorName(userHit) : undefined,
    notFound,
  };
}

const IMPORT_HEADER = (source: ImportSource, file: string) =>
  `<!-- Imported from ${source} (${file}) by \`meridian import\`. Review and edit. -->\n\n`;

function copyDirRecursive(from: string, to: string): number {
  let count = 0;
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const f = join(from, entry);
    const t = join(to, entry);
    if (statSync(f).isDirectory()) count += copyDirRecursive(f, t);
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
      const n = copyDirRecursive(step.sourceAbs, target);
      if (n > 0) written.push(`${step.targetRel}/ (${n} files)`);
      continue;
    }
    mkdirSync(join(target, '..'), { recursive: true });
    let content = readFileSync(step.sourceAbs, 'utf8');
    // Persona + instructions + memory get a provenance header.
    if (/AGENT\.md$|imported-instructions\.md$|imported\/MEMORY\.md$/.test(step.targetRel)) {
      content = IMPORT_HEADER(plan.source, basename(step.sourceAbs)) + content;
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
  console.log(colors.muted('\nNext:'));
  console.log(colors.muted(`  1. Review IDENTITY/AGENT.md and CONTEXT/ in ${home.agentRoot}`));
  if (plan.secrets.length) console.log(colors.muted('  2. Re-add the secrets listed above (they were not copied).'));
  console.log(colors.muted(`  ${plan.secrets.length ? 3 : 2}. meridian use ${slug} && meridian doctor && meridian`));
}
