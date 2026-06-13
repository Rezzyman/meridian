# Hosted / paid lane — architecture & on-ramp

> **Why this exists now, before launch.** Every precedent in the strategy
> research says the same thing: viral OSS adoption does **not** self-monetize
> (Steinberger lost $10–20k/mo on OpenClaw at peak; Mem0 and n8n monetized only
> because the paid path was wired in deliberately). So the paid lane is specced
> and the intent-capture is ready **before** the spike, not retrofitted after.

This is a design + ready-to-wire scaffold. Nothing here is auto-mounted or calls
an external service; standing up the hosted tier needs a server and keys, which
is out of scope until explicitly provisioned.

## The split (already in the codebase)

MERIDIAN is MIT and self-hostable end to end. The commercial lane is the
**memory layer**, behind the `MemoryProvider` seam that already exists:

```
MERIDIAN runtime ── MemoryProvider ──┬─ EmbeddedMemoryProvider   (MIT, zero-config, local)
   (turn loop,                       ├─ CortexMemoryProvider     (MIT, self-host CORTEX server)
    recall→encode)                   └─ QuartzMemoryProvider     (BSL/commercial, @aterna/quartz)
```

The runtime cannot tell which provider is active — same interface, same
isolation contract (`src/memory/provider.ts`). That is the whole point: the open
core is fully functional on embedded/CORTEX, and Quartz is a drop-in upgrade for
agents that license it. `MERIDIAN_MEMORY_PROVIDER=quartz` selects it, with an
automatic fallback to CORTEX if the package is absent (`src/memory/factory.ts`).

Licensing precedent: n8n's fair-code "Sustainable Use License" (free self-host
for internal use, paid for commercial hosting/embedding) is the tested structure
this mirrors — MIT core + BSL Quartz.

## What the hosted tier sells (in priority order)

1. **Hosted memory convenience** — a managed CORTEX/Quartz endpoint so an
   operator never runs Postgres+pgvector or a CORTEX server. The agent points
   `MERIDIAN_CORTEX_URL` at the hosted endpoint; everything else is unchanged.
2. **Quartz accuracy** — the LongMemEval-optimized recall pipeline. The proof is
   the open harness in `scripts/longmemeval/`: run embedded vs CORTEX vs Quartz
   through the identical benchmark and publish the delta. (Same credibility
   standard Mastra set — open, reproducible, official judge.)
3. **The security moat as a tier feature** — signed provenance + the LLM-judge
   tier (`config.cortex.provenanceTrust='signed'`, `memoryLlmJudge=true`) are the
   high-assurance settings a hosted "secure memory" plan turns on by default.

## Ready-to-wire pieces (in repo, not mounted)

- **Memory-over-HTTP** already exists two ways: the gateway (`src/gateway/`) and
  the MCP server (`meridian mcp serve`, read-only memory tools). A hosted tier is
  these, deployed behind auth + per-tenant isolation — not new surface area.
- **Waitlist intent capture** — `scripts/hosted/waitlist.mts`. A landing page
  ("Hosted MERIDIAN / Quartz — join the waitlist") POSTs to it; it appends to a
  local JSONL. No external service, no keys. Captures intent during the launch
  spike so the paid lane has a pipeline from day one.

  ```bash
  npx tsx scripts/hosted/waitlist.mts add --email you@example.com --plan secure-memory --note "from HN"
  npx tsx scripts/hosted/waitlist.mts list
  ```

## What is deliberately NOT here (BLOCKED until provisioned)

- A live hosted server, tenant DB, billing, or auth provider — all need real
  infrastructure + keys. Specced, not stood up.
- Any auto-start of CORTEX/Quartz from the eval or hosted scripts — they BLOCK
  and ask for `--confirm-live` + a configured server.

## Sequencing for launch (from the launch kit)

1. Ship the open core + the security moat (done — this PR stack).
2. Put up the landing page with the waitlist (capture intent).
3. Publish the open benchmarks (MemPoisonBench security + LongMemEval accuracy).
4. Stand up hosted memory for waitlist converts (needs infra — human-paced).
