import { encode } from 'gpt-tokenizer';
import type { ToolSet } from 'ai';

/**
 * Prompt budget accounting (found on the bench, 2026-09-22): Arlo's turns
 * averaged 57k prompt tokens, 33.7k minimum, with the static prompt (identity,
 * context, tool schemas) responsible for almost all of it and multi-step
 * turns resending it every step. Nothing in the runtime could say where the
 * tokens went. This module measures the static prompt at boot so /health and
 * the boot log can, and gives the turn loop a per-turn ceiling.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export interface PromptBudgetReport {
  systemBaseTokens: number;
  toolSchemaTokens: number;
  toolCount: number;
  /** Per-tool schema tokens, largest first (top 10). */
  largestTools: Array<{ name: string; tokens: number }>;
  totalStaticTokens: number;
}

export function measurePromptBudget(
  systemBase: string,
  tools: ToolSet | undefined,
): PromptBudgetReport {
  const systemBaseTokens = estimateTokens(systemBase);
  const perTool: Array<{ name: string; tokens: number }> = [];
  for (const [name, tool] of Object.entries(tools ?? {})) {
    const t = tool as { description?: string; parameters?: unknown };
    let schema = '';
    try {
      const p = t.parameters as { jsonSchema?: unknown; _def?: unknown } | undefined;
      schema = JSON.stringify(
        p && typeof p === 'object' && 'jsonSchema' in p ? p.jsonSchema : (p ?? {}),
      );
    } catch {
      schema = '';
    }
    perTool.push({ name, tokens: estimateTokens(`${name} ${t.description ?? ''} ${schema}`) });
  }
  perTool.sort((a, b) => b.tokens - a.tokens);
  const toolSchemaTokens = perTool.reduce((s, t) => s + t.tokens, 0);
  return {
    systemBaseTokens,
    toolSchemaTokens,
    toolCount: perTool.length,
    largestTools: perTool.slice(0, 10),
    totalStaticTokens: systemBaseTokens + toolSchemaTokens,
  };
}
