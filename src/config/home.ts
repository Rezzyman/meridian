/**
 * Resolves the per-agent home: ~/.meridian/<agent>/
 * Honors MERIDIAN_HOME and MERIDIAN_AGENT env vars.
 * Provides typed accessors for the seven AgentOS layers.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentConfig } from './schema.js';
import { AgentConfigSchema, defaultAgentConfig } from './schema.js';

const SEVEN_LAYERS = [
  'IDENTITY',
  'CONTEXT',
  'SKILLS',
  'MEMORY',
  'CONNECTIONS',
  'VERIFICATION',
  'AUTOMATIONS',
] as const;

export interface MeridianHome {
  root: string; // ~/.meridian
  agentSlug: string;
  agentRoot: string; // ~/.meridian/<agent>
  configPath: string;
  envPath: string;
  vaultPath: string;
  layer(name: (typeof SEVEN_LAYERS)[number]): string;
  sessions: string;
  logs: string;
  checkpoints: string;
  stateDb: string;
}

export function meridianRoot(): string {
  return process.env.MERIDIAN_HOME ?? join(homedir(), '.meridian');
}

export function activeAgentSlug(): string {
  if (process.env.MERIDIAN_AGENT) return process.env.MERIDIAN_AGENT;
  const activePtr = join(meridianRoot(), 'active');
  if (existsSync(activePtr)) {
    return readFileSync(activePtr, 'utf8').trim();
  }
  throw new Error(
    'No active agent. Set MERIDIAN_AGENT, pass --agent, or run `meridian init <name>`.',
  );
}

export function ensureRoot(): void {
  const root = meridianRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

export function resolveHome(slug: string): MeridianHome {
  const root = meridianRoot();
  const agentRoot = join(root, slug);
  return {
    root,
    agentSlug: slug,
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
}

export function ensureAgentHome(slug: string): MeridianHome {
  ensureRoot();
  const home = resolveHome(slug);
  if (!existsSync(home.agentRoot)) mkdirSync(home.agentRoot, { recursive: true });
  for (const layer of SEVEN_LAYERS) {
    const dir = home.layer(layer);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  for (const sub of ['sessions', 'logs', 'checkpoints']) {
    const dir = join(home.agentRoot, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // CONTEXT/.proposed/ for CORTEX-driven curation suggestions
  const proposed = join(home.layer('CONTEXT'), '.proposed');
  if (!existsSync(proposed)) mkdirSync(proposed, { recursive: true });
  // VERIFICATION/audits/ for retrospective reports
  const audits = join(home.layer('VERIFICATION'), 'audits');
  if (!existsSync(audits)) mkdirSync(audits, { recursive: true });
  // MEMORY substructure
  for (const sub of ['decision-logs', 'relationships', 'processes', 'episodic']) {
    const dir = join(home.layer('MEMORY'), sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return home;
}

export function loadAgentConfig(home: MeridianHome): AgentConfig {
  if (!existsSync(home.configPath)) {
    const defaults = defaultAgentConfig(home.agentSlug, home.agentSlug);
    writeFileSync(home.configPath, stringifyYaml(defaults));
    return defaults;
  }
  const raw = readFileSync(home.configPath, 'utf8');
  const parsed = parseYaml(raw);
  return AgentConfigSchema.parse(parsed);
}

export function saveAgentConfig(home: MeridianHome, config: AgentConfig): void {
  writeFileSync(home.configPath, stringifyYaml(config));
}

export function setActiveAgent(slug: string): void {
  ensureRoot();
  writeFileSync(join(meridianRoot(), 'active'), slug);
}

export function listAgents(): string[] {
  const root = meridianRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

/**
 * Read each agent's role/name from config.yaml (best-effort, swallows errors)
 * for the picker. Returns slug + display details.
 *
 * Skips template scaffolds (slugs containing `__`) and dirs without a
 * config.yaml — those are half-provisioned and would crash the REPL boot.
 */
export function describeAgents(): Array<{
  slug: string;
  name: string;
  role: string;
}> {
  const out: Array<{ slug: string; name: string; role: string }> = [];
  for (const slug of listAgents()) {
    if (slug.includes('__')) continue; // template placeholders
    const cfgPath = join(meridianRoot(), slug, 'config.yaml');
    if (!existsSync(cfgPath)) continue; // half-provisioned home
    let name = slug;
    let role = '';
    try {
      const raw = readFileSync(cfgPath, 'utf8');
      const parsed = parseYaml(raw) as { agent?: { name?: string; role?: string } };
      name = parsed.agent?.name ?? slug;
      role = parsed.agent?.role ?? '';
    } catch {
      /* keep defaults */
    }
    out.push({ slug, name, role });
  }
  return out;
}

export { SEVEN_LAYERS };
