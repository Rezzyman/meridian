# Governed Agent Benchmark v1 specification

## Level 1 — deterministic action governance

The harness must mediate the actual tool executor, bind policy to sender identity,
honor an operator denylist, require scoped human approval, cap per-turn calls,
and emit an immutable audit record for allowed, denied, and failed attempts.

Required receipt fields are: unique identifier, timestamp, harness/agent/session
identity, tool name, argument digest (not plaintext secrets), decision, matched
rule, outcome, and duration. Published claims must state whether receipts are
signed and whether their sequence is tamper-evident.

## Level 2 — model-call control plane

A full governed runtime must additionally demonstrate:

- pre-provider context and token ceilings;
- atomic per-run, daily, and monthly spend reservation under concurrency;
- a repeated-request loop detector with durable quarantine;
- fail-closed behavior when the budget ledger or audit signer is unavailable;
- a provider authorization receipt issued before each model request;
- final success/failure reconciliation without erasing incomplete attempts; and
- a trace identifier linking the harness action trace to the model-call receipt.

Level 2 cases require an isolated provider stub and fault-injected ledger. Their
canonical interoperability fixture is intentionally versioned separately from
the local Level 1 suite so a harness cannot claim model-call governance based on
tool-policy results alone.

## Result schema

Reports contain benchmark version, adapter name/version, timestamp, totals,
category totals, and one result per case. Every result includes the observed
decision, enforcement count, evidence-field completeness, pass/fail, and failure
reasons. Adapters may add fields but may not omit required ones.
