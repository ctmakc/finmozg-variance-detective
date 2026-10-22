#!/usr/bin/env bash
# Records real live runs of the five sample inputs for SAMPLE_MODE replay (needs Zetaris + Meterless Runtime up).
# Flow: 01 cold → controller confirms the duplicate-invoice and supplier findings → 02..05 start warm from H-MEM.
set -euo pipefail
cd "$(dirname "$0")/.."
export ZETARIS_RECORD=true LLM_RECORD=true QUIET=true HMEM_DIR=.hmem-record
rm -rf recordings "$HMEM_DIR"
mkdir -p recordings/hmem recordings/runs "$HMEM_DIR"
for f in input_examples/0*.json; do
  name=$(basename "$f" .json)
  mkdir -p "recordings/hmem/$name" && cp -r "$HMEM_DIR"/. "recordings/hmem/$name"/
  echo "== recording $name"
  npm run -s agent -- --input "$f" --out "recordings/runs/$name.json" > "recordings/runs/$name.memo.md"
  if [ "$name" = "01-gm-drop-sep" ]; then
    run=$(node -e "console.log(require('./recordings/runs/$name.json').runId)")
    for dt in booking_error supplier_price; do
      fid=$(node -e "const r=require('./recordings/runs/$name.json');const f=r.findings.find(x=>x.driverType==='$dt'&&x.verdict&&x.verdict.verdict==='accepted');console.log(f?f.id:'')")
      [ -n "$fid" ] && npm run -s feedback -- --run "$run" --finding "$fid" --verdict confirmed --note "controller checked the source documents" > /dev/null && echo "   feedback: $fid confirmed"
    done
  fi
done
cp -r "$HMEM_DIR" recordings/hmem-final
echo "recorded: $(ls recordings/zetaris | wc -l) Zetaris results, $(ls recordings/llm | wc -l) model replies"
