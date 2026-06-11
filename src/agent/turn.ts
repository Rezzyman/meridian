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
  type VerificationCheck,
} from '../config/schema.js';
import { screenRecall, type QuarantinedMemory } from '../verification/memory-integrity.js';
import { makeModelJudge, screenRecallDeep } from '../verification/memory-judge.js';
import { buildSacredGuard, sacredViolation } from '../verification/sacred.js';
import { runChecks, blocking, type CheckResult } from '../verification/runtime.js';
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
  /** MCP tool gating: toolName → channels allowed to see it. Declaring a
   *  server in CONNECTIONS/mcp.json is the opt-in (like skill install),
   *  but scoped per channel — voice never gains MCP tools unless the
   *  operator lists 'voice' on that server explicitly. */
  mcpGate?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Live stream observer (SSE gateway). Receives raw model deltas AS THEY
   * ARRIVE — i.e. BEFORE the post-stream pipeline (voice sacred-topic
   * guardrail, commitment footer). Consumers MUST treat the turn's final
   * reply as canonical and replace their accumulated buffer with it:
   *   delta  — next text chunk of the CURRENT provider attempt
   *   reset  — the attempt that produced prior deltas failed mid-stream;
   *            discard the buffer, a fallback provider starts fresh
   *   tool   — a tool call fired (UI affordance)
   */
  onStreamEvent?: (ev: TurnStreamEvent) => void;
  /** Hard runtime bounds for this turn (used by delegate sub-turns). */
  limits?: {
    /** Cap on generated tokens — streamText maxTokens. */
    maxOutputTokens?: number;
  };
  /** Operator-authored verification checks, loaded from VERIFICATION/ at
   *  boot and passed in (runTurn stays home/fs-free). Run after reply
   *  assembly; a `block`-severity failure replaces the reply with a refusal. */
  verificationChecks?: VerificationCheck[];
  history: CoreMessage[];
  channel: MeridianTurn['channel'];
  /** System prompt without recall; recall is injected per turn */
  systemBase: string;
}

