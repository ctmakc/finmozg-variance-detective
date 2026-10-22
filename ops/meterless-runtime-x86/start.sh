#!/bin/sh
# Start Meterless Runtime 1.4.5 (Nightshift headless daemon) as the current user.
# meterlessd is aarch64 -> runs under user-mode qemu with an arm64 Ubuntu 24.04
# sysroot; the Node engine host and the lane shim run natively (x86 Node 22).
set -eu
R=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PIDF="$R/run/meterlessd.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  echo "already running (pid $(cat "$PIDF"))"; exit 0
fi
mkdir -p "$R/run" "$R/log" "$R/state" "$R/models"
chmod 700 "$R/run" "$R/state"
export METERLESS_STATE_DIR="$R/state"
export METERLESSD_CONFIG="$R/config.toml"
export OLLAMA_BASE="${OLLAMA_BASE:-http://127.0.0.1:11434}"
export LANE_UPSTREAM_MODEL="${LANE_UPSTREAM_MODEL:-nemotron-3-super:cloud}"
export LANE_SHIM_LOG="$R/log/lane-shim.log"
cd "$R"
nohup setsid "$R/qemu-dl/ex/usr/bin/qemu-aarch64-static" -L "$R/sysroot" \
  "$R/opt/usr/bin/meterlessd" --config "$R/config.toml" \
  >>"$R/log/meterlessd.log" 2>&1 </dev/null &
echo $! > "$PIDF"
# Wait for the public API, then for the engine's lane roster (refreshed every
# 15 s) to include the Nemotron lane. route/preview plans without inferring.
TOKF="$R/state/proxy-token"
i=0
while [ $i -lt 90 ]; do
  if [ -s "$TOKF" ]; then
    out=$(curl -s -m 3 -H "Authorization: Bearer $(cat "$TOKF")" -H 'content-type: application/json' \
      http://127.0.0.1:8088/v1/meterless/route/preview \
      -d '{"model":"meterless/auto","messages":[{"role":"user","content":"ping"}]}' || true)
    case "$out" in
      *'"raced":["local-runtime/'*) echo "meterlessd up (pid $(cat "$PIDF")); :8088 ready, route -> $(printf '%s' "$out" | sed -n 's/.*"raced":\["\([^"]*\)".*/\1/p')"; exit 0;;
    esac
  fi
  i=$((i+1)); sleep 1
done
echo "timed out waiting for a routable lane on :8088; see $R/log/" >&2; exit 1
