#!/usr/bin/env bash
# Soak check for the Arlo canary (WS8). Run every few hours from a timer or a
# loop. Prints one line per check; exits non-zero on a hard failure so the
# caller can trigger scripts/ops/arlo-rollback.sh.
set -uo pipefail
AGENT="${AGENT:-arlo}"
PORT="${PORT:-18889}"
UNIT="meridian-gateway-${AGENT}.service"
DAILY_CAP="${DAILY_CAP:-10}"
hard=0
line() { echo "[$(date -u +%FT%TZ)] $*"; }
H=$(curl -fsS --max-time 8 "http://127.0.0.1:${PORT}/health" 2>/dev/null) || { line "HARD health unreachable"; exit 2; }
py() { python3 -c "import json,sys; d=json.load(sys.stdin); $1" <<<"$H"; }
py 'print("health ok" if d["ok"] else "HARD health not ok")' | tee /dev/stderr | grep -q HARD && hard=1
line "$(py 'print("restarts", 0)')"
R=$(systemctl show "$UNIT" -p NRestarts --value 2>/dev/null || echo 0); [ "${R:-0}" -gt 0 ] && { line "HARD unit restarts=$R"; hard=1; } || line "unit restarts 0"
line "$(py 'i=d["lastHourInference"] or {}; print("last hour turns", i.get("turns"), "errors", i.get("errors"))')"
py 'i=d["lastHourInference"] or {}; import sys; sys.exit(1 if (i.get("errors",0)>=3 and i.get("errors",0)>=i.get("turns",1)/2) else 0)' || { line "HARD error rate"; hard=1; }
line "$(py 'print("cortex", d["cortex"]["status"])')"
py 'import sys; sys.exit(1 if d["cortex"]["status"]=="down" else 0)' || { line "HARD cortex down"; hard=1; }
line "$(py 's=d["spend"] or {}; print("spend today $%.4f" % (s.get("today",{}).get("usd",0)))')"
py "import sys; s=d['spend'] or {}; sys.exit(1 if s.get('today',{}).get('usd',0) > $DAILY_CAP else 0)" || { line "HARD spend over cap"; hard=1; }
py 'for a in d["automations"]: print("automation", a["name"], "next", a["nextFireAt"], "last delivered", a["lastDeliveredAt"], "silent h", round((a["silentForMs"] or 0)/3600000,1))'
py 'import sys; sys.exit(1 if any((a["silentForMs"] or 0) > 30*3600000 and a["delivers"] for a in d["automations"]) else 0)' || { line "HARD an automation silent > 30h"; hard=1; }
J=$(journalctl -u "$UNIT" --since "6 hours ago" --no-pager 2>/dev/null | grep -c "502\|narration stripped\|unhandled rejection" || true)
[ "${J:-0}" -gt 0 ] && line "WARN journal flags in last 6h: $J" || line "journal clean (6h)"
[ "$hard" = "1" ] && { line "SOAK HARD FAIL"; exit 1; }
line "SOAK OK"
