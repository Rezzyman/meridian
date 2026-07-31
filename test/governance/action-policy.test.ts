import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';
import { evaluateActionPolicy, governToolSet, type ActionReceiptInput } from '../../src/governance/action-policy.js';
import { makeConfig } from '../helpers/fixtures.js';

const context = { agentId: 'stormy', sessionId: 's1', channel: 'gateway' as const, senderTrusted: false, callIndex: 1 };

describe('deterministic action policy', () => {
  it('denies privileged tools to an untrusted sender', () => {
    const result = evaluateActionPolicy(makeConfig(), { ...context, toolName: 'bash' });
    assert.equal(result.decision, 'deny');
    assert.equal(result.rule, 'trustedSender');
  });

  it('allows a trusted operator to use a privileged tool', () => {
    const result = evaluateActionPolicy(makeConfig(), { ...context, senderTrusted: true, toolName: 'bash' });
    assert.equal(result.decision, 'allow');
  });

  it('operator denylist overrides trusted identity', () => {
    const config = makeConfig({ governance: { enabled: true, denyTools: ['bash'], trustedOnlyTools: [], maxToolCallsPerTurn: 8 } });
    const result = evaluateActionPolicy(config, { ...context, senderTrusted: true, toolName: 'bash' });
    assert.equal(result.decision, 'deny');
    assert.equal(result.rule, 'denyTools');
  });

  it('denies every MCP tool to an untrusted sender', () => {
    const result = evaluateActionPolicy(makeConfig(), { ...context, toolName: 'mcp_crm_delete' });
    assert.equal(result.decision, 'deny');
  });

  it('records denials without executing the underlying tool', async () => {
    let executions = 0;
    const receipts: ActionReceiptInput[] = [];
    const tools = governToolSet({
      tools: { bash: tool({ description: 'shell', parameters: z.object({ cmd: z.string() }), execute: async () => { executions++; return 'ran'; } }) },
      config: makeConfig(), context: { agentId: 'stormy', sessionId: 's1', channel: 'gateway', senderTrusted: false },
      digestArgs: () => 'digest', record: (receipt) => receipts.push(receipt),
    });
    const result = await (tools.bash as { execute: (args: unknown) => Promise<{ error: string }> }).execute({ cmd: 'danger' });
    assert.equal(executions, 0);
    assert.equal(result.error, 'action_denied');
    assert.equal(receipts[0]?.outcome, 'denied');
    assert.equal(receipts[0]?.argsDigest, 'digest');
  });

  it('enforces the aggregate per-turn tool ceiling', async () => {
    const config = makeConfig({ governance: { enabled: true, denyTools: [], trustedOnlyTools: [], maxToolCallsPerTurn: 1 } });
    let executions = 0;
    const receipts: ActionReceiptInput[] = [];
    const tools = governToolSet({
      tools: { calculate: tool({ description: 'calc', parameters: z.object({}), execute: async () => { executions++; return 1; } }) },
      config, context: { agentId: 'a', sessionId: 's', channel: 'cli', senderTrusted: true }, digestArgs: () => 'd', record: (r) => receipts.push(r),
    });
    const execute = (tools.calculate as { execute: (args: unknown) => Promise<{ error?: string }> }).execute;
    await execute({});
    const second = await execute({});
    assert.equal(executions, 1);
    assert.equal(second.error, 'action_denied');
    assert.equal(receipts[1]?.rule, 'maxToolCallsPerTurn');
  });

  it('requires and consumes an explicit approval when configured', async () => {
    const config = makeConfig({ governance: { requireApprovalTools: ['calculate'] } });
    const denied = evaluateActionPolicy(config, { ...context, senderTrusted: true, toolName: 'calculate' });
    assert.equal(denied.rule, 'approvalRequired');
    const allowed = evaluateActionPolicy(config, { ...context, senderTrusted: true, toolName: 'calculate', approvalGranted: true });
    assert.equal(allowed.decision, 'allow');
  });
});
