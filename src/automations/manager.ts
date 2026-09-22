/**
 * AutomationManager — runs the AUTOMATIONS layer.
 *
 * Each agent's `~/.meridian/<agent>/AUTOMATIONS/*.cron` (or .yaml) is parsed
 * for a frontmatter block (name, schedule, mode, requiresApproval) plus a
 * body that becomes the prompt. node-cron schedules each job; on fire the
 * prompt runs as a conversation turn, the reply is encoded as a memory,
 * and (when configured) pushed to the operator on Telegram.
 *
 * Distinct from the proactive sentinel (Tier 4): the sentinel does ONE
 * morning brief and ad-hoc nudges. The automation engine runs ARBITRARY
 * scheduled jobs — daily decision review, weekly retrospective, end-of-day
 * commitment audit, monthly client pulse, etc. The sentinel is a hardcoded
 * partner ritual; automations are operator-defined cognitive habits.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolveTimezone } from '../config/timezone.js';
import { NARRATION_RULE, stripNarration } from './narration.js';
import { checkSpend } from '../spend/guard.js';
import type { SpendLedger } from '../spend/ledger.js';
import type { PricingCatalog } from '../providers/pricing.js';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { streamText, type ToolSet } from 'ai';
import type { Logger } from 'pino';
import type { MemoryProvider } from '../memory/provider.js';
import type { ProviderRouter } from '../providers/router.js';
import type { AgentConfig } from '../config/schema.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { MeridianHome } from '../config/home.js';
import { AutonomyControlPlane, type AutonomyOutcome } from '../autonomy/control-plane.js';
import { governToolSet } from '../governance/action-policy.js';
import type { SessionStore } from '../session/store.js';
import { scheduleDeterministic, type DeterministicTask } from '../autonomy/scheduler.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface AutomationDef {
  name: string;
  schedule: string; // cron expression
  /** IANA tz the schedule fires in (imported jobs keep their source agent's
   *  local tz); absent = process TZ / America/Chicago. */
  timezone?: string;
  mode: 'direct' | 'draft'; // direct = push immediately; draft = save + tag for approval
  requiresApproval: boolean;
  /** After this many consecutive approved runs the automation graduates to
   *  running without a per-run approval grant (WS3). 0 = never. */
  trustGraduationAfter: number;
  /** observe = read-only tools; draft = read-only tools + no delivery;
   * execute = consequential tools, always gated by an owner grant. */
  actionTier: 'observe' | 'draft' | 'execute';
  autonomyMode: 'shadow' | 'live';
  tools: string[];
  audit: boolean;
  leaseMinutes: number;
  timeoutMinutes: number;
  misfireGraceMinutes: number;
  cooldownMinutes: number;
  pushTo?: 'telegram' | 'none';
  prompt: string; // markdown body the agent sees on fire
  source: string; // file path (for audit)
}

export interface AutomationManagerOptions {
  home: MeridianHome;
  config: AgentConfig;
  cortex: MemoryProvider;
  router: ProviderRouter;
  logger: Logger;
  systemBase: string;
  channels: Map<string, ChannelAdapter>;
  /**
   * Tools the automation can call. Without these, the LLM can only emit text
   * — meaning automations like inbox-scan that need gmail_search would
   * silently fall through and just hallucinate. Pass the same ToolSet the
   * REPL/gateway uses; the model sees the full surface and picks what it needs.
   */
  tools?: ToolSet;
  store: SessionStore;
  controlPlane?: AutonomyControlPlane;
  /** Spend accounting (WS4): per-run and daily caps apply to automations too. */
  spend?: { ledger: SpendLedger; pricing?: PricingCatalog };
}

export interface AutomationStatus {
  name: string;
  schedule: string;
  timezone: string;
  pushTo: string;
  delivers: boolean;
  nextFireAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastDeliveredAt: string | null;
  armedAt: string | null;
  /** ms since the later of armedAt / lastDeliveredAt; null when never armed. */
  silentForMs: number | null;
  mode: 'direct' | 'draft';
  requiresApproval: boolean;
  graduatedAt: string | null;
  trustGraduationAfter: number;
  pendingDrafts: number;
}

function readDraft(
  path: string,
): { id: string; createdAt: string; status: string; body: string } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    id: path.split('/').pop()!.replace(/\.md$/, ''),
    createdAt: meta.createdAt ?? '',
    status: meta.status ?? 'pending',
    body: text.slice(m[0].length).replace(/\s+$/, ''),
  };
}

