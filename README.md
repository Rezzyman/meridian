# Meridian

**The open-source agent OS.** Persistent cognitive memory, voice as a first-class channel, batteries-included plugins. By [ATERNA AI](https://aterna.ai). Create your legend.

```
███╗   ███╗███████╗██████╗ ██╗██████╗ ██╗ █████╗ ███╗   ██╗
████╗ ████║██╔════╝██╔══██╗██║██╔══██╗██║██╔══██╗████╗  ██║
██╔████╔██║█████╗  ██████╔╝██║██║  ██║██║███████║██╔██╗ ██║
██║╚██╔╝██║██╔══╝  ██╔══██╗██║██║  ██║██║██╔══██║██║╚██╗██║
██║ ╚═╝ ██║███████╗██║  ██║██║██████╔╝██║██║  ██║██║ ╚████║
╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝
```

> Create Your Legend.

---

## What Meridian is

Meridian is a cognitive agent runtime organized around seven layers: **IDENTITY, CONTEXT, SKILLS, MEMORY, CONNECTIONS, VERIFICATION, AUTOMATIONS**.

Other agent stacks treat each of those as a discipline you maintain by hand. Meridian materializes them as a typed runtime, with **CORTEX cognitive memory** wired in at the spine and **voice** as a first-class channel.

Built by [ATERNA AI](https://aterna.ai). Ships under MIT. Powers ATERNA's production agent fleet.

---

## What makes Meridian different

| | LangChain / Mastra / CrewAI | Mem0 / Letta / Zep | voice-only platforms | **Meridian** |
|---|---|---|---|---|
| Category | Orchestration framework | Memory SDK | Voice platform | **AgentOS runtime** |
| Cognitive memory | bring-your-own | vector / graph | within-session only | **CORTEX-native, in-process** |
| Voice with cross-call memory | no | no | no | **yes** (voice channel + CORTEX `channel:voice` valence) |
| Verification layer | discipline | none | none | **runtime-enforced** |
| Per-agent isolation | shared backends | shared backends | shared accounts | **dedicated triad: Neon + Voyage + OpenRouter per agent** |
| Bundled plugins | DIY per integration | n/a | n/a | **gog / web-search / github / wearables preinstalled** |
| AgentOS portability | partial | none | none | **seven-layer filesystem readable by any tool** |

---

## Bundled plugins

Meridian ships plugins as first-class citizens, not "bring your own SDK." Every Meridian agent gets the following the moment you `meridian skills install <name>`:

| Skill | What it does | How |
|---|---|---|
| **`google`** | Gmail, Calendar, Drive across multiple mailboxes (incl. Workspace DWD) | Bundled [gogcli](https://github.com/steipete/gogcli) (MIT), auto-downloaded + checksum-verified |
| **`web-search`** | Real-time web search and synthesized answers with citations | [Tavily API](https://tavily.com) (free tier, 1000 searches/month) |
| **`github`** | Read repos / issues / PRs, post comments | GitHub REST API + personal access token |
| **`wearables`** | Pull ambient lifelog transcripts from a wearable provider into CORTEX. Multi-provider category with a pluggable adapter interface | Limitless Pendant (working) and Bee Pendant via local `bee proxy` (working). Plaud Note pending (Developer Platform in private beta). Adapter contract documented in `skeleton/SKILLS/wearables/setup.md`. |

Setup for each is one command:

```bash
meridian skills install web-search
meridian skills setup web-search   # paste API key, done
```

Coming next: `slack`, `notion`, `linear`, `browser` (Playwright bundle). Plugins are MIT-licensed and live under `skeleton/SKILLS/<name>/`. Copy any one as the template for your own.

---

## Install

Requires Node 20+ and [pnpm](https://pnpm.io). A CORTEX server reachable on `MERIDIAN_CORTEX_URL` (defaults to `http://127.0.0.1:3100`); the open-source CORTEX lives at [Rezzyman/cortex](https://github.com/Rezzyman/cortex) and runs alongside Meridian.

```bash
git clone https://github.com/Rezzyman/meridian
cd meridian
pnpm install
pnpm link --global   # exposes `meridian` and `mer` on $PATH
```

The CLI launcher runs straight from `src/` via `tsx`, so no build step is needed for daily use. If you want a compiled `dist/` for production deployment, that path is on the roadmap; for now `meridian` and `mer` work out of the box.

### Bring up CORTEX

Meridian needs a CORTEX server running before any agent can recall or encode memory. The open-source CORTEX is its own repo. Quickest path with Docker:

```bash
git clone https://github.com/Rezzyman/cortex
cd cortex
cp .env.example .env
# Edit .env: set VOYAGE_API_KEY (free tier at voyageai.com)
docker compose up -d
npx tsx scripts/run-migrations.ts
npx tsx src/index.ts        # REST API on :3100
```

Or run Postgres + pgvector yourself instead of Docker; full instructions are in the [CORTEX repo](https://github.com/Rezzyman/cortex). Either way, the result is a CORTEX server listening on `http://127.0.0.1:3100` (the default Meridian expects). If you run CORTEX on a different port or host, set `MERIDIAN_CORTEX_URL` in your agent's `.env` to match.

---

## Quick start

Spin up an agent in five minutes:

```bash
meridian init aria               # creates ~/.meridian/aria/
# Edit ~/.meridian/aria/.env and set the three required keys:
#   NEON_DATABASE_URL=...        (dedicated Neon project for this agent)
#   VOYAGE_API_KEY=...           (dedicated Voyage AI key)
#   OPENROUTER_API_KEY=...       (dedicated OpenRouter key)
# Optional channels:
#   VAPI_API_KEY=...             (voice)
#   TELEGRAM_BOT_TOKEN=...       (chat)

meridian doctor                  # validate the foundation
```

Install plugins:

```bash
meridian skills install web-search   # Tavily search
meridian skills install github       # GitHub read + comment
meridian skills install google       # Gmail / Calendar / Drive (auto-downloads gog)
meridian skills setup web-search     # paste your Tavily key
meridian skills setup github         # paste your GitHub PAT
meridian skills setup google         # OAuth multiple Google accounts
```

Bring channels online and start chatting:

```bash
meridian gateway                 # HTTP gateway on :18889 + Telegram + voice
meridian                         # interactive REPL
```

Add a specialist that inherits the hub's CONTEXT and MEMORY:

```bash
meridian init outbound --inherits aria
```

---

## The seven layers

`~/.meridian/<agent>/` materializes the AgentOS:

```
IDENTITY/        AGENT.md, USER.md
CONTEXT/         stakeholders.md, strategy.md, principles.md, ...
SKILLS/          google/, github/, web-search/, wearables/, calendar-prep/, commitment-ledger/, ...
MEMORY/          cortex.config, decision-logs/, relationships/, processes/, episodic/
CONNECTIONS/     mcp.json, calendar.config, inbox.config, slack.config
VERIFICATION/    <skill>.checks.md, audits/
AUTOMATIONS/     dream-cycle.cron, weekly-audit.cron, inbox-scan.cron, ...
config.yaml      .env       state.db       sessions/       logs/
```

This structure is portable. Any harness that reads markdown can consume a Meridian agent home: Claude Code reads `IDENTITY/AGENT.md`, OpenClaw reads `SKILLS/`, Cursor reads `CONTEXT/`. **Meridian is the best runtime for the OS, not the only one.**

---

## CORTEX-native turn lifecycle

```
user input
   ↓
preTurn hooks
   ↓
CORTEX recall (CA3 pattern completion against the agent's dedicated Neon DB)
   ↓
recall folded into <cortex_recall> system prompt section
   ↓
provider call via Vercel AI SDK (primary + fallback chain, smart-routing)
   ↓
tool-use loop (built-ins + filesystem skills + MCP)
   ↓
postTurn hooks
   ↓
verification checks (block | warn)
   ↓
CORTEX encode (hippocampal pipeline, valence-tagged, channel-aware)
   ↓
session.append + checkpoint
```

The dream cycle runs in-process via a Node `setInterval` worker. No external cron. No "gateway crashed → dream skipped → memory stale" failure mode.

---

## Voice with cross-call memory

The headline feature.

Voice assistants in the rest of the market have within-session memory only. Meridian wires the voice channel to CORTEX so every voice transcript is encoded with `channel:voice` valence, and the next call from the same phone number triggers cross-call recall:

> "Hi John, glad you called back. Earlier you were asking about the Oak Hills quote. Did you want to schedule the inspection now?"

That experience is impossible on a raw voice stack without code glue. Meridian gives every voice line a real receptionist's memory.

---

## Commands

```
meridian init <slug>            Seed a new agent home (--template, --inherits)
meridian agents                 List configured agents
meridian use <slug>             Switch active agent
meridian doctor                 End-to-end health check
meridian deploy --intake X.json Run the 20-minute provisioning pipeline
meridian audit                  Run the AgentOS retrospective
meridian gateway                Start HTTP gateway + Telegram + voice channels
meridian                        Open the interactive REPL (default)
```

Inside the REPL: `/help`, `/cortex`, `/recall`, `/encode`, `/dream`, `/audit`, `/skills`, `/quit`.

---

## Open-source vs commercial

**MIT under this repo:**
- Meridian runtime (CLI, REPL, gateway, channels, skills, sessions, verification, audit, automations)
- Seven-layer AgentOS spec
- Voice channel adapter (VAPI) + Telegram channel
- CORTEX V2.4 client bindings (compatible with the public CORTEX server)
- Encrypted vault (AES-256-GCM, per-agent isolated)
- Skills v2 spec + bundled plugin pack (`google`, `web-search`, `github`, `wearables`)
- DreamWeaver in-process consolidation cycle
- AutomationManager (cron skills with full tool access)

**Commercial (ATERNA-licensed):**
- **[Quartz](https://aterna.ai/quartz)** (BSL-1.1): frontier paid memory layer benchmarked at 94.53% on LongMemEval-oracle, statistically tied with the public state of the art. Drops in as a Meridian provider via `MERIDIAN_MEMORY_PROVIDER=quartz`. Production-deployed inside ATERNA today; available for licensing.
- **Operator dashboard** (web) and the managed cloud version of Meridian for non-technical operators.

The public release uses CORTEX by default. Quartz lives behind the same `MemoryProvider` interface, so upgrading is a config flag plus an installed package, not a port. When the Quartz package is missing, the runtime logs a notice and falls back to CORTEX so the agent always boots.

---

## Status

**v1.0.0**, first public release. Reserve a design-partner slot at [aterna.ai/meridian](https://aterna.ai/meridian). The full feature inventory (working today, in flight, on roadmap, not on roadmap) lives in [ROADMAP.md](ROADMAP.md).

What's new in 1.2:
- **MemoryProvider seam.** Pluggable memory backend. CORTEX is the open-source default; ATERNA-licensed Quartz drops in via `MERIDIAN_MEMORY_PROVIDER=quartz` with graceful fallback when absent.
- **Interactive plugin setup.** `meridian skills setup <name>` walks the operator through paste-and-validate flows for Tavily, GitHub PAT, Limitless, and Google OAuth. Masked input. Bad keys never reach the vault.
- **Quartz live in production at ATERNA.** ATERNA's flagship internal agent recall-routes through the Quartz pipeline on every turn. Statistically tied with the public LongMemEval-oracle SoTA at 94.53%. Drop-in for any Meridian agent that licenses it.
- **Bundled plugins ship 24 tools across `google`, `github`, `web-search`, `wearables`.** Every install is a bundled-binary or paste-the-key flow; nothing requires a separate harness.

What's working today:
- Multi-channel agents (CLI, Telegram, voice via VAPI) with cross-channel memory
- Skills v2 with bundled plugins and OAuth-via-CLI patterns
- Encrypted vault, passphrase-gated tools, voice unlock guard
- Scheduled automations that call tools (e.g. `inbox-scan` every 30 min)
- Per-agent isolation (Neon + Voyage + OpenRouter per agent)
- Live production fleet at ATERNA on dedicated infrastructure

What's coming next: Slack and Notion plugins, Playwright browser bundle, observation-pipeline integration for Quartz, observability dashboard, public registry.

---

## Built on the shoulders of

- [@aterna/cortex](https://github.com/Rezzyman/cortex): the cognitive memory architecture
- [Vercel AI SDK](https://ai-sdk.dev): provider abstraction and streaming
- [grammy](https://grammy.dev): Telegram bot framework
- [fastify](https://fastify.io): HTTP gateway
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3): session store
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol): MCP interop

---

## License

MIT. © 2026 ATERNA AI.
