/**
 * Conversation: stateful wrapper around runTurn. Maintains AI-SDK
 * message history, session id, and gathers turn outputs for the session
 * store and the verification layer.
 */

import { randomUUID } from 'node:crypto';
import type { CoreMessage, ToolSet } from 'ai';
import type { MemoryProvider } from '../memory/provider.js';
import type { ProviderRouter } from '../providers/router.js';
import type { AgentConfig } from '../config/schema.js';
import type { Logger } from 'pino';
import type { MeridianTurn, MeridianSession } from './types.js';
import { runTurn, type TurnStreamEvent } from './turn.js';
import type { VerificationCheck } from '../config/schema.js';
import type { ProvenanceSigner } from '../verification/provenance.js';
import type { SessionStore, TurnTrace } from '../session/store.js';

export interface ConversationOptions {
  config: AgentConfig;
  /** Memory provider; CortexBind or QuartzMemoryProvider. */
  cortex: MemoryProvider;
  router: ProviderRouter;
  logger: Logger;
  systemBase: string;
  channel: MeridianTurn['channel'];
  tools?: ToolSet;
  /** Tool names sourced from v2 skills — auto-allowed in chat regardless
   *  of config.tools.chat (installation is the opt-in). */
  skillToolNames?: Set<string>;
  /** MCP tool channel gate — see TurnContext.mcpGate. */
  mcpGate?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Operator verification checks (VERIFICATION/*.checks.md), loaded at boot. */
  verificationChecks?: VerificationCheck[];
  /** Per-agent provenance signer for signed-trust mode (provenance.ts). */
  provenanceSigner?: ProvenanceSigner;
  resume?: MeridianSession;
  /** When set, every turn's reasoning trace is persisted to this store
   *  so /why and /trace can answer "what backed that claim?" later. */
  store?: SessionStore;
}

// Keep at most this many user/assistant entries in the in-memory history
// passed to the model. Recall fills in deeper context; longer history
// just bloats the system prompt and slows generation. 16 = ~8 turns.
const MAX_HISTORY_ENTRIES = 16;

export class Conversation {
  readonly sessionId: string;
  readonly agentSlug: string;
  private history: CoreMessage[] = [];
  private turns: MeridianTurn[] = [];

  constructor(private opts: ConversationOptions) {
    this.sessionId = opts.resume?.id ?? randomUUID();
    this.agentSlug = opts.config.agent.slug;
    if (opts.resume) {
      for (const t of opts.resume.turns) {
        this.history.push({
          role: t.role === 'tool' ? 'tool' : t.role,
          content: t.content,
        } as CoreMessage);
        this.turns.push(t);
      }
      this.trimHistory();
    }
  }

  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.splice(0, this.history.length - MAX_HISTORY_ENTRIES);
    }
  }

  async send(
    userInput: string,
    sendOpts?: { onStreamEvent?: (ev: TurnStreamEvent) => void },
  ): Promise<MeridianTurn> {
    const userTurn: MeridianTurn = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: this.sessionId,
      role: 'user',
      content: userInput,
      channel: this.opts.channel,
      ts: new Date().toISOString(),
    };
    this.turns.push(userTurn);

    const result = await runTurn(
      {
        sessionId: this.sessionId,
        config: this.opts.config,
        cortex: this.opts.cortex,
        router: this.opts.router,
        logger: this.opts.logger,
        tools: this.opts.tools,
        skillToolNames: this.opts.skillToolNames,
        mcpGate: this.opts.mcpGate,
        verificationChecks: this.opts.verificationChecks,
        provenanceSigner: this.opts.provenanceSigner,
        onStreamEvent: sendOpts?.onStreamEvent,
        history: [...this.history],
        channel: this.opts.channel,
        systemBase: this.opts.systemBase,
      },
      userInput,
    );

    this.history.push({ role: 'user', content: userInput });
    this.history.push({ role: 'assistant', content: result.reply });
    this.turns.push(result.turn);
    this.trimHistory();

    // Persist trace so /why + /trace work even after restart.
    if (this.opts.store) {
      try {
        const trace: TurnTrace = {
          turnId: result.turn.id,
          sessionId: this.sessionId,
          channel: this.opts.channel,
          model: result.trace.model,
          recallQuery: result.trace.recallQuery,
          recallMemoryIds: result.trace.recallMemoryIds,
          recallArtifactIds: result.trace.recallArtifactIds,
          recallTokenCount: result.trace.recallTokenCount,
          toolCalls: result.trace.toolCalls,
          userInput,
          reply: result.reply,
          durationMs: result.durationMs,
          ts: result.turn.ts,
        };
        this.opts.store.recordTrace(trace);
      } catch (err) {
        this.opts.logger.warn({ msg: 'trace persist failed', err });
      }
    }

    return result.turn;
  }

  snapshot(): MeridianSession {
    return {
      id: this.sessionId,
      agentSlug: this.agentSlug,
      createdAt: new Date().toISOString(),
      turns: [...this.turns],
    };
  }

  get historyCount(): number {
    return this.history.length;
  }

  reset(): void {
    this.history = [];
    this.turns = [];
  }
}