function markDraft(path: string, status: 'delivered' | 'rejected'): void {
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/^status: .*$/m, `status: ${status}`), { mode: 0o600 });
}

function silentFor(now: Date, armedAt?: Date, lastDeliveredAt?: string): number | null {
  const anchor = Math.max(
    armedAt ? armedAt.getTime() : 0,
    lastDeliveredAt ? new Date(lastDeliveredAt).getTime() : 0,
  );
  if (!anchor) return null;
  return Math.max(0, now.getTime() - anchor);
}

export interface AutomationRunResult {
  name: string;
  ts: string;
  pushedTo: string[];
  durationMs: number;
  reply: string;
  outcome: AutonomyOutcome;
  runId: string;
  reason?: string;
}

const CONSEQUENTIAL_TOOL =
  /(^|_)(send|write|edit|delete|remove|create|update|post|put|patch|execute|run|bash|delegate|encode|ingest|dream|call|dm)(_|$)/i;

export function toolIsConsequential(name: string): boolean {
  return CONSEQUENTIAL_TOOL.test(name) || ['http_request', 'telegram_dm'].includes(name);
}

const RESERVED_NAMES = new Set([
  // dream-cycle is already handled by DreamWeaver — skip the AUTOMATIONS
  // copy so we don't double-fire.
  'dream-cycle',
]);

/** `trustGraduation: 5`, `{ after: 5 }`, or the config-schema shape `{ minRuns: 5 }`. */
export function parseGraduation(raw: unknown): number {
  if (typeof raw === 'number') return raw > 0 ? Math.floor(raw) : 0;
  if (raw && typeof raw === 'object') {
    const o = raw as { after?: unknown; minRuns?: unknown };
    const n = typeof o.after === 'number' ? o.after : typeof o.minRuns === 'number' ? o.minRuns : 0;
    return n > 0 ? Math.floor(n) : 0;
  }
  return 0;
}

