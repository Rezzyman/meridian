/**
 * `meridian onboard` — extended interview that populates the seven-layer
 * CONTEXT files plus IDENTITY/USER.md beyond what the 60-second guided
 * init writes. Runs after `meridian init` when the operator is ready to
 * commit five minutes to richer setup.
 *
 * What this writes:
 *   IDENTITY/USER.md         — operator profile (name, role, address-as)
 *   CONTEXT/strategy.md      — mission and outcome the agent serves
 *   CONTEXT/stakeholders.md  — important people the agent should know
 *   CONTEXT/principles.md    — timezone, working hours, working principles
 *   config.yaml              — sacred-topic policy under operator.sensitivity
 *
 * v1.3 will add a `--voice` flag that triggers an outbound VAPI call so
 * the agent introduces itself by phone and runs the same interview
 * conversationally. That flag is not implemented in this commit.
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { activeAgentSlug, ensureAgentHome } from '../config/home.js';
import { colors } from '../utils/truecolor.js';

interface OnboardAnswers {
  operatorFullName: string;
  operatorAddressAs: string;
  operatorRole: string;
  mission: string;
  stakeholders: Array<{ name: string; relationship: string }>;
  timezone: string;
  workingHours: string;
  sacredTopics: string[];
  workingNotes: string;
}

async function ask(
  rl: readline.Interface,
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  const tag = defaultValue ? colors.muted(` [${defaultValue}]`) : '';
  const ans = (await rl.question(`${colors.cyan('?')} ${prompt}${tag} `)).trim();
  return ans || defaultValue || '';
}

async function askMulti(rl: readline.Interface, prompt: string, hint: string): Promise<string[]> {
  console.log(`${colors.cyan('?')} ${prompt}`);
  console.log(colors.muted(`  ${hint}`));
  const lines: string[] = [];
  while (true) {
    const line = (await rl.question('  > ')).trim();
    if (!line) break;
    lines.push(line);
  }
  return lines;
}

async function askStakeholders(
  rl: readline.Interface,
): Promise<Array<{ name: string; relationship: string }>> {
  console.log(`${colors.cyan('?')} Who are the most important people in your life I should know about?`);
  console.log(colors.muted('  Format: "Name — relationship". One per line. Blank to finish.'));
  console.log(colors.muted('  Example: Stormy Knight — co-founder'));
  const list: Array<{ name: string; relationship: string }> = [];
  while (true) {
    const line = (await rl.question('  > ')).trim();
    if (!line) break;
    const [name, ...rest] = line.split(/\s*[—-]\s*/);
    const relationship = rest.join(' — ').trim();
    if (!name) continue;
    list.push({ name: name.trim(), relationship: relationship || 'unspecified' });
  }
  return list;
}

async function runInterview(slug: string, defaults: { operatorName?: string }): Promise<OnboardAnswers> {
  const rl = readline.createInterface({ input, output });

  console.log('');
  console.log(colors.cyan(`  Meridian extended onboarding for "${slug}"`));
  console.log(colors.muted('  Roughly five minutes. Skip any question with Enter.'));
  console.log('');

  const operatorFullName = await ask(rl, 'Your full name?', defaults.operatorName);
  const firstName = operatorFullName.split(/\s+/)[0] || '';
  const operatorAddressAs = await ask(rl, 'How should I address you?', firstName);
  const operatorRole = await ask(rl, 'Your role or title?');
  const mission = await ask(rl, "In one sentence, what are you hoping I'll help you with?");
  const stakeholders = await askStakeholders(rl);
  const timezone = await ask(rl, 'Your timezone? (e.g. America/Denver)');
  const workingHours = await ask(rl, 'Typical working hours? (e.g. 9am-6pm Mon-Fri)');
  const sacredTopics = await askMulti(
    rl,
    'Topics I should never share publicly (voice/external channels)?',
    'One per line. Blank to finish. Examples: home address, family medical info.',
  );
  const workingNotes = await ask(
    rl,
    'Anything else I should know about how you work or what to avoid?',
  );

  rl.close();
  return {
    operatorFullName,
    operatorAddressAs,
    operatorRole,
    mission,
    stakeholders,
    timezone,
    workingHours,
    sacredTopics,
    workingNotes,
  };
}

type LayerName = 'IDENTITY' | 'CONTEXT' | 'SKILLS' | 'MEMORY' | 'CONNECTIONS' | 'VERIFICATION' | 'AUTOMATIONS';

