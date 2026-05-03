/**
 * Verification runtime. Runs per-skill checks after every output.
 * Block severity fails the turn (caller retries). Warn severity flags
 * for the audit retrospective.
 *
 * Per AIDB: without this layer, the AgentOS has 8-week shelf life.
 * With it, the OS compounds forever. So this is non-optional.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { MeridianHome } from '../config/home.js';
import { VerificationCheckSchema, type VerificationCheck } from '../config/schema.js';

export interface CheckResult {
  name: string;
  passed: boolean;
  severity: 'block' | 'warn';
  note?: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

export function loadChecks(home: MeridianHome): VerificationCheck[] {
  const dir = home.layer('VERIFICATION');
  if (!existsSync(dir)) return [];
  const out: VerificationCheck[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.checks.md')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const m = FRONTMATTER_RE.exec(text);
    if (!m) continue;
    try {
      const data = parseYaml(m[1]) as { checks?: unknown[] };
      if (!Array.isArray(data.checks)) continue;
      for (const c of data.checks) {
        const parsed = VerificationCheckSchema.safeParse(c);
        if (parsed.success) out.push(parsed.data);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface VerificationContext {
  output: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
  systemPolicy?: string;
}

const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b\d{16}\b/, // CC
  /\b(?:\d{3})\D?\d{3}\D?\d{4}\b/, // phone
];

const FACTUAL_HEDGES = /\b(maybe|i think|probably|might|could be|likely)\b/i;

export function runChecks(checks: VerificationCheck[], ctx: VerificationContext): CheckResult[] {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (check.trigger === 'on_tool_use' && (!ctx.toolCalls || ctx.toolCalls.length === 0)) continue;
    let passed = true;
    let note: string | undefined;

    switch (check.helper) {
      case 'pii_redaction': {
        for (const re of PII_PATTERNS) {
          if (re.test(ctx.output)) {
            passed = false;
            note = `PII pattern detected: ${re.source}`;
            break;
          }
        }
        break;
      }
      case 'tone_match': {
        const required = (check.config?.required_tone as string | undefined) ?? '';
        if (required && !ctx.output.toLowerCase().includes(required.toLowerCase())) {
          passed = false;
          note = `Tone marker '${required}' not present`;
        }
        break;
      }
      case 'factual_check': {
        if (FACTUAL_HEDGES.test(ctx.output)) {
          passed = false;
          note = 'Output contains factual hedges; review before sending';
        }
        break;
      }
      case 'numeric_validation': {
        const requiredNumbers = (check.config?.must_contain_numbers as boolean | undefined) ?? false;
        if (requiredNumbers && !/\d/.test(ctx.output)) {
          passed = false;
          note = 'Expected numeric content not found';
        }
        break;
      }
      case 'policy_compliance': {
        if (ctx.systemPolicy) {
          const banned = (check.config?.banned_phrases as string[] | undefined) ?? [];
          for (const phrase of banned) {
            if (ctx.output.toLowerCase().includes(phrase.toLowerCase())) {
              passed = false;
              note = `Banned phrase: '${phrase}'`;
              break;
            }
          }
        }
        break;
      }
      case 'custom': {
        // Reserved: shell out to a custom check script. v0.1 stubs this as pass.
        passed = true;
        break;
      }
    }

    results.push({ name: check.name, passed, severity: check.severity, note });
  }
  return results;
}

export function blocking(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => !r.passed && r.severity === 'block');
}
