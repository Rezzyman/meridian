import { randomUUID } from 'node:crypto';
import type { ToolSet } from 'ai';
import type { AgentConfig } from '../config/schema.js';
import type { MeridianTurn } from '../agent/types.js';

export type ActionDecision = 'allow' | 'deny';
export interface ActionPolicyContext {
  agentId: string;
  sessionId: string;
  channel: MeridianTurn['channel'];
  senderTrusted: boolean;
  toolName: string;
  callIndex: number;
  approvalGranted?: boolean;
}
export interface ActionPolicyResult {
  decision: ActionDecision;
  reason: string;
  rule: string;
}
export interface ActionReceiptInput extends ActionPolicyContext, ActionPolicyResult {
  receiptId: string;
  ts: string;
  argsDigest: string;
  outcome?: 'succeeded' | 'failed' | 'denied';
  errorClass?: string;
  durationMs?: number;
}

const DEFAULT_TRUSTED_ONLY = new Set([
  'bash',
  'write',
  'edit_file',
  'run_code',
  'http_request',
  'telegram_dm',
  'cortex_encode',
  'cortex_dream',
  'delegate',
]);
const matches = (name: string, configured: string[]) =>
  configured.includes(name) || configured.includes('*');

export function evaluateActionPolicy(
  config: AgentConfig,
  ctx: ActionPolicyContext,
): ActionPolicyResult {
  const policy = config.governance;
  if (policy?.enabled === false)
    return {
      decision: 'allow',
      reason: 'governance disabled by operator config',
      rule: 'disabled',
    };
  if (matches(ctx.toolName, policy?.denyTools ?? []))
    return {
      decision: 'deny',
      reason: `tool '${ctx.toolName}' is denied by operator policy`,
      rule: 'denyTools',
    };
  const max = policy?.maxToolCallsPerTurn ?? 8;
  if (ctx.callIndex > max)
    return {
      decision: 'deny',
      reason: `turn tool-call ceiling (${max}) exceeded`,
      rule: 'maxToolCallsPerTurn',
    };
  if (matches(ctx.toolName, policy?.requireApprovalTools ?? []) && !ctx.approvalGranted)
    return {
      decision: 'deny',
      reason: `tool '${ctx.toolName}' requires a scoped human approval`,
      rule: 'approvalRequired',
    };
  const trustedOnly = new Set([...DEFAULT_TRUSTED_ONLY, ...(policy?.trustedOnlyTools ?? [])]);
  if (!ctx.senderTrusted && (trustedOnly.has(ctx.toolName) || ctx.toolName.startsWith('mcp_')))
    return {
      decision: 'deny',
      reason: `untrusted sender cannot invoke privileged tool '${ctx.toolName}'`,
      rule: 'trustedSender',
    };
  return { decision: 'allow', reason: 'allowed by deterministic action policy', rule: 'allow' };
}

export function governToolSet(opts: {
  tools: ToolSet;
  config: AgentConfig;
  context: Omit<ActionPolicyContext, 'toolName' | 'callIndex' | 'approvalGranted'>;
  digestArgs: (args: unknown) => string;
  consumeApproval?: (toolName: string, argsDigest: string) => boolean;
  record: (receipt: ActionReceiptInput) => void;
}): ToolSet {
  let calls = 0;
  return Object.fromEntries(
    Object.entries(opts.tools).map(([name, original]) => {
      const executable = original as typeof original & {
        execute?: (...args: unknown[]) => unknown;
      };
      if (typeof executable.execute !== 'function') return [name, original];
      return [
        name,
        {
          ...executable,
          execute: async (...executeArgs: unknown[]) => {
            calls++;
            const started = Date.now();
            const argsDigest = opts.digestArgs(executeArgs[0]);
            const policy = opts.config.governance;
            const approvalEligible =
              matches(name, policy?.requireApprovalTools ?? []) &&
              !matches(name, policy?.denyTools ?? []) &&
              calls <= (policy?.maxToolCallsPerTurn ?? 8);
            const base = {
              ...opts.context,
              toolName: name,
              callIndex: calls,
              approvalGranted: approvalEligible
                ? (opts.consumeApproval?.(name, argsDigest) ?? false)
                : false,
            };
            const result = evaluateActionPolicy(opts.config, base);
            const receipt = {
              ...base,
              ...result,
              receiptId: `act_${randomUUID()}`,
              ts: new Date().toISOString(),
              argsDigest,
            };
            if (result.decision === 'deny') {
              opts.record({ ...receipt, outcome: 'denied', durationMs: Date.now() - started });
              return {
                error: 'action_denied',
                reason: result.reason,
                receiptId: receipt.receiptId,
              };
            }
            try {
              const value = await executable.execute?.(...executeArgs);
              opts.record({ ...receipt, outcome: 'succeeded', durationMs: Date.now() - started });
              return value;
            } catch (error) {
              opts.record({
                ...receipt,
                outcome: 'failed',
                durationMs: Date.now() - started,
                errorClass: error instanceof Error ? error.constructor.name : 'UnknownError',
              });
              throw error;
            }
          },
        },
      ];
    }),
  ) as ToolSet;
}
