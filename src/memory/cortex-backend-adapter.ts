/**
 * CortexBackend adapter — bridges Meridian's runtime (CortexBind, ProviderRouter,
 * Voyage SDK) to the CortexBackend surface @aterna/quartz expects.
 *
 * Quartz is host-agnostic: it injects a CortexBackend with embed / llmComplete /
 * searchMemory / emitRecall and never imports CORTEX directly. This adapter is
 * the Meridian-side glue that satisfies that contract per agent. Per-agent
 * isolation: each agent's adapter carries its own VOYAGE_API_KEY, its own
 * ProviderRouter (wired with the agent's API keys), and its own CortexBind.
 */
import { generateText, type CoreMessage } from 'ai';
import { VoyageAIClient } from 'voyageai';

import type { CortexBind } from '../cortex/bind.js';
import type { ProviderRouter } from '../providers/router.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LlmCompleteOpts {
  maxTokens?: number;
  temperature?: number;
  system?: string;
  provider?: 'anthropic' | 'openai' | 'routexor';
  model?: string;
  apiKey?: string;
}

interface LlmCompleteResult {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface RawMemoryHit {
  id: number | string;
  sessionId?: string;
  content: string;
  score: number;
}

interface SearchMemoryOpts {
  agentId: number | string;
  query: string;
  topK: number;
}

export interface CortexBackend {
  embedTexts(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
  llmComplete(messages: ChatMessage[], opts: LlmCompleteOpts): Promise<LlmCompleteResult>;
  searchMemory(opts: SearchMemoryOpts): Promise<RawMemoryHit[]>;
  emitRecall?(opts: {
    agentId: number | string;
    memoryIds: Array<number | string>;
    query: string;
    source: string;
  }): void | Promise<void>;
}

export interface CortexBackendAdapterOptions {
  cortex: CortexBind;
  router: ProviderRouter;
  voyageApiKey: string;
  /** Voyage model id; defaults to "voyage-3.5". */
  voyageModel?: string;
  /** Default LLM model ref (e.g. "routexor/anthropic/claude-haiku-4.5"). */
  defaultModelRef?: string;
}

export class CortexBackendAdapter implements CortexBackend {
  private readonly cortex: CortexBind;
  private readonly router: ProviderRouter;
  private readonly voyage: VoyageAIClient;
  private readonly voyageModel: string;
  private readonly defaultModelRef: string;

  constructor(opts: CortexBackendAdapterOptions) {
    this.cortex = opts.cortex;
    this.router = opts.router;
    this.voyage = new VoyageAIClient({ apiKey: opts.voyageApiKey });
    this.voyageModel = opts.voyageModel ?? 'voyage-3.5';
    this.defaultModelRef = opts.defaultModelRef ?? 'routexor/anthropic/claude-haiku-4.5';
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.voyage.embed({
      input: texts,
      model: this.voyageModel,
      inputType: 'document',
    });
    const data = res.data ?? [];
    return data.map((d) => d.embedding ?? []);
  }

  async embedQuery(query: string): Promise<number[]> {
    const res = await this.voyage.embed({
      input: query,
      model: this.voyageModel,
      inputType: 'query',
    });
    const first = res.data?.[0]?.embedding;
    return first ?? [];
  }

  async llmComplete(messages: ChatMessage[], opts: LlmCompleteOpts): Promise<LlmCompleteResult> {
    const ref =
      opts.provider && opts.model
        ? `${opts.provider}/${opts.model}`
        : opts.model ?? this.defaultModelRef;

    const resolved = this.router.resolve(ref);

    const coreMessages: CoreMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const result = await generateText({
      model: resolved.model,
      system: opts.system,
      messages: coreMessages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature ?? 0,
    });

    return {
      content: result.text,
      usage: result.usage
        ? {
            inputTokens: result.usage.promptTokens ?? 0,
            outputTokens: result.usage.completionTokens ?? 0,
          }
        : undefined,
    };
  }

  async searchMemory(opts: SearchMemoryOpts): Promise<RawMemoryHit[]> {
    const recalled = await this.cortex.recall(opts.query, { tokenBudget: 16000 });
    return recalled.memories.slice(0, opts.topK).map((m) => ({
      id: m.id,
      content: m.content,
      score: m.score,
      sessionId: m.source ?? undefined,
    }));
  }

  emitRecall(_opts: {
    agentId: number | string;
    memoryIds: Array<number | string>;
    query: string;
    source: string;
  }): void {
    // CORTEX records recall events server-side via /api/v1/recall already.
    // No-op here keeps the contract honored without double-counting.
  }
}
