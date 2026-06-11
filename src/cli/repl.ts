/**
 * Interactive REPL. Renders boot panel, accepts /commands and free text,
 * dispatches to slash handlers or to the conversation, prints replies.
 */

import readline from 'node:readline';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Conversation } from '../agent/conversation.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { DreamWeaver } from '../dream/weaver.js';
import type { MeridianHome } from '../config/home.js';
import type { SkillRegistry } from '../skills/types.js';
import type { AgentConfig } from '../config/schema.js';
import { buildBootTrace, renderBootPanel, renderBootTrace, renderCommandCheatSheet, renderLogo, renderStatusBar, welcomeLine } from './banner.js';
import { dispatch } from './commands/handlers.js';
import { COMMAND_REGISTRY } from './commands/registry.js';
import { colors } from '../utils/truecolor.js';

const PROMPT = `${colors.cyan('❯')} `;
const VERSION = '1.0.1';
const RELEASE_DATE = '2026.4.27';

export interface ReplOptions {
  home: MeridianHome;
  config: AgentConfig;
  conversation: Conversation;
  cortex: MemoryProvider;
  dream: DreamWeaver;
  skills: SkillRegistry;
  store?: import('../session/store.js').SessionStore;
  passphraseGuard?: import('../skills/runtime.js').PassphraseGuard;
}

function countLayers(home: MeridianHome) {
  const counts = {
    identity: false,
    context: 0,
    skills: 0,
    memory: 0,
    connections: 0,
    verification: 0,
    automations: 0,
  };
  const idFile = join(home.layer('IDENTITY'), 'AGENT.md');
  counts.identity = existsSync(idFile);
  const ctxDir = home.layer('CONTEXT');
  if (existsSync(ctxDir))
    counts.context = readdirSync(ctxDir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).length;
  const skillsDir = home.layer('SKILLS');
  if (existsSync(skillsDir)) counts.skills = readdirSync(skillsDir).length;
  const conDir = home.layer('CONNECTIONS');
  if (existsSync(conDir))
    counts.connections = readdirSync(conDir).filter((f) => f.endsWith('.config') || f === 'mcp.json').length;
  const vDir = home.layer('VERIFICATION');
  if (existsSync(vDir))
    counts.verification = readdirSync(vDir).filter((f) => f.endsWith('.checks.md')).length;
  const aDir = home.layer('AUTOMATIONS');
  if (existsSync(aDir))
    counts.automations = readdirSync(aDir).filter((f) => f.endsWith('.cron')).length;
  return counts;
}