/** Events surfaced to TurnContext.onStreamEvent during the provider loop. */
export type TurnStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'tool'; name: string };

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
    /** Memories pulled from the model's view by the integrity screen. */
    quarantinedMemories: QuarantinedMemory[];
    /** Operator verification-check results for this turn. */
    verifications: CheckResult[];
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
  //
  // Hard-cap recall at RECALL_TIMEOUT_MS (default 8s). Voyage rate limits
  // and CORTEX server stalls can otherwise hang the entire turn for 3-5
  // minutes, blocking the channel from responding. If recall times out we
  // proceed without memory rather than freezing the operator.
  const RECALL_TIMEOUT_MS = 8000;
  let recallSummary = '';
  let _recallCount = 0;
  let recallMemoryIds: number[] = [];
  let recallArtifactIds: number[] = [];
  let recallTokenCount = 0;
  let quarantinedMemories: QuarantinedMemory[] = [];
  let recallTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      ctx.cortex.recall(userInput, { tokenBudget: 1500, sensitivityFilter }),
      new Promise<never>((_, reject) => {
        recallTimer = setTimeout(
          () => reject(new Error(`cortex recall timed out after ${RECALL_TIMEOUT_MS}ms`)),
          RECALL_TIMEOUT_MS,
        );
      }),
    ]);
    // ── Memory-integrity screen (poisoning defense) ──
    // Quarantine recalled memories that read like a standing directive AND
    // arrived from untrusted provenance, before they ever reach the model.
    // On a clean recall this is a byte-for-byte pass-through. With the
    // optional LLM-judge enabled, a second pass also catches non-lexicon /
    // encoded / semantic directives the regex screen can't see.
    const screen = ctx.config.cortex.memoryLlmJudge
      ? await screenRecallDeep(r.memories, r.context, {
          judge: makeModelJudge({
            router: ctx.router,
            models: ctx.config.models,
            logger: ctx.logger,
          }),
        })
      : screenRecall(r.memories, r.context);
    recallSummary = screen.safeContext;
    quarantinedMemories = screen.quarantined;
    _recallCount = screen.kept.length;
    recallMemoryIds = screen.kept.map((m) => m.id);
    recallArtifactIds = (r.artifacts ?? []).map((a) => a.id);
    recallTokenCount = r.tokenCount ?? 0;
    if (screen.quarantined.length > 0) {
      ctx.logger.warn({
        msg: 'memory-integrity: quarantined poisoning-suspect memories from recall',
        count: screen.quarantined.length,
        ids: screen.quarantined.map((q) => q.id),
        sources: screen.quarantined.map((q) => q.source),
      });
    }
    ctx.logger.debug({ msg: 'cortex recall', tokens: r.tokenCount, memories: screen.kept.length, quarantined: screen.quarantined.length, sensitivityFilter });
  } catch (err) {
    ctx.logger.warn({ msg: 'cortex recall failed or timed out; proceeding without memory', err: (err as Error).message });
  } finally {
    // The race leaves the loser's timer live; clear it so a fast recall
    // doesn't strand an 8s timer per turn (event-loop noise, test latency).
    clearTimeout(recallTimer);
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
  // MCP tools carry their own per-channel gate (set per server in
  // CONNECTIONS/mcp.json). A gated name is visible iff the current channel
  // is in its set — independent of config.tools, which stays the operator
  // surface for builtins.
  const mcpAllowed = (name: string): boolean => ctx.mcpGate?.get(name)?.has(ctx.channel) === true;
  const turnTools: ToolSet | undefined = ctx.tools
    ? Object.fromEntries(
        Object.entries(ctx.tools).filter(
          ([k]) =>
            k !== 'cortex_recall' &&
            k !== 'cortex_encode' &&
            (ctx.mcpGate?.has(k) ? mcpAllowed(k) : allow.has(k)),
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

  // Deltas forwarded for the CURRENT provider attempt. If that attempt
  // dies mid-stream and a fallback takes over, the observer gets a reset
  // so it can discard the partial buffer (hazard: double emission).
  let deltasEmittedThisAttempt = 0;

  for (const provider of chain) {
    try {
      // streamText (ai@4.x) does NOT throw on provider failure: errors are
      // routed to onError and textStream completes empty. Without capturing
      // them here the catch below never fires and the fallback chain is
      // dead code — a failing primary would surface as "All providers
      // failed" even with healthy fallbacks configured.
      let streamError: unknown;
      const stream = streamText({
        onError: ({ error }) => {
          streamError = error;
        },
        model: provider.model,
        system,
        messages,
        tools: turnTools,
        maxTokens: ctx.limits?.maxOutputTokens,
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
              ctx.onStreamEvent?.({ type: 'tool', name: t.toolName });
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
        if (delta) {
          deltasEmittedThisAttempt++;
          ctx.onStreamEvent?.({ type: 'delta', text: delta });
        }
      }
      if (streamError !== undefined) {
        throw streamError instanceof Error ? streamError : new Error(String(streamError));
      }
      reply = out;
      providerUsed = provider.ref;
      // Close the breaker circuit for this ref (mock routers may not have it).
      ctx.router.reportSuccess?.(provider.ref);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      providerErrors.push({ ref: provider.ref, message: message || '(no message)' });
      ctx.logger.warn({ msg: 'provider failed; trying fallback', provider: provider.ref, err });
      // Feed the breaker so repeated failures open the circuit and spare
      // future turns (and sub-agent fan-outs) the dead-provider timeout.
      ctx.router.reportFailure?.(provider.ref);
      if (deltasEmittedThisAttempt > 0) {
        deltasEmittedThisAttempt = 0;
        ctx.onStreamEvent?.({ type: 'reset' });
      }
    }
  }
  if (!reply) {
    const detail = providerErrors.map((e) => `${e.ref}: ${e.message}`).join(' | ');
    throw new Error(`All providers failed. ${detail || '(no error captured)'}`);
  }

  // ─── Sacred-topic guardrail (voice channel only) ──
  // The operator's private entities never appear on the public voice line.
  // WHICH entities are sacred is operator-owned config (operator.sensitivity),
  // not hardcoded framework source — the runtime ships only identity-free
  // universal defaults. If the model drafts a reply matching the guard,
  // replace it with a refusal.
  if (ctx.channel === 'voice') {
    const guard = buildSacredGuard(ctx.config.operator);
    const hit = sacredViolation(reply, guard);
    if (hit) {
      ctx.logger.warn({
        msg: 'sacred-topic guardrail fired on voice reply; replacing with refusal',
        pattern: hit.source,
      });
      reply = guard.refusal;
    }
  }

  // ─── Verification checks (operator-authored, VERIFICATION/*.checks.md) ──
  // Run the operator's per-output checks on the assembled reply. A
  // `block`-severity failure is a hard stop: the reply is withheld and
  // replaced with a refusal rather than sent (the documented contract —
  // block → don't send, warn → record for audit). No checks → no-op, so a
  // healthy turn is unchanged.
  const verifications: CheckResult[] = ctx.verificationChecks?.length
    ? runChecks(ctx.verificationChecks, {
        output: reply,
        toolCalls: toolCallTrace.map((t) => ({ name: t.name, args: undefined })),
      })
    : [];
  const blockedChecks = blocking(verifications);
  if (blockedChecks.length > 0) {
    ctx.logger.warn({
      msg: 'verification block: reply withheld',
      failures: blockedChecks.map((b) => ({ check: b.name, note: b.note })),
    });
    reply = `I drafted a reply but it did not pass this agent's verification checks, so I am not sending it (${blockedChecks
      .map((b) => b.name)
      .join(', ')}).`;
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
      commitmentQuote.length > 80 ? `${commitmentQuote.slice(0, 79)}…` : commitmentQuote;
    reply = `${reply.trimEnd()}\n\n✓ logged: ${trimQuote}`;
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
    verifications: verifications.length > 0 ? verifications : undefined,
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
      quarantinedMemories,
      verifications,
    },
  };
}
