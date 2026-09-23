# Meridian handoff, 2026-09-22 (end of day 1 of the Arlo-back-on-Meridian week)

Plan of record: `~/meridian/docs/MERIDIAN-GOAL-PROMPT-2026-09-17.md` (Part B). Finish line unchanged: Arlo on Meridian in production for seven clean days, then fleet and OSS 1.5.0 in the next prompt.

## Where things stand

Code (all merged to `origin/main`, CI green on Node 20, 22, 24; 856 tests, up from 641):

| PR | What |
|---|---|
| #31 | Consolidation: five divergent sources into one main, two lost production fixes recovered from a dist-only build (`docs/consolidation-2026-09.md`) |
| #32 | Crash safety, trust-gated brand redaction, recall budget config, live model ids, CI typechecks tests and checks formatting |
| #33 | The eight July defects with regression tests: silence detector, narration guard, timezone resolver, provider errors in doctor, Telegram document ingest, gmail_recent and gmail_read aliases plus manifest parity, doctor agent-home detection, tool diagnostics, provider posture preflight |
| #34 | Approval notices, draft OUTBOX with `/approve` and `/reject`, trust graduation with signed receipts, slash commands on chat channels, inbox watcher rescan |
| #35 | Spend ledger, ROUTEXOR pricing, per-turn/run/day/month caps, repeated tool-call quarantine, systemd template with a restart ceiling (`docs/spend-controls.md`) |
| #36 | `/health` with provider, CORTEX, breaker, last-hour inference, automations, spend; `meridian status`; structured turn log; ops alert sink (`MERIDIAN_OPS_CHAT_ID`) |
| #37 | Human texting shape: text-style rules on text channels, bubble shaping with typing pauses on Telegram, SMS, WhatsApp; `/style` |
| #38 | iMessage over BlueBubbles: `src/channels/imessage.ts`, `POST /imessage/webhook`, operator handle matching, SMS fallback, doctor relay row (`docs/imessage-setup.md`) |
| #39 | OpenAI-compatible `POST /v1/chat/completions` (the Loop sidecar's wire), `MERIDIAN_COMPLETIONS_ISOLATION=loop`, wearables per-encode timeout, `scripts/ops/loop-canary.mjs`, `scripts/ops/continuity-check.mjs` |
| #40 | Harness parity bench v1 (`benchmarks/harness-parity-v1/`, `scripts/harness-parity.mts`) |
| #41 | `scripts/ops/arlo-cutover.sh`, `arlo-rollback.sh`, `arlo-soak-check.sh`, `docs/production-deployment.md` |
| #42 | Token-authenticated gateway requests resolve as the operator (found on the bench: `/chat` was a stranger, governance denied Arlo's own tools, the model narrated the denials); stateless `/v1/chat/completions`; denial guidance for the model |
| #43 | `x-meridian-text-style: 1` on completions; two bench prompts reclassified as operator-private |
| #44 | Prompt budget: `/health.promptBudget` and boot log; `spend.maxPromptTokensPerTurn` (150k) cuts a runaway tool loop and answers with what it has |

## The two findings that matter most

1. **Cost per turn.** On Arlo's real home the first bench pass averaged 57k prompt tokens per call (33.7k minimum, 241k on a tool loop), $4.41 for 37 calls on Sonnet 5. Measured breakdown after the fix: about 20k static tokens per step, half identity plus context (Arlo's `IDENTITY/AGENT.md` alone is 21 KB), half 87 tool schemas, most of them MCP servers (cortex, meetjoin, voice, wearables) that ride on every turn. Multi-step turns resend all of it each step. This is almost certainly the mechanism behind the unattributed $556 on `ARLO_MERIDIAN-2.0` in late August. The ceiling is now in place; the config-side cuts (gate the cortex MCP server to CLI only, trim the identity file, prefer Haiku primary with Sonnet fallback) are Rez's calls and are listed under blockers.
2. **Trust on the HTTP path.** Every authenticated gateway request was a stranger to governance. Fixed in #42; the bench would have failed the functional axis without it.

VPS #2 (177.7.40.108), nothing production touched:

