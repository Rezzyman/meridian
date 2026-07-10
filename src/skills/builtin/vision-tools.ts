/**
 * Vision built-ins. `image_analyze` lets the agent look at an image on demand
 * — a file path from ingest, or a bare filename from the agent's media dir
 * (where inbound Telegram photos land). Errors returned to the model are
 * already sanitized by the vision runtime (VisionAnalysisError); no raw
 * provider detail crosses this boundary.
 *
 * Channel gating: registered whenever a router is available; the allowlist
 * (config/schema.ts CHAT/CLI defaults) exposes it on chat + CLI surfaces,
 * and turn.ts strips it from voice — a phone call has no way to carry an
 * image, so offering the tool there only invites hallucinated calls.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { AgentConfig } from '../../config/schema.js';
import type { ProviderRouter } from '../../providers/router.js';
import { analyzeImage, VisionAnalysisError } from '../../vision/analyze.js';

export interface VisionToolDeps {
  router: ProviderRouter;
  config: AgentConfig;
  logger?: Logger;
  /** Where inbound channel media lands (MEMORY/media). Bare filenames and
   *  relative refs are resolved against this dir. */
  mediaDir?: string;
}

/** Resolve a model-supplied image reference to an on-disk path. */
export function resolveImageRef(ref: string, mediaDir?: string): string | undefined {
  const cleaned = ref.trim();
  if (!cleaned) return undefined;
  if (isAbsolute(cleaned) && existsSync(cleaned)) return cleaned;
  if (mediaDir) {
    // Recent-media reference: a bare filename (or relative path) from the
    // media dir. normalize + prefix check keeps `../../etc/passwd` out.
    const candidate = normalize(join(mediaDir, cleaned));
    if (candidate.startsWith(normalize(mediaDir)) && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function visionTools(deps: VisionToolDeps) {
  return {
    image_analyze: tool({
      description:
        'Analyze an image file with the vision model. Pass an absolute path, or the filename of ' +
        'a recently received image (e.g. one the operator just sent on chat). Optionally ask a ' +
        'specific question about the image.',
      parameters: z.object({
        path: z
          .string()
          .describe('Absolute path to the image, or the filename of a recently received image'),
        question: z
          .string()
          .optional()
          .describe('Optional specific question to answer about the image'),
      }),
      execute: async ({ path, question }: { path: string; question?: string }) => {
        if (!deps.config.vision.enabled) {
          return {
            ok: false,
            error: 'image analysis is disabled for this agent (vision.enabled=false)',
          };
        }
        const resolved = resolveImageRef(path, deps.mediaDir);
        if (!resolved) {
          return { ok: false, error: `image not found: ${path}` };
        }
        try {
          const r = await analyzeImage(resolved, {
            router: deps.router,
            models: deps.config.models,
            vision: deps.config.vision,
            logger: deps.logger,
            question,
          });
          return { ok: true, path: resolved, description: r.description, model: r.model };
        } catch (err) {
          // VisionAnalysisError messages are pre-sanitized; anything else
          // collapses to a generic line so raw provider errors never reach
          // the model (and therefore never a client).
          const message =
            err instanceof VisionAnalysisError
              ? err.message
              : 'Image analysis failed. The error has been logged.';
          if (!(err instanceof VisionAnalysisError)) {
            deps.logger?.warn({ msg: 'image_analyze unexpected error', err });
          }
          return { ok: false, error: message };
        }
      },
    }),
  };
}
