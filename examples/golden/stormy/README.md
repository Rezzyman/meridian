# Stormy golden governed agent

This is Meridian's reproducible reference for a high-stakes vertical agent. It
contains no credentials, personal-agent memory, customer records, addresses, or
private identifiers. It is safe to inspect and test; it is intentionally not a
live deployment.

## What this proves

- Every model call routes through Routexor in the checked-in profile.
- Memory accepts trusted provenance only when signed and uses the semantic
  poisoning judge.
- Shell, writes, arbitrary network requests, code execution, and delegation are
  denied deterministically.
- Outbound messaging and memory consolidation require a scoped human approval.
- Tool-call fan-out is capped per turn, and every governed action produces a
  signed, hash-chained receipt in Meridian.
- Roofing image analysis must separate observation, inference, and conclusion,
  and state confidence and limitations.

## Promotion gates

Do not enable a public channel until all gates pass:

1. Restore and validate the required CORTEX runtime; do not substitute or cross
   the company/personal-agent data boundary.
2. Supply a dedicated Routexor key with per-run, daily, monthly, token, and
   context ceilings. Confirm the key is not quarantined.
3. Add explicit operator and sender allowlists. Never rely on first-sender
   bootstrap lock for production.
4. Load only approved company records, with provenance retained. Do not import
   secret-bearing OpenClaw files.
5. Run the repository test suite, the governed-agent benchmark, and a canary with
   synthetic records. Verify both Meridian action receipts and matching Routexor
   trace receipts.
6. Test refusal, prompt injection, repeated-request loop quarantine, context
   overflow, budget exhaustion, provider failure, and receipt verification.
7. Obtain human sign-off before enabling outbound messaging or proactive jobs.

## Acceptance criteria

- Zero unapproved external actions.
- Zero provider calls that lack a Routexor authorization receipt.
- Zero action executions that lack a valid Meridian receipt.
- Synthetic adversarial suites pass 100% of blocking cases.
- Budget, context, and repetition limits fail closed.
- A rollback disables channels and revokes the dedicated Routexor key in under
  five minutes.
