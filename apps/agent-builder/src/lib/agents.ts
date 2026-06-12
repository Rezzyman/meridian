/**
 * Read-only view over ~/.meridian agent homes for the UI: list agents,
 * summarize one agent. Mirrors the CLI's describeAgents() conventions
 * (skip dot-dirs, skip `__` template scaffolds, require config.yaml).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { gatewayStatus } from './gateway';
import { agentRoot, meridianHome } from './paths';
import type { AgentSummary } from './types';

interface RawConfig {
  agent?: { name?: string; role?: string; template?: string };
  operator?: { name?: string };
  channels?: {
    telegram?: { enabled?: boolean };
    vapi?: { enabled?: boolean };
    gateway?: { enabled?: boolean; port?: number };
  };
}

export function readAgentConfigRaw(slug: string): RawConfig | null {
  const cfgPath = join(agentRoot(slug), 'config.yaml');
  if (!existsSync(cfgPath)) return null;
  try {
    return (parseYaml(readFileSync(cfgPath, 'utf8')) ?? {}) as RawConfig;
  } catch {
    return null;
  }
}

const FEATURED_SKILLS = ['web-search', 'github', 'google'];

export async function summarizeAgent(slug: string): Promise<AgentSummary | null> {
  const cfg = readAgentConfigRaw(slug);
  if (!cfg) return null;
  const skillsDir = join(agentRoot(slug), 'SKILLS');
  let skills: string[] = [];
  if (existsSync(skillsDir)) {
    try {
      skills = readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && FEATURED_SKILLS.includes(d.name))
        .map((d) => d.name);
    } catch {
      /* unreadable SKILLS dir — show none */
    }
  }
  return {
    slug,
    name: cfg.agent?.name ?? slug,
    role: cfg.agent?.role ?? 'assistant',
    template: cfg.agent?.template,
    operatorName: cfg.operator?.name,
    port: cfg.channels?.gateway?.port,
    channels: {
      telegram: Boolean(cfg.channels?.telegram?.enabled),
      voice: Boolean(cfg.channels?.vapi?.enabled),
    },
    skills,
    gateway: await gatewayStatus(slug),
  };
}

export async function listAgentSummaries(): Promise<AgentSummary[]> {
  const home = meridianHome();
  if (!existsSync(home)) return [];
  const slugs = readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.includes('__'))
    .map((d) => d.name);
  const out: AgentSummary[] = [];
  for (const slug of slugs) {
    const summary = await summarizeAgent(slug);
    if (summary) out.push(summary);
  }
  return out;
}
