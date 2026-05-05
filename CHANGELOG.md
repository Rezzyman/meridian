# Changelog

All notable changes to Meridian. Date format: YYYY-MM-DD. UTC.

## [1.1.0] - 2026-05-05

Groq added as a first-class model provider.

### Added

- **`groq` provider** in the model router. Set `GROQ_API_KEY` in your agent's `.env` and reference models with the canonical `groq/<model-id>` ref (e.g. `groq/llama-3.3-70b-versatile`). Works everywhere a model ref is accepted: `models.primary`, `models.fallbacks`, `smartRouting.cheapModel`, `heartbeat.model`, skill-level overrides.
- **`doctor` command checks Groq key uniqueness** alongside Neon, Voyage, and OpenRouter. Sharing a Groq key across agents triggers the same fail signal: rate limits and usage attribution apply to the free tier just as they do to paid providers.

### Why

Groq's free tier (Llama 3.3 70B, Llama 3.1 8B, Mixtral, Gemma) gives operators a real zero-cost path to running an agent end-to-end. Latency on Groq's LPU hardware is markedly lower than the major paid providers, which feels especially good on voice-channel turns and short-prompt classification work. OpenRouter and Anthropic remain first-class for tool-using main-brain models where Sonnet-class reasoning is worth the spend.

### Recommended chain shape

For operators who want premium reasoning plus free fast routing on short turns:

```yaml
models:
  primary: openrouter/anthropic/claude-sonnet-4.6
  fallbacks:
    - groq/llama-3.3-70b-versatile
  smartRouting:
    enabled: true
    cheapModel: groq/llama-3.3-70b-versatile
```

[1.1.0]: https://github.com/Rezzyman/meridian/releases/tag/v1.1.0

## [1.0.1] - 2026-05-03

Same-day post-launch hardening + the public roadmap.

### Added

- **`ROADMAP.md`** at the repo root. The honest feature inventory: what's working today, what's in flight, what's queued, and what is explicitly NOT on the roadmap. Lives publicly so contributors and prospective operators can decide whether Meridian fits without guessing.
- **VAPI outbound calling.** `VapiChannel.placeOutboundCall(opts)` posts to `api.vapi.ai/call` with phoneNumberId + assistantId + customer.number. Per-call `firstMessage` and `customerName` overrides via `assistantOverrides` so the agent can open with situational context. Surfaced via:
  - `POST /vapi/call` gateway endpoint (token-auth) — for signup wizards and automation triggers
  - `meridian voice call <to>` CLI subcommand — for ad-hoc smoke tests
- **`skeleton/web/chat.html`** — single-file portable browser chat UI. Zero dependencies, zero build, opens straight from `file://` or any static host. Operator pastes their gateway URL + bearer token (saved to localStorage), starts chatting. Targets the largest UX gap for non-CLI operators: a chat surface they can see immediately.

### Changed

- **`cortex.recall` is hard-capped at 8 seconds per turn.** Voyage rate limits and CORTEX stalls would previously hang turns 3-5 minutes; now the agent proceeds without memory rather than freezing the channel. Timeout is logged explicitly so it surfaces in observability.
- **Gateway logs CORTEX health at boot.** If the backend is unreachable, the warning lands at startup with the concrete URL and error rather than the operator hitting a generic failure on the first `/chat` call.

### Removed nothing.

[1.0.1]: https://github.com/Rezzyman/meridian/releases/tag/v1.0.1

## [1.0.0] - 2026-05-03

First public open-source release of Meridian.

### Added

- **Seven-layer AgentOS scaffold.** `meridian init <name>` materializes IDENTITY, CONTEXT, SKILLS, MEMORY, CONNECTIONS, VERIFICATION, AUTOMATIONS as a typed runtime per agent. Operator picks a name; the rest is a clean home with sensible defaults.
- **`meridian onboard` extended interview.** Five-minute walkthrough that populates `IDENTITY/USER.md`, `CONTEXT/strategy.md`, `CONTEXT/stakeholders.md`, `CONTEXT/principles.md`, and the sacred-topic policy in `config.yaml`. Designed to run after `meridian init` when the operator has time to commit.
- **`meridian doctor`** end-to-end health check. Surfaces the active memory provider (cortex / quartz), CORTEX reachability, vault state, provider keys, and channel arming. Tells the operator at a glance what's wired and what isn't.
- **`MemoryProvider` seam.** Pluggable memory backend across the runtime. CORTEX is the open-source default (`@aterna/cortex` at github.com/Rezzyman/cortex); ATERNA-licensed Quartz drops in via `MERIDIAN_MEMORY_PROVIDER=quartz` with graceful fallback when the package is absent.
- **Bundled plugins** with interactive paste-and-validate setup walkthroughs (masked input, live API validation, bad keys never reach the vault):
  - **`google`** — Gmail, Calendar, Drive across multiple mailboxes via the bundled `gog` binary (steipete/gogcli, MIT, auto-downloaded + checksum-verified).
  - **`web-search`** — Real-time web search and synthesized answers with citations (Tavily API).
  - **`github`** — Read repos / issues / PRs and post comments via personal access token.
  - **`wearables`** — Multi-provider lifelog category. Limitless Pendant adapter ships working; Bee Pendant adapter ships working via local `bee proxy`; Plaud Note registered with honest "private beta, waitlist only" messaging until the API ships. `WearableProvider` interface is the contract for new adapters.
- **Skill manifest as source of truth for env keys.** Skills declare their env requirements in `manifest.yaml#requires.env[]`; the loader pre-scans, merges, and exposes those keys via `ctx.env`. New env-using skills only edit their manifest — no core schema or loader edits required.
- **Multi-channel agents** with cross-channel memory: CLI, Telegram, voice via VAPI. Per-agent isolation: every agent gets its own dedicated Neon DB, Voyage embedding key, and OpenRouter key. No shared backends.
- **Encrypted vault** (AES-256-GCM, scrypt-derived key) with passphrase-gated tools and voice-channel sacred-topic guardrails.
- **DreamWeaver** in-process consolidation cycle, **AutomationManager** for cron-scheduled skill runs, **SessionStore** persisting turns to SQLite for cross-restart continuity.
- **Framework-enforced `<runtime_rules>`** prepended to every system prompt across every channel. Five hard rules forbidding tool-call theatre, hallucinated results, fake background work, swallowed tool errors, and fabricated context. Eliminates the most trust-eroding model-output failure modes regardless of operator persona configuration.
- **`CONTRIBUTING.md`** and **`SECURITY.md`** for OSS hygiene. Plugin contribution contract documented for new skills.

### Notes

The CLI launcher runs from `src/` via `tsx`, so no build step is needed for daily use. CORTEX server (the memory backend) is its own repo at [Rezzyman/cortex](https://github.com/Rezzyman/cortex); the README's "Bring up CORTEX" subsection has the Docker quickstart.

[1.0.0]: https://github.com/Rezzyman/meridian/releases/tag/v1.0.0
