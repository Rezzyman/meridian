#!/usr/bin/env bash
# Roll Arlo back from Meridian to the retained OpenClaw unit (WS8).
# Idempotent. DRY_RUN=1 only checks preconditions. Target: under 20 seconds.
set -euo pipefail
AGENT="${AGENT:-arlo}"
PORT="${PORT:-18889}"
OLD_UNIT="aterna-openclaw-${AGENT}-canary.service"
NEW_UNIT="meridian-gateway-${AGENT}.service"
LOG="/var/log/meridian-cutover.log"
log() { echo "[$(date -u +%FT%TZ)] rollback: $*" | tee -a "$LOG"; }

systemctl cat "$OLD_UNIT" >/dev/null 2>&1 || { log "FAIL: $OLD_UNIT unit file missing"; exit 1; }
if [ "${DRY_RUN:-0}" = "1" ]; then log "dry-run ok: $OLD_UNIT present, would stop $NEW_UNIT and start it"; exit 0; fi

log "stopping $NEW_UNIT"
systemctl disable --now "$NEW_UNIT" || true
sleep 1
log "starting $OLD_UNIT"
systemctl enable --now "$OLD_UNIT"
for i in $(seq 1 20); do
  if ss -ltn | grep -q ":${PORT} "; then log "port ${PORT} bound by $OLD_UNIT after ${i}s"; break; fi
  sleep 1
done
systemctl is-active --quiet "$OLD_UNIT" && log "ROLLBACK OK" || { log "FAIL: $OLD_UNIT not active"; exit 1; }