function ensureLayer(home: ReturnType<typeof ensureAgentHome>, layer: LayerName): string {
  const dir = home.layer(layer);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeUserMd(home: ReturnType<typeof ensureAgentHome>, a: OnboardAnswers): string {
  const path = join(ensureLayer(home, 'IDENTITY'), 'USER.md');
  const body = `# Operator profile

The operator I work for is **${a.operatorFullName || '(unspecified)'}**.

Address them as: ${a.operatorAddressAs || a.operatorFullName.split(/\s+/)[0] || '(unspecified)'}.

${a.operatorRole ? `Role: ${a.operatorRole}\n` : ''}
This file is the canonical record of who the operator is. Keep it short
and accurate. Anything richer (relationships, context, history) lives in
CONTEXT/.
`;
  writeFileSync(path, body);
  return path;
}

function writeStrategyMd(home: ReturnType<typeof ensureAgentHome>, a: OnboardAnswers): string {
  const path = join(ensureLayer(home, 'CONTEXT'), 'strategy.md');
  const body = `# Mission

${a.mission || '(unspecified — onboarding skipped this question)'}

This is the load-bearing reason I exist for this operator. Decisions
about what to do proactively, what to surface, and what to deprioritize
all flow through this.
`;
  writeFileSync(path, body);
  return path;
}

function writeStakeholdersMd(
  home: ReturnType<typeof ensureAgentHome>,
  a: OnboardAnswers,
): string {
  const path = join(ensureLayer(home, 'CONTEXT'), 'stakeholders.md');
  const lines = a.stakeholders.length
    ? a.stakeholders.map((s) => `- **${s.name}** — ${s.relationship}`).join('\n')
    : '_(none provided during onboarding; add manually as the operator introduces them)_';
  const body = `# Stakeholders

People in the operator's life I should know about. When any of these
names appears in a conversation, the relationship below is the
load-bearing context.

${lines}
`;
  writeFileSync(path, body);
  return path;
}

function writePrinciplesMd(
  home: ReturnType<typeof ensureAgentHome>,
  a: OnboardAnswers,
): string {
  const path = join(ensureLayer(home, 'CONTEXT'), 'principles.md');
  const body = `# Operating principles

${a.timezone ? `Timezone: ${a.timezone}\n` : ''}
${a.workingHours ? `Working hours: ${a.workingHours}\n` : ''}
${a.workingNotes ? `\n## What the operator wants me to know\n\n${a.workingNotes}\n` : ''}
${
  a.sacredTopics.length
    ? `\n## Sacred topics (never share over voice or external channels)\n\n${a.sacredTopics.map((t) => `- ${t}`).join('\n')}\n`
    : ''
}
`;
  writeFileSync(path, body);
  return path;
}

function applySacredToConfig(
  home: ReturnType<typeof ensureAgentHome>,
  a: OnboardAnswers,
): void {
  if (a.sacredTopics.length === 0) return;
  if (!existsSync(home.configPath)) return;
  const cfg = (parseYaml(readFileSync(home.configPath, 'utf8')) ?? {}) as Record<
    string,
    unknown
  >;
  const operator = (cfg.operator as Record<string, unknown> | undefined) ?? {};
  operator.sensitivity = { sacredTopics: a.sacredTopics };
  cfg.operator = operator;
  writeFileSync(home.configPath, stringifyYaml(cfg));
}

export async function runOnboard(): Promise<void> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);

  // Pull operator name from existing config (init-guided populates it).
  let operatorName: string | undefined;
  if (existsSync(home.configPath)) {
    const cfg = (parseYaml(readFileSync(home.configPath, 'utf8')) ?? {}) as Record<
      string,
      unknown
    >;
    const op = cfg.operator as { name?: string } | undefined;
    operatorName = op?.name;
  }

  const answers = await runInterview(slug, { operatorName });

  const userPath = writeUserMd(home, answers);
  const strategyPath = writeStrategyMd(home, answers);
  const stakeholdersPath = writeStakeholdersMd(home, answers);
  const principlesPath = writePrinciplesMd(home, answers);
  applySacredToConfig(home, answers);

  console.log('');
  console.log(colors.ok(`  ${slug} onboarded.`));
  console.log(colors.muted(`  identity:    ${userPath}`));
  console.log(colors.muted(`  strategy:    ${strategyPath}`));
  console.log(colors.muted(`  stakeholders: ${stakeholdersPath}`));
  console.log(colors.muted(`  principles:  ${principlesPath}`));
  if (answers.sacredTopics.length) {
    console.log(colors.muted(`  sacred topics:  ${answers.sacredTopics.length} recorded under operator.sensitivity in config.yaml`));
  }
  console.log('');
  console.log(colors.muted('Restart the gateway (or REPL) so the new context files load on the next turn.'));
}
