#!/usr/bin/env bash
# Release train: build a numbered, immutable release, stage it on the VPS,
# certify it against a shadow gateway, and mark it CERTIFIED only when
# `meridian certify` exits 0. The cutover script refuses a release without
# that marker.
#
# Usage (on the Mac, from the repo root, clean tree on main):
#   scripts/ops/release.sh 1.5.0-rc.2
#   scripts/ops/release.sh 1.5.0-rc.2 --confirm telegram.operator --confirm sms.operator
#
# Environment (defaults are the VPS #2 bench lane):
#   VPS=root@177.7.40.108
#   RELEASES=/opt/meridian/releases
#   NODE_BIN=/opt/aterna-node-v26.8.1-linux-x64/bin
#   SHADOW_START=/root/meridian-bench/start-meridian.sh   # started with RELEASE=<dir>; must print healthy
#   SHADOW_GATEWAY=http://127.0.0.1:28889
#   CERTIFY_HOME=/root/.meridian-bench   CERTIFY_AGENT=arlo
#   SKIP_GATE=1  skips the local gate (never in the real train)
set -euo pipefail

VERSION="${1:?usage: release.sh <version> [--confirm <id>]...}"; shift
CONFIRMS=("$@")
VPS="${VPS:-root@177.7.40.108}"
RELEASES="${RELEASES:-/opt/meridian/releases}"
NODE_BIN="${NODE_BIN:-/opt/aterna-node-v26.8.1-linux-x64/bin}"
SHADOW_START="${SHADOW_START:-/root/meridian-bench/start-meridian.sh}"
SHADOW_GATEWAY="${SHADOW_GATEWAY:-http://127.0.0.1:28889}"
CERTIFY_HOME="${CERTIFY_HOME:-/root/.meridian-bench}"
CERTIFY_AGENT="${CERTIFY_AGENT:-arlo}"
DEST="$RELEASES/$VERSION"

log() { echo "[release $(date -u +%FT%TZ)] $*"; }
fail() { log "FAIL: $*"; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || fail "version must look like 1.5.0 or 1.5.0-rc.2"
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean; commit or stash first"
COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git branch --show-current)
log "version=$VERSION commit=$COMMIT branch=$BRANCH"

# 1. The gate. Nothing ships that the CI would reject.
if [ "${SKIP_GATE:-0}" != "1" ]; then
  log "gate: install, typecheck (src + test), lint, format check, test, build"
  pnpm install --frozen-lockfile --silent
  pnpm typecheck
  pnpm exec tsc --noEmit -p tsconfig.test.json
  pnpm lint
  pnpm run format:check
  pnpm test
  pnpm build
else
  log "gate SKIPPED (SKIP_GATE=1)"
fi

# 2. Releases are immutable. A version that exists on the box is never rewritten.
if ssh -o BatchMode=yes "$VPS" "[ -e '$DEST' ]"; then
  fail "$DEST already exists on $VPS; pick a new version"
fi

# 3. Stage source and build on the box with the aterna node.
log "staging to $VPS:$DEST"
ssh -o BatchMode=yes "$VPS" "mkdir -p '$DEST'"
rsync -az --exclude node_modules --exclude .git --exclude dist --exclude 'benchmarks/*/runs' ./ "$VPS:$DEST/"
ssh -o BatchMode=yes "$VPS" "set -e; cd '$DEST'; export PATH=$NODE_BIN:\$PATH; node -v; pnpm install --frozen-lockfile --silent; pnpm build >/dev/null; \
  printf '{\"version\":\"%s\",\"commit\":\"%s\",\"branch\":\"%s\",\"builtAt\":\"%s\"}\n' '$VERSION' '$COMMIT' '$BRANCH' \"\$(date -u +%FT%TZ)\" > RELEASE.json; cat RELEASE.json"

# 4. Shadow gateway from this exact release, then certify it.
log "starting shadow gateway from $DEST"
ssh -o BatchMode=yes "$VPS" "RELEASE='$DEST' '$SHADOW_START'" || fail "shadow gateway did not come up"

CONFIRM_ARGS=""
for c in "${CONFIRMS[@]:-}"; do [ -n "$c" ] && CONFIRM_ARGS="$CONFIRM_ARGS $c"; done
log "certify against $SHADOW_GATEWAY (home $CERTIFY_HOME, agent $CERTIFY_AGENT)"
set +e
ssh -o BatchMode=yes "$VPS" "cd '$CERTIFY_HOME/$CERTIFY_AGENT' && HOME=/root MERIDIAN_HOME='$CERTIFY_HOME' MERIDIAN_AGENT='$CERTIFY_AGENT' TZ=America/Denver PATH=$NODE_BIN:/usr/bin:/bin \
  '$DEST/bin/meridian' certify --gateway '$SHADOW_GATEWAY' --out '$DEST/CERTIFICATION.json' $CONFIRM_ARGS"
CERT_EXIT=$?
set -e

if [ "$CERT_EXIT" = "0" ]; then
  ssh -o BatchMode=yes "$VPS" "printf 'version=%s\ncommit=%s\ncertifiedAt=%s\nreport=%s\n' '$VERSION' '$COMMIT' \"\$(date -u +%FT%TZ)\" '$DEST/CERTIFICATION.json' > '$DEST/CERTIFIED'; cat '$DEST/CERTIFIED'"
  git tag -f "release/$VERSION" >/dev/null
  log "CERTIFIED: $DEST (tag release/$VERSION created locally; push it when you cut over)"
else
  ssh -o BatchMode=yes "$VPS" "printf 'version=%s\ncommit=%s\ncheckedAt=%s\nexit=%s\nreport=%s\n' '$VERSION' '$COMMIT' \"\$(date -u +%FT%TZ)\" '$CERT_EXIT' '$DEST/CERTIFICATION.json' > '$DEST/NOT-CERTIFIED'"
  fail "NOT CERTIFIED: $DEST (exit $CERT_EXIT). The release stays staged for inspection; the cutover script will refuse it."
fi