export function loadAutomationDefs(home: MeridianHome): AutomationDef[] {
  const dir = home.layer('AUTOMATIONS');
  if (!existsSync(dir)) return [];
  const out: AutomationDef[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.cron') && !entry.endsWith('.yaml') && !entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    const text = readFileSync(full, 'utf8');
    const m = FRONTMATTER_RE.exec(text);
    if (!m) continue;
    let meta: Record<string, unknown>;
    try {
      meta = parseYaml(m[1]) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = String(meta.name ?? entry.replace(/\.(cron|yaml|md)$/, ''));
    if (RESERVED_NAMES.has(name)) continue;
    // `enabled: false` parks a job without deleting it (imported-but-disabled
    // schedules land this way and must never fire until flipped on).
    if (meta.enabled === false) continue;
    const schedule = typeof meta.schedule === 'string' ? meta.schedule : null;
    if (!schedule) continue;
    const body = text.slice(m[0].length).trim();
    out.push({
      name,
      schedule,
      ...(typeof meta.timezone === 'string' ? { timezone: meta.timezone } : {}),
      mode: meta.mode === 'direct' ? 'direct' : 'draft',
      requiresApproval: meta.requiresApproval !== false,
      trustGraduationAfter: parseGraduation(meta.trustGraduation),
      actionTier:
        meta.actionTier === 'execute'
          ? 'execute'
          : meta.actionTier === 'draft'
            ? 'draft'
            : 'observe',
      autonomyMode: meta.autonomyMode === 'live' ? 'live' : 'shadow',
      tools: Array.isArray(meta.tools)
        ? meta.tools.filter((x): x is string => typeof x === 'string')
        : [],
      audit: meta.audit !== false,
      leaseMinutes: positiveNumber(meta.leaseMinutes, 30),
      timeoutMinutes: positiveNumber(meta.timeoutMinutes, 15),
      misfireGraceMinutes: positiveNumber(meta.misfireGraceMinutes, 30),
      cooldownMinutes: positiveNumber(meta.cooldownMinutes, 60),
      pushTo: meta.pushTo === 'none' ? 'none' : 'telegram',
      prompt: body || `Run the ${name} automation now.`,
      source: full,
    });
  }
  return out;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * [SILENT] contract: automation prompts routinely say "only push when it
 * matters" — this is the runtime half of that promise. A reply opening with
 * [SILENT] (or a run whose whole provider chain failed) is logged + encoded
 * but never pushed to the operator. Matches the Hermes fleet's suppression
 * idiom, so imported prompts keep their semantics.
 */
export function automationRunIsSilent(reply: string, defName: string): boolean {
  return /^\s*\[SILENT\]/i.test(reply) || reply.startsWith(`(${defName} produced no output`);
}

export function stripSilentMarker(reply: string): string {
  return reply.replace(/^\s*\[SILENT\]\s*/i, '') || '(silent run, no content)';
}

export class AutomationManager {
  private tasks: DeterministicTask[] = [];
  private lastRuns = new Map<string, AutomationRunResult>();
  private defs: AutomationDef[] = [];
  private readonly controlPlane: AutonomyControlPlane;
  private armedAt: Date | undefined;

  constructor(private opts: AutomationManagerOptions) {
    this.controlPlane = opts.controlPlane ?? new AutonomyControlPlane(opts.home);
  }

  start(): AutomationDef[] {
    const now = new Date();
    for (const recovered of this.controlPlane.recoverExpired(now)) {
      this.opts.logger.error({ msg: 'automation run recovered to dead letter', ...recovered });
    }
    this.defs = loadAutomationDefs(this.opts.home);
    this.armedAt = now;
    for (const def of this.defs) {
      const missedAt = this.controlPlane.getNextScheduledAt(def.name);
      const task = scheduleDeterministic(
        def.schedule,
        (scheduledAt) => {
          this.fire(def.name, scheduledAt).catch((err) =>
            this.opts.logger.error({ msg: 'automation failed', name: def.name, err }),
          );
        },
        {
          timezone: resolveTimezone(def.timezone, this.opts.config.agent.timezone, process.env.TZ),
          onScheduled: (next) => this.controlPlane.setNextScheduledAt(def.name, next),
        },
      );
      this.tasks.push(task);
      if (
        missedAt &&
        missedAt <= now &&
        now.getTime() - missedAt.getTime() <= def.misfireGraceMinutes * 60_000
      ) {
        void this.fire(def.name, missedAt).catch((err) =>
          this.opts.logger.error({ msg: 'automation catch-up failed', name: def.name, err }),
        );
      }
      this.opts.logger.info({
        msg: 'automation scheduled',
        name: def.name,
        schedule: def.schedule,
        source: def.source,
      });
    }
    return this.defs;
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }

  list(): AutomationDef[] {
    return this.defs;
  }

  lastRun(name: string): AutomationRunResult | undefined {
    return this.lastRuns.get(name);
  }

  /**
   * Operator-visible status for /health and doctor: what is armed, when it
   * fires next, when it last ran, and when it last delivered. Defect (a):
   * agents that were "healthy but silent" had no surface that showed this.
   */
  status(now = new Date()): AutomationStatus[] {
    return this.defs.map((def) => {
      const next = this.controlPlane.getNextScheduledAt(def.name);
      const last = this.lastRuns.get(def.name);
      const job = this.controlPlane.snapshot().jobs[def.name];
      return {
        name: def.name,
        schedule: def.schedule,
        timezone: resolveTimezone(def.timezone, this.opts.config.agent.timezone, process.env.TZ),
        pushTo: def.pushTo ?? 'none',
        delivers: def.autonomyMode === 'live' && def.mode === 'direct' && def.pushTo === 'telegram',
        nextFireAt: next ? next.toISOString() : null,
        lastRunAt: last?.ts ?? null,
        lastOutcome: last?.outcome ?? null,
        lastDeliveredAt: job?.lastNotification?.at ?? null,
        armedAt: this.armedAt ? this.armedAt.toISOString() : null,
        silentForMs: silentFor(now, this.armedAt, job?.lastNotification?.at),
        mode: def.mode,
        requiresApproval: def.requiresApproval,
        graduatedAt: job?.graduatedAt ?? null,
        trustGraduationAfter: def.trustGraduationAfter,
        pendingDrafts: this.listDrafts().filter((d) => d.name === def.name).length,
      };
    });
  }

  /**
   * Delivering automations that have not delivered anything within `windowMs`
   * of being armed (or since their last delivery). The gateway logs these on
   * a timer so a parked proactive layer is visible within a day, not a week.
   */
  silentAutomations(windowMs: number, now = new Date()): AutomationStatus[] {
    return this.status(now).filter(
      (st) => st.delivers && st.silentForMs !== null && st.silentForMs > windowMs,
    );
  }

  async fire(name: string, scheduledAt = new Date()): Promise<AutomationRunResult | null> {
    const def = this.defs.find((d) => d.name === name);
    if (!def) {
      this.opts.logger.warn({ msg: 'automation not found', name });
      return null;
    }
    const started = Date.now();
    const acquired = this.controlPlane.begin(def.name, scheduledAt, def.leaseMinutes * 60_000);
    if (!acquired.acquired || !acquired.run) {
      this.opts.logger.info({
        msg: 'automation occurrence suppressed',
        name,
        reason: acquired.reason,
      });
      return null;
    }
    const runId = acquired.run.runId;
    this.opts.logger.info({
      msg: 'automation firing',
      name,
      runId,
      scheduledAt: scheduledAt.toISOString(),
    });

    const selected = this.selectTools(def);
    const consequential = Object.keys(selected).filter(toolIsConsequential);
    if (consequential.length > 0 && def.actionTier !== 'execute') {
      return this.terminal(
        def,
        runId,
        started,
        'failed',
        '',
        [],
        `read-only action tier cannot expose consequential tools: ${consequential.join(', ')}`,
      );
    }
    if (def.actionTier === 'execute' && consequential.length > 0 && !def.requiresApproval) {
      return this.terminal(
        def,
        runId,
        started,
        'failed',
        '',
        [],
        'execute-tier automations with consequential tools must declare requiresApproval: true',
      );
    }
    const graduated = def.trustGraduationAfter > 0 && !!this.controlPlane.graduatedAt(def.name);
    if (def.requiresApproval && !graduated) {
      if (!this.opts.config.operator?.id) {
        return this.terminal(
          def,
          runId,
          started,
          'failed',
          '',
          [],
          'owner approval required but no operator id is configured',
        );
      }
      const approvalDigest = this.opts.store.digestActionArgs({
        job: def.name,
        scheduledAt: scheduledAt.toISOString(),
      });
      const approved = this.opts.store.consumeApproval(
        `op:${this.opts.config.operator.id}`,
        `automation:${def.name}`,
        approvalDigest,
      );
      if (!approved) {
        // WS3: the operator must LEARN that approval is needed. Before this,
        // an awaiting_approval run was a ledger entry nobody saw.
        await this.notifyOperator(
          def,
          `needs your approval to run. Reply /approve automation:${def.name} within 5 minutes of the next fire, or set requiresApproval: false in its frontmatter.`,
          `awaiting-approval:${def.name}`,
        );
        return this.terminal(
          def,
          runId,
          started,
          'awaiting_approval',
          '',
          [],
          `owner approval required: /approve automation:${def.name}`,
        );
      }
    }

    // Build a system prompt that frames the LLM as the agent running this
    // specific automation. We inject relevant CORTEX recall on the prompt
    // body so the automation has context, not raw recency.
    let recallContext = '';
    // Tri-state recall: present, empty, or failed. The model must never read
    // a failed recall as "nothing happened" (recovered from the 2026-08-18
    // Arlo production build; the source of that fix was lost).
    let recallAvailable = true;
    try {
      const r = await this.opts.cortex.recall(def.prompt, {
        tokenBudget: 2000,
        sensitivityFilter: ['public', 'internal'],
        // Last 21 days — automations look at fresh activity.
        since: new Date(Date.now() - 21 * 24 * 3600 * 1000),
      });
      recallContext = r.context;
    } catch (err) {
      recallAvailable = false;
      this.opts.logger.warn({ msg: 'automation recall failed', name, err });
    }

    const today = new Date().toISOString().slice(0, 10);
    const op = this.opts.config.operator;
    const sys = [
      this.opts.systemBase,
      '',
      '## YOU ARE RUNNING A SCHEDULED AUTOMATION',
      '',
      `Name: ${def.name}`,
      `Today: ${today}`,
      op?.name ? `Operator: ${op.name}` : '',
      '',
      'Compose the output of this automation. Direct, no preamble. If recall did',
      "not pull anything actionable, follow the automation's no-update instruction.",
      'Do not invent and do not expose internal memory or message ids.',
      NARRATION_RULE,
      '',
      recallAvailable
        ? recallContext
          ? `<cortex_recall>\n${recallContext}\n</cortex_recall>`
          : '<cortex_recall>No relevant memories returned.</cortex_recall>'
        : '<cortex_recall status="unavailable">Recall failed this run. Do not describe it as empty.</cortex_recall>',
    ]
      .filter(Boolean)
      .join('\n');

    // Spend cap (WS4): a scheduled job must never run the account dry.
    const jobId = `automation:${def.name}`;
    if (this.opts.spend) {
      const verdict = checkSpend(this.opts.spend.ledger, this.opts.config.spend, { jobId });
      if (verdict.action === 'block') {
        this.opts.logger.warn({
          msg: 'automation skipped: spend cap',
          name,
          reason: verdict.reason,
        });
        await this.notifyOperator(def, `did not run: ${verdict.reason}.`, `spend-cap:${def.name}`);
        return this.terminal(
          def,
          runId,
          started,
          'skipped',
          '',
          [],
          `spend cap: ${verdict.reason}`,
        );
      }
    }
    const chain = this.opts.router.chainFor(def.name, this.opts.config.models);
    let reply = '';
    for (const provider of chain) {
      try {
        // If tools are provided, allow up to 6 steps so the model can call
        // gmail_search / cortex_recall etc. before composing the final reply.
        // Without tools (legacy automations), keep maxSteps=1 — pure text only.
        const hasTools = Object.keys(selected).length > 0;
        const stream = streamText({
          model: provider.model,
          system: sys,
          messages: [{ role: 'user', content: def.prompt }],
          maxRetries: 1,
          maxSteps: hasTools ? 6 : 1,
          ...(hasTools ? { tools: selected } : {}),
          abortSignal: AbortSignal.timeout(def.timeoutMinutes * 60_000),
        });
        let out = '';
        for await (const delta of stream.textStream) out += delta;
        if (this.opts.spend) {
          try {
            const u = await stream.usage;
            if (u && Number.isFinite(u.promptTokens)) {
              const usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens };
              this.opts.spend.ledger.record({
                agentId: this.opts.config.agent.slug,
                scope: 'automation',
                jobId,
                model: provider.ref,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                usd: this.opts.spend.pricing?.price(provider.ref, usage) ?? null,
              });
            }
          } catch (err) {
            this.opts.logger.warn({ msg: 'automation spend record failed', name, err });
          }
        }
        if (out.trim()) {
          reply = out.trim();
          break;
        }
      } catch (err) {
        this.opts.logger.warn({
          msg: 'automation provider failed',
          name,
          provider: provider.ref,
          err,
        });
      }
    }
    if (!reply) {
      reply = `(${def.name} produced no output — provider chain exhausted)`;
    } else {
      const cleaned = stripNarration(reply);
      if (cleaned !== reply) {
        this.opts.logger.warn({ msg: 'automation narration stripped', name });
        reply = cleaned;
      }
    }

    const silent = automationRunIsSilent(reply, def.name);
    if (silent) {
      reply = stripSilentMarker(reply);
      this.opts.logger.info({ msg: 'automation ran silent — push suppressed', name });
    }

    // Shadow runs are observable in the durable ledger but never notify.
    // Draft runs (WS3) land in OUTBOX and the operator gets a preview with the
    // approve/reject commands; nothing is delivered until /approve draft:<id>.
    const pushed: string[] = [];
    const deliveryAllowed = def.autonomyMode === 'live' && def.mode === 'direct';
    if (
      !silent &&
      def.autonomyMode === 'live' &&
      def.mode === 'draft' &&
      def.pushTo === 'telegram'
    ) {
      const draft = this.saveDraft(def, runId, reply);
      const preview = reply.length > 400 ? `${reply.slice(0, 400)}…` : reply;
      await this.notifyOperator(
        def,
        `drafted a message and is waiting for you.\n\n${preview}\n\nReply /approve draft:${draft.id} to deliver it, or /reject draft:${draft.id} to discard.`,
        `draft:${draft.id}`,
      );
      pushed.push('outbox');
    }
    if (
      !silent &&
      deliveryAllowed &&
      def.pushTo === 'telegram' &&
      this.controlPlane.notificationAllowed(def.name, reply, def.cooldownMinutes * 60_000)
    ) {
      const tg = this.opts.channels.get('telegram');
      if (tg?.send && op?.channels.telegram[0]) {
        try {
          await tg.send({
            channel: 'telegram',
            to: op.channels.telegram[0],
            text: `🔔 ${def.name}\n\n${reply}`,
          });
          pushed.push('telegram');
          this.controlPlane.recordNotification(def.name, reply);
        } catch (err) {
          this.opts.logger.warn({ msg: 'automation telegram push failed', name, err });
        }
      }
    }

    // Shadow runs are evidence only: never mutate agent memory.
    if (def.autonomyMode === 'live') {
      try {
        await this.opts.cortex.encode(`AUTOMATION ${def.name}:\n${reply}`, {
          source: `meridian:automation:${def.name}`,
          priority: 2,
          sensitivity: 'internal',
        });
      } catch (err) {
        this.opts.logger.warn({ msg: 'automation encode failed', name, err });
      }
    }

    const outcome: AutonomyOutcome = reply.startsWith(`(${def.name} produced no output`)
      ? 'degraded'
      : silent
        ? 'skipped'
        : def.autonomyMode === 'shadow'
          ? 'shadow'
          : 'success';
    const result = this.terminal(def, runId, started, outcome, reply, pushed);
    await this.maybeGraduate(def, runId);
    return result;
  }

  /** Push a short operator-facing notice with a cooldown keyed on `key`. */
  private async notifyOperator(def: AutomationDef, text: string, key: string): Promise<boolean> {
    const op = this.opts.config.operator;
    const tg = this.opts.channels.get('telegram');
    if (!tg?.send || !op?.channels.telegram[0]) return false;
    if (!this.controlPlane.notificationAllowed(`${def.name}#notice`, key, 6 * 3600_000))
      return false;
    try {
      await tg.send({
        channel: 'telegram',
        to: op.channels.telegram[0],
        text: `🔔 ${def.name} ${text}`,
      });
      this.controlPlane.recordNotification(`${def.name}#notice`, key);
      return true;
    } catch (err) {
      this.opts.logger.warn({ msg: 'operator notice failed', name: def.name, err });
      return false;
    }
  }

  private draftsDir(def?: AutomationDef): string {
    const base = join(this.opts.home.agentRoot, 'OUTBOX');
    return def ? join(base, def.name) : base;
  }

  private saveDraft(def: AutomationDef, runId: string, body: string): { id: string; path: string } {
    const dir = this.draftsDir(def);
    mkdirSync(dir, { recursive: true });
    const id = runId.replace(/[^\w-]+/g, '').slice(0, 24) || Date.now().toString(36);
    const path = join(dir, `${id}.md`);
    const front = [
      '---',
      `name: ${def.name}`,
      `runId: ${runId}`,
      `createdAt: ${new Date().toISOString()}`,
      'status: pending',
      '---',
      '',
    ].join('\n');
    writeFileSync(path, `${front}${body}\n`, { mode: 0o600 });
    return { id, path };
  }

  /** Pending drafts across every automation, newest first. */
  listDrafts(): Array<{
    id: string;
    name: string;
    createdAt: string;
    path: string;
    preview: string;
  }> {
    const base = this.draftsDir();
    if (!existsSync(base)) return [];
    const out: Array<{
      id: string;
      name: string;
      createdAt: string;
      path: string;
      preview: string;
    }> = [];
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.md')) continue;
        const parsed = readDraft(join(dir, f));
        if (parsed && parsed.status === 'pending')
          out.push({
            id: parsed.id,
            name,
            createdAt: parsed.createdAt,
            path: join(dir, f),
            preview: parsed.body.slice(0, 120),
          });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private findDraft(id: string) {
    return this.listDrafts().find((d) => d.id === id);
  }

  /** /approve draft:<id>: deliver the saved text to the operator's Telegram. */
  async deliverDraft(id: string): Promise<{ ok: boolean; reason: string }> {
    const draft = this.findDraft(id);
    if (!draft) return { ok: false, reason: `no pending draft ${id}` };
    const def = this.defs.find((d) => d.name === draft.name);
    const op = this.opts.config.operator;
    const tg = this.opts.channels.get('telegram');
    if (!tg?.send || !op?.channels.telegram[0])
      return { ok: false, reason: 'no telegram delivery path' };
    const body = readDraft(draft.path)?.body ?? '';
    try {
      await tg.send({
        channel: 'telegram',
        to: op.channels.telegram[0],
        text: `🔔 ${draft.name}\n\n${body}`,
      });
    } catch (err) {
      return { ok: false, reason: `delivery failed: ${(err as Error).message}` };
    }
    markDraft(draft.path, 'delivered');
    if (def) this.controlPlane.recordNotification(def.name, body);
    this.opts.store.audit('draft_delivered', { id, name: draft.name });
    return { ok: true, reason: 'delivered' };
  }

  /** /reject draft:<id>: keep the file, mark it rejected, deliver nothing. */
  rejectDraft(id: string): { ok: boolean; reason: string } {
    const draft = this.findDraft(id);
    if (!draft) return { ok: false, reason: `no pending draft ${id}` };
    markDraft(draft.path, 'rejected');
    this.opts.store.audit('draft_rejected', { id, name: draft.name });
    return { ok: true, reason: 'rejected' };
  }

  /**
   * Trust graduation (WS3): once an approval-gated automation has completed
   * `trustGraduationAfter` consecutive approved runs, it earns direct mode.
   * The flip is durable (control plane) and signed (action receipt) so /why
   * and /receipts can show when and why an automation stopped asking.
   */
  private async maybeGraduate(def: AutomationDef, runId: string): Promise<void> {
    if (!def.requiresApproval || def.trustGraduationAfter <= 0) return;
    if (this.controlPlane.graduatedAt(def.name)) return;
    const approved = this.controlPlane.consecutiveApprovedRuns(def.name);
    if (approved < def.trustGraduationAfter) return;
    const now = new Date();
    this.controlPlane.setGraduated(def.name, now);
    const receipt = this.opts.store.recordActionReceipt({
      receiptId: `rcpt_grad_${runId}`,
      ts: now.toISOString(),
      agentId: this.opts.config.agent.slug,
      sessionId: `automation:${def.name}`,
      channel: 'system',
      senderTrusted: true,
      toolName: 'automation.graduate',
      callIndex: 0,
      decision: 'allow',
      rule: 'trustGraduation',
      reason: `${approved} consecutive approved runs (threshold ${def.trustGraduationAfter})`,
      argsDigest: this.opts.store.digestActionArgs({ job: def.name, approved }),
      outcome: 'succeeded',
    });
    this.opts.logger.info({
      msg: 'automation graduated to direct mode',
      name: def.name,
      receipt: receipt.receiptId,
    });
    await this.notifyOperator(
      def,
      `has earned direct mode after ${approved} approved runs and will no longer ask before running. Receipt ${receipt.receiptId}. Set trustGraduation: 0 to revoke.`,
      `graduated:${def.name}`,
    );
  }

  private selectTools(def: AutomationDef): ToolSet {
    if (!this.opts.tools || def.tools.length === 0) return {};
    const raw = Object.fromEntries(
      def.tools.flatMap((name) => (this.opts.tools?.[name] ? [[name, this.opts.tools[name]]] : [])),
    ) as ToolSet;
    return governToolSet({
      tools: raw,
      config: this.opts.config,
      context: {
        agentId: this.opts.config.agent.slug,
        sessionId: `automation:${def.name}`,
        channel: 'system',
        senderTrusted: true,
      },
      digestArgs: (args) => this.opts.store.digestActionArgs(args),
      record: (receipt) => {
        this.opts.store.recordActionReceipt(receipt);
      },
    });
  }

  private terminal(
    def: AutomationDef,
    runId: string,
    started: number,
    outcome: Exclude<AutonomyOutcome, 'running'>,
    reply: string,
    pushedTo: string[],
    reason?: string,
  ): AutomationRunResult {
    this.controlPlane.finish(def.name, runId, outcome, {
      reason,
      output: reply,
      metadata: { pushedTo },
    });
    const result = {
      name: def.name,
      runId,
      ts: new Date().toISOString(),
      pushedTo,
      durationMs: Date.now() - started,
      reply,
      outcome,
      reason,
    };
    if (def.audit) this.opts.store.audit('automation_run', result);
    this.lastRuns.set(def.name, result);
    this.opts.logger.info({
      msg: 'automation complete',
      name: def.name,
      runId,
      outcome,
      reason,
      durationMs: result.durationMs,
      pushed: pushedTo,
    });
    return result;
  }
}
