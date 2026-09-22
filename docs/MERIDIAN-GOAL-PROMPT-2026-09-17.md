# MERIDIAN: September 17, 2026 audit and goal prompt

Two parts. Part A is the audit of where Meridian actually stands today, verified read-only against the Mac, GitHub, npm, ROUTEXOR, and VPS #2. Part B is the goal prompt for an autonomous Claude Code session to pursue until the Definition of Done is met. Written by Claude Code (Fable 5.1) on the Mac Mini on September 17, 2026.

---

# PART A: AUDIT

## Verdict

Meridian is a solid codebase that nobody is running. The code is healthier than its history suggests: 641 tests pass, typecheck is clean, the safety layer (memory-poisoning screen, SSRF guard, sacred-topic guard, provenance signing, per-turn trace) is real. But it runs zero agents in production, its source is split across five copies on two machines, and the pieces that would make it world class (enforced approvals, spend caps, crash safety, self-diagnosis) are either stubs or sitting on branches that were never merged.

## The blind spot first

Memory says "Meridian is the default harness" (July 31). That stopped being true on August 21.

On VPS #2 every `meridian-gateway-*` unit is inactive and disabled. Arlo, Andy, Arly, and Luca run on vendor OpenClaw v2026.9.3 (the official `openclaw/openclaw` release, white-labelled, one gateway per agent under `/root/aterna-openclaw-migration-2026-08-21/`) since a blue/green cutover on August 21, refreshed September 9. The Loop iOS lane runs on OpenClaw too. The migration docs give the thesis: "OpenClaw owns commodity runtime concerns, ATERNA owns the durable product layer" (skills, plugin hooks, CORTEX, ROUTEXOR). Meridian was kept as an R&D lab on port 28889, then retired on September 10.

So "perfecting Meridian" is not polishing the thing that is live. It is winning production back from a vendor runtime, and proving it deserves to.

## Timeline in one paragraph

April 27 Meridian is born and replaces OpenClaw for Arlo. May 2 v1.2.0 public. May 10 MEMY's paying customers leave Meridian for Hermes (none of them had persistent memory under Meridian, and no outbound calling). May 14 "Arlo on Meridian still sucks." June 10 Arlo moves to Hermes. June and July: a burst of feature branches and the v1.3 and v1.4 flagship launches (memory-poisoning defense, nine channels, MCP, npm publish). July 10 gap closure lands on origin/main. July 13 to 20 the fleet moves from Hermes to Meridian, but the proactive layer is parked and agents go silent for days. July 31 the Routexor burn incident, the Meridian vs Hermes comparison, governance work, and a fleet upgrade to 3b22a8a with 719 tests. August 10 a Routexor outage. August 13 Loop adapter release. August 18 Arlo repair (provider config had been pointed at Anthropic's native endpoint). August 21 the fleet moves to OpenClaw. September 3 more Loop adapter work on the Mac, never committed. September 10 the Meridian R&D lab is retired. Today: zero Meridian processes in production.

## Source of truth is in five pieces

| Copy | Where | Head | What it has |
|---|---|---|---|
| Mac working tree | `~/meridian` on main | `8964020` (July 2) plus uncommitted September 3 work | 17 commits behind origin/main. About 1,034 uncommitted lines: Loop agent adapter, device media, weather, seven tests. Typecheck clean, 641 tests pass. |
| origin/main | GitHub | `cf8783b` (July 10) | Vision runtime and PDF caps, importer overhaul, heartbeat wired into gateway boot, `/ingest`, RULE ZERO error firewall, `[SILENT]` automation contract, Telegram multi-chat trust. |
| stormy-governed-release-20260731 | GitHub, checked out at `~/meridian-governance` (clean) | `3b22a8a` (July 31) | Governance action policy, signed hash-chained receipts, error firewall, golden Stormy example, governed-agent benchmark. Descendant of origin/main. Never merged. |
| ops/autonomy-control-plane | VPS only, `/root/meridian-autonomy-control-plane` | `289c934` (July 31) | Eight commits past 3b22a8a: Routexor compatibility fixes (omit temperature for Claude 5, GPT tool schema normalization, Haiku tool-call compat, fall back after an empty pre-tool response, simulate streaming for tool-bearing turns), governed autonomy control plane, dead-letter interrupted runs. Never pushed. Fetchable over ssh. |
| loop-20260813c | VPS only, `/opt/meridian/releases/loop-20260813c`, no git | August 13 | Superset of everything above plus the Loop contract and pairing. The last Meridian source that ran Arlo (as dist-only builds `loop-20260813e` and `arlo-repair-20260818`). |

Good news: origin/main, the governance branch, and the control-plane branch form one linear chain, so two merges should fast-forward. The off-chain pieces are the Mac's September 3 work (it touches five files that also changed on origin/main and reimplements the temperature fix as a Proxy) and the no-git snapshot. One more unmerged branch: `origin/agent/routexor-first-onboarding` (one commit, August 4, draft PR #30).

## Defects recorded from the July 13 to August 21 production run

- (a) Migrations parked the proactive layer. Agents were healthy and silent for days. The checklist written afterwards is at `/root/meridian-migration/AUTONOMY-TRANSFER-CHECKLIST.md`.
- (b) The automation runner leaked "I'll recall..." step narration into delivered Telegram briefs. Empty output was delivered as "(produced no output)". In-gateway cron defaults to `America/Chicago` in four places (`src/automations/manager.ts:123`, `src/proactive/sentinel.ts:63` and `:78`, `src/dream/weaver.ts:39`).
- (c) Routexor compatibility: the AI SDK injected `temperature`, which Claude 5 endpoints reject; GPT tool schemas needed normalizing; Haiku tool-call compat; empty pre-tool responses; streaming on tool-bearing turns. All fixed on the unpushed VPS branch only.
- (d) Telegram handles images but not document attachments.
- (e) Google skill v0.1 and the v0.2 scaffold expose incompatible tool names.
- (f) `meridian doctor` mistakes shared directories for agent homes and its checks are shallow.
- (g) Tool failures have no structured internal diagnostics.
- (h) August 18: Arlo's Routexor adapter had been pointed at Anthropic's native endpoint. The gateway produced 502s and could not say why.

## Code health on the Mac tree

