/**
 * Build bridge — runs under the meridian repo's tsx (cwd: repo root), NOT
 * inside Next.js. It drives the runtime's own scaffolding so a builder agent
 * is a 100% standard Meridian agent:
 *
 *   - initAgent()            seven-layer home, config.yaml, embedded .env,
 *                            skeleton + bundled skills (src/cli/init-cmd.ts)
 *   - composeIdentity()      canonical IDENTITY/AGENT.md (src/cli/init-guided.ts)
 *   - applyOperatorToConfig  operator block (src/cli/init-guided.ts)
 *   - loadAgentConfig/save   typed (zod-validated) config edits
 *
 * The CONTEXT files (USER.md, strategy.md, principles.md) are written in the
 * exact formats `meridian onboard` produces — this script is that interview,
 * answered by the wizard instead of a terminal.
 *
 * Memory-poisoning defense and verification live in the runtime and stay on
 * by default; nothing here touches them.
 *
 * Input:  argv[2] = base64(JSON BuildSpec)
 * Output: last stdout line = __BUILDER_RESULT__{json}
 */

import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initAgent } from '../../../src/cli/init-cmd.js';
import { applyOperatorToConfig, composeIdentity } from '../../../src/cli/init-guided.js';
import { ensureAgentHome, loadAgentConfig, saveAgentConfig } from '../../../src/config/home.js';

interface BridgeSpec {
  slug: string;
  agentName: string;
  personaKey: string;
  personaRole: string;
  personaIdentity: string;
  personaRules: string[];
  operatorName: string;
  addressAs?: string;
  audience?: string;
  mission: string;
  tone: string;
  remember?: string;
  neverShare: string[];
  channels: { telegram: boolean; voice: boolean };
  skills: { webSearch: boolean; github: boolean; google: boolean };
  models: { primary: string; fallbacks: string[]; cheapModel: string };
  voicePersona: string;
  gatewayPort: number;
  envAdditions: Record<string, string>;
}

function writeUserMd(identityDir: string, spec: BridgeSpec): void {
  const first = spec.operatorName.split(/\s+/)[0] || '';
  const body = `# Operator profile

The operator I work for is **${spec.operatorName || '(unspecified)'}**.

Address them as: ${spec.addressAs || first || '(unspecified)'}.

${spec.audience ? `Who I serve day to day: ${spec.audience}\n` : ''}
This file is the canonical record of who the operator is. Keep it short
and accurate. Anything richer (relationships, context, history) lives in
CONTEXT/.
`;
  writeFileSync(join(identityDir, 'USER.md'), body);
}

function writeStrategyMd(contextDir: string, spec: BridgeSpec): void {
  const body = `# Mission

${spec.mission || '(unspecified — onboarding skipped this question)'}
${spec.audience ? `\nWho this serves: ${spec.audience}\n` : ''}
This is the load-bearing reason I exist for this operator. Decisions
about what to do proactively, what to surface, and what to deprioritize
all flow through this.
`;
  writeFileSync(join(contextDir, 'strategy.md'), body);
}

function writePrinciplesMd(contextDir: string, spec: BridgeSpec): void {
  const body = `# Operating principles

${spec.remember ? `## What the operator wants me to know and remember\n\n${spec.remember}\n` : ''}
${
  spec.neverShare.length
    ? `\n## Sacred topics (never share over voice or external channels)\n\n${spec.neverShare.map((t) => `- ${t}`).join('\n')}\n`
    : ''
}
`;
  writeFileSync(join(contextDir, 'principles.md'), body);
}

async function main(): Promise<void> {
  const spec = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')) as BridgeSpec;

  // 1. Real init: seven layers, embedded zero-config .env, bundled skills.
  //    guided:false keeps it non-interactive; the wizard IS the guided intake.
  await initAgent(spec.slug, { guided: false, embedded: true });
  const home = ensureAgentHome(spec.slug);

  // 2. Canonical identity via the runtime's own composer, plus the persona
  //    appendix the wizard selected.
  const answers = {
    agentName: spec.agentName,
    oneLiner: spec.mission,
    operatorName: spec.operatorName,
    operatorEmail: undefined,
    operatorTelegram: undefined,
    operatorVoice: undefined,
    tone: spec.tone,
    rules: spec.personaRules,
  };
  const identity = `${composeIdentity(spec.slug, answers)}
## How I approach this role

${spec.personaIdentity}
${spec.audience ? `\nThe people I serve: ${spec.audience}\n` : ''}`;
  writeFileSync(join(home.layer('IDENTITY'), 'AGENT.md'), identity);

  // 3. Operator block in config.yaml (same path guided init uses).
  applyOperatorToConfig(home, answers);

  // 4. Onboard-format context files.
  writeUserMd(home.layer('IDENTITY'), spec);
  writeStrategyMd(home.layer('CONTEXT'), spec);
  writePrinciplesMd(home.layer('CONTEXT'), spec);

  // 5. Typed config: name/role/template, working model chain, channels, port,
  //    sacred topics. Everything passes through the zod schema on load+save.
  const config = loadAgentConfig(home);
  config.agent.name = spec.agentName;
  config.agent.role = spec.personaRole;
  config.agent.template = spec.personaKey;
  config.models.primary = spec.models.primary;
  config.models.fallbacks = spec.models.fallbacks;
  config.models.smartRouting.cheapModel = spec.models.cheapModel;
  config.channels.gateway = { enabled: true, port: spec.gatewayPort };
  config.channels.telegram.enabled = spec.channels.telegram;
  config.channels.vapi.enabled = spec.channels.voice;
  config.channels.vapi.voicePersona = spec.voicePersona as typeof config.channels.vapi.voicePersona;
  if (spec.neverShare.length > 0) {
    config.operator = config.operator ?? {
      id: 'primary',
      channels: { telegram: [], voice: [], cli: [] },
    };
    config.operator.sensitivity = {
      sacredTopics: spec.neverShare,
      sacredPatterns: [],
      refusal: undefined,
    };
  }
  saveAgentConfig(home, config);

  // 6. Featured skill cards map to the bundled skill dirs init copied in;
  //    unselected ones are removed from THIS agent's home (skeleton untouched).
  const skillChoice: Record<string, boolean> = {
    'web-search': spec.skills.webSearch,
    github: spec.skills.github,
    google: spec.skills.google,
  };
  for (const [name, keep] of Object.entries(skillChoice)) {
    const dir = join(home.layer('SKILLS'), name);
    if (!keep && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  // 7. The embedded .env template ships empty placeholders (`KEY=`); dotenv
  //    exports those as empty strings, which fail AgentEnvSchema's min-length
  //    checks (e.g. OPENROUTER_API_KEY min 20) and kill the gateway at boot.
  //    Comment the empty ones out — same zero-config semantics, valid env.
  let env = readFileSync(home.envPath, 'utf8');
  env = env.replace(/^([A-Z0-9_]+)=$/gm, '# $1=');

  //    Provider key (pasted in the wizard, or copied from the builder's env)
  //    goes into the agent's own .env — the runtime's per-agent key location —
  //    so `meridian gateway` works outside the builder too.
  for (const [key, value] of Object.entries(spec.envAdditions)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
  }
  writeFileSync(home.envPath, env);

  console.log(
    `__BUILDER_RESULT__${JSON.stringify({
      ok: true,
      slug: spec.slug,
      name: spec.agentName,
      agentRoot: home.agentRoot,
      port: spec.gatewayPort,
    })}`,
  );
}

main().catch((err) => {
  console.log(
    `__BUILDER_RESULT__${JSON.stringify({ ok: false, error: (err as Error).message })}`,
  );
  process.exit(1);
});
