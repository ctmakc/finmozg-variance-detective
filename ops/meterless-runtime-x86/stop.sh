#!/bin/sh
# Stop meterlessd and everything it spawned (engine host, lane shims).
R=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PIDF="$R/run/meterlessd.pid"
[ -f "$PIDF" ] || { echo "not running (no pid file)"; exit 0; }
PID=$(cat "$PIDF")
if kill -0 "$PID" 2>/dev/null; then
  # started with setsid: the daemon leads its own process group
  kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID"
  i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
  kill -0 "$PID" 2>/dev/null && kill -KILL -- "-$PID" 2>/dev/null
  echo "stopped (pid $PID)"
else
  echo "stale pid $PID"
fi
rm -f "$PIDF"
