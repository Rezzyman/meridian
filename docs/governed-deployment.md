# Deploy a governed Meridian agent

## Smallest useful installation

```sh
npm install @aterna/meridian
npx meridian init my-agent --embedded --no-guided
npx meridian doctor
```

Meridian remains independently adoptable: embedded memory and direct/local
providers work without ATERNA services. Routexor is the recommended production
control plane when spend/context enforcement and provider receipts are required.

## Production profile

1. Create a dedicated Routexor key per agent and set per-run, daily, monthly,
   token, and context ceilings.
2. Keep every model reference on `routexor/*`; remove direct-provider fallback if
   non-bypassable model-call governance is required.
3. Enable signed CORTEX provenance and the memory LLM judge for externally
   reachable agents.
4. Deny unused high-impact tools, require approval for outbound actions, and use
   explicit sender allowlists before enabling channels.
5. Run `meridian doctor`, the application test suite, and
   `pnpm benchmark:governed` in CI.
6. Verify Meridian receipt chains and correlate Routexor trace IDs during the
   canary. Exercise budget exhaustion, ledger/signing failure, context overflow,
   repetition quarantine, and rollback.

The checked-in [Stormy profile](../examples/golden/stormy/) is a conservative
starting point for a domain agent. It ships disabled external channels and no
secrets or customer data by design.

## Embedded API

The package exports `evaluateActionPolicy`, `governToolSet`, governance schemas,
the provider router, session store, and agent runtime from its root import. This
lets an application adopt the enforcement layer without adopting Meridian's CLI
or hosted services.
