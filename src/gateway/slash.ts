import type { AutomationManager } from '../automations/manager.js';
import type { AgentConfig } from '../config/schema.js';
import type { SessionStore } from '../session/store.js';

/**
 * Slash commands on chat channels (WS3).
 *
 * Until now `/approve` only existed in the local REPL, so an automation that
 * said "reply /approve automation:x" over Telegram was talking to a model
 * that could not honor it: the text went into the turn as prose and the run
 * stayed awaiting_approval forever. This is the channel-safe subset. It runs
 * only for the resolved operator (the gateway checks trust before calling).
 */
export interface ChannelCommandCtx {
  config: AgentConfig;
  store?: SessionStore;
  automations?: AutomationManager;
  sessionId: string;
}

export function isChannelCommand(text: string): boolean {
  return /^\/(approve|reject|approvals|drafts|automations|status|help)\b/i.test(text.trim());
}

export async function dispatchChannelCommand(
  text: string,
  ctx: ChannelCommandCtx,
): Promise<string | undefined> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [cmdRaw, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? '').toLowerCase();
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'help':
      return [
        'Commands I honor here:',
        '/approve automation:<name>  allow the next run of an approval-gated automation (5 min)',
        '/approve draft:<id>         deliver a drafted message',
        '/reject draft:<id>          discard a drafted message',
        '/approvals                  list approval grants',
        '/drafts                     list pending drafts',
        '/automations                what is armed and when it fires next',
      ].join('\n');
    case 'approve':
      return approve(ctx, arg);
    case 'reject':
      return reject(ctx, arg);
    case 'approvals':
      return approvals(ctx);
    case 'drafts':
      return drafts(ctx);
    case 'automations':
    case 'status':
      return automations(ctx);
    default:
      return undefined;
  }
}

async function approve(ctx: ChannelCommandCtx, arg: string): Promise<string> {
  const [target, minutesRaw] = arg.split(/\s+/);
  if (!target) return 'usage: /approve automation:<name> [minutes]  or  /approve draft:<id>';
  if (target.startsWith('draft:')) {
    if (!ctx.automations) return 'automations are not running on this gateway';
    const r = await ctx.automations.deliverDraft(target.slice('draft:'.length));
    return r.ok ? `delivered draft ${target.slice(6)}` : `could not deliver: ${r.reason}`;
  }
  if (!ctx.store) return 'approval store is not wired on this gateway';
  const minutes = minutesRaw ? Number(minutesRaw) : 5;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60)
    return 'minutes must be between 1 and 60';
  const automationScope = target.startsWith('automation:');
  if (automationScope && !ctx.config.operator?.id)
    return 'cannot approve an automation without operator.id in config';
  const sessionId = automationScope ? `op:${ctx.config.operator!.id}` : ctx.sessionId;
  const grant = ctx.store.grantApproval(sessionId, target, minutes);
  return `approved one use of ${target} for ${minutes} minute(s). Grant ${grant.grantId}.`;
}

function reject(ctx: ChannelCommandCtx, arg: string): string {
  const target = arg.split(/\s+/)[0] ?? '';
  if (!target.startsWith('draft:')) return 'usage: /reject draft:<id>';
  if (!ctx.automations) return 'automations are not running on this gateway';
  const r = ctx.automations.rejectDraft(target.slice('draft:'.length));
  return r.ok ? `discarded draft ${target.slice(6)}` : `could not reject: ${r.reason}`;
}

function approvals(ctx: ChannelCommandCtx): string {
  if (!ctx.store) return 'approval store is not wired on this gateway';
  const ids = new Set([ctx.sessionId]);
  if (ctx.config.operator?.id) ids.add(`op:${ctx.config.operator.id}`);
  const grants = ctx.store.listApprovals().filter((g) => ids.has(g.sessionId));
  if (!grants.length) return 'no approval grants';
  const now = new Date().toISOString();
  return grants
    .slice(0, 20)
    .map((g) => {
      const state = g.remainingUses < 1 ? 'consumed' : g.expiresAt <= now ? 'expired' : 'armed';
      return `${g.toolName}  ${state}  expires ${g.expiresAt}`;
    })
    .join('\n');
}

function drafts(ctx: ChannelCommandCtx): string {
  if (!ctx.automations) return 'automations are not running on this gateway';
  const list = ctx.automations.listDrafts();
  if (!list.length) return 'no pending drafts';
  return list
    .slice(0, 10)
    .map((d) => `draft:${d.id}  ${d.name}  ${d.createdAt}\n  ${d.preview}`)
    .join('\n');
}

function automations(ctx: ChannelCommandCtx): string {
  if (!ctx.automations) return 'automations are not running on this gateway';
  const st = ctx.automations.status();
  if (!st.length) return 'no automations armed';
  return st
    .map((a) => {
      const gate = a.graduatedAt ? 'graduated' : a.requiresApproval ? 'needs approval' : 'direct';
      return `${a.name}  ${a.schedule} ${a.timezone}  ${a.mode}/${gate}  next ${a.nextFireAt ?? 'n/a'}  last delivered ${a.lastDeliveredAt ?? 'never'}${a.pendingDrafts ? `  drafts ${a.pendingDrafts}` : ''}`;
    })
    .join('\n');
}
