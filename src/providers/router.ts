/**
 * Provider router on Vercel AI SDK.
 * Resolves "routexor/claude-4-haiku" → LanguageModel.
 * Implements primary + fallback chain and smart-routing for short turns.
 *
 * We do not rebuild streaming, tool-use loops, or message shapes.
 * Vercel AI SDK does that. We just route.
 */

import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import { createOllama } from 'ollama-ai-provider';
import type { AgentEnv, ModelChain } from '../config/schema.js';

export type ProviderName = 'anthropic' | 'openai' | 'groq' | 'ollama' | 'routexor';

export interface ResolvedProvider {
  provider: ProviderName;
  modelId: string;
  ref: string; // canonical "provider/model"
  model: LanguageModel;
}

/** Route ollama doStream calls by payload: tools → simulated streaming
 *  (tool calls parse), no tools → true streaming (live tokens). See the
 *  ollama case in ProviderRouter.build for the full rationale. */
function hybridOllama(live: LanguageModel, sim: LanguageModel): LanguageModel {
  return new Proxy(live, {
    get(target, prop, receiver) {
      if (prop === 'doStream') {
        return (options: Parameters<LanguageModel['doStream']>[0]) => {
          const mode = options.mode as { type?: string; tools?: unknown[] };
          const hasTools =
            mode?.type === 'regular' && Array.isArray(mode.tools) && mode.tools.length > 0;
          return (hasTools ? sim : live).doStream(options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function parseRef(ref: string): { provider: ProviderName; modelId: string } {
  const slash = ref.indexOf('/');
  if (slash === -1) throw new Error(`invalid model ref: ${ref}`);
  const provider = ref.slice(0, slash) as ProviderName;
  const modelId = ref.slice(slash + 1);
  return { provider, modelId };
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before a ref's circuit opens. */
  failureThreshold?: number;
  /** How long an open circuit stays open before a retry is allowed. */
  cooldownMs?: number;
}

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number; // epoch ms; 0 = closed
}

const BREAKER_DEFAULTS: Required<CircuitBreakerOptions> = {
  failureThreshold: 3,
  cooldownMs: 30_000,
};

export class ProviderRouter {
  private cached = new Map<string, LanguageModel>();
  // ── Circuit breaker ──
  // Sub-agent fan-out multiplies model calls; without a breaker, a dead
  // provider eats (timeout × fan-out × chain-position) of wall clock on
  // every turn. Call sites report outcomes; chainFor skips refs whose
  // circuit is open. Failsafe: if EVERY ref in a chain is open, the chain
  // is returned unfiltered — the breaker may never make availability worse.
  private breaker = new Map<string, BreakerState>();
  private breakerOpts: Required<CircuitBreakerOptions>;

  constructor(
    private env: AgentEnv,
    breakerOpts: CircuitBreakerOptions = {},
  ) {
    this.breakerOpts = { ...BREAKER_DEFAULTS, ...breakerOpts };
  }

  /** Call-site report: provider call failed. Opens the circuit at threshold. */
  reportFailure(ref: string): void {
    const st = this.breaker.get(ref) ?? { consecutiveFailures: 0, openUntil: 0 };
    st.consecutiveFailures += 1;
    if (st.consecutiveFailures >= this.breakerOpts.failureThreshold) {
      st.openUntil = Date.now() + this.breakerOpts.cooldownMs;
    }
    this.breaker.set(ref, st);
  }

  /** Call-site report: provider call succeeded. Closes the circuit. */
  reportSuccess(ref: string): void {
    this.breaker.delete(ref);
  }

  /** A ref is open while its cooldown is in the future. Expiry closes it
   *  to half-open: the next attempt either resets (success) or re-opens
   *  immediately (failure at threshold). */
  isOpen(ref: string): boolean {
    const st = this.breaker.get(ref);
    if (!st) return false;
    if (st.openUntil === 0) return false;
    if (Date.now() >= st.openUntil) {
      // Half-open: allow one probe; stay at threshold so a failure re-opens.
      st.openUntil = 0;
      st.consecutiveFailures = this.breakerOpts.failureThreshold - 1;
      this.breaker.set(ref, st);
      return false;
    }
    return true;
  }

  resolve(ref: string): ResolvedProvider {
    const cached = this.cached.get(ref);
    const { provider, modelId } = parseRef(ref);
    if (cached) return { provider, modelId, ref, model: cached };
    const model = this.build(provider, modelId);
    this.cached.set(ref, model);
    return { provider, modelId, ref, model };
  }

  private build(provider: ProviderName, modelId: string): LanguageModel {
    switch (provider) {
      case 'anthropic': {
        if (!this.env.ANTHROPIC_API_KEY) {
          throw new Error('ANTHROPIC_API_KEY missing for anthropic provider');
        }
        const a = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
        return a(modelId);
      }
      case 'openai': {
        if (!this.env.OPENAI_API_KEY) {
          throw new Error('OPENAI_API_KEY missing for openai provider');
        }
        const o = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
        return o(modelId);
      }
      case 'routexor': {
        // ROUTEXOR (routexor.com) — ATERNA's BYOK, zero-markup model router.
        // Speaks the OpenAI chat API, so it's a base-URL'd OpenAI provider:
        // a ref `routexor/<model>` sends `<model>` straight to ROUTEXOR, where
        // `<model>` is a ROUTEXOR catalog id (e.g. claude-4-haiku,
        // claude-sonnet-4.6, gpt-4o-mini — see /v1/models). The default router
        // for every Meridian agent; direct providers (anthropic/openai/groq) and
        // a local ollama all keep working for operators who prefer them. BYOK:
        // the operator supplies ROUTEXOR_API_KEY; ROUTEXOR_BASE_URL overrides the
        // endpoint if it differs from the default.
        if (!this.env.ROUTEXOR_API_KEY) {
          throw new Error(
            'ROUTEXOR_API_KEY missing — Meridian routes models through ROUTEXOR by default ' +
              '(BYOK, zero markup). Get a key at https://routexor.com, set ROUTEXOR_API_KEY in ' +
              "your agent's .env, or switch your model ref to a direct provider " +
              '(anthropic/openai/groq) or a local `ollama/...` model.',
          );
        }
        const rx = createOpenAI({
          apiKey: this.env.ROUTEXOR_API_KEY,
          baseURL: this.env.ROUTEXOR_BASE_URL ?? 'https://api.routexor.com/v1',
          name: 'routexor',
        });
        return rx(modelId);
      }
      case 'groq': {
        if (!this.env.GROQ_API_KEY) {
          throw new Error('GROQ_API_KEY missing for groq provider');
        }
        const g = createGroq({ apiKey: this.env.GROQ_API_KEY });
        return g(modelId);
      }
      case 'ollama': {
        // ollama-ai-provider@1.x speaks LanguageModelV1 (AI SDK 4). The
        // previous -v2 package emitted V2 models that ai@4.x rejects at
        // runtime with "Unsupported model version" — every default config
        // advertising ollama fallbacks was silently broken (caught by the
        // live eval).
        //
        // Hybrid streaming: the provider's TRUE streaming mode drops tool
        // calls entirely (model consumes tokens, zero parts surface, the
        // turn dies as "empty reply"), while simulateStreaming parses tool
        // calls but delivers text as one end burst. So: tool-bearing calls
        // go through the simulated model, text-only calls keep live
        // token-by-token streaming. Both verified against a live ollama
        // in the eval harness (scripts/eval/run-eval.mts).
        const o = createOllama({ baseURL: `${this.env.OLLAMA_BASE_URL}/api` });
        return hybridOllama(o(modelId), o(modelId, { simulateStreaming: true }));
      }
      default:
        throw new Error(`unknown provider: ${provider}`);
    }
  }

  /**
   * Pick the right model for a given turn.
   * Smart-routing: short user inputs go to the cheap model.
   * Returns ordered chain: [primary or cheap, ...fallbacks].
   */
  chainFor(input: string, chain: ModelChain): ResolvedProvider[] {
    const refs: string[] = [];
    if (chain.smartRouting.enabled && this.isSimple(input, chain)) {
      refs.push(chain.smartRouting.cheapModel);
    } else {
      refs.push(chain.primary);
    }
    for (const f of chain.fallbacks) {
      if (!refs.includes(f)) refs.push(f);
    }
    const out: ResolvedProvider[] = [];
    for (const r of refs) {
      try {
        out.push(this.resolve(r));
      } catch {
        // Skip providers we don't have keys for; doctor will warn separately.
      }
    }
    if (out.length === 0) {
      throw new Error('No providers resolvable. Check .env keys.');
    }
    // Breaker filter — but never to an empty chain (see breaker comment).
    const live = out.filter((p) => !this.isOpen(p.ref));
    return live.length > 0 ? live : out;
  }

  private isSimple(input: string, chain: ModelChain): boolean {
    if (input.length > chain.smartRouting.maxSimpleChars) return false;
    if (input.split(/\s+/).length > chain.smartRouting.maxSimpleWords) return false;
    return true;
  }
}
