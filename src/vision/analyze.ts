/**
 * Vision runtime — analyzeImage() turns an image (path or buffer) into a
 * model-written description via the AI SDK multimodal message format.
 *
 * Chain semantics mirror the minimal version of what runTurn does with the
 * ProviderRouter: an ordered ref list ([vision.model, then the agent chain]
 * filtered to vision-capable providers), each attempt reporting success /
 * failure into the router's circuit breaker, first success wins.
 *
 * Error firewall: raw provider errors (URLs, status codes, retry chatter)
 * NEVER leave this module. Failures are logged in full for the operator's
 * log file, then surfaced as a single generic VisionAnalysisError — the same
 * no-leak contract RULE ZERO enforces on the reply path.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { generateText, type CoreMessage } from 'ai';
import type { Logger } from 'pino';
import type { ModelChain, VisionConfig } from '../config/schema.js';
import type { ProviderRouter, ResolvedProvider } from '../providers/router.js';

/**
 * Sanitized terminal error for the vision chain. `message` is always safe to
 * show a user/agent; the raw provider errors live only in the log.
 */
export class VisionAnalysisError extends Error {
  constructor(message = 'Image analysis is unavailable right now. Please try again later.') {
    super(message);
    this.name = 'VisionAnalysisError';
  }
}

export interface AnalyzeImageOptions {
  router: ProviderRouter;
  /** The agent's model chain — the default resolution path when
   *  vision.model is not pinned. */
  models: ModelChain;
  vision: VisionConfig;
  logger?: Logger;
  /** Optional caller question appended to the analysis prompt. */
  question?: string;
  /** Mime type when passing a raw buffer (path input auto-detects). */
  mimeType?: string;
}

export interface AnalyzeImageResult {
  description: string;
  /** Canonical ref of the model that produced the description. */
  model: string;
}

const DEFAULT_VISION_PROMPT =
  'Describe this image thoroughly and factually. Capture the subject, setting, ' +
  'any visible text, and details that would matter to someone who cannot see it. ' +
  'Do not speculate beyond what is visible.';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
};

export function mimeTypeForPath(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()];
}

/**
 * Is this ref plausibly vision-capable? Anthropic/OpenAI (and ROUTEXOR's
 * claude/gpt catalog) models are multimodal across the board; groq/ollama
 * only for specific multimodal families. Heuristic on purpose — a wrong
 * "yes" fails over to the next ref, a wrong "no" is corrected by the
 * never-empty fallback in visionChain.
 */
export function isVisionCapableRef(ref: string): boolean {
  const slash = ref.indexOf('/');
  if (slash === -1) return false;
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1).toLowerCase();
  if (provider === 'anthropic' || provider === 'openai') return true;
  if (provider === 'routexor') return /claude|gpt|gemini|pixtral|qwen.*vl|vision/.test(modelId);
  // groq/ollama and anything else: only known multimodal families.
  return /vision|llava|llama-4|llama4|scout|maverick|pixtral|qwen.*vl|minicpm-v|moondream|gemma-?3|bakllava/.test(
    modelId,
  );
}

/**
 * Ordered, resolved provider chain for a vision call. Mirrors
 * ProviderRouter.chainFor semantics (skip refs without keys, skip open
 * circuits, but never filter down to an empty chain) minus smart-routing —
 * an image is never a "short simple turn".
 */
export function visionChain(
  router: ProviderRouter,
  models: ModelChain,
  visionModel?: string,
): ResolvedProvider[] {
  const refs: string[] = [];
  const push = (r: string) => {
    if (r && !refs.includes(r)) refs.push(r);
  };
  // Operator-pinned vision model always leads the chain, capability check
  // bypassed — pinning IS the operator's claim that it can see.
  if (visionModel) push(visionModel);
  const agentChain = [models.primary, ...models.fallbacks];
  for (const r of agentChain) {
    if (isVisionCapableRef(r)) push(r);
  }
  // No vision-capable ref anywhere → try the agent chain anyway (the
  // heuristic may be wrong; a hard provider error beats silent no-op).
  if (refs.length === 0) for (const r of agentChain) push(r);

  const resolved: ResolvedProvider[] = [];
  for (const r of refs) {
    try {
      resolved.push(router.resolve(r));
    } catch {
      // Missing key for this provider; doctor warns separately.
    }
  }
  if (resolved.length === 0) {
    throw new VisionAnalysisError(
      'No vision-capable model is configured for this agent. Set vision.model or check provider keys.',
    );
  }
  const live = resolved.filter((p) => !router.isOpen?.(p.ref));
  return live.length > 0 ? live : resolved;
}

/**
 * Analyze one image with the configured/resolved vision model chain.
 * Returns { description, model } or throws VisionAnalysisError (sanitized).
 */
export async function analyzeImage(
  image: string | Buffer,
  opts: AnalyzeImageOptions,
): Promise<AnalyzeImageResult> {
  const { vision } = opts;
  if (!vision.enabled) {
    throw new VisionAnalysisError(
      'Image analysis is disabled for this agent (vision.enabled=false).',
    );
  }

  let data: Buffer;
  let mimeType = opts.mimeType;
  if (typeof image === 'string') {
    const st = statSync(image, { throwIfNoEntry: false });
    if (!st?.isFile()) {
      throw new VisionAnalysisError(`Image file not found: ${image}`);
    }
    // Size check BEFORE reading — don't pull a multi-GB file into memory
    // just to reject it.
    if (st.size > vision.maxBytes) {
      throw new VisionAnalysisError(
        `Image is too large to analyze (${st.size} bytes; limit ${vision.maxBytes}).`,
      );
    }
    data = readFileSync(image);
    mimeType = mimeType ?? mimeTypeForPath(image);
  } else {
    data = image;
  }
  if (data.byteLength > vision.maxBytes) {
    throw new VisionAnalysisError(
      `Image is too large to analyze (${data.byteLength} bytes; limit ${vision.maxBytes}).`,
    );
  }

  const promptText = [
    vision.prompt?.trim() || DEFAULT_VISION_PROMPT,
    opts.question ? `Question from the user about this image: ${opts.question}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: CoreMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image', image: data, ...(mimeType ? { mimeType } : {}) },
      ],
    },
  ];

  const chain = visionChain(opts.router, opts.models, vision.model);
  for (const provider of chain) {
    try {
      const result = await generateText({
        model: provider.model,
        messages,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(vision.timeoutSeconds * 1000),
      });
      const description = result.text.trim();
      if (!description) throw new Error('empty vision reply');
      // Close the breaker circuit for this ref (mock routers may not have it).
      opts.router.reportSuccess?.(provider.ref);
      return { description, model: provider.ref };
    } catch (err) {
      // Full detail into the log; NOTHING provider-shaped leaves this module.
      opts.logger?.warn({
        msg: 'vision provider failed; trying fallback',
        provider: provider.ref,
        err: err instanceof Error ? err.message : String(err),
      });
      opts.router.reportFailure?.(provider.ref);
    }
  }
  throw new VisionAnalysisError();
}
