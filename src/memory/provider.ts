/**
 * MemoryProvider — the abstract memory surface every Meridian agent boots with.
 *
 * Meridian itself is open-source. CORTEX is the open-source default substrate.
 * The MemoryProvider seam is what lets ATERNA ship Quartz — a closed,
 * source-available recall pipeline (BSL-1.1) — as a drop-in replacement for
 * agents that license it. From the rest of Meridian's perspective, both look
 * identical: same shape, same return types, same agent-isolated semantics.
 *
 * Per-agent isolation is contractual. Every provider instance binds to a
 * single agentId and a single memory backend. Sharing a provider across
 * agents is a contract violation, regardless of the implementation.
 *
 * The interface mirrors CortexBind's existing public surface so the OSS
 * default (CortexMemoryProvider) is a zero-cost adoption — every existing
 * caller already speaks this shape.
 */
import type {
  CortexHealth,
  CortexStats,
  DreamCycleResult,
  EncodeResult,
  RecallArtifact,
  RecallResult,
  ValenceVector,
} from '../cortex/types.js';

export type DreamCycleType = 'full' | 'sws_only' | 'rem_only' | 'consolidation_only';

export interface RecallOptions {
  tokenBudget?: number;
  sensitivityFilter?: string[];
  /**
   * Hard freshness floor: drop memories whose `created_at` AND
   * `last_recalled_at` are both before this date. Used by the proactive
   * sentinel to guarantee a fresh morning brief.
   */
  since?: Date | string;
}

export interface EncodeOptions {
  source?: string;
  /** 0..4 */
  priority?: number;
  valence?: Partial<ValenceVector>;
  channel?: string;
  sensitivity?: 'public' | 'internal' | 'sacred';
}

export interface ListArtifactsOptions {
  sinceHours?: number;
  limit?: number;
}

export interface ListArtifactsResult {
  agentId: string;
  sinceHours: number;
  cutoff: string;
  count: number;
  artifacts: Array<{ id: number; type: string; content: unknown; createdAt: string }>;
}

/**
 * The cognitive surface every Meridian subsystem (turn loop, dream worker,
 * sentinel, skills, channels, doctor) consumes. Implementations include:
 *
 *   - CortexMemoryProvider — open-source default; talks HTTP to a co-located
 *     CORTEX server.
 *   - QuartzMemoryProvider — paid; layers the Tier 7 LongMemEval pipeline on
 *     top of any CortexBackend. Selected via MERIDIAN_MEMORY_PROVIDER=quartz.
 */
export interface MemoryProvider {
  /** Agent identifier; one provider per agent. */
  readonly agentId: string;

  /** Pre-turn pattern-completion recall. */
  recall(query: string, opts?: RecallOptions): Promise<RecallResult>;

  /** List recent cognitive artifacts (reflector clusters, dream insights). */
  listArtifacts(opts?: ListArtifactsOptions): Promise<ListArtifactsResult>;

  /** Post-turn hippocampal encode with valence. */
  encode(content: string, opts?: EncodeOptions): Promise<EncodeResult>;

  /** Trigger a dream cycle (in-band or worker-driven). */
  dream(cycleType?: DreamCycleType): Promise<DreamCycleResult>;

  /** Liveness probe for boot panel + doctor. */
  health(): Promise<CortexHealth>;

  /** Per-agent counts; null on transport failure. */
  stats(): Promise<CortexStats | null>;

  /** Edit a labile memory within the 1-hour reconsolidation window. */
  reconsolidate(memoryId: number, content: string): Promise<{ ok: boolean }>;
}

export type {
  CortexHealth,
  CortexStats,
  DreamCycleResult,
  EncodeResult,
  RecallArtifact,
  RecallResult,
  ValenceVector,
};
