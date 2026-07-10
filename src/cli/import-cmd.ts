/**
 * `meridian import <openclaw|hermes>` — migrate a competitor agent home into a
 * Meridian seven-layer home, so someone coming from OpenClaw or Hermes is up and
 * running on Meridian in one command (the move Hermes made on OpenClaw with
 * `hermes claw migrate`).
 *
 * It reads a user-provided home directory (default `~/.openclaw` / `~/.hermes`,
 * override with `--from`) and maps the REAL on-disk anatomy of each source:
 *   SOUL.md / persona / IDENTITY.md   → IDENTITY/AGENT.md   (hermes: LIVE-STATE block stripped)
 *   USER.md | memories/USER.md        → IDENTITY/USER.md   (+ operator name)
 *   MEMORY.md | memories/MEMORY.md    → MEMORY/imported/MEMORY.md
 *   AGENTS.md / instructions          → CONTEXT/imported-instructions.md
 *   skills/                           → SKILLS/imported/<name>/  (registries + secret-named files excluded)
 *   hermes config/cron/channels       → CONTEXT/imported-hermes-*.{yaml,json}  (sanitized, for review)
 *   hermes plugins/                   → CONTEXT/imported-hermes-plugins.md  (note only; Python plugins don't run here)
 *
 * And — because reference dumps are not a migration — it TRANSLATES the
 * operational substance:
 *   hermes state.db                   → MEMORY/imported/state-db-*.md + sessions-summary.md
 *   hermes sessions/*.jsonl           → MEMORY/imported/sessions/ (opt-in via --sessions; they can be huge)
 *   hermes cron/jobs.json             → real AUTOMATIONS/*.md entries (enabled state + local tz preserved)
 *   hermes/openclaw model pinning     → the agent's models chain (openrouter refs remapped or dropped loudly)
 *   channel_directory.json            → channels.telegram.defaultChatId + CONNECTIONS/imported-channels.md
 *   openclaw.json mcp.servers         → CONNECTIONS/mcp.json (secret-shaped env surfaced by name, never copied)
 *   systemd drop-ins (HERMES_HOME)    → env VAR NAMES in the secrets-to-re-add report
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ensureAgentHome, resolveHome, setActiveAgent, type MeridianHome } from '../config/home.js';
import { AgentConfigSchema, defaultAgentConfig } from '../config/schema.js';
import { embeddedEnvFileTemplate, envFileTemplate } from '../config/loader.js';
import { McpConnectionsFileSchema, type McpServerConfig } from '../mcp/config.js';
import { openSqliteReadOnly, type SqliteCell, type SqliteTableDump } from './sqlite-lite.js';
import { colors } from '../utils/truecolor.js';

const SKELETON_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../skeleton');

export type ImportSource = 'openclaw' | 'hermes';

export interface ImportOptions {
  from?: string;
  slug?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  cortex?: boolean;
  /** Copy raw session transcripts (JSONL) into MEMORY/imported/sessions/.
   *  OFF by default — real homes carry 50-160MB of them. */
  sessions?: boolean;
  /** Scan systemd units for the source home's env VAR NAMES (default on;
   *  a no-match scan is silent and free). */
  systemd?: boolean;
}

/** planImport knobs — the CLI flags that change WHAT gets planned. */
export interface ImportPlanOptions {
  sessions?: boolean;
  systemd?: boolean;
  /** Overridable for tests; production default is /etc/systemd/system. */
  systemdDir?: string;
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
  content?: string; // kind 'note' only: generated content (carries its own provenance)
  excludes?: string[]; // kind 'dir' only: entry names never copied
}

/** Secrets found in the source — surfaced by name, NEVER imported. */
export interface SecretFinding {
  file: string; // relative to source root (or systemd:<unit>.d/<conf>)
  keys: string[]; // env key names / structure descriptions, [] when only the file type is known
}

/** A source schedule translated into a real AUTOMATIONS entry. */
export interface AutomationImport {
  fileRel: string; // AUTOMATIONS/imported-<name>.md
  name: string;
  schedule: string; // cron expression
  timezone?: string; // source agent's LOCAL tz — hermes cron is interpreted in it
  enabled: boolean;
  pushTo: 'telegram' | 'none';
  deliver?: string; // source delivery binding (chat id, not a secret)
}

/** Semantic config translation applied to the scaffolded config.yaml. */
export interface ConfigPatch {
  models?: {
    primary?: string;
    fallbacks?: string[];
    smartRouting?: {
      enabled: boolean;
      maxSimpleChars?: number;
      maxSimpleWords?: number;
      cheapModel?: string;
    };
  };
  telegramEnabled?: boolean;
  telegramDefaultChatId?: string;
}

export interface ImportPlan {
  source: ImportSource;
  sourceRoot: string;
  steps: ImportStep[];
  secrets: SecretFinding[];
  automations: AutomationImport[];
  configPatch: ConfigPatch;
  /** Translation caveats the operator must see (dropped models, stale WAL, …). */
  warnings: string[];
  /** Deliberately-not-imported material (with the flag that would include it). */
  skipped: string[];
  /** systemd unit whose HERMES_HOME matches the source home, when found. */
  systemdUnit?: string;
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
  // Tuned against real OpenClaw homes (verified anatomy, 2026-07): per-agent
  // docs live under agents/<id>/agent/ (IDENTITY.md, PRIME-CONTEXT.md,
  // STANDING-ORDERS.md — discovered dynamically); openclaw.json wires models,
  // channels, and MCP servers; auth-profiles.json holds provider keys.
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
    secretDirs: ['credentials'],
    skillsCopyExclude: [],
  },
  // Tuned against real Hermes homes (verified anatomy, 2026-07): SOUL.md at the
  // top level with an auto-refreshed LIVE-STATE block; USER.md lives under
  // memories/ (durable memory is in state.db, NOT a MEMORY.md); config.yaml +
  // cron/jobs.json + channel_directory.json define the harness wiring;
  // auth.json holds a provider credential pool; skills/.hub and
  // skills/.bundled_manifest are machine registries, not skills.
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
    skillsCopyExclude: ['.hub', '.bundled_manifest'],
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
// Env var NAMES that are secret regardless of value shape.
const SECRET_ENV_NAME_RE = /key|token|secret|password/i;
// URLs carrying credentials in the userinfo slot (postgres://user:pass@…).
const URL_USERINFO_RE = /:\/\/[^/\s]*:[^/\s@]+@/;

// Providers Meridian's model chain speaks natively (see ProviderRefSchema).
const MERIDIAN_PROVIDERS = new Set(['anthropic', 'openai', 'groq', 'ollama', 'routexor']);

function firstExisting(root: string, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const p = isAbsolute(c) ? c : join(root, c);
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

function slugifyName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'job'
  );
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

