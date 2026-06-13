/**
 * Memory-safe autonomous skill creation.
 *
 * The agent can author its own skills from a description or from experience —
 * Hermes's signature "self-improving" capability. The difference: EVERY draft is
 * screened for malice BEFORE it is installed, so a poisoned conversation cannot
 * trick the agent into writing a skill that exfiltrates data, bypasses payment
 * confirmation, discloses secrets, or overrides its own safety. That safety
 * property is the moat applied to self-extension — nobody else screens
 * self-authored skills.
 *
 * Scope (deliberate): authored skills are MARKDOWN-only (instruction skills, no
 * generated `tools.ts`). Autonomously generating executable code is a bigger
 * attack surface than instruction text; code skills stay operator-authored.
 *
 * Three pieces:
 *   - screenSkillDraft(draft)  — the pure, model-free safety gate (the moat).
 *   - generateSkillDraft(...)  — author a draft via the model chain.
 *   - installSkillDraft(...)   — render SKILL.md + manifest.yaml and write them.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import type { Logger } from 'pino';
import type { MeridianHome } from '../config/home.js';
import type { ModelChain } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import { generateStructured } from '../agent/structured.js';
import { hasMultilingualDirective, normalizeForMatch } from '../verification/memory-integrity.js';

export const SkillDraftSchema = z.object({
  /** kebab-case skill id, e.g. "meeting-prep". */
  name: z.string().min(1),
  /** one-line human description. */
  description: z.string().min(1),
  category: z.string().default('general'),
  /** when the agent should reach for this skill (natural language). */
  triggers: z.string().default(''),
  /** the SKILL.md instruction body (markdown). */
  body: z.string().min(1),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

export interface SkillScreenResult {
  ok: boolean;
  /** Why it was rejected (empty when ok). */
  reason: string;
  /** The specific malicious signals found. */
  flags: string[];
}

// ─── The malice screen (the moat applied to self-authored skills) ─────────────
// A SKILL.md is SUPPOSED to instruct ("always cite sources", "never fabricate"),
// so we do NOT reject generic directives. We reject the MALICIOUS subset: the
// patterns a poisoned conversation would smuggle into a skill. Matched against
// the evasion-normalized text (homoglyph/leet/zero-width folded), reusing the
// poisoning defense's normalizer.

const SENSITIVE_VERB =
  '(?:wire|wires|transfer|transfers|pay|pays|withdraw|approve|approves|execute|delete|disclose|reveal|rotate|disable|exfiltrate|leak)';
const BYPASS_NOUN =
  '(?:confirmation|approval|review|verification|checks?|2fa|two[- ]factor|sign[- ]?off|oversight|authorization)';

