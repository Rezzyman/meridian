/**
 * CORTEX native bind. Talks to a co-located CORTEX server (v0.1) and exposes
 * a typed cognition handle for the rest of Meridian.
 *
 * Lifecycle: Meridian ensures a CORTEX server is reachable before agent
 * boot. If MERIDIAN_CORTEX_URL is set, we use that (production / shared
 * cortex). Otherwise we expect ~/cortex-sandbox to be runnable and we
 * spawn a per-agent CORTEX subprocess.
 */

import type {
  CortexHealth,
  CortexStats,
  DreamCycleResult,
  EncodeResult,
  RecallResult,
  ValenceVector,
} from './types.js';
import type { MemoryProvider } from '../memory/provider.js';

const DEFAULT_BASE = process.env.MERIDIAN_CORTEX_URL ?? 'http://127.0.0.1:3100';

export interface CortexBindOptions {
  agentId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Per-request wall-clock ceiling in ms. A CORTEX host that accepts the TCP
   * connection but never answers (firewalled port, wedged server, a proxy that
   * blackholes) would otherwise hang recall/encode/health forever — and with it
   * every turn and `meridian doctor`. Default 15s; callers pass a tighter signal
   * for interactive probes. Set 0 to disable.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class CortexBind implements MemoryProvider {
  readonly agentId: string;
  readonly baseUrl: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: CortexBindOptions) {
    this.agentId = opts.agentId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** A caller-supplied signal wins; otherwise fall back to the instance timeout. */
  private timeoutSignal(init?: RequestInit): AbortSignal | undefined {
    if (init?.signal) return init.signal;
    if (this.timeoutMs > 0) return AbortSignal.timeout(this.timeoutMs);
    return undefined;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      signal: this.timeoutSignal(init),
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CORTEX ${path} ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  // ─── Pre-turn: pattern-completion recall ─────────────────────────────────────
  async recall(
    query: string,
    opts: {
      tokenBudget?: number;
      sensitivityFilter?: string[];
      /**
       * Hard freshness floor — when set, drop memories whose `created_at`
       * AND `last_recalled_at` are both before this date. Used by the
       * proactive sentinel to guarantee a fresh morning brief.
       */
      since?: Date | string;
    } = {},
  ): Promise<RecallResult> {
    const since =
      opts.since instanceof Date
        ? opts.since.toISOString()
        : typeof opts.since === 'string'
          ? opts.since
          : undefined;
    return this.json<RecallResult>('/api/v1/recall', {
      method: 'POST',
      body: JSON.stringify({
        query,
        agentId: this.agentId,
        tokenBudget: opts.tokenBudget ?? 4000,
        sensitivityFilter: opts.sensitivityFilter,
        since,
      }),
    });
  }

  // ─── List recent cognitive artifacts (reflector clusters, dream insights) ────
  async listArtifacts(
    opts: { sinceHours?: number; limit?: number } = {},
  ): Promise<{
    agentId: string;
    sinceHours: number;
    cutoff: string;
    count: number;
    artifacts: Array<{ id: number; type: string; content: unknown; createdAt: string }>;
  }> {
    const params = new URLSearchParams({
      agentId: this.agentId,
      sinceHours: String(opts.sinceHours ?? 48),
      limit: String(opts.limit ?? 20),
    });
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/artifacts?${params.toString()}`, {
      signal: this.timeoutSignal(),
    });
    if (!res.ok) {
      throw new Error(`CORTEX /artifacts ${res.status}`);
    }
    return (await res.json()) as Awaited<ReturnType<CortexBind['listArtifacts']>>;
  }

  // ─── Post-turn: hippocampal encode with valence ──────────────────────────────
  async encode(
    content: string,
    opts: {
      source?: string;
      priority?: number; // 0..4
      valence?: Partial<ValenceVector>;
      channel?: string;
      sensitivity?: 'public' | 'internal' | 'sacred';
    } = {},
  ): Promise<EncodeResult> {
    return this.json<EncodeResult>('/api/v1/ingest', {
      method: 'POST',
      body: JSON.stringify({
        agentId: this.agentId,
        content,
        source: opts.source ?? 'meridian:turn',
        priority: opts.priority ?? 2,
        valence: opts.valence,
        channel: opts.channel,
        sensitivity: opts.sensitivity ?? 'internal',
      }),
    });
  }

  // ─── Dream cycle: in-band trigger (or scheduled by Meridian dream worker) ────
  async dream(
    cycleType: 'full' | 'sws_only' | 'rem_only' | 'consolidation_only' = 'full',
  ): Promise<DreamCycleResult> {
    return this.json<DreamCycleResult>('/api/v1/dream', {
      method: 'POST',
      body: JSON.stringify({ agentId: this.agentId, cycleType }),
    });
  }

  // ─── Health + stats for boot panel and doctor ────────────────────────────────
  /**
   * @param timeoutMs interactive callers (boot panel, `meridian doctor`) pass a
   * tight ceiling so an unreachable CORTEX degrades to "down" fast instead of
   * stalling the whole command on the 15s default.
   */
  async health(timeoutMs = 4_000): Promise<CortexHealth> {
    try {
      return await this.json<CortexHealth>(
        `/api/v1/health?agent_id=${encodeURIComponent(this.agentId)}`,
        timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : undefined,
      );
    } catch {
      return { status: 'down', database: 'disconnected' };
    }
  }

  async stats(): Promise<CortexStats | null> {
    try {
      // The agents endpoint returns per-agent counts; cheaper than enumerating memories.
      const data = await this.json<{
        agents: Array<{
          external_id: string;
          active_memories: string | number;
          total_memories: string | number;
          synapse_count?: string | number;
          last_memory_at?: string | null;
        }>;
      }>('/api/v1/memories/agents');
      const me = data.agents?.find((a) => a.external_id === this.agentId);
      if (!me) {
        return {
          memoryCount: 0,
          synapseCount: 0,
          artifactCount: 0,
          lastDreamAt: null,
          agentId: this.agentId,
        };
      }
      return {
        memoryCount: Number(me.active_memories) || 0,
        synapseCount: Number(me.synapse_count ?? 0) || 0,
        artifactCount: 0,
        lastDreamAt: me.last_memory_at ?? null,
        agentId: this.agentId,
      };
    } catch {
      return null;
    }
  }

  // ─── Reconsolidation: edit a labile memory within the 1-hour window ──────────
  async reconsolidate(memoryId: number, content: string): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>('/api/v1/reconsolidate', {
      method: 'POST',
      body: JSON.stringify({ agentId: this.agentId, memoryId, content }),
    });
  }
}

export function bindCortex(agentId: string, baseUrl?: string): CortexBind {
  return new CortexBind({ agentId, baseUrl });
}
