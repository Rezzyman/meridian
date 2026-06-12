/**
 * Build orchestrator: wizard submission → bridge spec → spawn the bridge
 * under the meridian repo's tsx → parse the result marker.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { allocatePort } from './gateway';
import { getPersona, toneToVoicePersona } from './personas';
import { meridianRepo, tsxBin } from './paths';
import { uniqueSlug } from './slug';
import { planFromKeyProvider, systemStatus } from './system';
import type { BuildResult, ModelPlan, WizardSubmission } from './types';

const ENV_KEY_NAME: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function runBridge(specB64: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const bridge = join(meridianRepo(), 'apps', 'agent-builder', 'bridge', 'build-agent.ts');
    const child = spawn(tsxBin(), [bridge, specB64], {
      cwd: meridianRepo(),
      env: { ...process.env, NODE_OPTIONS: '--no-deprecation' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('agent build timed out after 90s'));
    }, 90_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function buildAgent(submission: WizardSubmission): Promise<BuildResult> {
  const persona = getPersona(submission.personaKey);
  if (!persona) throw new Error(`unknown persona: ${submission.personaKey}`);
  const agentName = submission.agentName.trim() || persona.suggestedName;
  const operatorName = submission.operatorName.trim();
  const mission = submission.mission.trim() || persona.missionPlaceholder;

  // Model plan: pasted key wins; otherwise probe (ollama → env keys).
  let plan: ModelPlan | null = null;
  const envAdditions: Record<string, string> = {};
  if (submission.modelKey?.value) {
    plan = planFromKeyProvider(submission.modelKey.provider, true);
    envAdditions[ENV_KEY_NAME[submission.modelKey.provider]] = submission.modelKey.value.trim();
  } else {
    const status = await systemStatus();
    plan = status.plan;
    if (plan?.source === 'env-key') {
      // Copy the builder-process key into the agent's own .env so the agent
      // home stays self-sufficient (runs under plain `meridian gateway` too).
      const provider = (Object.keys(ENV_KEY_NAME) as Array<keyof typeof ENV_KEY_NAME>).find(
        (p) => plan && plan.label.toLowerCase().startsWith(p),
      );
      const envName = provider ? ENV_KEY_NAME[provider] : undefined;
      const value = envName ? process.env[envName] : undefined;
      if (envName && value) envAdditions[envName] = value;
    }
  }
  if (!plan) {
    throw new Error(
      'No way to run a model: Ollama is not running and no provider key was given. Start Ollama or paste a key in the wizard.',
    );
  }

  const slug = uniqueSlug(agentName);
  const gatewayPort = await allocatePort();

  const spec = {
    slug,
    agentName,
    personaKey: persona.key,
    personaRole: persona.role,
    personaIdentity: persona.identity,
    personaRules: persona.rules,
    operatorName,
    addressAs: submission.addressAs?.trim() || undefined,
    audience: submission.audience?.trim() || undefined,
    mission,
    tone: submission.tone,
    remember: submission.remember?.trim() || undefined,
    neverShare: (submission.neverShare ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    channels: submission.channels,
    skills: submission.skills,
    models: { primary: plan.primary, fallbacks: plan.fallbacks, cheapModel: plan.cheapModel },
    voicePersona: toneToVoicePersona(submission.tone),
    gatewayPort,
    envAdditions,
  };

  const b64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const { stdout, stderr, code } = await runBridge(b64);
  const marker = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('__BUILDER_RESULT__'));
  if (!marker) {
    throw new Error(
      `agent build failed (exit ${code}): ${stderr.slice(-400) || stdout.slice(-400) || 'no output'}`,
    );
  }
  const result = JSON.parse(marker.replace('__BUILDER_RESULT__', '')) as BuildResult;
  if (!result.ok) throw new Error(result.error || 'agent build failed');
  return result;
}