function readSystemBase(home: MeridianHome, agentName: string): string {
  const idFile = join(home.layer('IDENTITY'), 'AGENT.md');
  let id = '';
  if (existsSync(idFile)) id = readFileSync(idFile, 'utf8');
  const userFile = join(home.layer('IDENTITY'), 'USER.md');
  let user = '';
  if (existsSync(userFile)) user = readFileSync(userFile, 'utf8');
  const ctxDir = home.layer('CONTEXT');
  const ctxParts: string[] = [];
  if (existsSync(ctxDir)) {
    for (const f of readdirSync(ctxDir)) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue;
      ctxParts.push(`### ${f}\n${readFileSync(join(ctxDir, f), 'utf8')}`);
    }
  }
  return [
    `You are ${agentName}, an agent running on Meridian.`,
    id && `## IDENTITY\n${id}`,
    user && `## USER\n${user}`,
    ctxParts.length && `## CONTEXT\n${ctxParts.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const { home, config, conversation, cortex, dream, skills, store, passphraseGuard } = opts;
  const bootStart = Date.now();

  // Wordmark
  console.log(`\n${renderLogo()}\n`);

  // Live system probes
  const cortexHealth = await cortex.health();
  const cortexStats = await cortex.stats();
  const skillsByCat = skills.byCategory();
  const essentialSkills: Array<{ name: string; enabled: boolean }> = [];
  for (const list of Object.values(skillsByCat)) {
    for (const s of list) {
      essentialSkills.push({ name: s.manifest.name, enabled: true });
    }
  }
  const layerCounts = countLayers(home);
  const { BUNDLED_SKILL_LIBRARY } = await import('./skill-library.js');

  // ─── Boot trace ──
  // dmesg-style "system coming online" lines printed between the wordmark and
  // the boot panel. Pulls live facts from CORTEX + env so the trace tells the
  // user what actually happened instead of being decorative.
  // Capability flags — labelled by what's wired up, never by which vendor
  // the user picked. Meridian's boot screen is provider-agnostic by policy;
  // we don't leak the proprietary stack behind it.
  const isolation = {
    datastore: !!process.env.NEON_DATABASE_URL || !!process.env.DATABASE_URL,
    vectors: !!process.env.VOYAGE_API_KEY,
    inference: !!process.env.OPENROUTER_API_KEY || !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY,
  };
  const channels = {
    telegram: !!config.channels.telegram?.enabled,
    voice: !!config.channels.vapi.enabled,
    cli: true,
  };
  const cortexBaseUrl = process.env.MERIDIAN_CORTEX_URL || 'http://127.0.0.1:3101';
  const trace = buildBootTrace({
    agentName: config.agent.name,
    agentRole: config.agent.role || 'agent',
    cortexUrl: cortexBaseUrl,
    cortexStatus: cortexHealth.status,
    memoryCount: cortexStats?.memoryCount,
    synapseCount: cortexStats?.synapseCount,
    isolation,
    channels,
    lastDreamAt: cortexStats?.lastDreamAt ?? undefined,
    bootDurationMs: Math.max(1, Date.now() - bootStart),
  });
  console.log(renderBootTrace(trace));

  // ─── Boot panel ──
  // Identity card shows just the model name. We deliberately do NOT surface
  // the provider/gateway slug — that's our proprietary routing concern, not
  // something to broadcast on every boot.
  const primaryModel = config.models.primary;
  const modelSlug = primaryModel.includes('/')
    ? primaryModel.split('/').pop()!
    : primaryModel;
  console.log(
    renderBootPanel({
      version: VERSION,
      releaseDate: RELEASE_DATE,
      agentSlug: home.agentSlug,
      agentName: config.agent.name,
      identity: {
        agentRole: config.agent.role,
        model: modelSlug,
        cwd: process.cwd(),
        sessionId: conversation.sessionId,
      },
      toolsByCategory: {
        core: ['bash', 'read', 'write', 'edit', 'web_fetch'],
        cognition: ['cortex_recall', 'cortex_encode', 'cortex_dream'],
        ...(config.channels.vapi.enabled ? { voice: ['voice_call', 'voice_status'] } : {}),
      },
      mcpServers: [{ name: 'cortex', transport: 'native', toolCount: 0 }],
      channels: [
        ...(config.channels.telegram?.enabled
          ? [
              {
                name: 'Telegram',
                binding:
                  process.env.TELEGRAM_BOT_USERNAME
                    ? `@${process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, '')}`
                    : 'bot live',
                status: 'live' as const,
              },
            ]
          : []),
        ...(config.channels.vapi.enabled
          ? [
              {
                name: 'ATERNA Voice',
                binding: process.env.VAPI_PHONE_NUMBER || 'phone bound',
                status: 'live' as const,
              },
            ]
          : []),
        { name: 'CLI (REPL)', binding: 'this terminal', status: 'live' as const },
      ],
      essentialSkills:
        essentialSkills.length > 0
          ? essentialSkills
          : [{ name: '(loaded from skeleton)', enabled: false }],
      skillLibrary: BUNDLED_SKILL_LIBRARY,
      layerStatus: {
        identity: layerCounts.identity,
        context: layerCounts.context > 0,
        skills: layerCounts.skills > 0,
        memory: cortexHealth.status === 'ok',
        connections: layerCounts.connections > 0,
        verification: layerCounts.verification > 0,
        automations: layerCounts.automations > 0,
      },
      cortex: {
        status: cortexHealth.status,
        database: cortexHealth.database,
        memoryCount: cortexStats?.memoryCount,
        synapseCount: cortexStats?.synapseCount,
        lastDreamAt: cortexStats?.lastDreamAt ?? undefined,
      },
      cwd: process.cwd(),
      sessionId: conversation.sessionId,
    }),
  );

  // Slash command cheat sheet — every command grouped by category, visible
  // at boot so users don't have to type /help to discover the surface.
  console.log(renderCommandCheatSheet(COMMAND_REGISTRY));

  console.log(`\n${welcomeLine(config.agent.name)}\n`);
  console.log(
    `${renderStatusBar({
      ctxPct: 0,
      dreamState: 'idle',
      agent: home.agentSlug,
      elapsedSec: 0,
    })}\n`,
  );

  const systemBase = readSystemBase(home, config.agent.name);
  // wire system base into conversation by mutating internal hint
  (conversation as { systemBase?: string }).systemBase = systemBase;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => {
      if (!line.startsWith('/')) return [[], line];
      const matches = COMMAND_REGISTRY
        .map((c) => `/${c.name}`)
        .filter((c) => c.startsWith(line));
      return [matches, line];
    },
  });

  const ask = () => {
    rl.question(PROMPT, async (line) => {
      const text = line.trim();
      if (!text) return ask();
      if (text.startsWith('/')) {
        const out = await dispatch(text, { home, conversation, cortex, dream, skills, store, passphraseGuard });
        if (out !== undefined) console.log(out);
        return ask();
      }
      const started = Date.now();
      try {
        const turn = await conversation.send(text);
        console.log(`\n${turn.content}\n`);
        const elapsed = (Date.now() - started) / 1000;
        process.stdout.write(
          `${renderStatusBar({
            ctxPct: Math.min(100, Math.round((conversation.historyCount / 60) * 100)),
            dreamState: dream.state().running ? 'running' : 'idle',
            agent: home.agentSlug,
            elapsedSec: elapsed,
          })}\n`,
        );
      } catch (err) {
        console.log(colors.err(`error: ${(err as Error).message}\n`));
      }
      ask();
    });
  };

  ask();
  await new Promise<void>((resolve) => rl.once('close', resolve));
}
