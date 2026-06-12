# LongMemEval harness (accuracy axis)

MERIDIAN's open harness for [LongMemEval](https://github.com/xiaowu0162/LongMemEval) —
the long-term-memory accuracy benchmark. It runs the **same** MemoryProvider the
agent uses (embedded zero-config, CORTEX, or the paid Quartz) through ingest →
recall → answer → score, so provider comparisons are apples-to-apples.

This is the **accuracy** axis, complementary to
[`scripts/mempoison/`](../mempoison/) (the **security** axis). Mastra set the
open-harness credibility bar for LongMemEval accuracy; this is how MERIDIAN
publishes on the same standard, with the code in the open.

## Status: READY, GATED

Nothing here runs a cloud key by default. The harness is wired and unit-tested
(`test/longmemeval/score-harness.test.ts`), but a run needs the dataset, which is
**not vendored** (large + separately licensed).

```bash
# 1) Get the dataset (oracle / s / m variants) from the LongMemEval repo:
#    https://github.com/xiaowu0162/LongMemEval  →  longmemeval_oracle.json etc.

# 2) DRY RUN — retrieval recall only, NO model, fully local:
npx tsx scripts/longmemeval/run-longmemeval.mts --dataset ./longmemeval_oracle.json --limit 20
#    Reports: does the recalled context contain the gold evidence? (memory quality,
#    independent of the answerer). Needs only the dataset + the embedded provider.

# 3) FULL RUN — answer + score (gated behind --confirm-live because it calls a model).
#    Target the LOCAL model (no cloud key):
npx tsx scripts/longmemeval/run-longmemeval.mts \
  --dataset ./longmemeval_s.json --confirm-live --model ollama/qwen2.5:3b --judge --out ./lme-results.json
```

## Modes & gating

| flag | effect | needs |
|---|---|---|
| _(default)_ | DRY RUN — retrieval-recall diagnostic, no model | dataset only |
| `--confirm-live --model <ref>` | FULL RUN — model answers from recall | dataset + a model (local ok) |
| `--judge` | score with a model judge (official-style) instead of the offline lexical scorer | a model |
| `--provider cortex\|quartz` | use a server-backed provider | a running server (BLOCKED without `--confirm-live`) |
| `--limit N` | first N instances | — |
| `--out <path>` | write the full JSON summary | — |

The runner **BLOCKS** (exit 2, with instructions) if the dataset is missing or if
a server-backed provider is selected without `--confirm-live`. The embedded
provider needs no server or keys.

## Scoring honesty

- **offline** (default in a full run without `--judge`): a lexical approximation
  (normalized containment + token-F1 + abstention detection). It over-credits
  verbose answers — it is **not** the official metric, and every report labels it.
- **judge** (`--judge`): a model grades each answer against the gold with a
  type-aware prompt (abstention questions are graded on whether the model
  correctly abstains). This is the publishable number.

## Caveats (documented, not hidden)

- The embedded provider stores no per-memory timestamp, so the harness prefixes
  each session's date into the encoded text (`[2026-01-01] USER: …`) to keep
  temporal-reasoning questions answerable. CORTEX/Quartz carry real dates.
- A DRY RUN measures retrieval recall via gold-evidence containment, which is a
  proxy, not answer accuracy. Use a full run with `--judge` to publish accuracy.
- Per-instance isolation uses a fresh embedded JSONL store per question, deleted
  after each instance.
