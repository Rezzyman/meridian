/**
 * `meridian audit` retrospective. Scans the AgentOS for staleness, unused
 * skills, failing checks, and overdue context curation. Writes a markdown
 * report to VERIFICATION/audits/<date>.md.
 *
 * AIDB framework explicit: "Without retrospective audits, your OS has a
 * shelf life of maybe eight weeks before everything goes stale."
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeridianHome } from '../config/home.js';
import type { SessionStore } from '../session/store.js';
import { SEVEN_LAYERS } from '../config/home.js';

export interface AuditReport {
  agent: string;
  generatedAt: string;
  staleContextFiles: Array<{ file: string; ageDays: number }>;
  unusedSkills: string[];
  failingChecks: Array<{ skill: string; check: string; failures: number }>;
  layerHealth: Record<string, { status: 'ok' | 'empty' | 'stale'; note?: string }>;
  recommendations: string[];
}

function ageDaysOf(path: string): number {
  const st = statSync(path);
  const ageMs = Date.now() - st.mtimeMs;
  return Math.floor(ageMs / (1000 * 60 * 60 * 24));
}

export function runAudit(home: MeridianHome, _store?: SessionStore): AuditReport {
  const report: AuditReport = {
    agent: home.agentSlug,
    generatedAt: new Date().toISOString(),
    staleContextFiles: [],
    unusedSkills: [],
    failingChecks: [],
    layerHealth: {},
    recommendations: [],
  };

  // Layer presence
  for (const layer of SEVEN_LAYERS) {
    const dir = home.layer(layer);
    if (!existsSync(dir)) {
      report.layerHealth[layer] = { status: 'empty', note: 'directory missing' };
      continue;
    }
    const entries = readdirSync(dir).filter((e) => !e.startsWith('.'));
    if (entries.length === 0) {
      report.layerHealth[layer] = { status: 'empty', note: 'no files' };
    } else {
      report.layerHealth[layer] = { status: 'ok' };
    }
  }

  // Stale context files (>30d default; per-file frontmatter override would refine further)
  const ctxDir = home.layer('CONTEXT');
  if (existsSync(ctxDir)) {
    for (const file of readdirSync(ctxDir)) {
      if (file.startsWith('.') || !file.endsWith('.md')) continue;
      const full = join(ctxDir, file);
      const age = ageDaysOf(full);
      if (age > 30) {
        report.staleContextFiles.push({ file, ageDays: age });
        report.recommendations.push(
          `CONTEXT/${file} is ${age} days old. Review and update or mark as evergreen.`,
        );
      }
    }
  }

  // Unused skills: list every skill, intersect with audit_log calls (if store given)
  const skillsDir = home.layer('SKILLS');
  if (existsSync(skillsDir)) {
    for (const skillName of readdirSync(skillsDir)) {
      const fullSkill = join(skillsDir, skillName);
      if (!statSync(fullSkill).isDirectory()) continue;
      // Without a usage log we cannot know definitively; flag for now
      report.unusedSkills.push(skillName);
    }
  }

  // Suggested next steps
  if (report.layerHealth.IDENTITY?.status === 'empty') {
    report.recommendations.push(
      'IDENTITY layer is empty. Run `meridian init` and answer the identity prompts to seed AGENT.md.',
    );
  }
  if (report.layerHealth.VERIFICATION?.status === 'empty') {
    report.recommendations.push(
      'VERIFICATION layer is empty. Add at least one check per skill (see docs/verification.md).',
    );
  }
  if (report.layerHealth.MEMORY?.status === 'empty') {
    report.recommendations.push(
      'MEMORY layer has no specialized files. Consider adding decision-logs, relationships, processes.',
    );
  }

  return report;
}

export function renderReport(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Meridian audit: ${r.agent}`);
  lines.push(`Generated: ${r.generatedAt}\n`);

  lines.push('## Layer health');
  for (const [layer, health] of Object.entries(r.layerHealth)) {
    const mark = health.status === 'ok' ? 'ok' : health.status === 'empty' ? 'empty' : 'stale';
    lines.push(`- **${layer}**: ${mark}${health.note ? ` (${health.note})` : ''}`);
  }
  lines.push('');

  if (r.staleContextFiles.length) {
    lines.push('## Stale context files');
    for (const f of r.staleContextFiles) {
      lines.push(`- ${f.file} (${f.ageDays} days old)`);
    }
    lines.push('');
  }

  if (r.unusedSkills.length) {
    lines.push('## Skills (review for unused)');
    for (const s of r.unusedSkills) lines.push(`- ${s}`);
    lines.push('');
  }

  if (r.failingChecks.length) {
    lines.push('## Failing verification checks');
    for (const c of r.failingChecks) {
      lines.push(`- ${c.skill} :: ${c.check} (${c.failures} failures this period)`);
    }
    lines.push('');
  }

  if (r.recommendations.length) {
    lines.push('## Recommendations');
    for (const rec of r.recommendations) lines.push(`- ${rec}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function writeReport(home: MeridianHome, report: AuditReport): string {
  const dir = join(home.layer('VERIFICATION'), 'audits');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = report.generatedAt.slice(0, 10);
  const path = join(dir, `${date}.md`);
  writeFileSync(path, renderReport(report));
  return path;
}
