/**
 * Slash command handlers. Pure functions called by the REPL when input
 * starts with a `/`. Returns the text to display, or undefined to swallow.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { colors } from '../../utils/truecolor.js';
import type { Conversation } from '../../agent/conversation.js';
import type { MemoryProvider } from '../../memory/provider.js';
import type { DreamWeaver } from '../../dream/weaver.js';
import type { MeridianHome } from '../../config/home.js';
import type { SkillRegistry } from '../../skills/types.js';
import type { SessionStore } from '../../session/store.js';
import type { PassphraseGuard } from '../../skills/runtime.js';
import { commandsByCategory, findCommand } from './registry.js';
import { runAudit, writeReport } from '../../audit/retrospective.js';

export interface HandlerCtx {
  home: MeridianHome;
  conversation: Conversation;
  cortex: MemoryProvider;
  dream: DreamWeaver;
  skills: SkillRegistry;
  store?: SessionStore;
  passphraseGuard?: PassphraseGuard;
}

export async function dispatch(line: string, ctx: HandlerCtx): Promise<string | undefined> {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [head, ...rest] = trimmed.split(' ');
  const arg = rest.join(' ').trim();
  const cmd = findCommand(head);
  if (!cmd) return colors.warn(`unknown command: ${head}. Try /help.`);

  switch (cmd.name) {
    case 'help':
      return renderHelp();
    case 'profile':
      return renderProfile(ctx);
    case 'history':
      return renderHistory(ctx);
    case 'tools':
      return renderTools(ctx);
    case 'skills':
      return renderSkills(ctx);
    case 'cortex':
      return renderCortex(ctx);
    case 'recall':
      if (!arg) return 'usage: /recall <query>';
      return await handleRecall(ctx, arg);
    case 'encode':
      if (!arg) return 'usage: /encode <text>';
      return await handleEncode(ctx, arg);
    case 'dream':
      await ctx.dream.fire('full');
      return colors.ok('dream cycle triggered');
    case 'audit':
      return await handleAudit(ctx);
    case 'memory':
      return await renderMemoryDigest(ctx, arg);
    case 'commitments':
      return await renderCommitments(ctx);
    case 'decisions':
      return await renderDecisions(ctx);
    case 'why':
      if (!arg) return 'usage: /why <claim or topic>';
      return await renderWhy(ctx, arg);
    case 'trace':
      return await renderTrace(ctx, arg);
    case 'auth':
      return handleAuth(ctx, arg);
    case 'automations':
    case 'cron':
      return await renderAutomations(ctx, arg);
    case 'save':
      return handleSave(ctx);
    case 'usage':
      return colors.muted(`history turns: ${ctx.conversation.historyCount}`);
    case 'new':
    case 'clear':
      ctx.conversation.reset();
      return colors.ok('session reset');
    case 'quit':
      process.exit(0);
    default:
      return colors.muted(`/${cmd.name} not yet wired in v0.1`);
  }
}

function renderHelp(): string {
  const lines: string[] = [];
  lines.push(colors.cyan('Meridian commands'));
  for (const [category, cmds] of Object.entries(commandsByCategory())) {
    lines.push(`\n  ${colors.muted(`── ${category} ──`)}`);
    for (const c of cmds) {
      const aliases = c.aliases?.length ? colors.muted(` (${c.aliases.map((a) => `/${a}`).join(', ')})`) : '';
      const hint = c.argsHint ? colors.muted(` ${c.argsHint}`) : '';
      lines.push(`    ${colors.cyan(`/${c.name}`)}${hint}${aliases} — ${c.description}`);
    }
  }
  return lines.join('\n');
}

function renderProfile(ctx: HandlerCtx): string {
  const lines = [
    colors.cyan('Profile'),
    `  agent: ${ctx.home.agentSlug}`,
    `  home:  ${ctx.home.agentRoot}`,
    `  session: ${ctx.conversation.sessionId}`,
  ];
  return lines.join('\n');
}

function renderHistory(ctx: HandlerCtx): string {
  return colors.muted(`Conversation has ${ctx.conversation.historyCount} messages so far.`);
}

function renderTools(ctx: HandlerCtx): string {
  const skillNames = ctx.skills.list().map((s) => s.manifest.name);
  return [colors.cyan('Loaded tools'), ...skillNames.map((n) => `  • ${n}`)].join('\n');
}

function renderSkills(ctx: HandlerCtx): string {
  const cat = ctx.skills.byCategory();
  const lines: string[] = [colors.cyan('Skills')];
  for (const [c, skills] of Object.entries(cat)) {
    lines.push(`  ${colors.steel(c)}: ${skills.map((s) => s.manifest.name).join(', ')}`);
  }
  return lines.join('\n');
}

async function renderCortex(ctx: HandlerCtx): Promise<string> {
  const health = await ctx.cortex.health();
  const stats = await ctx.cortex.stats();
  const dreamState = ctx.dream.state();
  const lines = [colors.cyan('CORTEX'), `  status: ${health.status}`];
  if (health.database) lines.push(`  database: ${health.database}`);
  if (typeof stats?.memoryCount === 'number') {
    lines.push(`  memories: ${stats.memoryCount.toLocaleString()}`);
  }
  if (typeof stats?.synapseCount === 'number' && stats.synapseCount > 0) {
    lines.push(`  synapses: ${stats.synapseCount.toLocaleString()}`);
  }
  lines.push(`  last dream: ${stats?.lastDreamAt ?? 'never'}`);
  // Dream weaver = the in-process scheduler. If it hasn't fired in this
  // process, fall back to CORTEX's last_dream_at rather than saying "never"
  // (CORTEX has likely run dream cycles via its own reflector / online observer).
  const lastFired =
    dreamState.lastFiredAt?.toISOString() ?? stats?.lastDreamAt ?? 'never';
  lines.push(
    `  dream weaver: ${dreamState.running ? 'running' : 'idle'} (last: ${lastFired})`,
  );
  return lines.join('\n');
}

async function handleRecall(ctx: HandlerCtx, query: string): Promise<string> {
  const r = await ctx.cortex.recall(query, { tokenBudget: 1500 });
  if (!r.memories.length) return colors.muted('no memories matched');
  const lines = [colors.cyan(`Recall (${r.memories.length} memories, ${r.tokenCount} tokens)`)];
  for (const m of r.memories.slice(0, 5)) {
    lines.push(`  ${colors.muted(`#${m.id} score=${m.score.toFixed(2)}`)}`);
    lines.push(`  ${m.content.slice(0, 240).replace(/\n/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function handleEncode(ctx: HandlerCtx, text: string): Promise<string> {
  const r = await ctx.cortex.encode(text, { source: 'cli:/encode', priority: 3 });
  return colors.ok(`encoded #${r.memoryId} (novelty=${r.novelty.toFixed(2)})`);
}

async function handleAudit(ctx: HandlerCtx): Promise<string> {
  const report = runAudit(ctx.home);
  const path = writeReport(ctx.home, report);
  return colors.ok(`audit written to ${path}`);
}

async function renderMemoryDigest(ctx: HandlerCtx, topic: string): Promise<string> {
  if (!topic) {
    const dir = join(ctx.home.layer('MEMORY'));
    return [
      colors.cyan('Memory'),
      `  layer files: ${dir}`,
      '',
      colors.muted('  usage: /memory <topic>  — structured digest with sources'),
    ].join('\n');
  }
  const r = await ctx.cortex.recall(topic, { tokenBudget: 4000 });
  if (!r.memories.length) {
    return colors.muted(`no memories matched "${topic}"`);
  }
  const lines = [
    colors.cyan(`Memory digest: "${topic}"`),
    colors.muted(`  ${r.memories.length} memories · ${r.tokenCount} tokens`),
    '',
  ];
  // Group by source for readable provenance.
  const bySource: Record<string, typeof r.memories> = {};
  for (const m of r.memories) {
    const key = (m.source || 'unattributed').split('/').pop() || 'unattributed';
    (bySource[key] ??= []).push(m);
  }
  // Best-scoring source first; then most recent within source.
  const ordered = Object.entries(bySource).sort((a, b) => {
    const aMax = Math.max(...a[1].map((m) => m.score));
    const bMax = Math.max(...b[1].map((m) => m.score));
    return bMax - aMax;
  });
  for (const [src, ms] of ordered.slice(0, 8)) {
    lines.push(`  ${colors.steel(src)}  ${colors.muted(`(${ms.length} hit${ms.length === 1 ? '' : 's'})`)}`);
    for (const m of ms.slice(0, 3)) {
      const preview = m.content.slice(0, 220).replace(/\s+/g, ' ').trim();
      lines.push(`    ${colors.muted(`#${m.id} ·`)} ${preview}${m.content.length > 220 ? '…' : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function renderCommitments(ctx: HandlerCtx): Promise<string> {
  return await renderLedgerFile(ctx, 'commitments.md', 'Commitments');
}

async function renderDecisions(ctx: HandlerCtx): Promise<string> {
  return await renderLedgerFile(ctx, 'decisions.md', 'Decisions');
}

// ─── /why <claim> — recall the memories that back a specific agent claim ──
async function renderWhy(ctx: HandlerCtx, claim: string): Promise<string> {
  const r = await ctx.cortex.recall(claim, { tokenBudget: 2500 });
  if (!r.memories.length) {
    return colors.muted(
      `no memories matched "${claim}". the agent should not have made an assertion about this without recall evidence.`,
    );
  }
  const lines = [
    colors.cyan(`Why: "${claim}"`),
    colors.muted(`  ${r.memories.length} memories support this`),
    '',
  ];
  for (const m of r.memories.slice(0, 8)) {
    const src = (m.source || 'unattributed').split('/').pop() || 'unattributed';
    const preview = m.content.slice(0, 220).replace(/\s+/g, ' ').trim();
    lines.push(
      `  ${colors.muted(`#${m.id}`)} ${colors.steel(src)} ${colors.muted(`(score ${m.score.toFixed(2)})`)}`,
    );
    lines.push(`    ${preview}${m.content.length > 220 ? '…' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── /trace [turn-id|last] — show the full reasoning chain for a turn ──
async function renderTrace(ctx: HandlerCtx, arg: string): Promise<string> {
  if (!ctx.store) {
    return colors.muted('trace persistence not wired in this REPL');
  }
  const traces = ctx.store.listSessionTraces(ctx.conversation.sessionId, 50);
  if (!traces.length) {
    return colors.muted('no traces recorded yet for this session');
  }
  const target =
    !arg || arg === 'last'
      ? traces[0]!
      : traces.find((t) => t.turnId === arg || t.turnId.startsWith(arg)) ?? null;
  if (!target) {
    return colors.muted(`no trace found for "${arg}". try /trace last or /trace <turn-id>`);
  }
  const c = colors;
  const memCites = target.recallMemoryIds && target.recallMemoryIds.length
    ? target.recallMemoryIds.slice(0, 12).map((id) => `#${id}`).join(', ')
    : '(none)';
  const artCites = target.recallArtifactIds && target.recallArtifactIds.length
    ? target.recallArtifactIds.slice(0, 6).map((id) => `#${id}`).join(', ')
    : '(none)';
  const tools = target.toolCalls && target.toolCalls.length
    ? target.toolCalls.map((t) => `${t.stepType}:${t.name}`).join(' → ')
    : '(no tool calls)';
  const lines = [
    c.cyan(`Trace · turn ${target.turnId}`),
    c.muted(`  ${target.ts}  ·  ${target.channel}  ·  ${target.durationMs ?? '?'}ms  ·  ${target.model ?? 'unknown model'}`),
    '',
    `  ${c.steel('user')}    ${target.userInput.slice(0, 200)}${target.userInput.length > 200 ? '…' : ''}`,
    '',
    `  ${c.steel('recall')}  query: ${(target.recallQuery ?? '').slice(0, 120)}`,
    `           memories (${target.recallTokenCount ?? '?'} tokens): ${memCites}`,
    `           artifacts: ${artCites}`,
    '',
    `  ${c.steel('tools')}   ${tools}`,
    '',
    `  ${c.steel('reply')}   ${target.reply.slice(0, 240).replace(/\n/g, ' ')}${target.reply.length > 240 ? '…' : ''}`,
  ];
  return lines.join('\n');
}

function handleAuth(ctx: HandlerCtx, arg: string): string {
  if (!ctx.passphraseGuard) {
    return colors.warn('passphrase guard not wired into this REPL');
  }
  const parts = arg.split(/\s+/);
  if (parts.length < 2) return 'usage: /auth <skill> <passphrase>';
  const [skillName, ...phraseParts] = parts;
  const phrase = phraseParts.join(' ');
  try {
    ctx.passphraseGuard.require(skillName!, phrase);
    return colors.ok(`authorized ${skillName} (30 min session)`);
  } catch (err) {
    return colors.err(`auth failed: ${(err as Error).message}`);
  }
}

async function renderAutomations(_ctx: HandlerCtx, _arg: string): Promise<string> {
  const { loadAutomationDefs } = await import('../../automations/manager.js');
  const defs = loadAutomationDefs(_ctx.home);
  if (defs.length === 0) {
    return colors.muted(
      `no automations defined. drop *.cron files into ${_ctx.home.layer('AUTOMATIONS')} with frontmatter (name, schedule, mode).`,
    );
  }
  const lines = [colors.cyan(`Automations · agent ${_ctx.home.agentSlug}`), ''];
  for (const d of defs) {
    lines.push(
      `  ${colors.ok('●')}  ${colors.steel(d.name.padEnd(28, ' '))}${colors.muted(d.schedule)}  ${colors.muted(`(${d.mode}, push ${d.pushTo})`)}`,
    );
  }
  lines.push('');
  lines.push(colors.muted('  fire on demand: /automations run <name>  (v0.2)'));
  return lines.join('\n');
}

async function renderLedgerFile(
  ctx: HandlerCtx,
  filename: string,
  label: string,
): Promise<string> {
  const { readFileSync, existsSync } = await import('node:fs');
  const path = join(ctx.home.layer('MEMORY'), 'decision-logs', filename);
  if (!existsSync(path)) {
    // Fall back to recall over the topic — gives the user something even
    // when the structured ledger hasn't been wired yet.
    const r = await ctx.cortex.recall(label.toLowerCase(), { tokenBudget: 1500 });
    if (!r.memories.length) {
      return colors.muted(
        `no ${filename} ledger yet. ` +
          `start logging via the ${label.toLowerCase()}-tracker skill, ` +
          `or capture one inline and i will encode it.`,
      );
    }
    const lines = [colors.cyan(`${label} (from CORTEX recall)`)];
    for (const m of r.memories.slice(0, 6)) {
      lines.push(
        `  ${colors.muted(`#${m.id} score=${m.score.toFixed(2)}`)}  ` +
          m.content.slice(0, 200).replace(/\n/g, ' '),
      );
    }
    return lines.join('\n');
  }
  const body = readFileSync(path, 'utf8').trim();
  return [colors.cyan(`${label}  ·  ${path}`), '', body].join('\n');
}

function handleSave(ctx: HandlerCtx): string {
  const snap = ctx.conversation.snapshot();
  const path = join(ctx.home.sessions, `${snap.id}.json`);
  writeFileSync(path, JSON.stringify(snap, null, 2));
  return colors.ok(`saved ${path}`);
}