/** Structure of a JSON secret store, by NAME only (values never leave parse).
 *  Hermes auth.json credential_pool holds ARRAYS of prioritized keys per
 *  provider — surface how many, their labels, oauth vs api_key, priority and
 *  expiry so the operator knows exactly what to re-provision. */
function jsonSecretKeyNames(abs: string): string[] {
  try {
    const obj = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    const keys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'credential_pool' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [provider, pool] of Object.entries(v as Record<string, unknown>)) {
          if (Array.isArray(pool)) {
            keys.push(`credential_pool.${provider}: ${pool.length} key(s)`);
            for (const entry of pool as Array<Record<string, unknown>>) {
              if (!entry || typeof entry !== 'object') continue;
              const bits = [
                typeof entry.label === 'string' ? `label="${entry.label}"` : undefined,
                typeof entry.auth_type === 'string' ? entry.auth_type : undefined,
                typeof entry.priority === 'number' ? `priority=${entry.priority}` : undefined,
                typeof entry.expires_at_ms === 'number'
                  ? `expires=${new Date(entry.expires_at_ms).toISOString().slice(0, 10)}`
                  : undefined,
              ].filter(Boolean);
              keys.push(`credential_pool.${provider}[] ${bits.join(' ')}`.trim());
            }
          } else {
            keys.push(`credential_pool.${provider}`);
          }
        }
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

// ─── Semantic translation: shared model-ref mapping ───────────────────────────

/** Map a source (provider, model) pin onto Meridian's `provider/model` chain
 *  format. openrouter was removed from Meridian: `openrouter/anthropic/*`
 *  fallbacks have an obvious routexor equivalent; everything else drops with a
 *  logged warning rather than a silently broken chain. */
function mapModelRef(
  provider: string | undefined,
  model: string | undefined,
  role: string,
  warnings: string[],
): string | undefined {
  if (!provider || !model) return undefined;
  if (MERIDIAN_PROVIDERS.has(provider)) return `${provider}/${model}`;
  if (provider === 'openrouter') {
    if (model.startsWith('anthropic/')) {
      const mapped = `routexor/${model.slice('anthropic/'.length)}`;
      warnings.push(
        `${role}: openrouter/${model} → ${mapped} (Meridian removed openrouter; verify the routexor model id)`,
      );
      return mapped;
    }
    warnings.push(
      `${role}: dropped openrouter/${model} (openrouter removed from Meridian; no obvious routexor equivalent)`,
    );
    return undefined;
  }
  warnings.push(`${role}: dropped ${provider}/${model} (provider unknown to Meridian)`);
  return undefined;
}

/** Same mapping for `provider/model[/…]` single-string refs (OpenClaw style). */
function mapPrefixedModelRef(
  ref: string | undefined,
  role: string,
  warnings: string[],
): string | undefined {
  if (!ref || typeof ref !== 'string') return undefined;
  const slash = ref.indexOf('/');
  if (slash < 0) return undefined;
  return mapModelRef(ref.slice(0, slash), ref.slice(slash + 1), role, warnings);
}

// ─── Semantic translation: Hermes ──────────────────────────────────────────────

interface PlanAccumulator {
  steps: ImportStep[];
  secrets: SecretFinding[];
  automations: AutomationImport[];
  configPatch: ConfigPatch;
  warnings: string[];
  skipped: string[];
  notFound: string[];
  usedAutomationFiles: Set<string>;
  systemdUnit?: string;
}

function readJsonFile(abs: string): unknown {
  return JSON.parse(readFileSync(abs, 'utf8'));
}

function pushAutomationStep(
  acc: PlanAccumulator,
  a: Omit<AutomationImport, 'fileRel'>,
  prompt: string,
  provenance: string,
): void {
  const base = `imported-${slugifyName(a.name)}`;
  let fileRel = join('AUTOMATIONS', `${base}.md`);
  for (let n = 2; acc.usedAutomationFiles.has(fileRel); n++) {
    fileRel = join('AUTOMATIONS', `${base}-${n}.md`);
  }
  acc.usedAutomationFiles.add(fileRel);
  const meta: Record<string, unknown> = {
    name: a.name,
    schedule: a.schedule,
    ...(a.timezone ? { timezone: a.timezone } : {}),
    enabled: a.enabled,
    mode: 'draft',
    requiresApproval: true,
    pushTo: a.pushTo,
    ...(a.deliver ? { deliverHint: a.deliver } : {}),
    importedFrom: provenance,
  };
  const content = `---\n${stringifyYaml(meta)}---\n\n${sanitizeConfigContent(prompt).trim()}\n`;
  acc.steps.push({
    kind: 'note',
    sourceAbs: '',
    targetRel: fileRel,
    label: `automation "${a.name}" → ${fileRel} (${a.enabled ? 'enabled' : 'DISABLED'})`,
    bytes: content.length,
    content,
  });
  acc.automations.push({ ...a, fileRel });
}

/** config.yaml → models chain + telegram channel + the agent's local timezone. */
function analyzeHermesConfig(sourceRoot: string, acc: PlanAccumulator): string | undefined {
  const abs = firstExisting(sourceRoot, ['config.yaml', 'config.yml']);
  if (!abs) return undefined;
  let cfg: Record<string, unknown>;
  try {
    cfg = (parseYaml(readFileSync(abs, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch (err) {
    acc.warnings.push(`config.yaml unparseable (${(err as Error).message}) — model/channel translation skipped`);
    return undefined;
  }
  const tz = typeof cfg.timezone === 'string' ? cfg.timezone : undefined;

  const model = (cfg.model ?? {}) as Record<string, unknown>;
  const primary = mapModelRef(
    typeof model.provider === 'string' ? model.provider : undefined,
    typeof model.default === 'string' ? model.default : undefined,
    'models.primary',
    acc.warnings,
  );
  const fallbacks: string[] = [];
  const fp = cfg.fallback_providers;
  if (Array.isArray(fp)) {
    for (const f of fp as Array<Record<string, unknown>>) {
      const mapped = mapModelRef(
        typeof f?.provider === 'string' ? f.provider : undefined,
        typeof f?.model === 'string' ? f.model : undefined,
        'models.fallbacks',
        acc.warnings,
      );
      if (mapped && mapped !== primary && !fallbacks.includes(mapped)) fallbacks.push(mapped);
    }
  }
  const smr = cfg.smart_model_routing as Record<string, unknown> | undefined;
  let smartRouting: NonNullable<ConfigPatch['models']>['smartRouting'];
  if (smr && typeof smr === 'object') {
    const cheap = smr.cheap_model as Record<string, unknown> | undefined;
    smartRouting = {
      enabled: smr.enabled === true,
      ...(typeof smr.max_simple_chars === 'number' ? { maxSimpleChars: smr.max_simple_chars } : {}),
      ...(typeof smr.max_simple_words === 'number' ? { maxSimpleWords: smr.max_simple_words } : {}),
    };
    const cheapModel = mapModelRef(
      typeof cheap?.provider === 'string' ? cheap.provider : undefined,
      typeof cheap?.model === 'string' ? cheap.model : undefined,
      'smartRouting.cheapModel',
      acc.warnings,
    );
    if (cheapModel) smartRouting.cheapModel = cheapModel;
  }
  if (primary || fallbacks.length > 0 || smartRouting) {
    acc.configPatch.models = {
      ...(primary ? { primary } : {}),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
      ...(smartRouting ? { smartRouting } : {}),
    };
  }

  const telegram = cfg.telegram as Record<string, unknown> | undefined;
  if (telegram?.enabled === true) acc.configPatch.telegramEnabled = true;
  const homeChannel = cfg.TELEGRAM_HOME_CHANNEL;
  if (typeof homeChannel === 'string' || typeof homeChannel === 'number') {
    acc.configPatch.telegramDefaultChatId = String(homeChannel);
  }
  return tz;
}

/** channel_directory.json → defaultChatId fallback + a rewiring doc that
 *  enumerates every chat/DM binding by id and name (tokens live in .env and
 *  are surfaced by the secret scan, never here). */
function analyzeHermesChannels(sourceRoot: string, acc: PlanAccumulator): void {
  const abs = join(sourceRoot, 'channel_directory.json');
  if (!existsSync(abs)) return;
  let dir: Record<string, unknown>;
  try {
    dir = readJsonFile(abs) as Record<string, unknown>;
  } catch {
    acc.warnings.push('channel_directory.json unparseable — channel doc skipped');
    return;
  }
  const platforms = (dir.platforms ?? {}) as Record<string, unknown>;
  const lines: string[] = [
    '# Imported channel directory',
    '',
    `<!-- Imported from hermes (channel_directory.json) by \`meridian import\`. -->`,
    '',
    'Every chat/DM binding the source agent knew about. Rewire deliberately:',
    'operator DMs belong in `operator.channels.telegram` (config.yaml); the',
    'default outbound chat is `channels.telegram.defaultChatId`. Bot tokens are',
    'secrets — re-add them by NAME in `.env` (TELEGRAM_BOT_TOKEN etc.).',
    '',
  ];
  let firstTelegramDm: string | undefined;
  let any = false;
  for (const [platform, entries] of Object.entries(platforms)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    any = true;
    lines.push(`## ${platform}`, '');
    for (const e of entries as Array<Record<string, unknown>>) {
      const id = String(e?.id ?? '?');
      const name = typeof e?.name === 'string' ? e.name : '(unnamed)';
      const type = typeof e?.type === 'string' ? e.type : 'chat';
      lines.push(`- \`${id}\` — ${name} (${type})`);
      if (platform === 'telegram' && type === 'dm' && !firstTelegramDm) firstTelegramDm = id;
    }
    lines.push('');
  }
  if (!any) return;
  if (!acc.configPatch.telegramDefaultChatId && firstTelegramDm) {
    acc.configPatch.telegramDefaultChatId = firstTelegramDm;
  }
  const content = sanitizeConfigContent(`${lines.join('\n')}\n`);
  acc.steps.push({
    kind: 'note',
    sourceAbs: '',
    targetRel: join('CONNECTIONS', 'imported-channels.md'),
    label: 'channel directory → CONNECTIONS/imported-channels.md (rewire deliberately)',
    bytes: content.length,
    content,
  });
}

/** cron/jobs.json → real AUTOMATIONS entries. Hermes cron fires in the agent's
 *  LOCAL timezone — the tz travels with each entry so node-cron keeps the
 *  operator's actual schedule. Enabled state is preserved faithfully. */
function analyzeHermesCron(sourceRoot: string, tz: string | undefined, acc: PlanAccumulator): void {
  const abs = join(sourceRoot, 'cron', 'jobs.json');
  if (!existsSync(abs)) return;
  let parsed: unknown;
  try {
    parsed = readJsonFile(abs);
  } catch {
    acc.warnings.push('cron/jobs.json unparseable — no automations generated');
    return;
  }
  const jobs = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.jobs)
      ? ((parsed as Record<string, unknown>).jobs as unknown[])
      : [];
  for (const raw of jobs) {
    const job = raw as Record<string, unknown>;
    const name = typeof job.name === 'string' && job.name.trim() ? job.name.trim() : `hermes-job-${String(job.id ?? 'x')}`;
    let expr: string | undefined;
    const sched = job.schedule;
    if (typeof sched === 'string') expr = sched;
    else if (
      sched &&
      typeof sched === 'object' &&
      (sched as Record<string, unknown>).kind === 'cron' &&
      typeof (sched as Record<string, unknown>).expr === 'string'
    ) {
      expr = (sched as Record<string, unknown>).expr as string;
    }
    let enabled = job.enabled !== false;
    if (!expr) {
      const kind =
        sched && typeof sched === 'object' ? String((sched as Record<string, unknown>).kind) : String(sched);
      acc.warnings.push(
        `cron job "${name}": unsupported schedule kind '${kind}' — imported DISABLED with a placeholder schedule`,
      );
      expr = '0 9 * * *';
      enabled = false;
    }
    const deliver = typeof job.deliver === 'string' ? job.deliver : undefined;
    pushAutomationStep(
      acc,
      {
        name,
        schedule: expr,
        ...(tz ? { timezone: tz } : {}),
        enabled,
        pushTo: deliver?.startsWith('telegram') ? 'telegram' : 'none',
        ...(deliver ? { deliver } : {}),
      },
      typeof job.prompt === 'string' ? job.prompt : `Run the ${name} automation.`,
      `hermes cron job ${String(job.id ?? '?')} (schedule interpreted in ${tz ?? 'the source agent’s local tz'})`,
    );
  }
}

// Tables that hold durable narrative memory, by name. FTS shadow tables and
// sqlite internals never qualify.
const MEMORYISH_TABLE_RE = /(memor|journal|note|fact|knowledge|insight|reflect|learn)/i;
const SESSION_ROW_LIMIT = 5000;
const MEMORY_ROW_LIMIT = 500;

function cellToText(v: SqliteCell): string {
  if (v === null) return '';
  if (v instanceof Uint8Array) return `[blob ${v.byteLength} bytes]`;
  return String(v);
}

function renderMemoryTable(dump: SqliteTableDump, dbLabel: string): string {
  const lines: string[] = [
    `# Imported memory — ${dbLabel}, table \`${dump.name}\``,
    '',
    `<!-- Imported from ${dbLabel} (table ${dump.name}, ${dump.rows.length} row(s)${dump.truncated ? ', truncated' : ''}) by \`meridian import\`. Review and edit. -->`,
    '',
  ];
  dump.rows.forEach((row, i) => {
    lines.push(`## ${dump.name} #${i + 1}`, '');
    const longText: string[] = [];
    row.forEach((v, c) => {
      const text = cellToText(v);
      if (!text) return;
      if (typeof v === 'string' && text.length > 120) longText.push(text);
      else lines.push(`- ${dump.columns[c]}: ${text}`);
    });
    for (const t of longText) lines.push('', t);
    lines.push('');
  });
  if (dump.truncated) lines.push(`(truncated at ${MEMORY_ROW_LIMIT} rows — the full table stays in the source state.db)`, '');
  return sanitizeConfigContent(lines.join('\n'));
}

function renderSessionsSummary(dump: SqliteTableDump, dbLabel: string): string {
  const col = (name: string) => dump.columns.indexOf(name);
  const iStarted = col('started_at');
  const iSource = col('source');
  const iTitle = col('title');
  const iCount = col('message_count');
  const iModel = col('model');
  const asDate = (v: SqliteCell): string => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return '?';
    return new Date(n > 1e12 ? n : n * 1000).toISOString().slice(0, 10);
  };
  const rows = [...dump.rows].sort((a, b) => Number(b[iStarted] ?? 0) - Number(a[iStarted] ?? 0));
  const bySource = new Map<string, number>();
  for (const r of rows) {
    const s = cellToText(iSource >= 0 ? r[iSource] : null) || '?';
    bySource.set(s, (bySource.get(s) ?? 0) + 1);
  }
  const lines: string[] = [
    '# Imported session history — summary',
    '',
    `<!-- Imported from ${dbLabel} (table sessions) by \`meridian import\`. Compact index; raw transcripts are NOT copied by default (re-run with --sessions). -->`,
    '',
    `- sessions: ${rows.length}${dump.truncated ? '+' : ''}`,
    ...(rows.length > 0
      ? [`- span: ${asDate(rows[rows.length - 1][iStarted])} → ${asDate(rows[0][iStarted])}`]
      : []),
    `- by source: ${[...bySource.entries()].map(([s, n]) => `${s}=${n}`).join(', ')}`,
    '',
    '## Most recent sessions',
    '',
    '| date | source | model | msgs | title |',
    '|------|--------|-------|------|-------|',
  ];
  for (const r of rows.slice(0, 100)) {
    const title = cellToText(iTitle >= 0 ? r[iTitle] : null)
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    lines.push(
      `| ${asDate(iStarted >= 0 ? r[iStarted] : null)} | ${cellToText(iSource >= 0 ? r[iSource] : null)} | ${cellToText(iModel >= 0 ? r[iModel] : null)} | ${cellToText(iCount >= 0 ? r[iCount] : null)} | ${title} |`,
    );
  }
  lines.push('');
  return sanitizeConfigContent(lines.join('\n'));
}

/** state.db → memory-like tables as markdown + a compact session index.
 *  The sqlite reader is lazy-loaded work: a home without state.db never
 *  touches sqlite at all. */
function analyzeStateDb(sourceRoot: string, acc: PlanAccumulator): void {
  const abs = join(sourceRoot, 'state.db');
  if (!existsSync(abs)) {
    acc.notFound.push('state.db (memory tables + session index)');
    return;
  }
  let db: ReturnType<typeof openSqliteReadOnly>;
  try {
    db = openSqliteReadOnly(abs);
  } catch (err) {
    acc.warnings.push(`state.db unreadable (${(err as Error).message}) — memory/session extraction skipped`);
    return;
  }
  try {
    if (db.walPossiblyStale) {
      acc.warnings.push(
        'state.db has an unmerged write-ahead log the pure reader cannot apply — the newest rows may be missing (run the import on Node 22.13+ to merge the WAL)',
      );
    }
    for (const table of db.tables) {
      if (/_fts/i.test(table) || !MEMORYISH_TABLE_RE.test(table)) continue;
      let dump: SqliteTableDump;
      try {
        dump = db.read(table, MEMORY_ROW_LIMIT);
      } catch (err) {
        acc.warnings.push(`state.db table ${table}: ${(err as Error).message}`);
        continue;
      }
      if (dump.rows.length === 0) continue;
      const content = renderMemoryTable(dump, 'hermes state.db');
      const targetRel = join('MEMORY', 'imported', `state-db-${slugifyName(table)}.md`);
      acc.steps.push({
        kind: 'note',
        sourceAbs: '',
        targetRel,
        label: `state.db ${table} (${dump.rows.length} row(s)) → ${targetRel}`,
        bytes: content.length,
        content,
      });
    }
    if (db.tables.includes('sessions')) {
      try {
        const dump = db.read('sessions', SESSION_ROW_LIMIT);
        if (dump.rows.length > 0) {
          const content = renderSessionsSummary(dump, 'hermes state.db');
          acc.steps.push({
            kind: 'note',
            sourceAbs: '',
            targetRel: join('MEMORY', 'imported', 'sessions-summary.md'),
            label: `state.db sessions (${dump.rows.length}) → MEMORY/imported/sessions-summary.md`,
            bytes: content.length,
            content,
          });
        }
      } catch (err) {
        acc.warnings.push(`state.db sessions index: ${(err as Error).message}`);
      }
    }
  } finally {
    db.close();
  }
}

/** Raw session transcripts: opt-in (they run 50-160MB on real homes and may
 *  contain sensitive conversation content). Skipping is LOGGED, not silent. */
function planSessionsDir(
  absDir: string,
  targetRel: string,
  include: boolean,
  acc: PlanAccumulator,
): void {
  if (!existsSync(absDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  // Only the JSONL transcripts travel. Everything else in a hermes sessions/
  // dir is runtime debris — request_dump_*.json raw provider payloads,
  // sessions.json registries — and stays home even under --sessions.
  const files = entries.filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return;
  const totalBytes = files.reduce((sum, f) => sum + sizeOf(join(absDir, f)), 0);
  const mb = (totalBytes / (1024 * 1024)).toFixed(1);
  if (!include) {
    acc.skipped.push(
      `${basename(absDir)}/ raw transcripts (${files.length} files, ${mb} MB) — re-run with --sessions to copy them into ${targetRel}/`,
    );
    return;
  }
  const excludes = entries.filter((f) => !f.endsWith('.jsonl'));
  acc.steps.push({
    kind: 'dir',
    sourceAbs: absDir,
    targetRel,
    label: `raw sessions → ${targetRel}/ (${files.length} files, ${mb} MB — may contain sensitive content)`,
    bytes: totalBytes,
    ...(excludes.length > 0 ? { excludes } : {}),
  });
}

/** Locate the systemd unit whose HERMES_HOME points at the source home and
 *  surface every env VAR NAME its drop-ins set (values never read past the
 *  `=`). Real Hermes fleets keep provider keys in .d/*.conf drop-ins. */
function scanHermesSystemd(sourceRoot: string, systemdDir: string, acc: PlanAccumulator): void {
  let entries: string[];
  try {
    entries = readdirSync(systemdDir);
  } catch {
    return;
  }
  const wantedHome = resolve(sourceRoot);
  for (const unit of entries) {
    if (!/^hermes-gateway.*\.service$/.test(unit)) continue;
    let text: string;
    try {
      text = readFileSync(join(systemdDir, unit), 'utf8');
    } catch {
      continue;
    }
    const m = text.match(/^\s*Environment="?HERMES_HOME=([^"\n]+?)"?\s*$/m);
    if (!m || resolve(m[1]) !== wantedHome) continue;
    acc.systemdUnit = unit;
    const dropinDir = join(systemdDir, `${unit}.d`);
    let confs: string[] = [];
    try {
      confs = readdirSync(dropinDir).filter((f) => f.endsWith('.conf'));
    } catch {
      // no drop-ins — the unit match alone is still worth reporting
    }
    for (const conf of confs) {
      let confText: string;
      try {
        confText = readFileSync(join(dropinDir, conf), 'utf8');
      } catch {
        continue;
      }
      const names = [...confText.matchAll(/^\s*Environment="?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(
        (x) => x[1],
      );
      if (names.length > 0) acc.secrets.push({ file: `systemd:${unit}.d/${conf}`, keys: names });
    }
    return; // one home, one unit
  }
}

function analyzeHermes(sourceRoot: string, opts: ImportPlanOptions, acc: PlanAccumulator): void {
  const tz = analyzeHermesConfig(sourceRoot, acc);
  analyzeHermesChannels(sourceRoot, acc);
  analyzeHermesCron(sourceRoot, tz, acc);
  analyzeStateDb(sourceRoot, acc);
  planSessionsDir(
    join(sourceRoot, 'sessions'),
    join('MEMORY', 'imported', 'sessions'),
    opts.sessions === true,
    acc,
  );
  if (opts.systemd !== false) {
    scanHermesSystemd(sourceRoot, opts.systemdDir ?? '/etc/systemd/system', acc);
  }
}

// ─── Semantic translation: OpenClaw ────────────────────────────────────────────

interface OpenclawAgentEntry {
  id?: string;
  model?: string;
  agentDir?: string;
}

/** The primary (non-`main`) agent declared in openclaw.json — OpenClaw keeps a
 *  background `main` agent for heartbeat-style behavior; the named agent is
 *  the one being migrated. */
function openclawPrimaryAgent(cfg: Record<string, unknown> | undefined, sourceRoot: string): {
  entry?: OpenclawAgentEntry;
  agentDirAbs?: string;
  hasMain: boolean;
} {
  const list = ((cfg?.agents as Record<string, unknown> | undefined)?.list ?? []) as OpenclawAgentEntry[];
  const arr = Array.isArray(list) ? list : [];
  const hasMain = arr.some((a) => a?.id === 'main');
  let entry = arr.find((a) => a?.id && a.id !== 'main') ?? arr.find((a) => a?.id);
  if (!entry) {
    // No config (or an empty list): fall back to the agents/ dir layout.
    try {
      const ids = readdirSync(join(sourceRoot, 'agents')).filter(
        (e) => e !== 'main' && statSync(join(sourceRoot, 'agents', e)).isDirectory(),
      );
      if (ids.length > 0) entry = { id: ids[0] };
    } catch {
      // no agents dir either
    }
  }
  if (!entry?.id) return { hasMain };
  const agentDirAbs =
    typeof entry.agentDir === 'string' && entry.agentDir
      ? entry.agentDir
      : join(sourceRoot, 'agents', entry.id, 'agent');
  return { entry, agentDirAbs, hasMain };
}

function readOpenclawConfig(sourceRoot: string): Record<string, unknown> | undefined {
  const abs = join(sourceRoot, 'openclaw.json');
  if (!existsSync(abs)) return undefined;
  try {
    return readJsonFile(abs) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sanitizeMcpName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '');
  return cleaned || 'imported';
}

/** openclaw.json → models chain, telegram channel, CONNECTIONS/mcp.json,
 *  pdf + vision-prompt reference docs, heartbeat automation suggestion, and
 *  every secret surfaced by NAME. */
function analyzeOpenclaw(sourceRoot: string, acc: PlanAccumulator): void {
  const cfg = readOpenclawConfig(sourceRoot);
  if (!cfg) {
    if (existsSync(join(sourceRoot, 'openclaw.json'))) {
      acc.warnings.push('openclaw.json unparseable — config translation skipped');
    } else {
      acc.notFound.push('openclaw.json (models/channels/mcp wiring)');
    }
    return;
  }
  const agents = (cfg.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
  const defaultModel = (defaults.model ?? {}) as Record<string, unknown>;
  const { entry: primaryAgent, hasMain } = openclawPrimaryAgent(cfg, sourceRoot);

  // Models: the named agent's pin wins; agents.defaults.model fills the chain.
  const primary =
    mapPrefixedModelRef(primaryAgent?.model, 'models.primary', acc.warnings) ??
    mapPrefixedModelRef(
      typeof defaultModel.primary === 'string' ? defaultModel.primary : undefined,
      'models.primary',
      acc.warnings,
    );
  const fallbacks: string[] = [];
  const fallbackRefs = [
    typeof defaultModel.primary === 'string' ? defaultModel.primary : undefined,
    ...(Array.isArray(defaultModel.fallbacks) ? (defaultModel.fallbacks as unknown[]) : []),
  ];
  for (const ref of fallbackRefs) {
    const mapped = mapPrefixedModelRef(
      typeof ref === 'string' ? ref : undefined,
      'models.fallbacks',
      acc.warnings,
    );
    if (mapped && mapped !== primary && !fallbacks.includes(mapped)) fallbacks.push(mapped);
  }
  if (primary || fallbacks.length > 0) {
    acc.configPatch.models = {
      ...(primary ? { primary } : {}),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
    };
  }

  // Telegram channel: enabled travels; the bot token is a secret — by NAME only.
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const telegram = channels.telegram as Record<string, unknown> | undefined;
  const configSecretKeys: string[] = [];
  if (telegram?.enabled === true) acc.configPatch.telegramEnabled = true;
  if (typeof telegram?.botToken === 'string' && telegram.botToken) {
    configSecretKeys.push('channels.telegram.botToken');
  }
  const gateway = (cfg.gateway ?? {}) as Record<string, unknown>;
  if (typeof (gateway.auth as Record<string, unknown> | undefined)?.token === 'string') {
    configSecretKeys.push('gateway.auth.token');
  }
  for (const k of Object.keys((cfg.env ?? {}) as Record<string, unknown>)) {
    configSecretKeys.push(`env.${k}`);
  }

  // MCP servers → CONNECTIONS/mcp.json. Secret-shaped env vars are stripped
  // (surfaced by name); servers that lost env import DISABLED so the operator
  // re-arms them deliberately after re-adding the secrets.
  const mcpServers = ((cfg.mcp as Record<string, unknown> | undefined)?.servers ?? {}) as Record<
    string,
    unknown
  >;
  const servers: McpServerConfig[] = [];
  for (const [rawName, rawServer] of Object.entries(mcpServers)) {
    const s = (rawServer ?? {}) as Record<string, unknown>;
    const name = sanitizeMcpName(rawName);
    const env: Record<string, string> = {};
    let strippedEnv = false;
    for (const [k, v] of Object.entries((s.env ?? {}) as Record<string, unknown>)) {
      const value = String(v ?? '');
      const secret =
        SECRET_ENV_NAME_RE.test(k) ||
        URL_USERINFO_RE.test(value) ||
        SECRET_VALUE_RE.test(`${k}="${value}"`);
      if (secret) {
        strippedEnv = true;
        configSecretKeys.push(`mcp.servers.${rawName}.env.${k}`);
      } else {
        env[k] = value;
      }
    }
    const url = typeof s.url === 'string' ? s.url : undefined;
    const command = typeof s.command === 'string' ? s.command : undefined;
    if (!command && !url) {
      acc.warnings.push(`mcp server "${rawName}": no command or url — skipped`);
      continue;
    }
    if (strippedEnv) {
      acc.warnings.push(
        `mcp server "${rawName}": secret-shaped env stripped (names in the secrets report) — imported DISABLED`,
      );
    }
    servers.push({
      name,
      transport: url ? 'http' : 'stdio',
      ...(command ? { command } : {}),
      args: Array.isArray(s.args) ? (s.args as unknown[]).map(String) : [],
      env,
      ...(url ? { url } : {}),
      headers: {},
      enabled: strippedEnv ? false : s.enabled !== false,
      channels: ['cli', 'gateway', 'telegram', 'system'],
    });
  }
  if (configSecretKeys.length > 0) {
    acc.secrets.push({ file: 'openclaw.json', keys: configSecretKeys });
  }
  if (servers.length > 0) {
    try {
      const file = McpConnectionsFileSchema.parse({ servers });
      const content = `${JSON.stringify(file, null, 2)}\n`;
      acc.steps.push({
        kind: 'note',
        sourceAbs: '',
        targetRel: join('CONNECTIONS', 'mcp.json'),
        label: `mcp.servers (${servers.length}) → CONNECTIONS/mcp.json${servers.some((s) => !s.enabled) ? ' (secret env stripped — disabled entries need rewiring)' : ''}`,
        bytes: content.length,
        content,
      });
    } catch (err) {
      acc.warnings.push(`mcp.servers translation failed validation (${(err as Error).message}) — skipped`);
    }
  }

  // PDF pipeline settings: Meridian has no pdf config block — keep the source
  // values as a reference doc instead of dropping them silently.
  const pdfBits: string[] = [];
  const pdfModel = defaults.pdfModel as Record<string, unknown> | undefined;
  if (pdfModel && typeof pdfModel === 'object') {
    const pdfWarnings: string[] = [];
    const mappedPrimary = mapPrefixedModelRef(
      typeof pdfModel.primary === 'string' ? pdfModel.primary : undefined,
      'pdf primary',
      pdfWarnings,
    );
    pdfBits.push(
      `- model.primary: \`${String(pdfModel.primary ?? '?')}\`${mappedPrimary ? ` (Meridian equivalent: \`${mappedPrimary}\`)` : ''}`,
    );
    if (Array.isArray(pdfModel.fallbacks)) {
      for (const f of pdfModel.fallbacks as unknown[]) pdfBits.push(`- model.fallback: \`${String(f)}\``);
    }
  }
  if (typeof defaults.pdfMaxPages === 'number') pdfBits.push(`- maxPages: ${defaults.pdfMaxPages}`);
  if (typeof defaults.pdfMaxBytesMb === 'number') pdfBits.push(`- maxBytesMb: ${defaults.pdfMaxBytesMb}`);
  if (pdfBits.length > 0) {
    const content = sanitizeConfigContent(
      [
        '# Imported PDF settings (openclaw)',
        '',
        '<!-- Imported from openclaw (openclaw.json agents.defaults) by `meridian import`. -->',
        '',
        'Meridian has no per-agent PDF config block; PDF ingestion runs through',
        '`meridian ingest` (pdfjs). Source values kept for reference:',
        '',
        ...pdfBits,
        '',
      ].join('\n'),
    );
    acc.steps.push({
      kind: 'note',
      sourceAbs: '',
      targetRel: join('CONTEXT', 'imported-openclaw-pdf.md'),
      label: 'pdf settings → CONTEXT/imported-openclaw-pdf.md (reference)',
      bytes: content.length,
      content,
    });
  }

  // Vision prompt: operational prompt engineering — preserve it verbatim.
  const image = ((cfg.tools as Record<string, unknown> | undefined)?.media as
    | Record<string, unknown>
    | undefined)?.image as Record<string, unknown> | undefined;
  if (typeof image?.prompt === 'string' && image.prompt.trim()) {
    const models = Array.isArray(image.models)
      ? (image.models as Array<Record<string, unknown>>)
          .map((m) => `${String(m?.provider ?? '?')}/${String(m?.model ?? '?')}`)
          .join(', ')
      : undefined;
    const content = sanitizeConfigContent(
      [
        '# Imported vision prompt (openclaw)',
        '',
        '<!-- Imported from openclaw (openclaw.json tools.media.image.prompt) by `meridian import`. -->',
        '',
        ...(models ? [`Source vision models: ${models}`, ''] : []),
        image.prompt.trim(),
        '',
      ].join('\n'),
    );
    acc.steps.push({
      kind: 'note',
      sourceAbs: '',
      targetRel: join('CONTEXT', 'imported-vision-prompt.md'),
      label: 'vision prompt → CONTEXT/imported-vision-prompt.md',
      bytes: content.length,
      content,
    });
  }

  // OpenClaw's background `main` agent is its heartbeat surface. Suggest the
  // equivalent as a DISABLED automation — never auto-arm a background loop.
  if (hasMain) {
    pushAutomationStep(
      acc,
      {
        name: 'openclaw-main-heartbeat',
        schedule: '*/30 * * * *',
        enabled: false,
        pushTo: 'none',
      },
      [
        'OpenClaw ran a background `main` agent (heartbeat-style check-ins).',
        'Meridian equivalent: this automation, or the built-in heartbeat',
        '(config.yaml `heartbeat:`). Edit this prompt to describe what a',
        'check-in should look at, then set `enabled: true` deliberately.',
      ].join('\n'),
      'openclaw.json agents.list `main` agent (heartbeat behavior)',
    );
  }
}

/** auth-profiles.json lives per agent under agents/<id>/agent/ — surface each
 *  provider profile by NAME (values never read past parse). */
function scanOpenclawAuthProfiles(sourceRoot: string, acc: PlanAccumulator): void {
  let ids: string[];
  try {
    ids = readdirSync(join(sourceRoot, 'agents'));
  } catch {
    return;
  }
  for (const id of ids) {
    const abs = join(sourceRoot, 'agents', id, 'agent', 'auth-profiles.json');
    if (!existsSync(abs)) continue;
    try {
      const parsed = readJsonFile(abs) as Record<string, unknown>;
      const profiles = (parsed?.profiles ?? {}) as Record<string, unknown>;
      const keys = Object.entries(profiles).map(([name, p]) => {
        const type = (p as Record<string, unknown>)?.type;
        return `profiles.${name}${typeof type === 'string' ? ` (${type})` : ''}`;
      });
      acc.secrets.push({ file: join('agents', id, 'agent', 'auth-profiles.json'), keys });
    } catch {
      acc.secrets.push({ file: join('agents', id, 'agent', 'auth-profiles.json'), keys: [] });
    }
  }
}

/** OpenClaw memory/*.sqlite are document CHUNK stores (RAG), not narrative
 *  memory — copying embeddings across runtimes is meaningless. Log the skip. */
function noteOpenclawMemoryStores(sourceRoot: string, acc: PlanAccumulator): void {
  const dir = join(sourceRoot, 'memory');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sqlite'));
  } catch {
    return;
  }
  for (const f of files) {
    const mb = (sizeOf(join(dir, f)) / (1024 * 1024)).toFixed(1);
    acc.skipped.push(
      `memory/${f} (document chunk store, ${mb} MB) — not imported; re-ingest the source documents with \`meridian ingest\``,
    );
  }
}

/**
 * Build the import plan from a source home WITHOUT writing anything. Pure over
 * the filesystem of the SOURCE (reads only) — the unit-tested core.
 */
export function planImport(
  source: ImportSource,
  sourceRoot: string,
  opts: ImportPlanOptions = {},
): ImportPlan {
  const profile = PROFILES[source];
  const acc: PlanAccumulator = {
    steps: [],
    secrets: [],
    automations: [],
    configPatch: {},
    warnings: [],
    skipped: [],
    notFound: [],
    usedAutomationFiles: new Set(),
  };

  // OpenClaw keeps its docs per-agent under agents/<id>/agent/ — discover the
  // primary agent and put its docs FIRST in the candidate lists (legacy root
  // SOUL.md/MEMORY.md layouts still match as fallbacks).
  let personaCandidates = profile.persona;
  let instructionCandidates = profile.instructions;
  const extraFiles: Array<{ candidates: string[]; targetRel: string; label: string }> = [];
  if (source === 'openclaw') {
    const { agentDirAbs } = openclawPrimaryAgent(readOpenclawConfig(sourceRoot), sourceRoot);
    if (agentDirAbs) {
      personaCandidates = [join(agentDirAbs, 'IDENTITY.md'), ...profile.persona];
      instructionCandidates = [join(agentDirAbs, 'PRIME-CONTEXT.md'), ...profile.instructions];
      extraFiles.push({
        candidates: [join(agentDirAbs, 'STANDING-ORDERS.md')],
        targetRel: join('CONTEXT', 'imported-standing-orders.md'),
        label: 'standing orders → CONTEXT/imported-standing-orders.md',
      });
    }
  }

  const fileMap: Array<{
    candidates: string[];
    targetRel: string;
    label: string;
    transform?: ImportTransform;
  }> = [
    {
      candidates: personaCandidates,
      targetRel: join('IDENTITY', 'AGENT.md'),
      label: 'persona → IDENTITY/AGENT.md',
      transform: profile.personaTransform,
    },
    { candidates: profile.user, targetRel: join('IDENTITY', 'USER.md'), label: 'operator profile → IDENTITY/USER.md' },
    { candidates: profile.memory, targetRel: join('MEMORY', 'imported', 'MEMORY.md'), label: 'memory → MEMORY/imported/MEMORY.md' },
    { candidates: instructionCandidates, targetRel: join('CONTEXT', 'imported-instructions.md'), label: 'instructions → CONTEXT/imported-instructions.md' },
    ...extraFiles.map((e) => ({ candidates: e.candidates, targetRel: e.targetRel, label: e.label })),
  ];
  for (const m of fileMap) {
    const hit = firstExisting(sourceRoot, m.candidates);
    if (hit)
      acc.steps.push({
        kind: 'file',
        sourceAbs: hit,
        targetRel: m.targetRel,
        label: m.label,
        bytes: sizeOf(hit),
        ...(m.transform ? { transform: m.transform } : {}),
      });
    else acc.notFound.push(m.label);
  }

  // Known-shape harness configs (profile.configFiles) are copied into CONTEXT/
  // for review, SANITIZED (secret-shaped values redacted at write time). All
  // other competitor config/settings files stay deliberately un-copied — they
  // frequently embed secrets — and are content-scanned by scanSecrets() instead.
  for (const cf of profile.configFiles) {
    const hit = firstExisting(sourceRoot, cf.candidates);
    if (hit)
      acc.steps.push({
        kind: 'file',
        sourceAbs: hit,
        targetRel: cf.target,
        label: cf.label,
        bytes: sizeOf(hit),
        transform: 'sanitize-config',
      });
    else acc.notFound.push(cf.label);
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
          `<!-- Imported from ${profile.name} (generated) by \`meridian import\`. Review and edit. -->\n\n` +
          `Found in the ${profile.name} home (\`${nd.dir}/\`) but NOT imported — ` +
          `${profile.name} plugins are Python and do not run in Meridian:\n\n` +
          `${names.map((n) => `- ${n}`).join('\n')}\n\n` +
          'Recreate the capability with `meridian skills install <name>` or an MCP server (`meridian mcp add`).\n';
        acc.steps.push({
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
      acc.steps.push({
        kind: 'dir',
        sourceAbs: p,
        targetRel: join('SKILLS', 'imported', basename(sd)),
        label: `skills → SKILLS/imported/${basename(sd)}/`,
        bytes: 0,
        ...(profile.skillsCopyExclude.length ? { excludes: profile.skillsCopyExclude } : {}),
      });
    }
  }

  // Source-specific semantic translation (models, crons, channels, memory).
  if (source === 'hermes') {
    analyzeHermes(sourceRoot, opts, acc);
  } else {
    analyzeOpenclaw(sourceRoot, acc);
    scanOpenclawAuthProfiles(sourceRoot, acc);
    noteOpenclawMemoryStores(sourceRoot, acc);
    // OpenClaw transcripts live per agent under agents/<id>/sessions/ (a root
    // sessions/ dir covers legacy layouts).
    planSessionsDir(
      join(sourceRoot, 'sessions'),
      join('MEMORY', 'imported', 'sessions'),
      opts.sessions === true,
      acc,
    );
    let agentIds: string[] = [];
    try {
      agentIds = readdirSync(join(sourceRoot, 'agents'));
    } catch {
      // no agents dir
    }
    for (const id of agentIds) {
      planSessionsDir(
        join(sourceRoot, 'agents', id, 'sessions'),
        join('MEMORY', 'imported', 'sessions', id),
        opts.sessions === true,
        acc,
      );
    }
  }

  // Structured findings (auth pools, openclaw.json keys, systemd drop-ins)
  // beat the generic content scan — don't report the same file twice.
  const structured = new Set(acc.secrets.map((s) => s.file));
  acc.secrets.push(...scanSecrets(sourceRoot, profile).filter((s) => !structured.has(s.file)));

  const userHit = firstExisting(sourceRoot, profile.user);
  return {
    source,
    sourceRoot,
    steps: acc.steps,
    secrets: acc.secrets,
    automations: acc.automations,
    configPatch: acc.configPatch,
    warnings: acc.warnings,
    skipped: acc.skipped,
    ...(acc.systemdUnit ? { systemdUnit: acc.systemdUnit } : {}),
    operatorName: userHit ? parseOperatorName(userHit) : undefined,
    notFound: acc.notFound,
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
      // Generated content carries its own provenance (frontmatter files and
      // JSON can't take a leading comment header).
      writeFileSync(target, step.content ?? '');
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

/** Patch the scaffolded config.yaml with everything the plan translated:
 *  operator name, models chain, telegram channel. Validated before writing —
 *  a bad translation must never persist an invalid config. */
export function patchImportedConfig(home: MeridianHome, plan: ImportPlan): void {
  try {
    const raw = readFileSync(home.configPath, 'utf8');
    const obj = parseYaml(raw) as Record<string, unknown>;
    if (plan.operatorName) {
      const operator = (obj.operator as Record<string, unknown> | undefined) ?? { id: 'primary' };
      operator.name = plan.operatorName;
      obj.operator = operator;
    }
    const patch = plan.configPatch;
    const models = obj.models as Record<string, unknown> | undefined;
    if (patch.models && models) {
      if (patch.models.primary) models.primary = patch.models.primary;
      if (patch.models.fallbacks?.length) models.fallbacks = patch.models.fallbacks;
      if (patch.models.smartRouting) {
        const sr = (models.smartRouting as Record<string, unknown> | undefined) ?? {};
        sr.enabled = patch.models.smartRouting.enabled;
        if (patch.models.smartRouting.maxSimpleChars != null)
          sr.maxSimpleChars = patch.models.smartRouting.maxSimpleChars;
        if (patch.models.smartRouting.maxSimpleWords != null)
          sr.maxSimpleWords = patch.models.smartRouting.maxSimpleWords;
        if (patch.models.smartRouting.cheapModel) sr.cheapModel = patch.models.smartRouting.cheapModel;
        models.smartRouting = sr;
      }
    }
    if (patch.telegramEnabled) {
      const channels = (obj.channels as Record<string, unknown> | undefined) ?? {};
      channels.telegram = {
        enabled: true,
        ...(patch.telegramDefaultChatId ? { defaultChatId: patch.telegramDefaultChatId } : {}),
      };
      obj.channels = channels;
    }
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
  const plan = planImport(src, sourceRoot, { sessions: opts.sessions, systemd: opts.systemd });

  console.log(colors.cyan(`Importing ${src} home: ${sourceRoot}`));
  console.log(colors.muted(`  → Meridian agent: ${slug}\n`));

  // What we'll bring over.
  for (const step of plan.steps) console.log(`  ${colors.ok('+')} ${step.label}`);
  const patch = plan.configPatch;
  if (patch.models?.primary) console.log(`  ${colors.ok('+')} models.primary: ${patch.models.primary}`);
  if (patch.models?.fallbacks?.length)
    console.log(`  ${colors.ok('+')} models.fallbacks: ${patch.models.fallbacks.join(', ')}`);
  if (patch.models?.smartRouting?.cheapModel)
    console.log(`  ${colors.ok('+')} models.smartRouting.cheapModel: ${patch.models.smartRouting.cheapModel}`);
  if (patch.telegramEnabled)
    console.log(
      `  ${colors.ok('+')} channels.telegram: enabled${patch.telegramDefaultChatId ? ` (defaultChatId ${patch.telegramDefaultChatId})` : ''}`,
    );
  if (plan.systemdUnit) console.log(`  ${colors.ok('+')} systemd unit matched: ${plan.systemdUnit} (drop-in env names below)`);
  for (const nf of plan.notFound) console.log(`  ${colors.muted('·')} ${colors.muted(`not found: ${nf}`)}`);
  for (const sk of plan.skipped) console.log(`  ${colors.muted('·')} ${colors.muted(`skipped: ${sk}`)}`);
  if (plan.operatorName) console.log(`  ${colors.ok('+')} operator name: ${plan.operatorName}`);

  if (plan.warnings.length > 0) {
    console.log(colors.warn('\n  ⚠ Translation warnings:'));
    for (const w of plan.warnings) console.log(colors.warn(`     ${w}`));
  }

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
  patchImportedConfig(home, plan);

  console.log(colors.ok(`\n✓ Imported ${written.length} item(s) into ${home.agentRoot}`));
  console.log(colors.muted(`  memory: ${opts.cortex ? 'CORTEX (set NEON/VOYAGE keys in .env)' : 'embedded (zero-config, ready now)'}`));
  if (plan.automations.length > 0) {
    const on = plan.automations.filter((a) => a.enabled).length;
    console.log(
      colors.muted(
        `  automations: ${plan.automations.length} imported (${on} enabled, ${plan.automations.length - on} disabled) — see AUTOMATIONS/`,
      ),
    );
  }
  if (src === 'hermes') {
    console.log(colors.muted('\n  Hermes config, cron, and channels were copied to CONTEXT/ for reference;'));
    console.log(colors.muted('  schedules became real AUTOMATIONS entries and model pins landed in config.yaml.'));
  }
  console.log(colors.muted('\nNext:'));
  console.log(colors.muted(`  1. Review IDENTITY/AGENT.md, CONTEXT/, and AUTOMATIONS/ in ${home.agentRoot}`));
  if (plan.secrets.length) console.log(colors.muted('  2. Re-add the secrets listed above (they were not copied).'));
  console.log(colors.muted(`  ${plan.secrets.length ? 3 : 2}. meridian use ${slug} && meridian doctor && meridian`));
}
