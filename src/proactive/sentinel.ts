/**
 * Proactive sentinel — what makes Meridian a partner, not a chatbot.
 *
 * Runs in-process on a cron schedule. Each tick:
 *   1. Recalls memories tagged "open commitment", "pending decision",
 *      "stale thread" via CORTEX queries.
 *   2. Composes a tight morning brief through the agent's primary model.
 *   3. Pushes the brief to the operator on their preferred push channel.
 *
 * No tool calls. No shell. Recall + LLM + outbound message. The agent
 * SURFACES things on its own initiative — that's the magic.
 */

import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import { streamText } from 'ai';
import type { Logger } from 'pino';
import type { MemoryProvider } from '../memory/provider.js';
import type { ProviderRouter } from '../providers/router.js';
import type { AgentConfig, OperatorConfig } from '../config/schema.js';
import type { ChannelAdapter } from '../channels/types.js';

export interface SentinelOptions {
  config: AgentConfig;
  cortex: MemoryProvider;
  router: ProviderRouter;
  logger: Logger;
  /** Map of channel-name → ChannelAdapter for outbound push (telegram, vapi, etc.). */
  channels: Map<string, ChannelAdapter>;
  /** Agent name for brief preamble. */
  agentName: string;
  /** Read-only IDENTITY/USER text, used as the brief's persona anchor. */
  systemBase: string;
}

export interface ProactiveBrief {
  preamble: string;
  body: string;
  pushedTo: string[];
  durationMs: number;
}

export class ProactiveSentinel {
  private morningTask: ScheduledTask | null = null;
  private nudgeTask: ScheduledTask | null = null;
  private lastBriefAt: Date | null = null;

  constructor(private opts: SentinelOptions) {}

  start(): void {
    const cfg = this.opts.config.proactive;
    if (!cfg?.enabled) {
      this.opts.logger.info({ msg: 'proactive sentinel disabled by config' });
      return;
    }
    if (cfg.morningBriefSchedule) {
      this.morningTask = cronSchedule(
        cfg.morningBriefSchedule,
        () => {
          this.fireMorningBrief().catch((err) =>
            this.opts.logger.error({ msg: 'morning brief failed', err }),
          );
        },
        { timezone: process.env.TZ ?? 'America/Chicago' },
      );
      this.opts.logger.info({
        msg: 'morning brief scheduled',
        schedule: cfg.morningBriefSchedule,
      });
    }
    if (cfg.hourlyNudgesEnabled && cfg.hourlyNudgeSchedule) {
      this.nudgeTask = cronSchedule(
        cfg.hourlyNudgeSchedule,
        () => {
          this.fireNudgeIfWarranted().catch((err) =>
            this.opts.logger.error({ msg: 'hourly nudge failed', err }),
          );
        },
        { timezone: process.env.TZ ?? 'America/Chicago' },
      );
      this.opts.logger.info({
        msg: 'hourly nudge scheduled',
        schedule: cfg.hourlyNudgeSchedule,
      });
    }
  }

  stop(): void {
    this.morningTask?.stop();
    this.nudgeTask?.stop();
  }

