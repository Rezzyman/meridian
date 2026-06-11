/**
 * delegate — bounded sub-agent execution.
 *
 * Runs a scoped sub-turn through the SAME runTurn spine as every other
 * turn (runtime_rules, recall, provider chain + breaker, tool loop), with
 * hard bounds the model cannot negotiate:
 *
 *   depth     — delegation.maxDepth levels; the child's toolset only
 *               contains `delegate` while depth remains, so recursion is
 *               structurally impossible past the limit
 *   tokens    — delegation.maxOutputTokens per sub-turn (streamText maxTokens)
 *   wall time — delegation.timeoutSec per sub-turn
 *   tools     — child gets an explicit, parent-approved subset; never the
 *               full surface, never bash/write unless granted
 *   memory    — child turns do NOT encode unless delegation.encodeSubTurns
 *
 * Result is always structured + non-empty: { ok, result | error, ... } —
 * a child failure is data for the parent, never a thrown turn.
 */

import { tool, type ToolSet } from 'ai';
import type { Logger } from 'pino';
import { z } from 'zod';
import { runTurn } from '../../agent/turn.js';
import {
  type AgentConfig,
  AgentConfigSchema,
  type DelegationConfig,
  DelegationConfigSchema,
} from '../../config/schema.js';
import type { MemoryProvider } from '../../memory/provider.js';
import type { ProviderRouter } from '../../providers/router.js';

export interface DelegateDeps {
  config: AgentConfig;
  memory: MemoryProvider;
  router: ProviderRouter;
  logger: Logger;
  /** Lazily resolves the parent's full tool surface — set after assembly. */
  getParentTools: () => ToolSet;
}

const CHILD_SYSTEM = (task: string, context: string | undefined, depth: number) =>
  [
    `You are a focused sub-agent (delegation depth ${depth}). Complete EXACTLY this task and nothing else:`,
    `<task>\n${task}\n</task>`,
    context ? `<context_from_parent>\n${context}\n</context_from_parent>` : '',
    'Return a complete, self-contained answer — your reply goes back to the parent agent, not a human. No preamble, no questions back.',
  ]
    .filter(Boolean)
    .join('\n\n');

/** Tools the child may NEVER receive implicitly. */
const CHILD_DENYLIST = new Set(['delegate', 'cortex_recall', 'cortex_encode']);

export function delegationConfigOf(config: AgentConfig): DelegationConfig {
  return config.delegation ?? DelegationConfigSchema.parse({});
}

export function delegateTools(deps: DelegateDeps): ToolSet {
  const dcfg = delegationConfigOf(deps.config);
  if (!dcfg.enabled) return {};
  return { delegate: buildDelegateTool(deps, dcfg, 1) };
}

function buildDelegateTool(
  deps: DelegateDeps,
  dcfg: DelegationConfig,
  depth: number,
): ToolSet[string] {
  return tool({
    description:
      `Delegate a self-contained task to a scoped sub-agent (depth ${depth}/${dcfg.maxDepth}). ` +
      `The sub-agent runs with its own budget (${dcfg.maxOutputTokens} output tokens, ` +
      `${dcfg.timeoutSec}s) and ONLY the tools you grant it. ` +
      'Use for: parallel-izable research, summarizing a large fetch, any subtask ' +
      'where a fresh focused context beats your current one. The result returns to you as data.',
    parameters: z.object({
      task: z.string().min(8).describe('Complete, self-contained task description'),
      context: z
        .string()
        .optional()
        .describe('Facts the sub-agent needs (it does NOT see your conversation)'),
      tools: z
        .array(z.string())
        .optional()
        .describe(`Tool names to grant from your own surface. Default: ${dcfg.childTools.join(', ')}`),
    }),
    execute: async ({ task, context, tools: requested }) => {
      const startedAt = Date.now();
      try {
        const parentTools = deps.getParentTools();
        const grantNames = (requested?.length ? requested : dcfg.childTools).filter(
          (n) => !CHILD_DENYLIST.has(n) && n in parentTools,
        );
        const childTools: ToolSet = {};
        for (const n of grantNames) childTools[n] = parentTools[n];

        // Re-delegation: only while depth remains, and the child's delegate
        // is built with depth+1 — the bound is structural, not advisory.
        if (depth < dcfg.maxDepth) {
          childTools.delegate = buildDelegateTool(deps, dcfg, depth + 1);
          grantNames.push('delegate');
        }

        // Child config: same agent identity, but its OWN hard bounds. The
        // tools allowlist is exactly the granted set (channel 'system'
        // resolves the chat list), encode is off unless opted in.
        const childConfig: AgentConfig = AgentConfigSchema.parse({
          ...deps.config,
          agent: { ...deps.config.agent, gatewayTimeoutSec: dcfg.timeoutSec },
          tools: { chat: grantNames, cli: grantNames },
          cortex: { ...deps.config.cortex, encodeOnTurn: dcfg.encodeSubTurns },
        });

        deps.logger.info({
          msg: 'delegate: sub-turn start',
          depth,
          tools: grantNames,
          taskPreview: task.slice(0, 80),
        });

        const result = await runTurn(
          {
            sessionId: `delegate-${Date.now().toString(36)}`,
            config: childConfig,
            cortex: deps.memory,
            router: deps.router,
            logger: deps.logger,
            tools: childTools,
            history: [],
            channel: 'system',
            systemBase: CHILD_SYSTEM(task, context, depth),
            limits: { maxOutputTokens: dcfg.maxOutputTokens },
          },
          task,
        );

        deps.logger.info({
          msg: 'delegate: sub-turn done',
          depth,
          durationMs: result.durationMs,
          model: result.trace.model,
          toolCalls: result.trace.toolCalls.length,
        });

        return {
          ok: true,
          result: result.reply,
          depth,
          model: result.trace.model,
          toolCallCount: result.trace.toolCalls.length,
          durationMs: result.durationMs,
        };
      } catch (err) {
        const message = (err as Error).message;
        deps.logger.warn({ msg: 'delegate: sub-turn failed', depth, err: message });
        return {
          ok: false,
          error: `sub-agent failed: ${message}`,
          depth,
          durationMs: Date.now() - startedAt,
        };
      }
    },
  });
}
