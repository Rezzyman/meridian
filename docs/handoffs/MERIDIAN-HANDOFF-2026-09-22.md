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

VPS #2 (177.7.40.108), nothing production touched:

- Release staged: `/opt/meridian/releases/1.5.0-rc.1` = main `aa062d5`, deps installed with the box's pnpm 9.15.9, built with the aterna node 26.8.1. Version string still prints 1.4.0 (no package bump in this prompt).
- Bench Postgres: Docker `meridian-bench-pg` (pgvector pg17) on 127.0.0.1:5499, db `cortex_bench`, restoring `/root/cortex-backups/arlo/cortex-arlo-20260921-040137.sql.gz` in the background; log `/root/meridian-bench/restore.log` (ends with `EXIT:<code>` when done).
- Arlo still runs on `aterna-openclaw-arlo-canary.service` (port 18889). The retained `meridian-gateway-arlo.service` unit still points at the old shared install and must be rewritten from `skeleton/systemd/meridian-gateway@.service` with `<release>=/opt/meridian/releases/1.5.0-rc.1` before cutover.
- Peer session: the Arlo voice session (`rezcorp-85`) confirmed it owns only `/root/arlo-voice-webhook`, its unit, the three VAPI assistants, and `/root/vapi-hero-webhook`. It was told the cutover will be announced first. It also measured CORTEX recall at about 1 second at or below 900 tokens and 10 to 16 seconds at 2000; Arlo's config must set `cortex.recallTokenBudget: 900`.

## Next (Wednesday onward), in order

1. Confirm the restore finished (`tail -3 /root/meridian-bench/restore.log`; expect `EXIT:0` and `memory_nodes` around 150k).
2. Bench CORTEX: copy `/root/cortex-arlo-sandbox` to `/root/meridian-bench/cortex`, `.env` with `DATABASE_URL=postgres://postgres:benchpw@127.0.0.1:5499/cortex_bench`, `PORT=3199`; run with `systemd-run --unit=meridian-bench-cortex`.
3. Bench Meridian gateway: copy `/root/.meridian/arlo` to `/root/.meridian-bench/arlo`; in its `.env` set `MERIDIAN_CORTEX_URL=http://127.0.0.1:3199`, `MERIDIAN_GATEWAY_PORT=28889`, blank `TELEGRAM_BOT_TOKEN`; in `config.yaml` set `spend.dailyUsd: 5`, `cortex.recallTokenBudget: 900`, `agent.timezone: America/Denver`; run `/opt/meridian/releases/1.5.0-rc.1/bin/meridian gateway --port 28889` with `MERIDIAN_HOME=/root/.meridian-bench MERIDIAN_AGENT=arlo`. Then `meridian doctor --provider`, `scripts/ops/continuity-check.mjs`.
4. Bench OpenClaw: a second instance copied from `instances/arlo` with gateway port 28890, Telegram disabled, and the runtime plugin pointed at CORTEX 3199 (plugin config keys are in the recon output of this session; see below). Same ROUTEXOR key. If pointing the plugin at the clone proves fragile, run the incumbent side of the bench with `--no-memory` and record the memory axis as unmeasured for OpenClaw.
5. Run the bench: `pnpm exec tsx scripts/harness-parity.mts --a meridian=http://127.0.0.1:28889,<token> --b openclaw=http://127.0.0.1:28890,<token> --judge routexor/claude-sonnet-5 --out benchmarks/harness-parity-v1/results-2026-09-24.json`. Iterate at most twice.
6. Autonomy transfer (WS7): the three `.cron` files are already `live/direct/requiresApproval: false`, call `gmail_recent`, `gmail_search`, `gmail_read` (all resolve now). Dry-run each via `POST /automations/run` on the shadow, one live push to Rez.
7. Cutover (WS8): rewrite `meridian-gateway-arlo.service` from the template; message `rezcorp-85`; `RELEASE=/opt/meridian/releases/1.5.0-rc.1 scripts/ops/arlo-cutover.sh`; then `arlo-soak-check.sh` on a timer; rollback drill at hour 24.

## Blockers only Rez can clear

- The iMessage relay decision: promote a Mac (the Mac Mini or a spare) to a BlueBubbles relay with a dedicated Apple ID and number for Arlo, or choose a hosted relay. Everything is built and tested against fixtures; nothing is live until a relay exists.
- An ops alert Telegram chat id that is not Arlo's (`MERIDIAN_OPS_CHAT_ID`), otherwise alerts are log-only.
- Bench spend: the bench runs on Arlo's ROUTEXOR key under a five dollar daily cap in the bench config unless a dedicated `ARLO_BENCH` key is provided. Say so if that is not acceptable.
- A Hostinger snapshot of VPS #2 before the cutover (panel click).
- Two prospect names for the client-build lever; that lever has not started.

## Landmines carried forward

- Never run two pollers on Arlo's Telegram token; the cutover script stops the old unit fully first.
- The bench clone must never be pointed at by production, and production memory must never be pointed at by the bench.
- `~/Desktop` is iCloud; this file's canonical copy is in the repo.
