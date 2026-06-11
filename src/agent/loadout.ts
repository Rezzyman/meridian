/**
 * Runtime loadout — auto-generated CONTEXT file that tells the agent
 * what it can actually do right now.
 *
 * Why this exists: the agent's IDENTITY/AGENT.md is hand-authored persona.
 * The agent's tools / skills / automations / channels live in code and
 * config. Without an explicit bridge, the model on every turn does not
 * know what is wired up — leading to "let me check..." then silence
 * when asked "what are your cron jobs?".
 *
 * The fix is to write a markdown file into the CONTEXT layer at every
 * gateway/REPL boot. CONTEXT is loaded into the system prompt on every
 * turn, so the agent always knows its current loadout.
 *
 * Single source of truth: this file is REGENERATED every boot. Do not
 * hand-edit it.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MeridianHome } from '../config/home.js';
import type { AgentConfig, AgentEnv } from '../config/schema.js';
import type { SkillRegistry } from '../skills/types.js';
import type { AutomationDef } from '../automations/manager.js';

export interface LoadoutInputs {
  home: MeridianHome;
  config: AgentConfig;
  env: AgentEnv;
  skills: SkillRegistry;
  automations: AutomationDef[];
  builtinToolNames: string[];
  /** MCP tools discovered at boot: name + source server. */
  mcpTools?: Array<{ name: string; server: string }>;
  cortexStats?: {
    memoryCount?: number | null;
    synapseCount?: number | null;
    lastDreamAt?: string | null;
  };
}

export function writeLoadoutFile(inputs: LoadoutInputs): string {
  const { home, config, env, skills, automations, builtinToolNames, mcpTools, cortexStats } =
    inputs;
  const lines: string[] = [];

  lines.push('# Runtime loadout');
  lines.push('');
  lines.push(
    'This file is regenerated every time the gateway or REPL starts. It is the',
  );
  lines.push(
    'authoritative list of what I can do RIGHT NOW. If a capability is not on',
  );
  lines.push(
    'this list, I do not have it. I never claim a capability I cannot find here.',
  );
  lines.push('');

  // ── Channels ──
  lines.push('## Channels armed');
  if (config.channels.telegram?.enabled && env.TELEGRAM_BOT_TOKEN) {
    const handle = process.env.TELEGRAM_BOT_USERNAME
      ? `@${process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, '')}`
      : 'live';
    lines.push(`- Telegram — ${handle}`);
  }
  if (config.channels.vapi.enabled && env.VAPI_API_KEY) {
    const phone = process.env.VAPI_PHONE_NUMBER || 'live';
    lines.push(`- ATERNA Voice — ${phone}`);
  }
  lines.push('- CLI (REPL)');
  if (config.channels.gateway?.enabled) {
    lines.push(`- HTTP gateway — port ${config.channels.gateway.port}`);
  }
  lines.push('');

  // ── Automations on autopilot ──
  lines.push('## Automations on autopilot');
  if (automations.length === 0) {
    lines.push('_(none configured — drop *.cron files into AUTOMATIONS/)_');
  } else {
    for (const a of automations) {
      const push = a.pushTo === 'telegram' ? 'Telegram push' : 'no push';
      lines.push(`- **${a.name}** — \`${a.schedule}\` — ${push}`);
    }
    lines.push('');
    lines.push(
      '_Each automation runs in CORTEX-aware mode: it pulls the last 21 days of relevant memory, composes through my model chain, encodes the output as a memory, and pushes the result to my operator on the configured channel._',
    );
  }
  lines.push('');

  // ── Skills installed ──
  lines.push('## Skills installed');
  const skillList = skills.list();
  if (skillList.length === 0) {
    lines.push('_(none installed)_');
  } else {
    for (const s of skillList) {
      const v2 = s.manifestV2;
      const tools = s.dynamicTools ? Object.keys(s.dynamicTools) : [];
      const tag = v2 ? '' : ' (markdown-only)';
      lines.push(`- **${s.manifest.name}**${tag} — ${s.manifest.description}`);
      if (tools.length > 0) {
        lines.push(`  - Tools: \`${tools.join('`, `')}\``);
      }
    }
  }
  lines.push('');

  // ── Tools (chat surface) ──
  lines.push('## Tools available during chat');
  const skillTools = new Set<string>();
  for (const s of skillList) {
    if (s.dynamicTools) for (const k of Object.keys(s.dynamicTools)) skillTools.add(k);
  }
  // Default chat-safe builtins (Tier 5 default)
  const chatBuiltins = ['web_fetch', 'voice_status', 'cortex_dream', 'telegram_dm'];
  for (const t of chatBuiltins) {
    if (builtinToolNames.includes(t)) lines.push(`- \`${t}\``);
  }
  for (const t of skillTools) {
    lines.push(`- \`${t}\` (from skill)`);
  }
  for (const t of mcpTools ?? []) {
    lines.push(`- \`${t.name}\` (MCP: ${t.server})`);
  }
  lines.push('');
  lines.push(
    '_When the operator asks me to do something, I check this list first. If the right tool is here, I call it. If it is not, I say so honestly and ask what they want me to do with what I have._',
  );
  lines.push('');

  // ── Memory state ──
  if (cortexStats) {
    lines.push('## Memory state at boot');
    if (typeof cortexStats.memoryCount === 'number') {
      lines.push(`- ${cortexStats.memoryCount.toLocaleString()} active memory nodes`);
    }
    if (typeof cortexStats.synapseCount === 'number' && cortexStats.synapseCount > 0) {
      lines.push(`- ${cortexStats.synapseCount.toLocaleString()} synaptic connections`);
    }
    if (cortexStats.lastDreamAt) {
      lines.push(`- Last dream cycle: ${cortexStats.lastDreamAt}`);
    }
    lines.push('');
  }

  // ── How I behave under this loadout ──
  lines.push('## How I behave under this loadout');
  lines.push(
    '- When asked "what can you do?" or "what tools do you have?", I list from this file directly. No theatre, no "let me check..." pause.',
  );
  lines.push(
    '- When asked to do something this loadout supports, I call the relevant tool immediately.',
  );
  lines.push(
    '- When asked to do something this loadout does NOT support, I say so cleanly and propose the closest thing I can do.',
  );
  lines.push(
    '- I never pretend a tool ran when it did not, and I never say "loaded the data" when no tool produced data.',
  );

  const path = join(home.layer('CONTEXT'), '_runtime-loadout.md');
  mkdirSync(home.layer('CONTEXT'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}
