# Production deployment (Meridian gateway on a VPS)

Written from the August 2026 cutover records with secrets removed. This is the shape the Arlo canary uses; every other agent follows it with its own ports and home.

## Layout on the box

| Thing | Where |
|---|---|
| Agent home | `/root/.meridian/<agent>/` (config.yaml, .env, IDENTITY, AUTOMATIONS, SKILLS, LEDGER, OUTBOX, sessions, logs) |
| Releases | `/opt/meridian/releases/<version>/` (immutable; never overwrite a release dir) |
| Memory | `cortex-<agent>.service` on a loopback port (Arlo: 3101), its own database and key |
| Gateway | `meridian-gateway-<agent>.service` on a loopback port (Arlo: 18889) |
| Public ingress | Caddy on `webhook.aterna.ai`; only `/health`, `/vapi/webhook*`, and the Loop routes are public |
| Voice | `arlo-voice-webhook.service` on 18893, a separate adapter; never touched by a gateway deploy |
| Loop | `aterna-loop.service` sidecar on 19989, upstream selected by `LOOP_UPSTREAM_URL` |

## Unit

Install `skeleton/systemd/meridian-gateway@.service` as `/etc/systemd/system/meridian-gateway-<agent>.service` with `<agent>`, `<user>`, `<release>` filled in. It carries the restart ceiling (`StartLimitBurst=5` in 300 seconds), `TZ=America/Denver`, and reads `/root/.meridian/<agent>/.env` plus an optional `.env.meridian` for Meridian-only variables. Never rewrite the shared `.env`; add to `.env.meridian`.

## Ship a release

The release train does all of the below in one command and refuses to mark a
release shippable unless `meridian certify` passes against a shadow gateway
running that exact build:

```bash
scripts/ops/release.sh 1.5.0-rc.2                       # gate, stage, build, shadow, certify
scripts/ops/release.sh 1.5.0-rc.2 --confirm telegram.operator   # operator-attested claims
```

It writes `RELEASE.json` and `CERTIFICATION.json` into the release directory,
then `CERTIFIED` (or `NOT-CERTIFIED`). `scripts/ops/arlo-cutover.sh` refuses a
release without `CERTIFIED` unless `ALLOW_UNCERTIFIED=1` is set on purpose.
The manual steps, for reference:

```bash
# on the Mac
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build
VERSION=1.5.0-rc.1
rsync -a --exclude node_modules --exclude .git ./ root@<vps>:/opt/meridian/releases/$VERSION/
ssh root@<vps> "cd /opt/meridian/releases/$VERSION && PATH=/opt/aterna-node-v26.8.1-linux-x64/bin:\$PATH pnpm install --prod --frozen-lockfile"
```

Run the release with the aterna node (`/opt/aterna-node-v26.8.1-linux-x64/bin/node`); the box's default node is 22 and the repo floor is 20.

## Shadow before cutover

```bash
# a second gateway on a spare port, no Telegram, no memory writes
MERIDIAN_AGENT=arlo MERIDIAN_GATEWAY_PORT=28889 TELEGRAM_BOT_TOKEN= MERIDIAN_MEMORY_PROVIDER=cortex \
  /opt/meridian/releases/$VERSION/bin/meridian gateway --port 28889
meridian doctor --provider
GATEWAY_URL=http://127.0.0.1:28889 GATEWAY_TOKEN=... node scripts/ops/continuity-check.mjs   # bench clone only
```

Then the parity bench (`benchmarks/harness-parity-v1/README.md`) against the incumbent on a memory clone.

## Cutover and rollback

```bash
RELEASE=/opt/meridian/releases/$VERSION scripts/ops/arlo-cutover.sh   # snapshots, rollback dry-run, switch, poll, health, one turn, side-service checks; auto-rollback on any failure
scripts/ops/arlo-rollback.sh                                          # restore the retained OpenClaw unit, under 20 seconds
scripts/ops/arlo-soak-check.sh                                        # every few hours during the soak; non-zero = run the rollback
```

The OpenClaw unit is disabled, never removed, for 30 days after cutover. Rollback assets from the original migration remain under `/root/aterna-openclaw-migration-2026-08-21/rollback/`.

## Rules that do not bend

- One Telegram bot token, one poller. Stop the old unit fully before starting the new one.
- Two harnesses never write the same memory database at the same time.
- The voice webhook, the Loop sidecar, `cortex-*`, and Caddy are not part of a gateway deploy.
- Coordinate with any peer session on the box before the cutover window.
