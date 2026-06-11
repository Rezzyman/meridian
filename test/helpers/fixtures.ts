/**
 * Shared test fixtures. Every test file builds its world from these so the
 * suite has one idiom: DI through real entry points, no module mocking.
 *
 * Conventions (see test/README.md):
 *   - node:test + tsx, assert from node:assert/strict
 *   - encodeOnTurn defaults to false in fixtures (encode is fire-and-forget
 *     in runTurn; tests that assert encode use mockCortex's recorded calls
 *     plus settle())
 *   - never assert on TurnResult.encodeOk / memoryId — hardcoded false /
 *     undefined by design
 */
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import type { LanguageModelV1, LanguageModelV1StreamPart } from 'ai';
import { AgentConfigSchema, AgentEnvSchema, defaultAgentConfig } from '../../src/config/schema.js';
import type { AgentConfig, AgentEnv } from '../../src/config/schema.js';
import type {
  EncodeOptions,
  MemoryProvider,
  RecallOptions,
  RecallResult,
} from '../../src/memory/provider.js';
import type { ProviderRouter, ResolvedProvider } from '../../src/providers/router.js';
import type { Logger } from 'pino';

// ─── Config / env ────────────────────────────────────────────────────────────

/** Valid AgentConfig with test-friendly defaults (no encode, 5s timeout, no smart routing). */
export function makeConfig(overrides: Record<string, unknown> = {}): AgentConfig {
  const base = defaultAgentConfig('test-agent', 'Test Agent');
  base.agent.gatewayTimeoutSec = 5;
  base.cortex.encodeOnTurn = false;
  base.models.smartRouting.enabled = false;
  return AgentConfigSchema.parse(deepMerge(base as unknown as Record<string, unknown>, overrides));
}

/** Valid AgentEnv. Keys are syntactically valid dummies — never live keys. */
export function makeEnv(overrides: Partial<AgentEnv> = {}): AgentEnv {
  return AgentEnvSchema.parse({
    MERIDIAN_AGENT: 'test-agent',
    CORTEX_AGENT_ID: 'test-agent',
    NEON_DATABASE_URL: 'postgres://user:pass@localhost:5432/test_db',
    VOYAGE_API_KEY: 'voyage-test-key-0000000000000000',
    ...overrides,
  });
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
} as unknown as Logger;

// ─── Memory provider stub ────────────────────────────────────────────────────

export interface MockCortexOptions {
  recallContext?: string;
  recallMemories?: Array<{ id: number; content: string; source: string | null; score: number }>;
  /** Throw from recall() */
  recallError?: Error;
  /** Never resolve recall() — exercises the 8s timeout race. */
  recallHangs?: boolean;
  agentId?: string;
}

export interface MockCortex extends MemoryProvider {
  recallCalls: Array<{ query: string; opts?: RecallOptions }>;
  encodeCalls: Array<{ content: string; opts?: EncodeOptions }>;
}

/** MemoryProvider stub that records every recall/encode call. */
export function mockCortex(opts: MockCortexOptions = {}): MockCortex {
  const recallCalls: MockCortex['recallCalls'] = [];
  const encodeCalls: MockCortex['encodeCalls'] = [];
  const memories = opts.recallMemories ?? [
    { id: 1, content: 'remembered fact', source: 'test', score: 0.9 },
  ];
  return {
    agentId: opts.agentId ?? 'test-agent',
    recallCalls,
    encodeCalls,
    async recall(query: string, ro?: RecallOptions): Promise<RecallResult> {
      recallCalls.push({ query, opts: ro });
      if (opts.recallHangs) return new Promise(() => {});
      if (opts.recallError) throw opts.recallError;
      return {
        context: opts.recallContext ?? 'recalled context block',
        memories,
        artifacts: [],
        tokenCount: 42,
        tokenBudget: ro?.tokenBudget ?? 1500,
      };
    },
    async encode(content: string, eo?: EncodeOptions) {
      encodeCalls.push({ content, opts: eo });
      return { memoryId: 101, novelty: 0.5, encoded: true };
    },
    async listArtifacts() {
      return { agentId: 'test-agent', sinceHours: 24, cutoff: '', count: 0, artifacts: [] };
    },
    async dream() {
      return { cycleType: 'full', durationMs: 1, insights: [], stats: {} };
    },
    async health() {
      return { status: 'ok' as const, database: 'connected' as const };
    },
    async stats() {
      return null;
    },
    async reconsolidate() {
      return { ok: true };
    },
  };
}

// ─── Provider router stubs ───────────────────────────────────────────────────

/** Model that streams `text` and finishes cleanly. Records the last call options. */
export function textModel(text: string): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV1StreamPart>({
        chunks: [
          ...chunked(text).map((t) => ({ type: 'text-delta', textDelta: t }) as const),
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 10 },
          } as const,
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

/** Model whose stream call throws immediately (hard provider failure). */
export function failingModel(message = 'provider down'): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doStream: async () => {
      throw new Error(message);
    },
  });
}

function chunked(text: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

/**
 * Duck-typed ProviderRouter: runTurn/AutomationManager only call chainFor().
 * Pass one or more models; each becomes a ResolvedProvider in chain order.
 */
export function mockRouter(...models: LanguageModelV1[]): ProviderRouter {
  const chain: ResolvedProvider[] = models.map((model, i) => ({
    provider: 'anthropic',
    modelId: `mock-${i}`,
    ref: `anthropic/mock-${i}`,
    model,
  }));
  return {
    chainFor: () => chain,
    resolve: (ref: string) => chain.find((c) => c.ref === ref) ?? chain[0],
  } as unknown as ProviderRouter;
}

// ─── Async helpers ───────────────────────────────────────────────────────────

/** Let detached promises (fire-and-forget encode) settle. */
export async function settle(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
}
