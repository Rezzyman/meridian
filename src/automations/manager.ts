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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import { parse as parseYaml } from 'yaml';
import { streamText, type ToolSet } from 'ai';
import type { Logger } from 'pino';
import type { MemoryProvider } from '../memory/provider.js';
import type { ProviderRouter } from '../providers/router.js';
import type { AgentConfig } from '../config/schema.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { MeridianHome } from '../config/home.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface AutomationDef {
  name: string;
  schedule: string;          // cron expression
  /** IANA tz the schedule fires in (imported jobs keep their source agent's
   *  local tz); absent = process TZ / America/Chicago. */
  timezone?: string;
  mode: 'direct' | 'draft';  // direct = push immediately; draft = save + tag for approval
  requiresApproval: boolean;
  pushTo?: 'telegram' | 'none';
  prompt: string;            // markdown body the agent sees on fire
  source: string;            // file path (for audit)
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
}

export interface AutomationRunResult {
  name: string;
  ts: string;
  pushedTo: string[];
  durationMs: number;
  reply: string;
}

const RESERVED_NAMES = new Set([
  // dream-cycle is already handled by DreamWeaver — skip the AUTOMATIONS
  // copy so we don't double-fire.
  'dream-cycle',
]);

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
      pushTo: meta.pushTo === 'none' ? 'none' : 'telegram',
      prompt: body || `Run the ${name} automation now.`,
      source: full,
    });
  }
  return out;
}

export class AutomationManager {
  private tasks: ScheduledTask[] = [];
  private lastRuns = new Map<string, AutomationRunResult>();
  private defs: AutomationDef[] = [];

  constructor(private opts: AutomationManagerOptions) {}

  start(): AutomationDef[] {
    this.defs = loadAutomationDefs(this.opts.home);
    for (const def of this.defs) {
      const task = cronSchedule(
        def.schedule,
        () => {
          this.fire(def.name).catch((err) =>
            this.opts.logger.error({ msg: 'automation failed', name: def.name, err }),
          );
        },
        { timezone: def.timezone ?? process.env.TZ ?? 'America/Chicago' },
      );
      this.tasks.push(task);
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

  async fire(name: string): Promise<AutomationRunResult | null> {
    const def = this.defs.find((d) => d.name === name);
    if (!def) {
      this.opts.logger.warn({ msg: 'automation not found', name });
      return null;
    }
    const started = Date.now();
    this.opts.logger.info({ msg: 'automation firing', name });

    // Build a system prompt that frames the LLM as the agent running this
    // specific automation. We inject relevant CORTEX recall on the prompt
    // body so the automation has context, not raw recency.
    let recallContext = '';
    try {
      const r = await this.opts.cortex.recall(def.prompt, {
        tokenBudget: 2000,
        sensitivityFilter: ['public', 'internal'],
        // Last 21 days — automations look at fresh activity.
        since: new Date(Date.now() - 21 * 24 * 3600 * 1000),
      });
      recallContext = r.context;
    } catch (err) {
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
      'not pull anything actionable, say so cleanly — do not invent. Cite memory',
      'ids in (#nnnn) for any specific claim.',
      '',
      recallContext ? `<cortex_recall>\n${recallContext}\n</cortex_recall>` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const chain = this.opts.router.chainFor(def.name, this.opts.config.models);
    let reply = '';
    for (const provider of chain) {
      try {
        // If tools are provided, allow up to 6 steps so the model can call
        // gmail_search / cortex_recall etc. before composing the final reply.
        // Without tools (legacy automations), keep maxSteps=1 — pure text only.
        const hasTools = !!(this.opts.tools && Object.keys(this.opts.tools).length > 0);
        const stream = streamText({
          model: provider.model,
          system: sys,
          messages: [{ role: 'user', content: def.prompt }],
          maxRetries: 1,
          maxSteps: hasTools ? 6 : 1,
          ...(hasTools ? { tools: this.opts.tools } : {}),
        });
        let out = '';
        for await (const delta of stream.textStream) out += delta;
        if (out.trim()) {
          reply = out.trim();
          break;
        }
      } catch (err) {
        this.opts.logger.warn({ msg: 'automation provider failed', name, provider: provider.ref, err });
      }
    }
    if (!reply) {
      reply = `(${def.name} produced no output — provider chain exhausted)`;
    }

    // Push to operator channel if configured.
    const pushed: string[] = [];
    if (def.pushTo === 'telegram') {
      const tg = this.opts.channels.get('telegram');
      if (tg?.send && op?.channels.telegram[0]) {
        try {
          await tg.send({
            channel: 'telegram',
            to: op.channels.telegram[0],
            text: `🔔 ${def.name}\n\n${reply}`,
          });
          pushed.push('telegram');
        } catch (err) {
          this.opts.logger.warn({ msg: 'automation telegram push failed', name, err });
        }
      }
    }

    // Encode the automation output as a memory so future recalls see it.
    try {
      await this.opts.cortex.encode(`AUTOMATION ${def.name}:\n${reply}`, {
        source: `meridian:automation:${def.name}`,
        priority: 2,
        sensitivity: 'internal',
      });
    } catch (err) {
      this.opts.logger.warn({ msg: 'automation encode failed', name, err });
    }

    const result: AutomationRunResult = {
      name: def.name,
      ts: new Date().toISOString(),
      pushedTo: pushed,
      durationMs: Date.now() - started,
      reply,
    };
    this.lastRuns.set(def.name, result);
    this.opts.logger.info({
      msg: 'automation complete',
      name,
      durationMs: result.durationMs,
      pushed,
    });
    return result;
  }
}