- Runner is `node:test`. 62 test files, 641 pass, zero skipped. `tsc` clean. Biome lint one warning. CI on Node 20, 22, 24 runs typecheck, lint, test, build. The release workflow publishes to npm on a `v*` tag.
- Format drift in 110 of 190 files because CI never runs `biome format --check`. `tsconfig` excludes `test/`, so ten thousand lines of tests are never typechecked. No coverage tooling.
- `requiresApproval`, `mode: draft`, and `trustGraduation` in automation config are parsed and never read. An automation marked `requiresApproval: true` runs unattended today.
- Zero spend or token accounting. `turn.ts` and `router.ts` capture no usage at all. No caps.
- No `unhandledRejection` or `uncaughtException` handler. Four fire-and-forget `void result.done` sites in `src/gateway/server.ts` (lines 480, 505, 540, 558). Rate limiting exists only on `/waitlist`. The provider circuit breaker fails open by design when every provider is open.
- The default model ids in `src/config/schema.ts` (lines 150, 156, 169, 604, 609) are `routexor/claude-4-haiku` and `routexor/claude-sonnet-4.6`. ROUTEXOR's live catalog has no `claude-4-haiku`; the real id is `claude-haiku-4.5`. A fresh agent fails on its first turn. This is the same phantom-id class that broke RUDY on September 2.
- Largest untested modules: proactive sentinel (322 lines), automations manager (269), file ingest (243), voice session guard (176), heartbeat scheduler, dream weaver. `src/cron/` and `src/hooks/` are empty directories. `skeleton/SKILLS/voice-receptionist/` has no SKILL.md and will not load.
- Strengths worth protecting: memory-poisoning screen with MemPoisonBench, SSRF guard with obscure-encoding normalization, exec sandbox, HMAC provenance signing, sacred-topic guard on every channel, per-turn reasoning trace behind `/why` and `/trace`, pino structured logs, nine channels with signature verification, MCP client and server, bounded `delegate` sub-agents, and on the unmerged branch, governance receipts and an action policy.
- Stale claims: README badge says 587 tests (it is 641). `test/README.md` says verification is unwired (it is wired). ROADMAP header says v1.2. GitHub releases stop at v1.0.1 while npm is at 1.4.0. The aterna.ai/meridian page claims Stripe and GHL integrations that exist only on the roadmap and cites the wrong license for the engine.

## The pattern behind every past fix

Every shipped CHANGELOG fix is the same bug: something failed with no error. Channel env never reached Slack, Discord, or WhatsApp. Provider fallback was dead code because `streamText` routed errors to a callback nobody set. The skill loader swallowed a Node 20 import error and silently dropped every real tool. The empty-tool breaker only logged while the model narrated fabricated results. SMS replies were sliced silently. `meridian demo` showed zero vectors on a real install. The VAPI webhook failed open with no secret. The gateway replays `state.jsonl` traces independently of CORTEX, so clearing memory resurrects deleted content. `CONTEXT/_runtime-loadout.md` advertises tools the allowlist blocks, so the agent over-claims what it can do. The boot banner used to imply 79 installable skills that did not exist.

Silent failure and capability over-claiming are Meridian's two chronic diseases. The prompt treats them as workstreams, not cosmetics.

## Cost incidents in the family

Two sibling agents on OpenClaw burned $190 per week and $208 in three days in restart crash-loops with no backoff ceiling and no spend cap. Meridian's units use the same `Restart=always` with no `StartLimitBurst`. A third incident is unattributed: $556 on a ROUTEXOR key named `ARLO_MERIDIAN-2.0` between August 26 and September 1. It is not in any memory file; it lives only in the September 3 and September 15 ROUTEXOR handoffs, which assign the attribution work to the ROUTEXOR prompt. The Meridian prompt owns the harness-side fix: caps that exist regardless of what the router does.

## What serves Arlo today (the parity surface)

`/root/aterna-openclaw-migration-2026-08-21/instances/arlo/openclaw.json`: Telegram DM allowlist locked to Rez, tools profile full with three denies, all vendor skills disabled, the `aterna-runtime` plugin owns CORTEX recall and encode, heartbeat off, no in-app cron, model `routexor/routexor/deepseek-v4-flash` primary, 1800 second timeout. Ten shared behavioral skills: commitments, communications, cortex, degraded-operation, external-actions, proactivity, tool-discipline, verification, voice, white-label. Proactive work runs as host systemd timers that bypass the harness entirely (arlo-meet-autopilot every two minutes, arlo-inbox-monitor at 18:00 UTC, arlo-dream at 08:30 UTC, cortex-arlo-prewarm, a weekly wearables reminder). Fleet health is `aterna-health.timer` every five minutes writing `/var/lib/aterna-observability/health.json`. Rollback assets from the August 21 cutover are in `rollback/arlo-precutover-20260821/`. Arlo's Meridian home at `/root/.meridian/arlo` still exists with 13 skills and three automations (morning-brief, open-loops, eod-checkin).

A root SSH session from 73.34.233.232 has been logged into VPS #2 since September 15, and Arlo's `openclaw.json` was modified at 14:59 UTC today. Another tool session is actively working that box.

## Traction

