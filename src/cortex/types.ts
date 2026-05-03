/**
 * CORTEX bind: typed surface for cognitive operations.
 * Meridian treats CORTEX as a peer module, not an MCP server.
 * v0.1 talks to a co-located CORTEX server over localhost HTTP for safety
 * and per-agent DB isolation. v0.2 can move to true in-process imports.
 */

export interface RecallMemory {
  id: number;
  content: string;
  source: string | null;
  score: number;
}

export interface RecallArtifact {
  id: number;
  type: string;
  content: unknown;
}

export interface RecallResult {
  context: string;
  memories: RecallMemory[];
  artifacts: RecallArtifact[];
  tokenCount: number;
  tokenBudget: number;
}

export interface EncodeResult {
  memoryId: number;
  novelty: number;
  encoded: boolean;
  valence?: ValenceVector;
}

export interface ValenceVector {
  /** Six-dimensional vector inferred from content */
  arousal: number;
  pleasantness: number;
  approach: number;
  dominance: number;
  certainty: number;
  novelty: number;
  /** Optional channel/category axis for valence-weighted recall */
  channel?: string;
}

export interface DreamCycleResult {
  cycleType: string;
  durationMs: number;
  insights: string[];
  stats: Record<string, unknown>;
}

export interface CortexHealth {
  status: 'ok' | 'degraded' | 'down';
  database: 'connected' | 'disconnected';
  memoryCount?: number;
  synapseCount?: number;
  lastDreamAt?: string;
  versionTag?: string;
}

export interface CortexStats {
  memoryCount: number;
  synapseCount: number;
  artifactCount: number;
  lastDreamAt: string | null;
  agentId: string;
}