- Release staged: `/opt/meridian/releases/1.5.0-rc.1` = main `aa062d5`, deps installed with the box's pnpm 9.15.9, built with the aterna node 26.8.1. Version string still prints 1.4.0 (no package bump in this prompt).
- Bench Postgres: Docker `meridian-bench-pg` (pgvector pg17) on 127.0.0.1:5499, db `cortex_bench`, restoring `/root/cortex-backups/arlo/cortex-arlo-20260921-040137.sql.gz` in the background; log `/root/meridian-bench/restore.log` (ends with `EXIT:<code>` when done).
- Bench stack running (transient units, all bench-only): `meridian-bench-cortex` on 3199 against the clone (157,320 nodes, 1.5M synapses restored from the 09-22 dump), `meridian-bench-gateway` on 28889 from the staged release with the bench home `/root/.meridian-bench/arlo` (Telegram off, `dailyUsd` 15 for today only, `recallTokenBudget` 900, primary `claude-haiku-4.5`), `meridian-bench-openclaw` on 28890 from the production vendor build with a bench instance dir pointed at 3199 and pinned to the same model. `/root/meridian-bench/stop-all.sh` stops them. Parity run 2 log: `/root/meridian-bench/parity.log`; results `/root/meridian-bench/results-2026-09-22.json` when it finishes. Run 1 was stopped at the cap (partial log kept).
- Arlo still runs on `aterna-openclaw-arlo-canary.service` (port 18889). The retained `meridian-gateway-arlo.service` unit still points at the old shared install and must be rewritten from `skeleton/systemd/meridian-gateway@.service` with `<release>=/opt/meridian/releases/1.5.0-rc.1` before cutover.
- Peer session: the Arlo voice session (`rezcorp-85`) confirmed it owns only `/root/arlo-voice-webhook`, its unit, the three VAPI assistants, and `/root/vapi-hero-webhook`. It was told the cutover will be announced first. It also measured CORTEX recall at about 1 second at or below 900 tokens and 10 to 16 seconds at 2000; Arlo's config must set `cortex.recallTokenBudget: 900`.

## Update 2026-09-23: parity loop 2 and certification step 1

