/**
 * LongMemEval runner — READY TO RUN, GATED.
 *
 * Two modes:
 *   DRY RUN (default) — ingest each instance's haystack into a fresh embedded
 *     store, recall the question, and report the RETRIEVAL-RECALL rate (does the
 *     recalled context contain the gold evidence?). NO model is invoked, so this
 *     runs fully locally with only the dataset. It measures memory quality
 *     independent of the answerer.
 *   FULL RUN (--confirm-live --model <ref>) — additionally calls the model to
 *     answer from recall and scores (offline lexical, or --judge for a model
 *     judge). Gated behind --confirm-live because it invokes a model.
 *
 * Nothing here needs a cloud key by default: the embedded provider has no
 * server/keys, and a full run can target the LOCAL model (e.g. --model
 * ollama/qwen2.5:3b). CORTEX/Quartz providers need a running server and are
 * BLOCKED unless you pass --confirm-live and have one configured.
 *
 *   # get the dataset first (NOT vendored): https://github.com/xiaowu0162/LongMemEval
 *   npx tsx scripts/longmemeval/run-longmemeval.mts --dataset ./longmemeval_oracle.json --limit 20
 *   npx tsx scripts/longmemeval/run-longmemeval.mts --dataset ./longmemeval_s.json --confirm-live --model ollama/qwen2.5:3b --judge
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { EmbeddedMemoryProvider } from '../../src/memory/embedded-memory-provider.js';
import type { MemoryProvider } from '../../src/memory/provider.js';
import type { ModelChain } from '../../src/config/schema.js';
import { runLongMemEval, type HarnessDeps } from './harness.js';
import { judgePrompt } from './score.js';
import type { LongMemEvalInstance } from './types.js';

interface Args {
  dataset?: string;
  provider: 'embedded' | 'cortex' | 'quartz';
  model?: string;
  limit?: number;
  confirmLive: boolean;
  judge: boolean;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { provider: 'embedded', confirmLive: false, judge: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--dataset') a.dataset = next();
    else if (k === '--provider') a.provider = next() as Args['provider'];
    else if (k === '--model') a.model = next();
    else if (k === '--limit') a.limit = Number(next());
    else if (k === '--confirm-live') a.confirmLive = true;
    else if (k === '--judge') a.judge = true;
    else if (k === '--out') a.out = next();
  }
  return a;
}

function block(msg: string): never {
  console.error(`\n⛔ BLOCKED — ${msg}\n`);
  process.exit(2);
}

function loadDataset(path: string): LongMemEvalInstance[] {
  if (!existsSync(path)) {
    block(
      `dataset not found at ${path}.\n` +
        '   LongMemEval is not vendored (large + separately licensed). Get it from\n' +
        '   https://github.com/xiaowu0162/LongMemEval and pass --dataset <path>.\n' +
        '   Expected: a JSON array of instances (longmemeval_oracle.json / _s.json / _m.json).',
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) block(`dataset at ${path} is not a JSON array of instances.`);
  return raw as LongMemEvalInstance[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset) {
    block(
      'no --dataset given. Usage:\n' +
        '   npx tsx scripts/longmemeval/run-longmemeval.mts --dataset <path> [--limit N]\n' +
        '   add --confirm-live --model <ref> [--judge] for a full (model) run.',
    );
  }
  if (args.provider !== 'embedded' && !args.confirmLive) {
    block(
      `provider '${args.provider}' needs a running CORTEX/Quartz server + keys. Re-run with\n` +
        '   --confirm-live once a server is configured, or use the default embedded provider.',
    );
  }

  let instances = loadDataset(args.dataset);
  if (args.limit && args.limit > 0) instances = instances.slice(0, args.limit);
  console.log(`Loaded ${instances.length} instances from ${args.dataset}.`);

  // ── Provider factory: a fresh embedded store per instance (isolation). ──
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lme-'));
  const providerFor = async (inst: LongMemEvalInstance): Promise<MemoryProvider> => {
    if (args.provider !== 'embedded') {
      block(`provider '${args.provider}' wiring is intentionally not auto-started here (needs a server).`);
    }
    return new EmbeddedMemoryProvider({
      agentId: `lme-${inst.question_id}`,
      dbPath: join(tmpRoot, `${inst.question_id}.jsonl`),
    });
  };
  const releaseProvider = (_p: MemoryProvider, inst: LongMemEvalInstance) => {
    rmSync(join(tmpRoot, `${inst.question_id}.jsonl`), { force: true });
  };

  // ── Answerer + judge: gated behind --confirm-live (they invoke a model). ──
  let answer: HarnessDeps['answer'];
  let judge: HarnessDeps['judge'] | undefined;
  let modelLabel = 'none (dry-run: retrieval-recall only)';

  if (args.confirmLive) {
    if (!args.model) block('--confirm-live requires --model <ref> (e.g. ollama/qwen2.5:3b).');
    // Lazy import so a dry run never constructs a router or reads provider keys.
    const { ProviderRouter } = await import('../../src/providers/router.js');
    const { AgentEnvSchema } = await import('../../src/config/schema.js');
    const env = AgentEnvSchema.parse({
      MERIDIAN_AGENT: 'longmemeval',
      CORTEX_AGENT_ID: 'longmemeval',
      MERIDIAN_MEMORY_PROVIDER: 'embedded',
      ...process.env,
    });
    const router = new ProviderRouter(env);
    const models: ModelChain = { primary: args.model, fallbacks: [], smartRouting: { enabled: false, maxSimpleChars: 200, maxSimpleWords: 35, cheapModel: args.model } };
    modelLabel = args.model;
    const modelFor = (q: string) => router.chainFor(q, models)[0].model;
    answer = async (question, context) => {
      const { text } = await generateText({
        model: modelFor(question),
        system:
          'You answer ONLY from the provided memory context. If the answer is not in the context, say you have no information about it. Be concise.',
        prompt: `Memory context:\n${context}\n\nQuestion: ${question}\nAnswer:`,
        maxTokens: 256,
      });
      return text.trim();
    };
    if (args.judge) {
      judge = async (inst, predicted) => {
        const { text } = await generateText({
          model: modelFor(inst.question),
          system:
            'You are a strict grader. Reply with exactly "CORRECT" or "INCORRECT" and nothing else.',
          prompt: judgePrompt(inst.question_type, inst.question, inst.answer, predicted),
          maxTokens: 5,
        });
        return /correct/i.test(text) && !/incorrect/i.test(text);
      };
    }
  } else {
    // DRY RUN: no model. "Answer" = the recalled context itself, so offline
    // scoring degenerates to "does recall contain the gold evidence?" — a pure
    // retrieval-recall diagnostic that needs nothing external.
    answer = async (_q, context) => context;
  }

  const summary = await runLongMemEval(
    instances,
    {
      providerFor,
      releaseProvider,
      answer,
      judge,
      recallTokenBudget: 2000,
      onProgress: (done, total, last) => {
        if (done % 10 === 0 || done === total) {
          process.stdout.write(`\r  ${done}/${total} … last: ${last.correct ? '✓' : '·'}   `);
        }
      },
    },
    { dataset: args.dataset!, provider: args.provider, model: modelLabel },
  );
  process.stdout.write('\n');

  rmSync(tmpRoot, { recursive: true, force: true });

  // ── Report ──
  const mode = args.confirmLive
    ? `FULL RUN (model=${modelLabel}, scored by ${summary.scoredBy})`
    : 'DRY RUN (retrieval-recall: does recall contain the gold evidence? NO model invoked)';
  console.log(`\n## LongMemEval — ${mode}`);
  console.log(`provider: ${summary.provider} · instances: ${summary.total}`);
  const metric = args.confirmLive ? 'accuracy' : 'retrieval-recall';
  console.log(`${metric}: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total})`);
  console.log('\nby question type:');
  for (const [type, t] of Object.entries(summary.byType).sort()) {
    console.log(`  ${type.padEnd(28)} ${(t.accuracy * 100).toFixed(1)}% (${t.correct}/${t.total})`);
  }
  if (summary.abstention.total > 0) {
    console.log(`\nabstention: ${(summary.abstention.accuracy * 100).toFixed(1)}% (${summary.abstention.correct}/${summary.abstention.total})`);
  }
  if (!args.confirmLive) {
    console.log(
      '\nNote: DRY RUN approximates retrieval recall by checking gold-evidence containment in the\n' +
        'recalled context (offline scorer fed the context as the "answer"). For a publishable\n' +
        'answer-accuracy number, re-run with --confirm-live --model <ref> [--judge].',
    );
  }

  if (args.out) {
    mkdirSync(join(args.out, '..'), { recursive: true });
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
    console.log(`\nwrote ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
