#!/usr/bin/env bash
# Runs the official Meterless conformance suites against our vendored engines.
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$R/docs/evidence"
HMEM_IMPL="$R/src/engines/hmem/index.ts" npx tsx "$R/conformance/hmem/runner.ts" | tee "$R/docs/evidence/conformance-hmem.txt" | tail -n 2
WORLD_MODEL_IMPL="$R/src/engines/world-model/index.ts" npx tsx "$R/conformance/world-model/runner.ts" | tee "$R/docs/evidence/conformance-world-model.txt" | tail -n 2
MARKOVIAN_IMPL="$R/src/engines/markovian/index.ts" npx tsx "$R/conformance/markovian/runner.ts" | tee "$R/docs/evidence/conformance-markovian.txt" | tail -n 2
