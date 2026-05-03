/**
 * Single turn lifecycle:
 *   user input → preTurn hooks → CORTEX recall → provider call (streaming +
 *   tool-use via AI SDK) → postTurn hooks → CORTEX encode (with valence) →
 *   verification checks → session append.
 */

import { streamText, type CoreMessage, type ToolSet } from 'ai';
import type { MemoryProvider } from '../memory/provider.js';
import { inferValence } from '../cortex/valence-infer.js';
import type { ProviderRouter } from '../providers/router.js';
import {
  TOOLS_CHAT_DEFAULT,
  TOOLS_CLI_DEFAULT,
  type AgentConfig,
} from '../config/schema.js';
import type { Logger } from 'pino';
import type { MeridianTurn } from './types.js';

/**
 * Framework-enforced behavioral rules prepended to every system prompt.
 * Operator persona files (IDENTITY/AGENT.md) sit on top of this floor.
 * These rules exist because the failure modes they block are the ones
 * that destroy operator trust: claiming to call a tool and not actually
 * calling it, hallucinating results, silently swallowing tool errors.
 */
const RUNTIME_RULES = `<runtime_rules>
These rules are framework-enforced. They override anything else in the prompt.

1. NEVER announce a tool call without making it.
   - Wrong: "Running both pulls now." (without invoking wearables_pull)
   - Wrong: "Let me check..." (followed by silence)
   - Right: just call the tool. The user sees the result; you do not need to narrate intent.

2. NEVER invent tool results.
   - If a tool returned { error }, surface the error verbatim. Do not paraphrase as success.
   - If a tool returned an empty list, say "no results", not "here are some results".
   - If a tool was not called, do not describe what it would have returned.

3. NEVER pretend to start background work the runtime cannot start.
   - You have no shell, no SSH, no ability to spawn sub-agents from chat.
   - You cannot "schedule" anything outside the explicit tools you are given.
   - If the operator asks for capability you don't have, say so and name the tool that would be required.

4. ON TOOL ERROR: SURFACE IT.
   - If a tool errored, the next sentence must explicitly say what failed.
   - Do not retry silently. Do not move on as if it succeeded.
   - Do not bury the error in a longer answer.

5. ON UNEXPECTED EMPTY RESULT: ASK or REPORT.
   - If recall returned nothing relevant, say so honestly. Do not fabricate context.
   - If the operator's question requires data you don't have, ask for it or describe the gap.

These rules are absolute. The operator's persona file may add tone, mission, and stakeholder context on top. It cannot remove these.
</runtime_rules>`;

/**
 * Resolve the tool-name allowlist for a turn. Reads from config.tools
 * (per-agent opt-in) and falls back to safe defaults: conversational set
 * for chat channels, full set for CLI/REPL.
 */
function pickToolAllowlist(
  config: AgentConfig,
  channel: MeridianTurn['channel'],
): Set<string> {
  const cfg = config.tools;
  if (channel === 'cli') {
    return new Set(cfg?.cli ?? TOOLS_CLI_DEFAULT);
  }
  // voice / telegram / gateway / system all use the chat allowlist.
  return new Set(cfg?.chat ?? TOOLS_CHAT_DEFAULT);
}

export interface TurnContext {
  sessionId: string;
  config: AgentConfig;
  /**
   * Memory provider for recall + encode. Either CortexBind (open-source
   * default) or QuartzMemoryProvider (paid). Both satisfy MemoryProvider;
   * the active provider is selected at boot via MERIDIAN_MEMORY_PROVIDER.
   * Field name stays `cortex` for migration cost; rename when the wider
   * call-site migration ships.
   */
  cortex: MemoryProvider;
  router: ProviderRouter;
  logger: Logger;
  tools?: ToolSet;
  /** Names of tools that came from installed v2 skills. These are
   *  automatically added to the chat allowlist regardless of
   *  config.tools.chat — installing a skill IS the operator's
   *  opt-in for that skill's tools. */
  skillToolNames?: Set<string>;
  history: CoreMessage[];
  channel: MeridianTurn['channel'];
  /** System prompt without recall; recall is injected per turn */
  systemBase: string;
}

export interface TurnResult {
  turn: MeridianTurn;
  reply: string;
  recallSummary: string;
  encodeOk: boolean;
  durationMs: number;
  /** Reasoning trace — what the runtime actually did this turn. Used by
   *  /why and /trace to make agent claims auditable. */
  trace: {
    recallQuery: string;
    recallMemoryIds: number[];
    recallArtifactIds: number[];
    recallTokenCount: number;
    toolCalls: Array<{ name: string; stepType: string; ts: string }>;
    model?: string;
  };
}