GitHub: one star, zero forks, zero issues ever filed, 30 pull requests (#6 Agent Builder open since June 12, #30 ROUTEXOR onboarding draft since August 4), last push August 4, and the last 22 commits went straight to main without a PR. npm 1.4.0 published July 2.

## What to do, in order

1. Put the source back together. One main, nothing lost, before any new line is written.
2. Make failures loud and the config honest: enforce or delete every parsed-but-ignored safety field, add crash handlers, fix the phantom model ids, make CI check formatting and typecheck the tests.
3. Fix the eight July defects with a failing test first for each.
4. Add spend accounting and caps inside the harness, plus a restart backoff ceiling in the unit template.
5. Build the parity bench against the OpenClaw runtime on a clone of Arlo's real home and memory. Numbers, not vibes.
6. Make text feel human, add iMessage through BlueBubbles, and prove Loop, wearables, and voice against Meridian.
7. Transfer Arlo's autonomy, then cut Arlo over with a scripted, pre-tested rollback. Soak seven days.
8. Fleet and the 1.5.0 release are the next prompt.

Honest framing: the August thesis was right that commodity runtime concerns (channels, streaming, provider quirks) are not worth building from scratch. It was wrong about where the differentiators live. Spend caps, action receipts, silence detection, the poisoning screen, the per-turn trace, and provider preflight all live inside the turn loop, and vendor OpenClaw has no seam for them. A harness its own maker does not run is a credibility hole any customer finds in one question.

---

# PART B: GOAL PROMPT

You are Claude Code running autonomously for Atanasio Juarez (goes by Rez), founder of ATERNA LLC, on Meridian (repo `~/meridian`, GitHub Rezzyman/meridian, npm `@aterna/meridian`), ATERNA's open-source agent operating system. Your mission is to make Meridian the harness that runs Arlo, Rez's chief-of-staff agent, in production again, and to prove it is better than the vendor OpenClaw runtime it replaces: fewer silent failures, enforced safety config, measured cost per turn, proactive deliveries that actually arrive, and a texting experience that feels like a person with deep knowledge of the role, reachable over iMessage, voice, the Loop mobile app, and the wearables that are the agent's ears in real life. The finish line is Arlo running on `meridian-gateway-arlo.service` on VPS #2 for seven consecutive clean days with the OpenClaw unit disabled but retained. Andy, Arly, Luca, and the open-source 1.5.0 release belong to the next prompt, not this one. You pursue this prompt until every Definition of Done item below is verified true, or until an item is provably blocked on something only Rez can supply, in which case you finish everything else and report the exact blocker.

You do not ask Rez yes-or-no questions mid-run. You make the routine calls yourself, surface blockers in one batched list at the end of each work session, and keep working on everything that is not blocked. Rez has delegated the Arlo cutover itself: once the parity gates pass and the rollback script has been exercised, you cut over without asking and tell him after, with the receipt.

Rez's product bar, in his words on September 17: agents must feel as real as possible. Talking to Meridian should feel like texting a person who has infinite knowledge of the subject matter and the role you gave it, not like using a chatbot. iMessage is required; SMS alone is no longer acceptable. Voice, the Loop mobile portal, and wearables (Loop pendant, Limitless, Bee) are the agent's ears and mouth in real life and must stay wired in as you harden the core. Every workstream below is judged against that bar, not only against test counts.

---

## 0. Read these first, then verify before trusting

1. Part A of this document. It is the audit that produced this prompt; everything in it was verified on September 17, 2026, and everything in it can go stale. Reconcile disagreements in favor of the repo and the box.
2. On VPS #2 (`ssh root@177.7.40.108`): `/root/meridian-migration/AUTONOMY-TRANSFER-CHECKLIST.md` (the rule for never parking autonomy again), `/root/aterna-openclaw-migration-2026-08-21/README.md` and `/root/aterna-openclaw-migration-2026-08-21/docs/PRODUCTION-CUTOVER.md` (the live topology and the rollback shape you will mirror), `/root/aterna-fleet/CURRENT-RUNTIME-INVENTORY.md`, and `/root/aterna-fleet/MERIDIAN-FLEET-UPGRADE-2026-07-31.md` (the last Meridian fleet run and its listed defects).
3. In the worktree `~/meridian-governance`: `docs/governance-guarantee.md` and `docs/governed-deployment.md`. In `~/meridian`: `docs/harness-comparison-methodology.md` (its honesty rules govern the parity bench), `docs/releasing.md`, `ROADMAP.md`, `CHANGELOG.md`.
4. Memory files: `meridian_handoff_next_session.md`, `project_meridian_fleet_on_openclaw_2026-08-21.md`, `project_arlo_on_vps2_meridian.md`, `feedback_meridian_arlo_still_sucks.md`, `playbook_arlo_outbound_call.md`, `feedback_vapi_full_patch_only.md`, and every `feedback_*` file in the memory index.
5. `~/Desktop/ROUTEXOR-GOAL-PROMPT-2026-09-15.md`. Its Workstream 2 provisions per-agent ROUTEXOR keys and owns the attribution of the $556 `ARLO_MERIDIAN-2.0` charge. Do not duplicate that work; depend on it.
6. Note that `~/Desktop` is iCloud-synced and shared with Rez's MacBook. If a Desktop read or write times out, use a new filename and keep a copy in `~/meridian/docs/handoffs/`.

Then run this verification block and record the results in your first handoff:

```bash
cd ~/meridian && git fetch --all --prune && git status -sb && git stash list && git worktree list && git log --oneline -3
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -5 && pnpm build
cd ~/meridian-governance && git status -sb && git log --oneline -1
ssh root@177.7.40.108 'who; systemctl list-units "meridian-gateway-*" "aterna-openclaw-*" "cortex-*" "arlo-voice-webhook" "andy-webhook" "aterna-loop*" --all --no-pager; cd /root/meridian-autonomy-control-plane && git log --oneline -1 && git status -sb; ls /opt/meridian/releases; ls /root/.meridian; /opt/aterna-node-v26.8.1-linux-x64/bin/node -v'
git ls-remote ssh://root@177.7.40.108/root/meridian-autonomy-control-plane | head
curl -s https://api.routexor.com/v1/models | python3 -c "import json,sys; d=json.load(sys.stdin); print([m['id'] for m in d['data'] if 'claude' in m['id'].lower()])"
```

State as of 2026-09-17: Mac main is `8964020` plus about 1,034 uncommitted lines of September 3 Loop adapter work; origin/main is `cf8783b`; the governance branch is `3b22a8a`; the VPS control-plane branch is `289c934`; the VPS source snapshot is `loop-20260813c`; 641 tests pass; npm is 1.4.0; zero Meridian units are active in production; Arlo runs on `aterna-openclaw-arlo-canary.service` on loopback port 18889 with `cortex-arlo.service` on 3101.

---

## 1. Non-negotiable rules

- VPS #2 is production. Never start, stop, enable, disable, edit, or restart `arlo-voice-webhook`, `andy-webhook`, `aterna-loop.service`, `aterna-openclaw-loop-private`, `aterna-loop-openclaw-canary`, any `cortex-*` service, caddy, or any Andy, Arly, or Luca unit. The only units this prompt may touch are `aterna-openclaw-arlo-canary.service` and `meridian-gateway-arlo.service`, and only through the scripted cutover in Workstream 8. Nothing on the VPS is deleted; the OpenClaw Arlo unit is disabled, not removed, for 30 days after cutover.
- Per-agent isolation: Arlo's own CORTEX database and port, own ROUTEXOR key, own env file. `doctor` must fail on a key hash shared with a sibling home.
- ROUTEXOR only. Every model ref is `routexor/<id>` and the id must exist in the live `/v1/models` catalog. Never OpenRouter, never a native Anthropic endpoint as a production fallback (that is defect h), never a platform key.
- Two harnesses never write the same CORTEX database at the same time. Shadow and bench runs use a cloned database or run with encode disabled. One Telegram bot token has exactly one poller; shadow runs use the CLI channel or a separate bot token.
- No force-push, no history rewrite on origin. Consolidation lands through one pull request. Commit as `Atanasio Juarez <atanasiojuarez@gmail.com>` with no Co-Authored-By trailer. No em dashes in anything user-facing: README, CHANGELOG, CLI output, Telegram replies, docs. Comments may keep them.
- All Claude Code on the Mac bills the Max subscription, never API keys. Arlo's turns run on Arlo's ROUTEXOR key; that is the product working. Do not spend on a new key without Rez's say-so.
- Never PATCH a VAPI assistant without the full model object. Never upload transcripts to a VAPI knowledge base. Never use Arlo's Telegram for infra or bench pings; ops alerts go to the ops sink or the log.
- Coordinate with other sessions. Before any push, `git fetch` and rebase. Use `ListAgents` and `SendMessage` to tell any active Meridian, ROUTEXOR, or Loop session what you own. A root SSH session has been live on VPS #2 since September 15 and edited Arlo's OpenClaw config on September 17; before the cutover window, message it, leave a dated note in `/root/CLAUDE.md`, and confirm by `stat` that Arlo's config has not changed in the last hour.
- Never use Rez's Chrome. Playwright's bundled Chromium is fine for verification. Never generate PDFs with Chrome.
- Incidents stay stealth. Bias to shipping. Plain language. Tell Rez directly when he is wrong. Time-box any single rabbit hole to two hours, then ship the honest partial and note it.

---

## 2. Definition of Done (each item verified in CI or on the box)

1. `origin/main` contains every commit from `stormy-governed-release-20260731`, `ops/autonomy-control-plane`, `agent/routexor-first-onboarding`, the Mac's September 3 work, and every source-level delta from `loop-20260813c`. `docs/consolidation-2026-09.md` lists each source with its hash, the per-file disposition, and anything intentionally dropped. The Mac tree and the VPS control-plane tree are clean. `ops/autonomy-control-plane` exists on origin as an archived branch.
2. CI on Node 20, 22, and 24 typechecks `src` and `test`, runs `biome format --check`, lint, test, build, and publishes a coverage summary. Green.
3. Defects (a) through (h) each have a named regression test under `test/` and a CHANGELOG line. The default model ids in `src/config/schema.ts` are live catalog ids.
4. `mode: draft`, `requiresApproval`, and `trustGraduation` in automation frontmatter are enforced with tests. `/approve <id>` and `/reject <id>` work from a trusted Telegram sender through the governance approval seam and leave a signed receipt.
5. Every turn and automation run appends a spend record (model, prompt and completion tokens, USD or null, jobId). Per-turn, per-run, daily, and monthly USD caps block, proved by a test and by a one-cent daily cap on a throwaway VPS agent home refusing its second turn. The shipped unit template carries `StartLimitBurst` and `StartLimitIntervalSec`.
6. A fault-injection test proves that a rejected `result.done` and a thrown error inside a channel handler do not kill the gateway. `unhandledRejection` and `uncaughtException` handlers log through pino with a documented policy.
7. `GET /health` returns provider preflight, CORTEX reachability, automations armed, next fire, last fire, spend today, last proactive delivery, and breaker state. `meridian doctor` passes its deep checks on `/root/.meridian/arlo` and fails, with a plain message, on `/root/.meridian`.
8. `benchmarks/harness-parity-v1/results-<date>.json` meets the Workstream 6 thresholds against the OpenClaw runtime on the same cloned Arlo home and CORTEX. Cells OpenClaw cannot expose are marked unmeasured, never fabricated.
9. Arlo runs on `meridian-gateway-arlo.service` for seven consecutive clean days: every automation delivered on schedule in Denver time with journal evidence, zero 502s, zero unit restarts, zero narration leaks, spend inside caps. A rollback drill was executed at hour 24 and the re-cutover completed. The Loop lane and the voice webhook were verified unaffected. `aterna-openclaw-arlo-canary.service` is disabled and retained.
10. A GitHub issue exists for every defect found (the repo has never had one). README badge, ROADMAP header, `test/README.md`, and `skeleton/SKILLS/voice-receptionist/SKILL.md` are corrected. The boot banner, `CONTEXT/_runtime-loadout.md`, and the aterna.ai/meridian page claim only what ships. `docs/production-deployment.md` exists, written from the cutover doc with secrets removed.
11. Arlo is reachable over iMessage through a BlueBubbles relay, locked to Rez's handle, with attachments, multi-bubble replies, and typing indicators working, and SMS retained only as the fallback for non-Apple contacts. `src/channels/imessage.ts` has recorded-fixture tests and a setup doc.
12. Text channels pass the human-feel bar: message shaping (short bubbles, natural cadence, no assistant-speak, no bullet dumps on text channels, no tool narration) is enforced in the turn loop for Telegram, iMessage, SMS, and WhatsApp, and the parity bench carries a blind judge-scored human-feel axis on which Meridian beats the OpenClaw lane.
13. IRL ears and mouth verified on Meridian: the Loop synthetic canary passes against the Meridian gateway in shadow using the consolidated Loop adapter; a live `wearables_pull` completes end to end through the authorization broker into Arlo's CORTEX with zero encode errors; the voice line still answers through `arlo-voice-webhook`; one cross-channel continuity test (a fact captured by the pendant, asked over iMessage, confirmed by voice) passes.
14. A dated handoff exists on the Desktop with a copy in `~/meridian/docs/handoffs/`, memory is updated, and peer sessions have been told the repo and the box are free.

---

## 3. Workstreams, in order

### Workstream 0: Consolidate five sources into one main (day 1, hard cap 1.5 days)

Preserve first, merge second, nothing destructive.

1. Preserve. On the Mac: from `8964020`, `git checkout -b wip/loop-adapters-20260903`, commit every uncommitted file as-is (it passes tests at that base), tag `pre-consolidation-mac-20260917`. On the VPS, read-only: `git -C /root/meridian-autonomy-control-plane bundle create /tmp/cp.bundle --all`; `tar czf /tmp/loop-20260813c.tgz -C /opt/meridian/releases loop-20260813c --exclude node_modules`; also tar the `dist/` of `loop-20260813e` and `arlo-repair-20260818`. `scp` all of it to `~/meridian-consolidation/` on the Mac (outside iCloud).
2. Base. `git checkout -b consolidate/2026-09 origin/main`. Merge `origin/stormy-governed-release-20260731` (expect fast-forward). Add the bundle as remote `vps`, merge `vps/ops/autonomy-control-plane` (expect fast-forward). Push `ops/autonomy-control-plane` to origin for archival. Gate: typecheck, lint, test, build green.
3. Snapshot diff. `diff -rq --exclude=node_modules --exclude=dist --exclude=.git ~/meridian-consolidation/loop-20260813c ~/meridian`. Classify every differing file: identical, snapshot-only (import), snapshot-newer (import), branch-newer (keep), Loop files (defer to step 4). Import as one commit `import: loop-20260813c source deltas` with the file list in the message.
4. Mac September 3 work. `git merge wip/loop-adapters-20260903`. Expect conflicts in `src/agent/turn.ts`, `src/cli/gateway-cmd.ts`, `src/cli/main.ts`, `src/config/schema.ts`, `src/gateway/server.ts`, and possibly `conversation.ts`, `loader.ts`, `router.ts`. In `router.ts` both sides strip `temperature` for Claude 5; keep one implementation (the Mac Proxy covers `doStream` too) and keep both test sets. For Loop files the Mac wins over the snapshot, but diff each Loop file against the snapshot version and record any snapshot-only hunk in the consolidation doc.
5. Dist drift check. Build the consolidated tree, then compare `strings` output of your `dist/` against the two dist-only production builds for error messages, route paths, and env var names. Any string that exists only in the production build is a fix whose source was lost. Reimplement it or list it. This is the one place source can genuinely be missing.
6. Merge `origin/agent/routexor-first-onboarding` last and close draft PR #30 on its merits.
7. One lone commit `chore: format (no logic)` from `biome format --write .` so every later diff stays readable.
8. Exit gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; test count at least 641 plus the governance, control-plane, and Loop tests; `docs/consolidation-2026-09.md` written; PR opened and merged to origin/main; tag `consolidated-20260917`; Mac tree clean; peer sessions told.

### Workstream 1: Make CI tell the truth and make the process crash-safe (half day)

- Add `tsconfig.test.json` extending the base with `test/**/*` and a `typecheck:test` script in CI. Fix whatever the tests were hiding.
- Add `biome format --check .` to CI. Add coverage behind `COVERAGE=1` using `node --test --experimental-test-coverage` in `scripts/run-tests.mjs`, summary uploaded as a CI artifact.
- In `src/cli/gateway-cmd.ts` register `unhandledRejection` and `uncaughtException` handlers that log `{agentId, err}` through pino. Policy: log and continue on rejection, log and exit 1 on exception so systemd restarts under the new backoff ceiling. Replace the four `void result.done` sites in `src/gateway/server.ts` with a shared `settle(promise, {channel, turnId})` that catches, logs, and never rethrows into the HTTP handler. Add `test/gateway/crash-safety.test.ts`.
- Fix the phantom default model ids in `src/config/schema.ts`: primary and cheap `routexor/claude-haiku-4.5`, fallback `routexor/claude-sonnet-5`, or `routexor/auto` if the catalog check at boot supports it. Add a boot-time catalog check that warns on an unknown id.
- Fix the trivial truth drift now: README badge in both READMEs, ROADMAP header, the `test/README.md` "unwired" line, `skeleton/SKILLS/voice-receptionist/SKILL.md`. Make the boot banner and `CONTEXT/_runtime-loadout.md` derive from the actual tool allowlist so the agent cannot advertise a tool it cannot call. Draft the aterna.ai/meridian copy fix (Stripe and GHL are roadmap, the engine license is Apache 2.0) as a patch file for the site session; do not deploy the site from this prompt.
- Exit gate: CI green on all three Node versions with the new steps; the crash-safety test passes.

### Workstream 2: Fix the eight July defects, reproduce-first (1.5 days)

Write the failing test first for each, then the fix, then the CHANGELOG line, then the GitHub issue closed by the commit.

- (a) Silent agents. Boot logs `automations armed: N, next: <iso>`. `/health.automations` exposes armed, next, last. A silence detector in `src/proactive/sentinel.ts` warns on the ops sink (never Arlo's chat) when an agent with automations has delivered nothing in a configurable window. `meridian doctor --transfer` encodes the AUTONOMY-TRANSFER-CHECKLIST as checks.
- (b) Narration and empty output. Automation turns get an appended runtime rule: emit only the deliverable, first character is the first character of the message. A post-filter strips leading planning lines. Keep the `[SILENT]` contract from origin/main. "(produced no output)" is never delivered. Remove the four `America/Chicago` literals; resolve `def.timezone ?? config.timezone ?? process.env.TZ`; `doctor` warns when none is set.
- (c) Routexor compatibility. Fixture-based regression tests for the five cases already fixed on the control-plane branch (record real Routexor responses, redact keys). Add `meridian doctor --provider`, which sends one minimal request through the configured primary and prints model id, base URL, and any parameter rejection.
- (d) Telegram documents. In `src/channels/telegram.ts` accept `document` updates (pdf, txt, md, docx), download, hand to the ingest and vision path from origin/main, reply with what was understood.
- (e) Google tool names. Pick one namespace, update `skeleton/SKILLS/google/` and the scaffold, add `test/skills/manifest-parity.test.ts` asserting every skill's declared tool names resolve.
- (f) Doctor. An agent home has `IDENTITY/` and `config.yaml`; shared directories fail with a plain message. Deep checks: provider preflight, authenticated CORTEX ping, automations armed, TZ set, spend caps present, ROUTEXOR key hash unique across sibling homes.
- (g) Tool diagnostics. Reuse the receipts from `src/governance/action-policy.ts` (error class, duration, args digest) as the universal tool wrapper, on for every turn, not only when governance is configured. Surface in `/trace` and as a pino line per failure.
- (h) Provider misconfiguration. Boot preflight refuses to start, with a one-line reason, when a `routexor/*` primary is configured against a base URL that is not routexor.com or an explicit `ROUTEXOR_BASE_URL` proxy. `/health.provider` reports it. This is the August 18 outage class.
- Exit gate: eight tests named `defect-<letter>` pass; eight CHANGELOG lines; eight issues.

### Workstream 3: Enforce the safety config that is parsed and ignored (1 day)

- `mode: draft`: the run writes its deliverable to `<home>/OUTBOX/<automation>/<timestamp>.md` and sends the operator "draft ready, /approve <id>" on the trusted channel; `direct` pushes as today.
- `requiresApproval`: the same hold, applied regardless of mode. `/approve` and `/reject` handlers in `src/cli/commands/handlers.ts`, trusted senders only, approval consumed through the governance `consumeApproval` seam so a receipt is recorded.
- `trustGraduation`: after N consecutive approvals the automation flips to direct; the flip is a signed receipt in the session store and visible in `/why`.
- `doctor` warns on `mode: direct` with no approval for any automation that touches trusted-only tools.
- Exit gate: tests for hold, approve, reject, graduation, and receipt-chain verification; a section in `docs/governance-guarantee.md`.

### Workstream 4: Spend accounting and caps inside the harness (1 day)

- Capture `usage` from `streamText` in `runTurn` and in the automation runner. Price from the ROUTEXOR `/v1/models` catalog cached at boot; when a price is unknown, record tokens and USD null, never a guess.
- Ledger: `{t:'spend'}` records in the session store plus `<home>/LEDGER/spend-YYYY-MM-DD.jsonl`. Include `jobId` for automation runs and send it as a request header so ROUTEXOR's Agent Run Control can enforce per-job caps when it ships. The harness cap must work alone.
- Config `spend: { perTurnUsd, perRunUsd, dailyUsd, monthlyUsd, onExceed: 'block' | 'degrade' }` in `src/config/schema.ts`. Preflight before the provider call, settlement after. Exceeded turns reply in plain language on trusted channels and go silent for automations. `/health.spend` and `/why` show today's total.
- Reuse the control-plane dead-letter path for runaway loops and add a repeated-identical-tool-call quarantine inside the tool wrapper.
- Shipped unit template (`skeleton/` or `docs/production-deployment.md`) gets `StartLimitBurst=5`, `StartLimitIntervalSec=300`, `RestartSec=10`.
- Exit gate: tests for each cap; the one-cent daily cap experiment on a throwaway VPS home; `docs/spend-controls.md`.

### Workstream 5: Observability a canary can be judged on (half day)

- Standard pino fields on every line: `agentId, channel, turnId, sessionId, automation, model, tokens, usd, durationMs, outcome`.
- `/health` fields per Definition of Done item 7, in a shape `/root/aterna-fleet/scripts/vps-health-check.sh` can consume without modification of its Arlo row. `meridian status` prints the same.
- Ops alert sink: `OPS_ALERT_CHAT_ID` (a Telegram chat that is not Arlo's) or log-only by default. Do not invent a destination; if none exists it is a founder blocker.
- Exit gate: a `/health` contract test and a log-field test.

### Workstream 5b: Feels like a person over text (1 day)

The bar is Rez's: texting Arlo should feel like texting a sharp human who knows the role cold. This is a turn-loop and channel-adapter concern, not a prompt-only concern.

- Message shaping in `runTurn` for text channels (telegram, imessage, sms, whatsapp): a `textStyle` policy in `src/config/schema.ts` with defaults for max bubble length, bubble splitting on natural sentence breaks, a cap on bubbles per reply, no markdown headers or bullet walls on text channels, no "As an AI" or "I'm just a" phrasing, no tool narration, no sign-offs. Each channel adapter gets `splitForHumans()` that honors the policy and the platform's real limits.
- Cadence: typing indicators where the channel supports them (BlueBubbles and Telegram do), a short human-like delay proportional to reply length capped at two seconds, and follow-up bubbles for long content instead of one wall. Reactions where supported (BlueBubbles tapbacks) for acknowledgements that need no words.
- Voice of the role: the operator's IDENTITY and the skill `voice-of-user` feed a style block that the framework appends after RUNTIME_RULES; add a `meridian style` command that shows five sample replies rendered under the current policy so the operator can tune it without a deploy.
- Grounded confidence: when recall is empty the agent says so like a person would ("I don't have that one yet, want to tell me?") instead of fabricating; this reuses the RUNTIME_RULES no-fabrication law with channel-appropriate phrasing.
- Bench: add a human-feel axis to Workstream 6. Twenty real prompts from Rez's recent Telegram history (read on the box, never copied off it), each answered by the OpenClaw lane and by Meridian on the same clone, judged blind by `scripts/eval/run-eval.mts` on naturalness, brevity, role knowledge, and absence of assistant-speak, with pairwise preference. Threshold: Meridian preferred at least 60 percent of the time.
- Exit gate: tests for the shaping policy on every text channel; the `meridian style` command; the human-feel axis wired into the bench.

### Workstream 5c: iMessage through BlueBubbles (1.5 days)

iMessage is required. The ROADMAP already names two routes: a Mac relay (BlueBubbles) or a hosted API (Sendblue, LoopMessage). Build the BlueBubbles adapter first because it is the route with the buzz, real blue bubbles, and no per-message vendor; keep the hosted route as a second adapter behind the same interface if Rez chooses it.

- `src/channels/imessage.ts`: a `ChannelAdapter` like `telegram.ts` and `sms.ts`. Transport is the BlueBubbles server REST API plus its webhook (`new-message`, `updated-message`, typing events). Config: `imessage.serverUrl`, `imessage.password` in the vault, `imessage.allowFrom` (Rez's handle only for Arlo, bootstrap-locked to first sender like Telegram), `imessage.webhookSecret`. Outbound: send text, send attachment, typing indicator start and stop, tapback reactions, reply-in-thread. Inbound: text, attachments (images through the vision path, documents through ingest), read receipts as signals only. Operator resolution through `resolveOperator()` so iMessage joins the one continuous conversation across channels.
- Security: the webhook fails closed without the secret (the VAPI lesson), the sacred-topic guard and the memory-integrity screen apply as on every channel, unknown senders get the untrusted path, and the gateway route is `/imessage/webhook` behind caddy with the same posture as the other webhooks.
- Reliability: SMS stays as the fallback adapter when the recipient is not on iMessage or the relay is down; the adapter reports relay health in `/health.channels`; recorded-fixture tests for every event type in `test/channels/imessage.test.ts`; `meridian doctor` probes the relay.
- Setup doc `docs/imessage-setup.md`: a Mac that stays on, Messages signed into a dedicated Apple ID and phone number for the agent (never Rez's personal Apple ID), BlueBubbles server installed and its port reachable from VPS #2 over a tunnel or the relay's own tunnel, password in the vault. Plain language, no em dashes.
- Candor for Rez, stated in the blocker list: BlueBubbles makes whichever Mac runs it production infrastructure. The two-VPS rule says the Mac Mini is dev-only. Either he promotes the Mac Mini (or a spare Mac) to a production relay with its own Apple ID and accepts that his iCloud-synced machine is now in the serving path, or he picks the hosted route. Do not decide this for him; build the adapter so both routes plug in.
- Exit gate: the adapter passes its fixture tests; in shadow, a message from Rez's handle reaches Arlo on Meridian and the reply arrives as a blue bubble with a typing indicator first; the fallback to SMS is exercised once.

### Workstream 5d: IRL ears and mouth on Meridian (1 day)

Voice, Loop, and wearables are how the agent hears and speaks in the real world. None of them may regress, and each must be proven against Meridian, not assumed.

- Loop: the consolidated Loop adapter (`src/gateway/loop-contract.ts`, `loop-pairing.ts`, `loop-agent-adapter.ts`, `device-media.ts`, from the September 3 work) must pass the same synthetic Loop canary the OpenClaw sidecar passes: HTTP 401 unauthenticated, HTTP 200 with schema `aterna.loop.reply.v1`, agent `arlo`, one exact segment citation, `toolExecution: disabled`, `memoryWrite: disabled`, no content in logs. Run it against the Meridian gateway in shadow. Switching the production Loop sidecar to Meridian stays out of scope for this prompt, but the adapter must be ready so the switch is a config change.
- Wearables: run one live `wearables_pull` end to end through `/usr/local/sbin/aterna-wearables-authorize` and the broker into Arlo's CORTEX (the July 31 procedure), and record transcripts seen, encoded, skipped, and errors. Zero errors is the bar. Add a per-encode timeout to the backfill path if it is still missing.
- Voice: `arlo-voice-webhook` is a separate service and must not change. Verify after cutover that a test call still answers, that the voice channel's public-memory-only filter still applies, and that the passphrase unlock still works.
- Cross-channel continuity: one scripted test on the shadow that captures a fact through the wearables path, asks about it over iMessage, and confirms the same fact is available to the voice channel's recall with the correct sensitivity tier.
- Exit gate: Definition of Done item 13.

### Workstream 6: Harness parity bench against the OpenClaw runtime that serves Arlo (1.5 days, at most two fix-and-rerun loops)

Parity means: on an identical clone of Arlo's home (`/root/.meridian/arlo` copied to `/root/.meridian-bench/arlo`), an identical CORTEX clone (copy the arlo database into a bench CORTEX on a spare loopback port), one dedicated `ARLO_BENCH` ROUTEXOR key with a hard budget, and the CLI channel or a shadow bot token, Meridian matches or beats the OpenClaw runtime on every dimension both share and is measurably better on the ones OpenClaw does not offer. Run one harness at a time against the clone. Follow `docs/harness-comparison-methodology.md`; results stay internal unless its publication rules are satisfied.

Dimensions, recorded in `benchmarks/harness-parity-v1/` modelled on `benchmarks/governed-agent-v1/`:

1. Functional: 30 scripted turns covering the 13 skills and the three automations rendered on demand. Deterministic checks: expected tool invoked, non-empty deliverable, no narration prefix, no "produced no output", correct format. Optional judge tier reusing `scripts/eval/run-eval.mts`. Threshold: pass rate at or above OpenClaw's.
2. Memory: 20 seeded facts, recall hit rate and encode round-trip, using the `scripts/longmemeval` harness pattern. Threshold: at or above OpenClaw's.
3. Reliability: 100 turns, p50 and p95 latency, error and 502 rate, breaker trips. Threshold: error rate at or below OpenClaw's, p95 within 20 percent.
4. Proactive: the three automations fire exactly once at the scheduled Denver minute over 24 hours. Threshold: three of three.
5. Safety and cost: MemPoisonBench score, governance deny receipts, USD per turn from the ledger. OpenClaw cells are marked unmeasured where it exposes nothing.
6. Human feel: the blind pairwise judge axis from Workstream 5b. Threshold: Meridian preferred at least 60 percent of the time.

Exit gate: `results-<date>.json` meets every threshold, or a named list of failures feeds back into Workstreams 2 to 5 for at most two loops.

### Workstream 7: Transfer Arlo's autonomy, do not park it (half day)

Follow the checklist. Inventory every Arlo timer and automation on the box. Classify each ARM-NOW, PHASE-2 with a reason, or RETIRE with a reason. Re-arm the three Meridian automations (morning-brief, open-loops, eod-checkin) with the narration guard and `[SILENT]`. Leave the host timers that do not depend on the harness untouched (meet-autopilot, inbox-monitor, dream, prewarm, wearables reminder). Dry-run each automation through `POST /chat` and confirm it is grounded, honest, and clean. Fire exactly one operator-facing automation live to Rez's Telegram and confirm `pushedTo: ["telegram"]`.

### Workstream 8: Arlo canary with auto-rollback (1 day active, then a 7-day soak)

1. Build `1.5.0-rc.N` on the Mac, `scp` to `/opt/meridian/releases/1.5.0-rc.N/`, install production deps there with the aterna node (`/opt/aterna-node-v26.8.1-linux-x64/bin/node`). Never overwrite an existing release directory.
2. Write the new `meridian-gateway-arlo.service`: ExecStart and WorkingDirectory on the release, `Environment=TZ=America/Denver`, the restart ceiling, `EnvironmentFile=/root/.meridian/arlo/.env` plus `/root/.meridian/arlo/.env.meridian` for Meridian-only variables. Add, never rewrite, the env the OpenClaw unit reads.
3. Shadow phase: start Meridian on a different loopback port with Telegram disabled and encode disabled or pointed at the bench clone. Run `doctor --transfer` and `doctor --provider`. Run the parity script once more against the real home.
4. Pre-flight: message the peer session and leave the note in `/root/CLAUDE.md`; `stat` Arlo's OpenClaw config; take a fresh backup of `/root/.meridian/arlo` and the OpenClaw instance directory; ask Rez for a Hostinger snapshot in the blocker list but do not wait on it. Write `scripts/ops/arlo-cutover.sh` and `scripts/ops/arlo-rollback.sh` in the repo. Exercise the rollback script once against the shadow before the real cutover.
5. Cutover: `systemctl disable --now aterna-openclaw-arlo-canary && systemctl enable --now meridian-gateway-arlo`; poll for the port bind for up to 30 seconds (never sleep; boot takes 9 to 12 seconds); `GET /health`; one authenticated turn through `/chat`; on any failure run the rollback script, which must restore the OpenClaw unit within 20 seconds. Then verify the Loop synthetic canary still passes through the sidecar on port 18889, the voice webhook health is unchanged, and, if the iMessage relay is live, one blue-bubble round trip works. Tell Rez, with the receipt.
6. Soak: schedule a `/loop` or a cloud routine that checks `/health`, deliveries, spend, restarts, and the journal for 502s every few hours. A hard failure (502, missed automation, narration leak, spend over cap, restart) triggers the rollback script and an ops alert. At hour 24 run the rollback drill and re-cutover. Record every day in the handoff. Seven consecutive clean days closes the prompt.
7. Exit gate: Definition of Done item 9 evidence in the handoff; `docs/production-deployment.md` written.

### Workstream 9: Process (continuous)

Handoff at the end of every session: `~/Desktop/MERIDIAN-HANDOFF-<date>.md` with a copy in `~/meridian/docs/handoffs/`. Memory updated. A GitHub issue for every defect found. `ListAgents` and `SendMessage` before every push and before touching the box. One batched blocker list per session.

---

## 4. Sequencing and time boxes

- Order is 0, 1, 2, 3, 4, 5, 5b, 5c, 5d, 6, 7, 8, with 9 throughout. About twelve working days of effort plus the seven-day soak. Workstreams 5b, 5c, and 5d can run in parallel with each other once 5 is done.
- Nothing pushes to origin/main before the Workstream 0 gate. Workstream 1 before 2, because CI must be truthful before fixes count. Workstreams 2 through 5d before 6. Workstream 6 thresholds before 8. No VPS unit is touched before Workstream 8 step 5.
- Workstream 0 has a hard cap of 1.5 days; land what is typecheck-clean and document the rest. Workstream 6 gets at most two fix-and-rerun loops.
- Any single technical rabbit hole: two hours, then ship the honest partial and note it.
- If a workstream is blocked on Rez, finish every other workstream and present one batched blocker list with the exact command or click he needs.

## 5. Landmines

- `arlo-repair-20260818` is dist-only; its source may not exist anywhere. Workstream 0 step 5 is the only mitigation.
- Two harnesses on one CORTEX database double-encode and can poison memory. Shadow and bench runs use a clone or encode off.
- One Telegram bot token, one poller. A shadow Meridian with Arlo's token steals updates from the OpenClaw unit mid-production.
- The default model ids in `src/config/schema.ts` do not exist on ROUTEXOR. The September 2 RUDY incident proves a wrong id fails confidently, not loudly.
- 110 files of format drift. Do the format commit alone or every later diff is unreadable.
- Desktop is iCloud-synced and shared with the MacBook; writes can time out.
- The Loop sidecar has its own private OpenClaw runtime and `ATERNA_LOOP_HARNESS=openclaw`. Switching Loop's harness is out of scope; the Loop canary is only a regression check that the Arlo cutover did not break port 18889.
- Shared `.env` variable names between the two harnesses. Add, never rewrite.
- VPS default node is 22; the aterna node is 26.8.1; the repo floor is 20. Build on the Mac, run with the aterna node, keep the CI matrix.
- A peer AI session is live on the box and another may be on the repo. Coordinate before every push and before the cutover.
- BlueBubbles puts a Mac in the serving path. Rez's Mac Mini is iCloud-synced to his MacBook and is dev-only by standing rule; never sign Messages on it into his personal Apple ID for an agent.
- The VAPI assistant `ARLO_MAIN_7.0` is reached through `arlo-voice-webhook`, not the harness. You should never need to PATCH it. If you do, GET, mutate, PATCH the full object.

## 6. Known blockers only Rez can clear

- An ops alert destination that is not Arlo's Telegram (a chat id or an email).
- A dedicated `ARLO_BENCH` ROUTEXOR key with a budget, or explicit approval to run the bench on Arlo's key.
- A shadow Telegram bot token for the bench, or agreement to bench on the CLI channel only.
- A Hostinger panel snapshot of VPS #2 before the cutover.
- Identifying the peer session on the box if it does not answer a message.
- Deploying the aterna.ai/meridian copy fix (site session, his say-so).
- The iMessage decision: promote the Mac Mini (or a spare Mac) to a production BlueBubbles relay with a dedicated Apple ID and phone number for Arlo, or pick a hosted relay (Sendblue or LoopMessage). Until decided, the adapter is built and tested against fixtures and a local BlueBubbles instance only.
- The dedicated Apple ID and phone number for Arlo, and the BlueBubbles server password for the vault.

## 7. Verification and reporting

- Every ship is verified with a command before it is reported: the test name, the curl, the journalctl line. Report what was verified and how; if something could not be verified, say so first.
- Final report format: outcome first, the Definition of Done checklist with a verified mark per item, one parity table with OpenClaw and Meridian columns, one seven-row soak table, the blocker list, and where the handoff lives. No em dashes.
- Honest framing to keep in every report: the goal is not "Meridian works." The goal is "Meridian runs the founder's own agent better than the vendor runtime, with numbers." Report against the parity table and the soak table, not against feelings about the code.

## 8. Anti-goals

- No fleet migration and no Andy, Arly, or Luca changes. Next prompt.
- No npm publish, no GitHub release, no README redesign. Next prompt.
- No new channels beyond iMessage, no new skills, no hosted-lane or SaaS work, no switch of the production Loop sidecar to Meridian, no OpenClaw removal.
- No competitor benchmarks that violate `docs/harness-comparison-methodology.md`. No fabricated OpenClaw numbers.
- No Stripe, no OpenRouter, no shared keys, no platform-key fallbacks, no partial VAPI PATCH.
- No claims, numbers, or dates that are not sourced; when in doubt, verify and record the source.