- Parity rerun (`benchmarks/harness-parity-v1/runs/results-2026-09-22-run2.json`): Meridian functional 22/30 vs 15/30, reliability 0 errors vs 3, p50 3.4s vs 3.7s, p95 within 20 percent, human feel 62 percent preferred (after PR #46 fixed pre-tool text being glued to the answer). Memory 17/20 vs 20/20, but that axis was unfair as run: Meridian writes memory in the background and the bench asked 8 seconds after seeding, and the clone was shared across runs so the second harness read the first one's seeds. Not a cutover blocker by itself; certify's memory probe now polls until recalled.
- Certification step 1 merged (PR #47): `CAPABILITIES/manifest.yaml` per agent, `meridian certify`, `/health.timezone`, `/health.spendCaps`, `GET /tools`. Arlo's draft manifest at `examples/arlo/CAPABILITIES/manifest.yaml` (22 claims) awaits Rez's strike-through.
- First certify card on the bench found: Arlo's installed google skill is v0.1 (no gmail_get/gmail_draft/gcal_*), upgrade at cutover; recall ranks older look-alike facts above a newer one (CORTEX recency weighting item); Loop probe needs a paired device token.
- Next: step 2 (golden set inside certify, real automation and channel probes on the actual Arlo home in shadow), step 3 (Arlo's golden set), step 4 (release train with certify as the gate), then cutover only on a fully green card.

## Update 2026-09-23 evening: certification step 2 ran, and a ROUTEXOR Claude outage stopped it

- Merged today: #48 (spend ledger fixes), #49 (golden set runs inside `meridian certify`), #50 (a thrown tool error is returned to the model as an error result instead of killing the turn; the memory probe uses a plain fact). Open: PR #51 (`feat/memory-trust-sources`, see below). Main after #50: `122c84b`.
- Second certify card on the bench (`/root/.meridian-bench/arlo/CAPABILITIES/certifications/2026-09-23T18-52-05-241Z.json`): green on all six foundation claims (memory round trip recalled after 45 s on one ask), the three chat claims, voice.line, tools.web, tools.github, tools.wearables, and all three automations armed in Denver time. Red: imessage.operator (no relay yet), tools.gmail (Arlo's installed google skill is v0.1: no gmail_get, no gmail_draft), tools.calendar (v0.1 implements no calendar tools at all even though its own manifest names calendar_today and calendar_upcoming), golden 6/12. Manual: telegram.operator, sms.operator. Skipped: loop.canary (no LOOP_DEVICE_TOKEN).
- Golden 6/12 breaks down as: g01 to g04, g07, g08 pass; g05 and g06 over their length caps (step 3 tuning: Arlo dumps memory instead of texting); g09 to g12 HTTP 500 because both Claude providers failed (next bullet). The report now records each prompt's reply excerpt once #51 lands.
- ROUTEXOR Claude outage, first failure 18:51:56 UTC (12:51 Denver): every Claude model through ROUTEXOR returns `Anthropic request failed with HTTP 400` on Arlo's key and on Andy's separate key; deepseek-v4-flash works on the same keys; Anthropic status page all green; ROUTEXOR main unchanged since 09-22 and its Anthropic adapter since 09-10. ROUTEXOR discards the upstream body by design, so the reason is only visible in the Anthropic console (most likely an exhausted credit balance on the provider key) or the ROUTEXOR dashboard Provider Keys page. Production Arlo on OpenClaw runs DeepSeek and was unaffected. Memory: `project_routexor_anthropic_400_outage_2026-09-23`.
- Memory trust finding (PR #51): the bench log showed the poisoning screen quarantining Arlo's own `rez-directive` identity rules, Mac workspace session notes, and OpenClaw-era encodes (`aterna-agent:agent:arlo:*`) on every recall, because the prefix trust list only knew Meridian's labels. Source families on the clone: Mac import 61k, wearables 43k, limitless 41k, aterna-agent 6.4k, telegram-export 0.8k, Meridian's own labels under 1k. `cortex.trustedSources` fixes this per agent. The proposed Arlo list (NOT applied anywhere; the auto-mode classifier declined to widen trust on the bench config, and it is Rez's call): `^aterna-agent:agent:arlo:`, `^rez-directive$`, `^session$`, `^conversation$`, `^cron$`, `^proactive$`, `^arlo$`, `^openclaw-workspace`, `^telegram-export`, `^telegram-20\d\d-`, `^/Users/rezcorp/Desktop/ARLO-WORKSPACE/(?!memory/limitless-)`. Wearables, limitless, screen-observer, vapi stay untrusted on purpose: strangers speak there.
- Bench hygiene: the bench home's `.env` uses Arlo's production ROUTEXOR key (same `...e1e38e`), not a dedicated bench key. Arlo's v0.1 google skill is restored on the bench (the v0.2 skeleton needs `meridian skills setup google`, an OAuth consent click, before it can run; see `skeleton/SKILLS/google/setup.md` and the headless OAuth playbook).
- Next, in order, once Claude via ROUTEXOR is back: merge #51, restage rc.1 (`rsync` main to `/opt/meridian/releases/1.5.0-rc.1`, `pnpm install --frozen-lockfile && pnpm build` there), apply the trustedSources list to the bench config on Rez's yes, `/root/meridian-bench/start-meridian.sh`, rerun `meridian certify --gateway http://127.0.0.1:28889` from the bench home, and read the per-prompt golden detail. Then step 3 (golden tuning with Rez, Google v0.2 or shrink the claims), step 4 (release train with certify as the gate).

## Next (Wednesday onward), in order

1. Confirm the restore finished (`tail -3 /root/meridian-bench/restore.log`; expect `EXIT:0` and `memory_nodes` around 150k).
2. Bench CORTEX: copy `/root/cortex-arlo-sandbox` to `/root/meridian-bench/cortex`, `.env` with `DATABASE_URL=postgres://postgres:benchpw@127.0.0.1:5499/cortex_bench`, `PORT=3199`; run with `systemd-run --unit=meridian-bench-cortex`.
3. Bench Meridian gateway: copy `/root/.meridian/arlo` to `/root/.meridian-bench/arlo`; in its `.env` set `MERIDIAN_CORTEX_URL=http://127.0.0.1:3199`, `MERIDIAN_GATEWAY_PORT=28889`, blank `TELEGRAM_BOT_TOKEN`; in `config.yaml` set `spend.dailyUsd: 5`, `cortex.recallTokenBudget: 900`, `agent.timezone: America/Denver`; run `/opt/meridian/releases/1.5.0-rc.1/bin/meridian gateway --port 28889` with `MERIDIAN_HOME=/root/.meridian-bench MERIDIAN_AGENT=arlo`. Then `meridian doctor --provider`, `scripts/ops/continuity-check.mjs`.
4. Bench OpenClaw: a second instance copied from `instances/arlo` with gateway port 28890, Telegram disabled, and the runtime plugin pointed at CORTEX 3199 (plugin config keys are in the recon output of this session; see below). Same ROUTEXOR key. If pointing the plugin at the clone proves fragile, run the incumbent side of the bench with `--no-memory` and record the memory axis as unmeasured for OpenClaw.
5. Run the bench: `pnpm exec tsx scripts/harness-parity.mts --a meridian=http://127.0.0.1:28889,<token> --b openclaw=http://127.0.0.1:28890,<token> --judge routexor/claude-sonnet-5 --out benchmarks/harness-parity-v1/results-2026-09-24.json`. Iterate at most twice.
6. Autonomy transfer (WS7): the three `.cron` files are already `live/direct/requiresApproval: false`, call `gmail_recent`, `gmail_search`, `gmail_read` (all resolve now). Dry-run each via `POST /automations/run` on the shadow, one live push to Rez.
7. Cutover (WS8): rewrite `meridian-gateway-arlo.service` from the template; message `rezcorp-85`; `RELEASE=/opt/meridian/releases/1.5.0-rc.1 scripts/ops/arlo-cutover.sh`; then `arlo-soak-check.sh` on a timer; rollback drill at hour 24.

## Blockers only Rez can clear

- (09-23) Claude through ROUTEXOR: check the Anthropic console billing/credit balance and the Provider Keys page in the ROUTEXOR dashboard for the ATERNA account(s); every Claude request on ATERNA keys has returned HTTP 400 since 12:51 Denver.
- (09-23) Approve (or edit) the `cortex.trustedSources` list for Arlo above; nothing recalls his own standing rules reliably until it is applied.
- (09-23) Google on Meridian: either click through `meridian skills setup google` (v0.2, OAuth) for Arlo's mailbox so drafting and calendar exist, or decide to keep v0.1 and drop the drafting and calendar claims for now.
- The iMessage relay decision: promote a Mac (the Mac Mini or a spare) to a BlueBubbles relay with a dedicated Apple ID and number for Arlo, or choose a hosted relay. Everything is built and tested against fixtures; nothing is live until a relay exists.
- An ops alert Telegram chat id that is not Arlo's (`MERIDIAN_OPS_CHAT_ID`), otherwise alerts are log-only.
- Bench spend: the bench runs on Arlo's ROUTEXOR key under a five dollar daily cap in the bench config unless a dedicated `ARLO_BENCH` key is provided. Say so if that is not acceptable.
- A Hostinger snapshot of VPS #2 before the cutover (panel click).
- Two prospect names for the client-build lever; that lever has not started.
- Cost decisions before cutover: (a) gate the cortex MCP server (and meetjoin, voice, wearables) to the channels that need them in `CONNECTIONS/mcp.json`; (b) shrink `IDENTITY/AGENT.md` from 21 KB; (c) primary model for Arlo on Meridian (Haiku with Sonnet fallback is the cost-sane default; the current config is Sonnet primary).

## Landmines carried forward

- Never run two pollers on Arlo's Telegram token; the cutover script stops the old unit fully first.
- The bench clone must never be pointed at by production, and production memory must never be pointed at by the bench.
- `~/Desktop` is iCloud; this file's canonical copy is in the repo.