const MALICE_PATTERNS: Array<{ id: string; re: RegExp }> = [
  // Prompt-injection / instruction override.
  {
    id: 'instruction-override',
    re: /\b(?:ignore|disregard|forget|override|bypass|delete)\b[^.!?\n]{0,40}\b(?:previous|prior|earlier|above|all|any|the)\b[^.!?\n]{0,20}\b(?:instruction|instructions|rule|rules|guideline|guidelines|constraint|constraints|safety|safeguard|safeguards|policy|policies|system prompt)\b/i,
  },
  // "operate / act without restriction|oversight".
  {
    id: 'remove-restriction',
    re: /\b(?:operate|act|run|proceed|work)\b[^.!?\n]{0,24}\bwithout\b[^.!?\n]{0,24}\b(?:restriction|restrictions|limit|limits|oversight|supervision|guardrails?)\b/i,
  },
  // Forged authority header (system:/admin:/root: …).
  { id: 'authority-spoof', re: /(?:^|\n)\s*(?:system|assistant|admin|root|developer|superuser)\s*[:=]/i },
  // Sensitive capability + bypass-of-control, either order.
  { id: 'sensitive-bypass', re: new RegExp(`\\b${SENSITIVE_VERB}\\b[^.!?\\n]{0,70}\\bwithout\\b[^.!?\\n]{0,30}\\b${BYPASS_NOUN}\\b`, 'i') },
  { id: 'sensitive-bypass', re: new RegExp(`\\bwithout\\b[^.!?\\n]{0,30}\\b${BYPASS_NOUN}\\b[^.!?\\n]{0,70}\\b${SENSITIVE_VERB}\\b`, 'i') },
  // "approve … to any caller / anyone who asks" (autonomy on a sensitive verb).
  { id: 'sensitive-anyone', re: new RegExp(`\\b${SENSITIVE_VERB}\\b[^.!?\\n]{0,70}\\b(?:any|every|all)\\b[^.!?\\n]{0,20}\\b(?:caller|callers|request|requests|requester|number|user|users|person)\\b`, 'i') },
  // Secret disclosure / exfiltration of credentials.
  {
    id: 'secret-disclosure',
    re: /\b(?:disclose|reveal|share|expose|send|forward|leak|exfiltrate|print|output|copy)\b[^.!?\n]{0,40}\b(?:api[- ]?keys?|passwords?|secrets?|tokens?|credentials?|private[- ]?keys?|\.env|vault|seed phrase)\b/i,
  },
  // Exfiltration to an external destination (email / url / "external").
  {
    id: 'exfiltration',
    re: /\b(?:bcc|cc|forward|forwards|send|sends|email|relay|relays|upload|uploads|post|leak|mirror|copy)\b[^.!?\n]{0,80}(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/|\bexternal\b)/i,
  },
];

