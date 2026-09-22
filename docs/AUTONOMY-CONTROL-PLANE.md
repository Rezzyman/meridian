# Meridian autonomy control plane

Meridian separates autonomy into three layers:

1. The control plane supplies deterministic schedules, leases, idempotency,
   durable outcomes, dead-letter recovery, and notification suppression.
2. The agent supplies judgment from bounded evidence.
3. The owner supplies explicit authority for consequential work.

The durable ledger is stored at
`AUTOMATIONS/.runtime/control-plane.json` inside each agent home. Writes are
atomic and owner-only. A schedule occurrence has one deterministic run id.
An active lease prevents overlap. A process restart or expired lease recovers
the interrupted run as a `dead_letter` rather than silently retrying after an
unknown side effect.

## Automation policy

Every automation should declare its authority instead of inheriting the chat
agent's tools:

```yaml
---
name: morning-brief
schedule: "0 8 * * 1-5"
timezone: America/Denver
autonomyMode: live       # shadow | live
actionTier: observe      # observe | draft | execute
mode: direct             # draft | direct
requiresApproval: false
tools: [gmail_recent]
pushTo: telegram
audit: true
leaseMinutes: 30
timeoutMinutes: 15
misfireGraceMinutes: 30
cooldownMinutes: 60
---
```

- `shadow` runs produce ledger evidence but neither notify nor encode memory.
- `draft` never delivers externally.
- `observe` and `draft` refuse mutating tools even if accidentally listed.
- `execute` is the only tier that can receive consequential tools, and such a
  job must set `requiresApproval: true`.
- `tools` is a per-job allowlist. An omitted list means no tools. The raw
  gateway tool surface is never exposed to a scheduled job.
- `requiresApproval: true` consumes one owner-scoped grant before the model
  runs. From the trusted Meridian REPL, authorize it with:

  ```text
  /approve automation:<job-name> 5
  ```

The grant is single-use, expires, and is stored in the same canonical
`op:<operator.id>` scope the scheduler consumes.

## Heartbeat policy

Heartbeat is a read-only assessor, not a synthetic chat turn. It has no tools,
does not create an unknown-operator session, and does not encode its own output
into CORTEX. It returns a structured assessment (`quiet`, `actionable`, or
`degraded`) backed only by recalled evidence.

`heartbeat.mode: shadow` is the deployment default. In `live` mode it notifies
only when the result is actionable, clears `minConfidence`, and is novel within
`cooldownMinutes`. Failed deliveries are not marked as sent, so they are not
incorrectly suppressed later.

## Operational invariants

- A crash never causes an automatic retry of a possibly consequential run.
- A corrupt ledger fails closed instead of silently replacing history.
- Stale writer locks are reclaimed; live locks fail closed.
- Provider or evidence failure is recorded as `degraded`/`failed`, not dressed
  up as a successful judgment.
- Shadow evidence must be reviewed before changing a flagship agent to live.
