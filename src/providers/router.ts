/**
 * Provider router on Vercel AI SDK.
 * Resolves "openrouter/anthropic/claude-haiku-4.5" → LanguageModel.
 * Implements primary + fallback chain and smart-routing for short turns.
 *
 * We do not rebuild streaming, tool-use loops, or message shapes.
 * Vercel AI SDK does that. We just route.
 */

import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGroq } from '@ai-sdk/groq';
import { createOllama } from 'ollama-ai-provider-v2';
import type { AgentEnv, ModelChain } from '../config/schema.js';

export type ProviderName = 'openrouter' | 'anthropic' | 'openai' | 'groq' | 'ollama';

export interface ResolvedProvider {
  provider: ProviderName;
  modelId: string;
  ref: string; // canonical "provider/model"
  model: LanguageModel;
}

function parseRef(ref: string): { provider: ProviderName; modelId: string } {
  const slash = ref.indexOf('/');
  if (slash === -1) throw new Error(`invalid model ref: ${ref}`);
  const provider = ref.slice(0, slash) as ProviderName;
  const modelId = ref.slice(slash + 1);
  return { provider, modelId };
}

export class ProviderRouter {
  private cached = new Map<string, LanguageModel>();
  constructor(private env: AgentEnv) {}

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
      case 'openrouter': {
        if (!this.env.OPENROUTER_API_KEY) {
          throw new Error('OPENROUTER_API_KEY missing for openrouter provider');
        }
        const or = createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY });
        return or.chat(modelId);
      }
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
      case 'groq': {
        if (!this.env.GROQ_API_KEY) {
          throw new Error('GROQ_API_KEY missing for groq provider');
        }
        const g = createGroq({ apiKey: this.env.GROQ_API_KEY });
        return g(modelId);
      }
      case 'ollama': {
        const o = createOllama({ baseURL: `${this.env.OLLAMA_BASE_URL}/api` });
        // ollama-ai-provider-v2 returns LanguageModelV2; AI SDK 4 expects V1.
        // The runtime tolerates the mismatch (duck-typed). Cast through unknown.
        return o(modelId) as unknown as LanguageModel;
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
    return out;
  }

  private isSimple(input: string, chain: ModelChain): boolean {
    if (input.length > chain.smartRouting.maxSimpleChars) return false;
    if (input.split(/\s+/).length > chain.smartRouting.maxSimpleWords) return false;
    return true;
  }
}
