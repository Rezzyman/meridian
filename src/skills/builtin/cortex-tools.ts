/**
 * Built-in CORTEX tools exposed to the model loop.
 * These are the only tools that talk to the cognitive layer directly.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { CortexBind } from '../../cortex/bind.js';
import { inferValence } from '../../cortex/valence-infer.js';

export function cortexTools(cortex: CortexBind) {
  return {
    cortex_recall: tool({
      description:
        'Recall memories from CORTEX using CA3 pattern completion. Use when the user references prior interactions, asks "do you remember", or you need cross-session context.',
      parameters: z.object({
        query: z.string().describe('The query to pattern-match against past memories'),
        tokenBudget: z.number().int().min(100).max(8000).default(2000),
      }),
      execute: async ({ query, tokenBudget }) => {
        const r = await cortex.recall(query, { tokenBudget });
        return {
          context: r.context,
          memoryCount: r.memories.length,
          tokenCount: r.tokenCount,
        };
      },
    }),
    cortex_encode: tool({
      description:
        'Manually encode a memory into CORTEX with optional priority and valence. Use to bookmark a decision, milestone, or important user-stated preference.',
      parameters: z.object({
        content: z.string(),
        source: z.string().optional(),
        priority: z.number().int().min(0).max(4).default(2),
        channel: z.string().optional(),
      }),
      execute: async ({ content, source, priority, channel }) => {
        const valence = inferValence(content, channel);
        const r = await cortex.encode(content, { source, priority, valence, channel });
        return { memoryId: r.memoryId, novelty: r.novelty, encoded: r.encoded };
      },
    }),
    cortex_dream: tool({
      description:
        'Trigger a CORTEX dream cycle on demand. Heavyweight; only use if the user explicitly asks for consolidation or insight synthesis.',
      parameters: z.object({
        cycleType: z.enum(['full', 'sws_only', 'rem_only', 'consolidation_only']).default('full'),
      }),
      execute: async ({ cycleType }) => {
        const r = await cortex.dream(cycleType);
        return { durationMs: r.durationMs, insights: r.insights };
      },
    }),
  };
}
