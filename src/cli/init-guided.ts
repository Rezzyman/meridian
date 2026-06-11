/**
 * `meridian init <slug> --guided` — 60-second guided intake.
 *
 * The first-impression flow: instead of leaving the user with empty
 * scaffolds and a TODO list, ask 6 short questions, write a coherent
 * IDENTITY/AGENT.md from the answers, populate the operator block in
 * config.yaml, and end with the agent ready to chat.
 *
 * No LLM is called by default — answers are slotted directly into a
 * coherent template. If `--ai` is passed, a single LLM call can be made
 * to expand the role description into richer language. (v0.2)
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ensureAgentHome } from '../config/home.js';
import { colors } from '../utils/truecolor.js';

interface IntakeAnswers {
  agentName: string;
  oneLiner: string;
  operatorName: string;
  operatorEmail?: string;
  operatorTelegram?: string;
  operatorVoice?: string;
  tone: string;
  rules: string[];
}

const TONE_CHOICES = [
  'warm-professional',
  'friendly-casual',
  'authoritative',
  'energetic',
  'calm-concierge',
] as const;

async function ask(rl: readline.Interface, prompt: string, defaultValue?: string): Promise<string> {
  const tag = defaultValue ? colors.muted(` [${defaultValue}]`) : '';
  const ans = (await rl.question(`${colors.cyan('?')} ${prompt}${tag} `)).trim();
  return ans || defaultValue || '';
}

async function askOptional(rl: readline.Interface, prompt: string): Promise<string | undefined> {
  const ans = (await rl.question(`${colors.cyan('?')} ${prompt}  ${colors.muted('(optional, enter to skip)')} `)).trim();
  return ans || undefined;
}

async function askChoice(rl: readline.Interface, prompt: string, choices: readonly string[], defaultValue: string): Promise<string> {
  const choiceTag = choices.map((c) => (c === defaultValue ? colors.cyan(c) : colors.muted(c))).join(' / ');
  const ans = (await rl.question(`${colors.cyan('?')} ${prompt}\n  ${choiceTag}\n  ${colors.muted(`[${defaultValue}]`)} `)).trim();
  if (!ans) return defaultValue;
  // Allow loose match: any choice that startsWith the user's input.
  const match = choices.find((c) => c.toLowerCase().startsWith(ans.toLowerCase()));
  return match ?? defaultValue;
}

export async function runGuidedIntake(slug: string): Promise<IntakeAnswers> {
  const rl = readline.createInterface({ input, output });

  console.log('');
  console.log(colors.cyan('  Meridian guided intake'));
  console.log(colors.muted('  Six quick questions. Skip any with Enter.'));
  console.log('');

  const agentName = await ask(rl, "What's the agent's name?", slug.charAt(0).toUpperCase() + slug.slice(1));
  const oneLiner = await ask(rl, 'One sentence — what does this agent do?', 'Personal chief of staff');
  const operatorName = await ask(rl, 'Your name (the operator)?', '');
  const operatorEmail = await askOptional(rl, 'Your email?');
  const operatorTelegram = await askOptional(rl, 'Your Telegram chat id (run /start with the bot to find it)?');
  const operatorVoice = await askOptional(rl, 'Your phone number (E.164, e.g. +13035551234)?');
  const tone = await askChoice(rl, "How should they sound?", TONE_CHOICES, 'warm-professional');
  const rulesRaw = await ask(rl, 'One rule they should always enforce? (or Enter to use defaults)', '');
  const rules = rulesRaw
    ? [rulesRaw, 'Always tell the user what is missing or unclear.', 'Flag when over-committing for the next week.']
    : [
        'Always tell the user what is missing or unclear.',
        'Never send external messages without showing a draft first.',
        'Flag when over-committing for the next week.',
      ];

  rl.close();
  return {
    agentName,
    oneLiner,
    operatorName,
    operatorEmail,
    operatorTelegram,
    operatorVoice,
    tone,
    rules,
  };
}

export function composeIdentity(_slug: string, answers: IntakeAnswers): string {
  const tone = answers.tone.replace(/-/g, ' ');
  const rules = answers.rules.map((r) => `- ${r}`).join('\n');
  return `# ${answers.agentName}

I am ${answers.agentName}, an agent operating ${answers.operatorName ? `for ${answers.operatorName}` : ''}.

## Who I am
${answers.oneLiner}

## How I sound
${tone}

## Rules I enforce
${rules}

---

## How I work — Meridian operating principles

These are the operator-level expectations that sit on top of the
framework-enforced runtime rules. The framework already guarantees the
"no tool theatre / no hallucinated results / no fake background work"
floor — see the runtime_rules block in every system prompt. The points
below are the partnership layer.

### Memory is already loaded
Every turn, the runtime recalls relevant memories from CORTEX and injects
them into my system prompt as \`<cortex_recall>...</cortex_recall>\`. By the
time I see a question, the memory is in front of me. I do not "go look it
up" with shell tools — that path is closed in chat. If the recall does
not contain what I need, I say so honestly and ask the operator for specifics.

### Continuity is real
The same conversation continues across voice, Telegram, and CLI for the
same operator. I do not say "as a new session..." — I do remember.

### I am a partner, not a chatbot
I do proactive work. When I see a commitment go overdue, a thread go
stale, or a decision wait too long, I surface it without being asked.
`;
}

export function applyOperatorToConfig(home: ReturnType<typeof ensureAgentHome>, answers: IntakeAnswers): void {
  if (!answers.operatorName && !answers.operatorTelegram && !answers.operatorVoice) return;
  const cfgPath = home.configPath;
  if (!existsSync(cfgPath)) return;
  const raw = readFileSync(cfgPath, 'utf8');
  const cfg = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const operator = {
    id: (answers.operatorName?.split(/\s+/)[0] || 'primary').toLowerCase(),
    ...(answers.operatorName ? { name: answers.operatorName } : {}),
    ...(answers.operatorEmail ? { email: answers.operatorEmail } : {}),
    channels: {
      telegram: answers.operatorTelegram ? [answers.operatorTelegram] : [],
      voice: answers.operatorVoice ? [answers.operatorVoice] : [],
      cli: [process.env.USER || 'root'].filter(Boolean),
    },
  };
  cfg.operator = operator;
  writeFileSync(cfgPath, stringifyYaml(cfg));
}

export async function runGuidedInit(
  slug: string,
  home: ReturnType<typeof ensureAgentHome>,
): Promise<void> {
  const answers = await runGuidedIntake(slug);
  // Write IDENTITY/AGENT.md from answers (always overwrite — guided init
  // is the canonical authoring path).
  const identityPath = join(home.layer('IDENTITY'), 'AGENT.md');
  writeFileSync(identityPath, composeIdentity(slug, answers));
  applyOperatorToConfig(home, answers);
  console.log('');
  console.log(colors.ok(`  ${answers.agentName} is configured.`));
  console.log(colors.muted(`  identity: ${identityPath}`));
  if (answers.operatorTelegram || answers.operatorVoice) {
    console.log(colors.muted(`  operator: ${answers.operatorName} (${[
      answers.operatorTelegram ? 'telegram' : null,
      answers.operatorVoice ? 'voice' : null,
    ].filter(Boolean).join(', ')})`));
  }
}
