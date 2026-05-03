/**
 * QuartzMemoryProvider — Meridian-side wrapper around the @aterna/quartz lib.
 *
 * Phase 3b scope: establish the seam. The wrapper holds a fully constructed
 * Quartz pipeline (recall router, observation extractor, answerer), delegates
 * the MemoryProvider surface to a backing CortexBind, and exposes the Quartz
 * library handle so later phases can route recall and answer paths through
 * the LongMemEval Tier 7 pipeline without touching the env switch or boot
 * wiring again.
 *
 * Why two QuartzMemoryProviders:
 *   - The class in @aterna/quartz is the cognitive pipeline (CORTEX-agnostic).
 *   - This class in @aterna/meridian is the runtime adapter that satisfies
 *     the MemoryProvider interface every Meridian subsystem already speaks.
 *
 * Per-agent isolation stays intact: one CortexBind, one Quartz pipeline,
 * one set of API keys per agent. The pipeline is constructed inside this
 * wrapper, not shared.
 */
import type {
  CortexHealth,
  CortexStats,
  DreamCycleResult,
  EncodeResult,
  RecallResult,
} from '../cortex/types.js';
import type { CortexBind } from '../cortex/bind.js';
import type {
  DreamCycleType,
  EncodeOptions,
  ListArtifactsOptions,
  ListArtifactsResult,
  MemoryProvider,
  RecallOptions,
} from './provider.js';

/**
 * Structural shape of @aterna/quartz's QuartzMemoryProvider — only the methods
 * we actually call from this wrapper. Keeps the no-hard-import discipline
 * intact while still giving us type-safe access to the fields we use.
 */
export interface QuartzPipeline {
  recall(input: {
    agentId: string | number;
    question: string;
    questionType?: string;
    sessionDates: Map<string, string>;
    store: null;
    includeRawWithObservations?: boolean;
  }): Promise<{
    context: string;
    retrievedSessionIds: string[];
    tokenCount: number;
  }>;
}

export interface QuartzLib {
  // Loose binding so this file does not hard-import @aterna/quartz at compile
  // time. The factory in `factory.ts` lazy-imports the package and constructs
  // the lib provider, then hands the shaped object in here.
  pipeline: QuartzPipeline;
}

export interface QuartzMemoryProviderOptions {
  cortex: CortexBind;
  /** Pre-constructed @aterna/quartz QuartzMemoryProvider instance + handles. */
  lib: QuartzLib;
}

export class QuartzMemoryProvider implements MemoryProvider {
  readonly agentId: string;
  private readonly cortex: CortexBind;
  /** Reserved for Phase 4+: route recall/answer paths through this. */
  readonly lib: QuartzLib;

  constructor(opts: QuartzMemoryProviderOptions) {
    this.cortex = opts.cortex;
    this.agentId = opts.cortex.agentId;
    this.lib = opts.lib;
  }

  async recall(query: string, opts?: RecallOptions): Promise<RecallResult> {
    // Parallel reads:
    //   cortex.recall   — canonical memories[] + artifacts[] for downstream
    //                     subsystems (turn loop, dream worker, channels).
    //   lib.pipeline.recall — Quartz's RecallRouter, raw-only mode (no
    //                     observation store). Returns a `[YYYY-MM-DD]
    //                     (session ID)`-prefixed context with token-budgeted
    //                     truncation; this is the formatted snippet the
    //                     answer LLM reads.
    //
    // Both calls hit localhost CORTEX (one direct, one through the adapter),
    // so combined wall-time is ~50ms. Phase 4+ optimization: collapse to a
    // single backend hit once the adapter caches the last recall.
    const [cortexResult, quartzCtx] = await Promise.all([
      this.cortex.recall(query, opts ?? {}),
      this.lib.pipeline.recall({
        agentId: this.agentId,
        question: query,
        sessionDates: new Map(),
        store: null,
      }),
    ]);
    return {
      context: quartzCtx.context,
      memories: cortexResult.memories,
      artifacts: cortexResult.artifacts,
      tokenCount: quartzCtx.tokenCount,
      tokenBudget: cortexResult.tokenBudget,
    };
  }

  listArtifacts(opts?: ListArtifactsOptions): Promise<ListArtifactsResult> {
    return this.cortex.listArtifacts(opts ?? {});
  }

  encode(content: string, opts?: EncodeOptions): Promise<EncodeResult> {
    return this.cortex.encode(content, opts ?? {});
  }

  dream(cycleType?: DreamCycleType): Promise<DreamCycleResult> {
    return this.cortex.dream(cycleType);
  }

  health(): Promise<CortexHealth> {
    return this.cortex.health();
  }

  stats(): Promise<CortexStats | null> {
    return this.cortex.stats();
  }

  reconsolidate(memoryId: number, content: string): Promise<{ ok: boolean }> {
    return this.cortex.reconsolidate(memoryId, content);
  }
}