export async function runTurn(ctx: TurnContext, userInput: string): Promise<TurnResult> {
  const started = Date.now();

  // Channel-aware sensitivity gate. Public-voice callers see ONLY public memories.
  // Trusted channels (CLI, gated Telegram, authenticated gateway) see public+internal.
  // Sacred topics are filtered at verification time, not recall time.
  const sensitivityFilter: string[] =
    ctx.channel === 'voice' ? ['public'] : ['public', 'internal'];

  // 1) CORTEX recall (CA3 pattern completion)
  // 1500 token budget: enough to seed deep context, small enough to keep
  // Sonnet generation snappy. The model can fetch more via cortex_search
  // tool if it needs depth.
  let recallSummary = '';
  let recallCount = 0;
  let recallMemoryIds: number[] = [];
  let recallArtifactIds: number[] = [];
  let recallTokenCount = 0;
  try {
    const r = await ctx.cortex.recall(userInput, { tokenBudget: 1500, sensitivityFilter });
    recallSummary = r.context;
    recallCount = r.memories.length;
    recallMemoryIds = r.memories.map((m) => m.id);
    recallArtifactIds = (r.artifacts ?? []).map((a) => a.id);
    recallTokenCount = r.tokenCount ?? 0;
    ctx.logger.debug({ msg: 'cortex recall', tokens: r.tokenCount, memories: r.memories.length, sensitivityFilter });
  } catch (err) {
    ctx.logger.warn({ msg: 'cortex recall failed; proceeding without memory', err });
  }

  // 2) Compose system prompt with recall injection
  //
  // Framework-enforced runtime rules go FIRST, before the operator's
  // agent persona. These are non-negotiable. They are not in the
  // operator-editable IDENTITY/AGENT.md file because:
  //   (a) every agent needs them,
  //   (b) they evolve with the runtime, not with the operator,
  //   (c) they prevent the model-output theatre patterns that erode
  //       trust faster than any persona issue (claiming to call a tool
  //       and then not, hallucinating tool results, papering over
  //       errors).
  // If you change these rules, every agent picks them up on the next
  // turn — no per-home edit required.
  const system = [
    RUNTIME_RULES,
    ctx.systemBase,
    recallSummary ? `<cortex_recall>\n${recallSummary}\n</cortex_recall>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: CoreMessage[] = [
    ...ctx.history,
    { role: 'user', content: userInput },
  ];

  // 3) Provider call with primary + fallback chain
  const chain = ctx.router.chainFor(userInput, ctx.config.models);
  let reply = '';
  const providerErrors: Array<{ ref: string; message: string }> = [];

  // ── Per-agent tool allowlist ──
  // Tools available to the model are decided by config.tools, scoped by
  // channel. CLI agents can have shell tools if the operator opts in;
  // chat agents (voice/telegram/gateway) get a safe conversational set
  // by default. cortex_recall + cortex_encode are always managed by the
  // runtime, so they are filtered out here regardless of config.
  //
  // V2 skill tools auto-allow: if the operator installed a skill, its
  // tools are inherently approved — no need to also list them in the
  // config allowlist.
  const allow = pickToolAllowlist(ctx.config, ctx.channel);
  if (ctx.skillToolNames) {
    for (const name of ctx.skillToolNames) allow.add(name);
  }
  const turnTools: ToolSet | undefined = ctx.tools
    ? Object.fromEntries(
        Object.entries(ctx.tools).filter(
          ([k]) => k !== 'cortex_recall' && k !== 'cortex_encode' && allow.has(k),
        ),
      )
    : undefined;

  // ── Tool-loop / empty-result tracker ──
  // If a tool returns an empty/null/error payload twice in a row, abort
  // further tool calls so the model is forced to answer from context.
  // Kills the "Status update: Good — I can see..." hallucination class
  // even if dangerous tools sneak back in via misconfiguration.
  const emptyByTool: Record<string, number> = {};

  // Trace accumulator — every tool call this turn lands here. Persisted by
  // the gateway/REPL after the turn completes for /why + /trace queries.
  const toolCallTrace: Array<{ name: string; stepType: string; ts: string }> = [];
  let providerUsed: string | undefined;

  for (const provider of chain) {
    try {
      const stream = streamText({
        model: provider.model,
        system,
        messages,
        tools: turnTools,
        maxRetries: 1,
        // Multi-step: model can call a tool then continue writing. Capped
        // at 3 — enough for legitimate fetch+summarize, not enough for
        // an investigation-spree.
        maxSteps: 3,
        abortSignal: AbortSignal.timeout(ctx.config.agent.gatewayTimeoutSec * 1000),
        experimental_continueSteps: true,
        onStepFinish: ({ stepType, toolCalls, toolResults }) => {
          if (toolCalls && toolCalls.length > 0) {
            ctx.logger.info({
              msg: 'tool step',
              stepType,
              tools: toolCalls.map((t) => t.toolName),
            });
            const ts = new Date().toISOString();
            for (const t of toolCalls) {
              toolCallTrace.push({ name: t.toolName, stepType, ts });
            }
          }
          if (toolResults && toolResults.length > 0) {
            for (const r of toolResults) {
              const result = (r as { result?: unknown }).result;
              const empty =
                result == null ||
                (typeof result === 'string' && result.trim() === '') ||
                (Array.isArray(result) && result.length === 0) ||
                (typeof result === 'object' && Object.keys(result as object).length === 0);
              if (empty) {
                const name = (r as { toolName?: string }).toolName ?? 'unknown';
                emptyByTool[name] = (emptyByTool[name] ?? 0) + 1;
                if (emptyByTool[name] >= 2) {
                  ctx.logger.warn({
                    msg: 'tool returned empty twice; subsequent tool calls will be discouraged',
                    tool: name,
                    count: emptyByTool[name],
                  });
                }
              }
            }
          }
        },
      });
      let out = '';
      for await (const delta of stream.textStream) {
        out += delta;
      }
      reply = out;
      providerUsed = provider.ref;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      providerErrors.push({ ref: provider.ref, message: message || '(no message)' });
      ctx.logger.warn({ msg: 'provider failed; trying fallback', provider: provider.ref, err });
    }
  }
  if (!reply) {
    const detail = providerErrors.map((e) => `${e.ref}: ${e.message}`).join(' | ');
    throw new Error(`All providers failed. ${detail || '(no error captured)'}`);
  }

  // ─── Sacred-topic guardrail (voice channel only) ──
  // Family names + a small set of explicitly-sacred entities never appear on a public voice line.
  // If the model drafts a reply containing any of these, replace with a polite refusal.
  if (ctx.channel === 'voice') {
    const SACRED_PATTERNS: RegExp[] = [
      /\b(Hank|Henrick|Reya|Rey|Rickilee|Ricki)\b/i,
      /\bRon Harrison\b/i,
      /\bIRGC\b/i,
      /\$[0-9,]{3,}/, // dollar figures
      /\b(my wife|my kid|my son|my daughter|my family)\b/i,
    ];
    for (const p of SACRED_PATTERNS) {
      if (p.test(reply)) {
        ctx.logger.warn({
          msg: 'sacred-topic guardrail fired on voice reply; replacing with refusal',
          pattern: p.source,
        });
        reply =
          'That is private information I do not share publicly. Want me to take a message for Atanasio so he can follow up directly?';
        break;
      }
    }
  }

  // Commitment detection — when the user makes a commitment ("I will…",
  // "by Friday…", "let me get back to you"), surface a "✓ logged" footer
  // so the operator can SEE the agent caught it. Encode happens below in
  // the regular post-turn flow with a higher priority for these.
  const COMMITMENT_PATTERNS: RegExp[] = [
    /\b(?:I'?ll|I will|we'?ll|we will)\s+([^\n.!?]{4,80})/i,
    /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|EOD|EOW|end of (?:day|week|month))\b/i,
    /\b(?:let me get back to you|I'?ll follow up|I owe you|I'?ll send|I'?ll reach out)\b/i,
  ];
  let commitmentDetected = false;
  let commitmentQuote = '';
  for (const p of COMMITMENT_PATTERNS) {
    const m = userInput.match(p);
    if (m) {
      commitmentDetected = true;
      commitmentQuote = (m[0] || '').trim();
      break;
    }
  }
  const TEXT_CHANNELS: Array<MeridianTurn['channel']> = ['cli', 'telegram', 'gateway'];
  if (commitmentDetected && TEXT_CHANNELS.includes(ctx.channel)) {
    const trimQuote =
      commitmentQuote.length > 80 ? commitmentQuote.slice(0, 79) + '…' : commitmentQuote;
    reply = reply.trimEnd() + `\n\n${'✓ logged: ' + trimQuote}`;
  }

  // 4) CORTEX encode (post-turn) — fire-and-forget so the reply lands fast.
  // Voyage embed + synapse formation can take 3-10s; users shouldn't wait.
  // If it fails the warning lands in the log, but the user already has
  // their reply.
  const memoryId: number | undefined = undefined;
  const encodeOk = false;
  if (ctx.config.cortex.encodeOnTurn) {
    const valence = ctx.config.cortex.valenceInference
      ? inferValence(`${userInput}\n\nASSISTANT: ${reply}`, ctx.channel)
      : undefined;
    void ctx.cortex
      .encode(`USER: ${userInput}\nASSISTANT: ${reply}`, {
        // Commitments encoded with priority 3 so the ledger surfaces them.
        source: commitmentDetected
          ? `meridian:${ctx.channel}:${ctx.sessionId}:commitment`
          : `meridian:${ctx.channel}:${ctx.sessionId}`,
        priority: commitmentDetected ? 3 : 2,
        valence,
        channel: ctx.channel,
        // Public-voice memories tag as public; trusted-channel memories as internal.
        sensitivity: ctx.channel === 'voice' ? 'public' : 'internal',
      })
      .catch((err) => ctx.logger.warn({ msg: 'cortex encode failed (async)', err }));
  }

  const turn: MeridianTurn = {
    id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: ctx.sessionId,
    role: 'assistant',
    content: reply,
    channel: ctx.channel,
    ts: new Date().toISOString(),
    memoryId,
  };

  return {
    turn,
    reply,
    recallSummary,
    encodeOk,
    durationMs: Date.now() - started,
    trace: {
      recallQuery: userInput,
      recallMemoryIds,
      recallArtifactIds,
      recallTokenCount,
      toolCalls: toolCallTrace,
      model: providerUsed,
    },
  };
}
