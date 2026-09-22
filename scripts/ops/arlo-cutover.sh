#!/usr/bin/env bash
# Arlo canary cutover: OpenClaw -> Meridian, with automatic rollback (WS8).
#
# Usage (on VPS #2, as root):
#   RELEASE=/opt/meridian/releases/1.5.0-rc.1 scripts/ops/arlo-cutover.sh
#
# Preconditions this script checks before touching a unit:
#   - the Meridian unit file exists and points at $RELEASE
#   - the rollback script is present and executable
#   - the OpenClaw unit is currently active (we are cutting FROM it)
#   - a pre-cutover snapshot of both configs exists (taken here)
#
# It never deletes anything. On any failed check after the switch it runs the
# rollback script, which restores the OpenClaw unit within about 20 seconds.
set -euo pipefail

RELEASE="${RELEASE:?set RELEASE=/opt/meridian/releases/<version>}"
AGENT="${AGENT:-arlo}"
PORT="${PORT:-18889}"
OLD_UNIT="aterna-openclaw-${AGENT}-canary.service"
NEW_UNIT="meridian-gateway-${AGENT}.service"
ROLLBACK="${ROLLBACK:-$(dirname "$0")/arlo-rollback.sh}"
ENV_FILE="/root/.meridian/${AGENT}/.env"
SNAP="/root/meridian-cutover-snapshots/$(date -u +%Y%m%dT%H%M%SZ)"
LOG="/var/log/meridian-cutover.log"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; exit 1; }

log "cutover start agent=$AGENT release=$RELEASE"
[ -x "$RELEASE/bin/meridian" ] || fail "release binary missing at $RELEASE/bin/meridian"
[ -x "$ROLLBACK" ] || fail "rollback script missing or not executable: $ROLLBACK"
systemctl cat "$NEW_UNIT" >/dev/null 2>&1 || fail "$NEW_UNIT is not installed"
systemctl cat "$NEW_UNIT" | grep -q "$RELEASE" || fail "$NEW_UNIT does not point at $RELEASE"
systemctl is-active --quiet "$OLD_UNIT" || fail "$OLD_UNIT is not active; nothing to cut from"
[ -f "$ENV_FILE" ] || fail "env file missing: $ENV_FILE"
TOKEN=$(grep -E '^MERIDIAN_GATEWAY_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)
[ -n "$TOKEN" ] || fail "MERIDIAN_GATEWAY_TOKEN not in $ENV_FILE"

# Snapshot everything the rollback might need. Never overwritten.
mkdir -p "$SNAP"
systemctl cat "$OLD_UNIT" > "$SNAP/$OLD_UNIT"
systemctl cat "$NEW_UNIT" > "$SNAP/$NEW_UNIT"
cp -a "/root/.meridian/${AGENT}/config.yaml" "$SNAP/config.yaml" 2>/dev/null || true
cp -a "/root/aterna-openclaw-migration-2026-08-21/instances/${AGENT}/openclaw.json" "$SNAP/openclaw.json" 2>/dev/null || true
log "snapshot at $SNAP"

# Rollback drill against nothing live: verify the script parses and its checks pass in dry-run.
DRY_RUN=1 "$ROLLBACK" || fail "rollback dry-run failed; refusing to cut over"

# The switch. One poller per bot token: stop the old unit fully before the new one starts.
log "stopping $OLD_UNIT"
systemctl disable --now "$OLD_UNIT"
sleep 2
log "starting $NEW_UNIT"
systemctl enable --now "$NEW_UNIT"

# Poll for the port bind; boot takes 9 to 12 seconds. Never sleep blind.
bound=0
for i in $(seq 1 30); do
  if ss -ltn | grep -q ":${PORT} "; then bound=1; break; fi
  sleep 1
done
if [ "$bound" != "1" ]; then
  log "port ${PORT} did not bind within 30s"
  "$ROLLBACK" || true
  fail "rolled back: no port bind"
fi

# Health, then one authenticated turn.
if ! curl -fsS --max-time 8 "http://127.0.0.1:${PORT}/health" | tee -a "$LOG" | grep -q '"ok":true'; then
  log "health not ok"
  "$ROLLBACK" || true
  fail "rolled back: health"
fi
REPLY=$(curl -fsS --max-time 60 -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"input":"Cutover check: reply with the single word ready."}' "http://127.0.0.1:${PORT}/chat" || true)
echo "$REPLY" >> "$LOG"
if ! echo "$REPLY" | grep -qi '"reply"'; then
  log "authenticated turn failed"
  "$ROLLBACK" || true
  fail "rolled back: turn"
fi

# Side services that must be untouched: voice webhook and Loop sidecar.
systemctl is-active --quiet arlo-voice-webhook.service || log "WARN: arlo-voice-webhook is not active (was it before?)"
systemctl is-active --quiet aterna-loop.service && log "loop sidecar active" || log "WARN: aterna-loop sidecar not active"
curl -fsS --max-time 8 http://127.0.0.1:18893/health >/dev/null && log "voice webhook health ok" || log "WARN: voice webhook health failed"

log "CUTOVER OK: $AGENT now on $NEW_UNIT ($RELEASE). Old unit disabled, retained. Snapshot $SNAP"