  /** Trigger a morning brief on demand. Used by /brief slash command + cron. */
  async fireMorningBrief(): Promise<ProactiveBrief> {
    const started = Date.now();
    const op = this.opts.config.operator;
    const greeting = op?.name ? `Good morning, ${op.name.split(' ')[0]}.` : 'Good morning.';

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const sinceTwoWeeks = new Date(today.getTime() - 14 * 24 * 3600 * 1000);
    const sinceTwoWeeksStr = sinceTwoWeeks.toISOString().slice(0, 10);

    // ── Step 1: read what the agent ALREADY flagged as important overnight ──
    // The reflector + online observer run in CORTEX; their cognitive_artifacts
    // are the agent's own analysis of what matters. Surfacing those is way
    // better signal than blind recall on generic queries.
    let artifacts: Awaited<ReturnType<typeof this.opts.cortex.listArtifacts>>['artifacts'] = [];
    try {
      const r = await this.opts.cortex.listArtifacts({ sinceHours: 36, limit: 8 });
      artifacts = r.artifacts;
    } catch (err) {
      this.opts.logger.warn({ msg: 'sentinel listArtifacts failed', err });
    }

    // ── Step 2: derive recall queries from the artifact topics ──
    // For each artifact, pull deep recall on the cluster topics it flagged
    // (with a hard freshness floor so we never surface stale memories).
    // If there are no recent artifacts, fall back to date-anchored generic
    // queries so the brief still has something to chew on.
    const queries: string[] = [];
    for (const a of artifacts.slice(0, 5)) {
      const c = a.content as Record<string, unknown>;
      const topic =
        (typeof c?.title === 'string' && c.title) ||
        (typeof c?.summary === 'string' && c.summary) ||
        (typeof c?.cluster === 'string' && c.cluster) ||
        (Array.isArray(c?.entities) ? (c.entities as string[]).slice(0, 3).join(', ') : '');
      if (topic && typeof topic === 'string') queries.push(topic.slice(0, 200));
    }
    if (queries.length === 0) {
      queries.push(
        `open commitments and todos due this week ${todayStr}`,
        `decisions awaiting approval recent pending`,
        `unanswered messages follow-ups past 7 days`,
      );
    }

    const recalls: Array<{ topic: string; context: string; count: number }> = [];
    for (const q of queries) {
      try {
        const r = await this.opts.cortex.recall(q, {
          tokenBudget: 2500,
          sensitivityFilter: ['public', 'internal'],
          // Hard freshness floor — CORTEX-side date filter, no stale
          // memories will pass through regardless of cosine similarity.
          since: sinceTwoWeeks,
        });
        recalls.push({ topic: q, context: r.context, count: r.memories.length });
      } catch (err) {
        this.opts.logger.warn({ msg: 'sentinel recall failed', q, err });
      }
    }

    // ── Step 3: compose brief weighting artifact-flagged stuff highest ──
    const artifactBlock =
      artifacts.length > 0
        ? `<reflector_artifacts since="last 36h">\n${artifacts
            .map(
              (a) =>
                `### ${a.type} #${a.id} (${a.createdAt})\n${JSON.stringify(a.content, null, 2)}`,
            )
            .join('\n\n')}\n</reflector_artifacts>`
        : '';

    const briefingPrompt = [
      this.opts.systemBase,
      '',
      '## YOUR ASSIGNMENT — MORNING BRIEF',
      '',
      `Today is ${todayStr}.`,
      '',
      'Sources you have:',
      '  1. **Reflector artifacts from the last 36 hours** — your own overnight',
      '     analysis of what is important. These are the strongest signal.',
      '  2. **Recent memories** — pulled with a hard freshness floor of',
      `     ${sinceTwoWeeksStr}. Anything older has been filtered out at`,
      '     the database layer; you will not see stale rows.',
      '',
      '**Compose rules:**',
      '- Lead with what the reflector flagged. Cite artifact ids (#nnnn).',
      '- If a reflector cluster names specific entities, weave the deep-recall',
      '  memories that match into the same bullet so the operator can act.',
      '- If the recall blocks are thin, that is FINE — short brief is honest.',
      '- If you have nothing to surface, say so cleanly:',
      `  "${greeting} Quiet plate this morning. Drop me a note if you want me`,
      '  to track something specific."',
      '- No filler, no closing pleasantries.',
      '',
      'Format:',
      '',
      `${greeting} Here's what's on your plate today:`,
      '',
      '**Top of mind** (the 1-3 things that genuinely matter THIS WEEK)',
      '**Awaiting your call** (decisions or replies the operator owes)',
      '**Watching for you** (things you are tracking on their behalf)',
      '',
      'Keep the whole brief under 14 lines.',
      '',
      artifactBlock,
      ...recalls.map((r) => `<memories topic="${r.topic}">\n${r.context}\n</memories>`),
    ].join('\n');

    const chain = this.opts.router.chainFor('morning brief', this.opts.config.models);
    let body = '';
    for (const provider of chain) {
      try {
        const stream = streamText({
          model: provider.model,
          system: briefingPrompt,
          messages: [{ role: 'user', content: 'Compose my morning brief now.' }],
          maxRetries: 1,
          maxSteps: 1,
        });
        let out = '';
        for await (const delta of stream.textStream) out += delta;
        if (out.trim()) {
          body = out.trim();
          break;
        }
      } catch (err) {
        this.opts.logger.warn({ msg: 'sentinel provider failed', provider: provider.ref, err });
      }
    }
    if (!body) {
      body = `${greeting} I don't have anything pressing surfaced this morning — quiet plate, or my recall came up empty. Drop me a note if there's something I should be tracking.`;
    }

    // Push to the operator's preferred morning channel.
    const pushed = await this.pushToOperator(body, op);

    this.lastBriefAt = new Date();
    const result: ProactiveBrief = {
      preamble: greeting,
      body,
      pushedTo: pushed,
      durationMs: Date.now() - started,
    };
    this.opts.logger.info({
      msg: 'morning brief delivered',
      pushedTo: pushed,
      durationMs: result.durationMs,
    });
    return result;
  }

  /**
   * Hourly nudge. Scans recent activity; only sends a message if something
   * is genuinely overdue or noteworthy. Silence is the default — the
   * operator should NEVER feel spammed.
   */
  async fireNudgeIfWarranted(): Promise<ProactiveBrief | null> {
    const op = this.opts.config.operator;
    let body = '';
    try {
      const r = await this.opts.cortex.recall('overdue urgent action required today', {
        tokenBudget: 400,
        sensitivityFilter: ['public', 'internal'],
      });
      if (r.memories.length === 0) return null;
      // Compose a 1-2 line nudge. If the model thinks nothing is genuinely
      // urgent, it should return an empty string.
      const chain = this.opts.router.chainFor('nudge', this.opts.config.models);
      const sys = [
        this.opts.systemBase,
        '',
        '## YOUR ASSIGNMENT — POSSIBLE NUDGE',
        '',
        'Decide if any of the recalled memories below represents something the operator needs to act on RIGHT NOW. If yes, write a single 1-2 line nudge in their voice. If nothing is genuinely urgent, return literally `__skip__` and nothing else. Be very conservative — quiet is the default.',
        '',
        `<memories>\n${r.context}\n</memories>`,
      ].join('\n');
      for (const provider of chain) {
        try {
          const stream = streamText({
            model: provider.model,
            system: sys,
            messages: [{ role: 'user', content: 'Compose a nudge or return __skip__.' }],
            maxRetries: 1,
            maxSteps: 1,
          });
          let out = '';
          for await (const delta of stream.textStream) out += delta;
          body = out.trim();
          break;
        } catch {
          /* try next provider */
        }
      }
      if (!body || body.includes('__skip__')) return null;
    } catch (err) {
      this.opts.logger.warn({ msg: 'nudge recall failed', err });
      return null;
    }
    const pushed = await this.pushToOperator(body, op);
    const result: ProactiveBrief = {
      preamble: '',
      body,
      pushedTo: pushed,
      durationMs: 0,
    };
    this.opts.logger.info({ msg: 'nudge sent', pushedTo: pushed });
    return result;
  }

  state(): { lastBriefAt: Date | null } {
    return { lastBriefAt: this.lastBriefAt };
  }

  private async pushToOperator(text: string, op?: OperatorConfig): Promise<string[]> {
    const pushed: string[] = [];
    const tg = this.opts.channels.get('telegram');
    if (tg?.send && op?.channels.telegram[0]) {
      try {
        await tg.send({ channel: 'telegram', to: op.channels.telegram[0], text });
        pushed.push('telegram');
      } catch (err) {
        this.opts.logger.warn({ msg: 'telegram push failed', err });
      }
    }
    return pushed;
  }
}
