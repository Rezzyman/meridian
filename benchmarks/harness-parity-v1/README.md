# Harness parity bench v1

Question answered: on the same agent home and the same memory clone, does Meridian meet or beat the incumbent runtime on the things an operator feels?

## Setup that makes it fair

- Same agent home (`/root/.meridian/arlo` cloned to `/root/.meridian-bench/arlo`).
- Same memory: the agent's CORTEX database copied into a bench CORTEX on a spare loopback port. Both harnesses point at that clone. One harness runs at a time.
- Same key family: a dedicated `ARLO_BENCH` ROUTEXOR key with a hard budget.
- Same wire: both harnesses are driven through OpenAI-compatible `POST /v1/chat/completions` with a bearer token.

## Dimensions

| Axis | How | Threshold for Meridian |
|---|---|---|
| Functional | 30 scripted prompts in `prompts.json`; deterministic checks (non-empty, no narration prefix, no assistant-speak, no markdown wall, must/must-not regexes, length cap) | pass rate at or above the incumbent |
| Memory | 20 seeded facts in `memory.json`: seed, wait, ask; hit = expected pattern in the answer | hit rate at or above the incumbent |
| Reliability | 100 turns round-robin over the prompts; p50, p95, error rate | error rate at or below; p95 within 20 percent |
| Human feel | blind pairwise judge over the functional replies, order randomized, JSON verdict | Meridian preferred at least 60 percent |
| Safety and cost | MemPoisonBench score, governance receipts, USD per turn from the ledger | reported; incumbent cells "unmeasured" where it exposes nothing |
| Proactive | measured in the soak, not here: three automations fire once at the scheduled minute over 24 hours | three of three |

## Run

```bash
pnpm exec tsx scripts/harness-parity.mts \
  --a meridian=http://127.0.0.1:28889,$MERIDIAN_BENCH_TOKEN \
  --b openclaw=http://127.0.0.1:18889,$OPENCLAW_BENCH_TOKEN \
  --judge routexor/claude-sonnet-5 \
  --out benchmarks/harness-parity-v1/results-$(date +%F).json
```

`--reliability 100` sets the reliability turn count, `--no-memory` skips the seeding pass on a database you must not write to, `--judge` is optional and needs `ROUTEXOR_API_KEY`.

## What this bench does not cover

Both harnesses are driven as the resolved operator, so refusal of sacred topics to strangers is not exercised here; it is covered by the runtime's unit tests (`test/verification`, `test/agent/turn-safe-memory.test.ts`). The two `operator-private` prompts check that the operator's own data is not withheld from the operator with chatbot disclaimers.

Meridian answers the bench with `x-meridian-text-style: 1`, which applies the texting rules and bubble shaping a text channel would; the incumbent has no equivalent switch and answers as it always does. The human-feel judge sees both as the operator would receive them.

## Honesty

Follows `docs/harness-comparison-methodology.md`. Every number in a results file comes from that run. A dimension a harness cannot expose is recorded as `unmeasured`. Results are internal unless the methodology's publication rules are met.
