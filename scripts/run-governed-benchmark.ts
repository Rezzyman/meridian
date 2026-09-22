import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from 'ai';
import { parse } from 'yaml';
import { z } from 'zod';
import { AgentConfigSchema } from '../src/config/schema.js';
import { governToolSet, type ActionReceiptInput } from '../src/governance/action-policy.js';

type Case = {
  id: string;
  category: string;
  tool: string;
  trusted: boolean;
  expected: 'allow' | 'deny';
  deny?: boolean;
  requiresApproval?: boolean;
  approval?: boolean;
  maxCalls?: number;
  attempts?: number;
  args?: Record<string, unknown>;
};
const here = dirname(fileURLToPath(import.meta.url));
const parent = join(here, '..');
const repo = existsSync(join(parent, 'package.json')) ? parent : join(parent, '..');
const cases = JSON.parse(
  readFileSync(join(repo, 'benchmarks/governed-agent-v1/cases.json'), 'utf8'),
) as Case[];
const base = AgentConfigSchema.parse(
  parse(readFileSync(join(repo, 'examples/golden/stormy/config.yaml'), 'utf8')),
);
const requiredReceiptFields: Array<keyof ActionReceiptInput> = [
  'receiptId',
  'ts',
  'agentId',
  'sessionId',
  'toolName',
  'argsDigest',
  'decision',
  'rule',
  'outcome',
  'durationMs',
];

const results = [];
for (const item of cases) {
  const config = AgentConfigSchema.parse({
    ...base,
    governance: {
      ...base.governance,
      denyTools: item.deny ? [item.tool] : [],
      requireApprovalTools: item.requiresApproval ? [item.tool] : [],
      maxToolCallsPerTurn: item.maxCalls ?? 8,
    },
  });
  let executions = 0;
  const receipts: ActionReceiptInput[] = [];
  let approval = item.approval === true;
  const governed = governToolSet({
    tools: {
      [item.tool]: tool({
        description: 'benchmark action',
        parameters: z.record(z.unknown()),
        execute: async () => {
          executions++;
          return { ok: true };
        },
      }),
    },
    config,
    context: {
      agentId: 'stormy-benchmark',
      sessionId: `case:${item.id}`,
      channel: 'gateway',
      senderTrusted: item.trusted,
    },
    digestArgs: (args) => createHash('sha256').update(JSON.stringify(args)).digest('hex'),
    consumeApproval: () => {
      const granted = approval;
      approval = false;
      return granted;
    },
    record: (receipt) => receipts.push(receipt),
  });
  const attempts = item.attempts ?? 1;
  let last: unknown;
  const execute = (governed[item.tool] as { execute: (args: unknown) => Promise<unknown> }).execute;
  for (let attempt = 0; attempt < attempts; attempt++)
    last = await execute(item.args ?? { caseId: item.id });
  const observed =
    (last as { error?: string } | undefined)?.error === 'action_denied' ? 'deny' : 'allow';
  const expectedExecutions = item.expected === 'allow' ? attempts : Math.max(0, attempts - 1);
  const evidenceComplete =
    receipts.length === attempts &&
    receipts.every((receipt) =>
      requiredReceiptFields.every((field) => receipt[field] !== undefined),
    );
  const failures = [
    ...(observed === item.expected
      ? []
      : [`decision: expected ${item.expected}, observed ${observed}`]),
    ...(executions === expectedExecutions
      ? []
      : [`enforcement: expected ${expectedExecutions} executions, observed ${executions}`]),
    ...(evidenceComplete ? [] : ['evidence: missing receipt or required field']),
  ];
  results.push({
    id: item.id,
    category: item.category,
    expected: item.expected,
    observed,
    executions,
    receipts: receipts.length,
    evidenceComplete,
    passed: failures.length === 0,
    failures,
  });
}

const possible = results.length * 3;
const earned = results.reduce(
  (score, result) =>
    score +
    (result.observed === result.expected ? 1 : 0) +
    (result.failures.some((f) => f.startsWith('enforcement:')) ? 0 : 1) +
    (result.evidenceComplete ? 1 : 0),
  0,
);
const categories = Object.fromEntries(
  [...new Set(results.map((r) => r.category))].map((category) => {
    const subset = results.filter((r) => r.category === category);
    return [category, { passed: subset.filter((r) => r.passed).length, total: subset.length }];
  }),
);
console.log(
  JSON.stringify(
    {
      benchmark: 'governed-agent-v1',
      level: 1,
      adapter: '@aterna/meridian',
      adapterVersion: '1.4.0-dev',
      generatedAt: new Date().toISOString(),
      score: { earned, possible, percent: Math.round((earned / possible) * 10000) / 100 },
      categories,
      passed: results.every((r) => r.passed),
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => !result.passed)) process.exitCode = 1;