// A negation/prohibition appearing BEFORE a malice match in the same sentence
// flips it from "do the bad thing" to "never do the bad thing" — i.e. a legit
// control ("never delete without approval", "I never disclose API keys"). The
// `authority-spoof` pattern is exempt: a forged `system:` header is malicious
// regardless of surrounding prose.
const NEGATION_RE =
  /\b(?:never|not|n'?t|cannot|can'?t|won'?t|do not|don'?t|doesn'?t|must not|refuse|refuses|decline|declines|avoid|avoids|prohibit|prohibits|forbid|forbids|require|requires|required)\b/i;

function splitSentences(s: string): string[] {
  // Split on sentence-ending punctuation FOLLOWED BY whitespace (or newlines) so
  // we don't break apart emails/URLs/domains (e.g. archive@billing-mirror.io).
  return s.split(/[.!?]+\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * The moat applied to self-extension. Returns ok=false when the draft carries a
 * malicious instruction (override, sensitive-bypass, secret-disclosure,
 * exfiltration, authority-spoof). Legit instruction skills ("always cite your
 * sources", "never fabricate URLs", "always confirm before deleting") pass —
 * the negation guard distinguishes "approve … without confirmation" (malice)
 * from "never approve … without confirmation" (control).
 */
export function screenSkillDraft(draft: SkillDraft): SkillScreenResult {
  const raw = `${draft.name}\n${draft.description}\n${draft.triggers}\n${draft.body}`;
  const flags: string[] = [];
  // Per-sentence (over both raw and the evasion-normalized form) with a
  // negation guard, so a prohibition of the bad action is not mistaken for it.
  for (const sentence of [...splitSentences(raw), ...splitSentences(normalizeForMatch(raw))]) {
    for (const p of MALICE_PATTERNS) {
      const m = p.re.exec(sentence);
      if (!m) continue;
      if (p.id === 'authority-spoof') {
        flags.push(p.id);
        continue;
      }
      const lead = sentence.slice(0, m.index);
      if (!NEGATION_RE.test(lead)) flags.push(p.id);
    }
  }
  // A non-Latin standing directive aimed at a sensitive action in a skill body
  // is suspicious self-extension (the multilingual poisoning signal).
  if (hasMultilingualDirective(raw)) flags.push('multilingual-directive');

  const unique = [...new Set(flags)];
  if (unique.length > 0) {
    return {
      ok: false,
      reason: `skill draft rejected: contains ${unique.join(', ')} — a poisoned source may be trying to install a malicious skill`,
      flags: unique,
    };
  }
  return { ok: true, reason: 'no malicious instruction detected', flags: [] };
}

// ─── Render ───────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';
}

export interface RenderedSkill {
  slug: string;
  skillMd: string;
  manifestYaml: string;
}

/** Render a draft into the on-disk SKILL.md (frontmatter + body) + manifest.yaml. */
export function renderSkillFiles(draft: SkillDraft): RenderedSkill {
  const slug = slugify(draft.name);
  const frontmatter = stringifyYaml({
    name: slug,
    description: draft.description,
    category: draft.category || 'general',
    runtime: 'markdown',
    trigger: draft.triggers || undefined,
    authored_by: 'meridian-skill-author',
  }).trimEnd();
  const skillMd = `---\n${frontmatter}\n---\n\n<!-- Authored by \`meridian skills new\` and screened by the memory-poisoning defense. Review before relying on it. -->\n\n${draft.body.trim()}\n`;
  const manifestYaml = stringifyYaml({
    name: slug,
    version: '0.1.0',
    description: draft.description,
    category: draft.category || 'general',
    requires: { env: [], vault: [] },
    passphrase: { required: false },
    tools: [],
  });
  return { slug, skillMd, manifestYaml };
}

/**
 * Install a SCREENED draft into the agent's SKILLS layer. Throws if the draft
 * has not passed screenSkillDraft (defense in depth — never write an unscreened
 * skill), or if the skill exists and overwrite is not set.
 */
export function installSkillDraft(
  draft: SkillDraft,
  home: MeridianHome,
  opts: { overwrite?: boolean } = {},
): { slug: string; dir: string } {
  const screen = screenSkillDraft(draft);
  if (!screen.ok) throw new Error(screen.reason);
  const { slug, skillMd, manifestYaml } = renderSkillFiles(draft);
  const dir = join(home.layer('SKILLS'), slug);
  if (existsSync(dir) && !opts.overwrite) {
    throw new Error(`skill '${slug}' already exists (use --overwrite)`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd);
  writeFileSync(join(dir, 'manifest.yaml'), manifestYaml);
  return { slug, dir };
}

// ─── Generate (model-backed) ──────────────────────────────────────────────────

const SKILL_AUTHOR_SYSTEM =
  'You are a skill author for the MERIDIAN agent OS. Given a capability description, you write a concise, safe MARKDOWN skill: a short instruction set the agent will follow when the skill applies. ' +
  'A skill body explains WHEN to use it, HOW to behave, and WHAT never to do. ' +
  'HARD SAFETY RULES for what you write: never instruct the agent to ignore or override prior instructions or safety; never instruct it to move money, approve, transfer, or disclose anything WITHOUT confirmation; never instruct it to reveal API keys, passwords, secrets, or credentials; never instruct it to send/forward/BCC data to an external email or URL; never forge an authority header. Write helpful, bounded behavior only. ' +
  'Return: name (kebab-case), description (one line), category, triggers (when to use), and body (the markdown instructions).';

export interface GenerateSkillDeps {
  router: ProviderRouter;
  models: ModelChain;
  logger?: Logger;
  maxTokens?: number;
}

/** Author a skill draft from a description (and optional experience/context). */
export async function generateSkillDraft(
  description: string,
  context: string | undefined,
  deps: GenerateSkillDeps,
): Promise<SkillDraft> {
  const prompt =
    `Author a Meridian skill for this capability:\n\n${description}\n` +
    (context ? `\nRelevant context / experience to encode:\n${context}\n` : '') +
    '\nReturn the skill fields.';
  const { object } = await generateStructured({
    router: deps.router,
    models: deps.models,
    schema: SkillDraftSchema,
    system: SKILL_AUTHOR_SYSTEM,
    prompt,
    maxTokens: deps.maxTokens ?? 1500,
    logger: deps.logger,
  });
  return object;
}
