# Meridian Roadmap

What's working today, what's in flight, and what's coming. Honest about every line. Updated against `main`, not against vibes.

This file lives at the repo root because the OSS framework and the upcoming managed product (`meridian.aterna.ai`) share a feature set. If you're evaluating whether Meridian fits your use case, this is the load-bearing document.

---

## Working today (`v1.2`)

### Core runtime

- **Seven-layer AgentOS scaffold** (`meridian init <slug>`)
- **Onboarding interview** (`meridian onboard`) populates IDENTITY, CONTEXT, principles, sacred-topic policy
- **`meridian doctor`** end-to-end health check including active-memory-provider visibility
- **MemoryProvider seam** — CORTEX (open-source) by default; ATERNA-licensed Quartz drops in via env flag with graceful fallback
- **Encrypted vault** (AES-256-GCM, scrypt KDF) for per-skill secrets
- **Passphrase guards** for sensitive skills (configurable session window)
- **Sacred-topic gates on every channel** — regex-blocked patterns refused before the model sees them, for the public voice line and any sender not resolved to the operator (SMS/WhatsApp/Slack/Discord/Matrix/Telegram)
- **Per-agent isolation** — dedicated Neon DB, Voyage embedding key, model key per agent
- **Framework-enforced runtime rules** prepended to every system prompt (no tool-call theatre, no hallucinated results, no swallowed errors)
- **DreamWeaver** in-process consolidation cycle
- **AutomationManager** for cron-scheduled skill runs
- **SessionStore** persisting turns to a pure-JS JSONL append log for cross-restart continuity (zero native dependencies)
- **Test suite + CI** — 587 tests over the core seams (turn loop, memory contract, vault, router, skills, verification, MCP, gateway, delegation, structured output); GitHub Actions runs typecheck + lint + test + build on every push/PR across Node 20 / 22 / 24
- **MCP client** — `CONNECTIONS/mcp.json` servers (stdio / streamable-http / sse) surface as first-class, channel-gated tools (`mcp_<server>_<tool>`); voice excluded by default; `meridian mcp add` registers a server, `meridian mcp list` probes, `meridian mcp remove` drops one
- **MCP server** — `meridian mcp serve` exposes CORTEX recall/stats/health over the protocol (encode opt-in via `--allow-encode`); agentId pinned server-side
- **Bounded sub-agents** — `delegate` built-in: scoped sub-turn, structural depth limit, output-token + wall-clock caps, explicit tool grants, no memory encode by default
- **Provider circuit breaker** — per-ref open/half-open/closed with an all-open failsafe, fed from the turn loop
- **Schema-enforced output** — `defineTool` (Zod-validated tool results) + `generateStructured` (validated JSON from the model chain with repair-retries)
- **Memory-poisoning defense** — recall-stage provenance screening quarantines injected directives from untrusted sources before they reach the model; scored on the open, reproducible MemPoisonBench (100%→0% poisoning success, known gaps published as the roadmap)
- **Runtime VERIFICATION layer** — operator-authored checks run every turn; block-severity withholds the reply, warn-severity records for audit

### Channels (9)

- **CLI / REPL** — primary developer interface
- **Telegram** — bootstrap-locked to first sender or pinned chat ID
- **Slack** — Events API with v0 HMAC signature verification and replay window
- **Discord** — Interactions endpoint with Ed25519 verification
- **WhatsApp** — Meta Cloud API with sha256 HMAC verification
- **Matrix** — client-server /sync long-poll (self-hostable, behind NAT)
- **SMS** — Twilio, with HMAC-SHA1 verification and reply pagination
- **VAPI voice** — public phone line with passphrase unlock; the webhook fails closed without a shared secret
- **HTTP gateway** — token-auth `/chat`, `/chat/stream` (SSE), and per-channel webhooks. One resolved operator shares one conversation across every channel.

### Skills (bundled)

- **`web-search`** — Tavily real-time search + cited answers
- **`github`** — repos / issues / PRs read + comment via personal access token
- **`google`** — Gmail / Calendar / Drive via the bundled `gog` binary (works on Mac; **headless-server OAuth flow is documented but not yet automated** — see "In flight" below)
- **`wearables`** — multi-provider lifelog category. Limitless Pendant adapter and Bee Pendant adapter (via local `bee proxy`) ship working. Plaud Note registered for the public API when it ships.

### Memory

- **CORTEX** (open-source default) — full hippocampal pipeline, dream cycle, valence, reconsolidation. See `github.com/Rezzyman/cortex`.
- **Quartz** (ATERNA-licensed, BSL-1.1) — recall pipeline benchmarked at 94.53% on LongMemEval-oracle, statistically tied with the public state of the art. Drops in as a Meridian provider via `MERIDIAN_MEMORY_PROVIDER=quartz`.

