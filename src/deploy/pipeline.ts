/**
 * The 20-minute deployment pipeline.
 * Driven by an intake JSON matching IntakeSchema. Wraps the developer flow
 * (init + .env + identity + context + first dream + channels up) into a
 * single command. The wizard UI in v0.2 calls this same function.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ensureAgentHome, setActiveAgent } from '../config/home.js';
import { IntakeSchema, defaultAgentConfig } from '../config/schema.js';
import type { Intake } from '../config/schema.js';
import { envFileTemplate } from '../config/loader.js';
import { bindCortex } from '../cortex/bind.js';
import { colors } from '../utils/truecolor.js';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export async function runDeploy(opts: { intake: string; allowWrite?: boolean }): Promise<void> {
  const started = Date.now();
  const json = JSON.parse(readFileSync(opts.intake, 'utf8')) as unknown;
  const intake: Intake = IntakeSchema.parse(json);
  const slug = slugify(intake.q3_agent_name);
  console.log(colors.cyan(`Deploying ${intake.q3_agent_name} (${slug}) for ${intake.q1_business_name}`));

  // Step 1: agent home
  const home = ensureAgentHome(slug);
  console.log(colors.ok(`  [1/8] home ready: ${home.agentRoot}`));

  // Step 2: config
  const config = defaultAgentConfig(slug, intake.q3_agent_name);
  config.agent.role = intake.q4_agent_role;
  config.agent.template = intake.q4_agent_role === 'chief_of_staff' ? 'chief_of_staff' : intake.q4_agent_role;
  if (intake.q5_phone_strategy !== 'no_voice') {
    config.channels.vapi.enabled = true;
    config.channels.vapi.voicePersona = intake.q6_voice_persona;
  }
  if (intake.q10_extra_channels.includes('telegram')) {
    config.channels.telegram.enabled = true;
  }
  config.channels.gateway.enabled = true;
  writeFileSync(home.configPath, stringifyYaml(config));
  console.log(colors.ok(`  [2/8] config.yaml written`));

  // Step 3: env template (operator fills in keys)
  if (!existsSync(home.envPath)) writeFileSync(home.envPath, envFileTemplate(slug));
  console.log(colors.ok(`  [3/8] .env template ready`));

  // Step 4: IDENTITY
  const identityMd = `# ${intake.q3_agent_name}

I am ${intake.q3_agent_name}, an agent operating for ${intake.q1_business_name}.

## What we do
${intake.q2_business_one_liner}

## My role
${intake.q4_agent_role.replace(/_/g, ' ')}

## How I sound
${intake.q6_voice_persona.replace(/_/g, ' ')}

## When I am available
${intake.q7_business_hours}

## Rules I enforce
- Never send external messages without an explicit operator confirmation in the first ${
    opts.allowWrite ? 7 : 30
  } days of operation.
- When the situation matches any of the handoff triggers, hand the conversation to ${
    intake.q9_handoff_human.name
  } at ${intake.q9_handoff_human.phone} (${intake.q9_handoff_human.email}).
`;
  writeFileSync(join(home.layer('IDENTITY'), 'AGENT.md'), identityMd);
  writeFileSync(
    join(home.layer('IDENTITY'), 'USER.md'),
    `# ${intake.q1_business_name}\n\nPrimary human: ${intake.q9_handoff_human.name}\n`,
  );
  console.log(colors.ok(`  [4/8] IDENTITY layer seeded`));

  // Step 5: CONTEXT seed
  writeFileSync(
    join(home.layer('CONTEXT'), 'business.md'),
    `---\ntitle: business\nowner: ${intake.q9_handoff_human.name}\nlastUpdated: ${new Date()
      .toISOString()
      .slice(0, 10)}\n---\n\n${intake.q8_knowledge_seed}\n`,
  );
  writeFileSync(
    join(home.layer('CONTEXT'), 'handoff.md'),
    `---\ntitle: handoff\nowner: system\nlastUpdated: ${new Date()
      .toISOString()
      .slice(0, 10)}\n---\n\n## When to hand off\n${intake.q9_handoff_human.triggers
      .map((t) => `- ${t}`)
      .join('\n')}\n\n## Where to send the conversation\n- ${intake.q9_handoff_human.name}\n- phone: ${
      intake.q9_handoff_human.phone
    }\n- email: ${intake.q9_handoff_human.email}\n`,
  );
  console.log(colors.ok(`  [5/8] CONTEXT layer seeded`));

  // Step 6: VERIFICATION default checks
  writeFileSync(
    join(home.layer('VERIFICATION'), 'default.checks.md'),
    `---\nchecks:\n  - name: pii_redaction\n    skill: any\n    helper: pii_redaction\n    severity: block\n  - name: factual_check\n    skill: any\n    helper: factual_check\n    severity: warn\n  - name: tone_match\n    skill: any\n    helper: tone_match\n    severity: warn\n    config:\n      required_tone: ${
      intake.q6_voice_persona.split('_')[0]
    }\n---\n\nDefault verification checks for the deployed agent.\n`,
  );
  console.log(colors.ok(`  [6/8] VERIFICATION layer seeded`));

  // Step 7: AUTOMATIONS defaults
  writeFileSync(
    join(home.layer('AUTOMATIONS'), 'dream-cycle.cron'),
    `---\nname: dream-cycle\nschedule: "0 2 * * *"\nmode: direct\nrequiresApproval: false\naudit: true\n---\n\nNightly CORTEX dream cycle (in-process).\n`,
  );
  writeFileSync(
    join(home.layer('AUTOMATIONS'), 'weekly-audit.cron'),
    `---\nname: weekly-audit\nschedule: "0 4 * * 0"\nmode: draft\nrequiresApproval: true\naudit: true\n---\n\nWeekly retrospective. Writes to VERIFICATION/audits/.\n`,
  );
  console.log(colors.ok(`  [7/8] AUTOMATIONS layer seeded`));

  // Step 8: first dream cycle (consolidate-only mode for speed)
  setActiveAgent(slug);
  try {
    const cortex = bindCortex(slug);
    const health = await cortex.health();
    if (health.status === 'ok') {
      await cortex.dream('consolidation_only');
      console.log(colors.ok(`  [8/8] first dream cycle complete`));
    } else {
      console.log(colors.warn(`  [8/8] CORTEX not reachable; first dream skipped, set NEON_DATABASE_URL`));
    }
  } catch (err) {
    console.log(colors.warn(`  [8/8] first dream skipped: ${(err as Error).message}`));
  }

  const elapsed = ((Date.now() - started) / 1000 / 60).toFixed(2);
  console.log('');
  console.log(colors.ok(`Meridian agent '${slug}' deployed in ${elapsed} min.`));
  console.log(colors.muted('Next:'));
  console.log(colors.muted(`  1. Fill ${home.envPath} with provider keys.`));
  console.log(colors.muted(`  2. \`meridian doctor\` to validate.`));
  console.log(colors.muted(`  3. \`meridian gateway\` to bring channels online.`));
}