---

## In flight (next 1–2 weeks)

These features are scaffolded in the codebase but require either polish, headless-server work, or live-data validation before they can be promised in marketing copy.

### Reliability

- **VAPI outbound calls** — required for the "your new agent calls you to introduce itself" onboarding moment. Inbound voice works today; outbound triggering from Meridian is the missing piece.
- **`meridian skills setup google` headless-server flow** — works fine on Mac (gog handles OAuth via local browser). On a headless server, the operator needs to SSH-port-forward the OAuth callback. The walkthrough is documented; automating it cleanly is in flight.
- **Live `wearables_pull` end-to-end test** — the `limitless` and `bee` adapters compile and have unit-level smoke tests. A production-scale lifelog backfill against a real Voyage key is queued and will surface any rate-limit or large-payload edge cases that need throttling refinements.

### Distribution

- **Remote skill install** (`meridian skills add <github-url>`) — screened through the same malice gate as self-authored skills before install, so the community on-ramp does not become a supply-chain surface. (`meridian mcp add` already lands the MCP half of this.)

> Shipped since this section was written: a compiled `dist/` build (`pnpm build` via `tsup` + `scripts/build-skills.mjs`) and npm publish, so `npm i -g @aterna/meridian` runs the built runtime with no `tsx` on the path.

---

## Coming next (Q3 2026)

### Channels

(Slack, Discord, WhatsApp, Matrix, and SMS have shipped — see "Working today".)

- **Web chat UI (hosted)** — Next.js component shipped as a standalone page operators can host or embed. (The single-file `skeleton/web/chat.html` ships today with live SSE streaming.)
- **iMessage** — via a Mac relay agent or Sendblue/LoopMessage API for non-Mac operators
- **Signal** — via signal-cli for operators who want an end-to-end-encrypted channel

### Skills

- **`notion`** — read pages, search workspaces, append blocks (read + append, no destructive ops by default)
- **`linear`** — issue triage, PR-status checks, my-assigned views
- **`browser`** — bundled Playwright with sandboxed browser contexts per tool call
- **`stripe`** — read-only customer / subscription / invoice surface for operators running ATERNA-style billing
- **`calendly` / `cal.com`** — booking surface for operator's voice line callbacks

### Wearables (more adapters under existing category)

- **Plaud Note** — when the Plaud Developer Platform exits private beta
- **Friend AI** — if/when Based Hardware ships a server-side API (currently phone-local only)
- **Meta Ray-Ban Stories** — not on the near-term roadmap; Meta's Wearables Device Access Toolkit is partner-only and exposes live sensors not stored transcripts

### Operations

- **Observability dashboard** — per-agent health, recall hit rates, token spend, automation run history
- **Public skill registry** — install community skills with `meridian skills install <namespace>/<name>`

---

## Coming later (Q4 2026 +)

- **Meridian managed cloud** (`meridian.aterna.ai`) — the SaaS surface for non-technical operators. Hosted Meridian gateways, per-customer Neon DBs, voice + chat included, monthly subscription. ATERNA-managed; OSS framework remains free + self-hostable for those who prefer that.
- **Quartz observation pipeline** integrated into Meridian's request path — today's release uses Quartz's `RecallRouter` (raw-only mode); the full pipeline (observation extraction + Answerer + multi-pass retry) lights up next.
- **Agent-to-agent handoff protocol** — formalized so a Meridian agent can hand a thread off to a specialist agent in the same operator's fleet without context loss.
- **Mobile clients** (iOS / Android) — wrappers around the web chat UI plus push notifications for proactive briefs.

---

## Explicitly NOT on the roadmap

- **Selling your data.** Per-agent isolation is contractual. Memory stays in the operator's database; ATERNA does not aggregate, train on, or share customer memory. The license enforces this for paid tiers, the architecture enforces it for everyone.
- **Multi-agent shared memory by default.** Two agents in the same operator's fleet do NOT see each other's memory unless the operator explicitly inherits CONTEXT layers. Privacy is the default.
- **A general-purpose autonomous agent.** Meridian is a chief-of-staff runtime — focused, accountable, with explicit tool surfaces and verification gates. We will not ship features that let the agent run wild on your machine without authorization.

---

## Want a feature on the list?

Open an issue at [github.com/Rezzyman/meridian/issues](https://github.com/Rezzyman/meridian/issues) with the use case. We prioritize by signal density — five operators asking for the same integration moves faster than one shouting.

Pull requests for new skills are especially welcome; the contract is in [CONTRIBUTING.md](CONTRIBUTING.md) and the smallest working plugin example is `skeleton/SKILLS/web-search/`.
