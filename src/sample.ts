/**
 * SAMPLE_MODE support. A recorded live run replays with no network: Zetaris results and model replies come from
 * recordings/, and H-MEM starts from the snapshot taken right before that input was recorded (so a warm-start run
 * replays warm). Snapshots are copied to a temp dir, so replays never change the recordings.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const isSampleMode = () => process.env.SAMPLE_MODE === "true";

/** Input file basename whose question matches, e.g. "01-gm-drop-sep". */
export function inputNameForQuestion(question: string, dir = "input_examples"): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const q = JSON.parse(readFileSync(join(dir, f), "utf8")).question as string;
    if (q.trim().toLowerCase() === question.trim().toLowerCase()) return basename(f, ".json");
  }
  return undefined;
}

/** Fresh temp copy of the H-MEM snapshot recorded for this question (empty dir if none). */
export function sampleMemoryDir(question: string, recordings = process.env.RECORDINGS_DIR ?? "recordings"): string {
  const tmp = mkdtempSync(join(tmpdir(), "fm-hmem-"));
  const name = inputNameForQuestion(question);
  const snap = name ? join(recordings, "hmem", name) : "";
  if (snap && existsSync(snap)) cpSync(snap, tmp, { recursive: true });
  return tmp;
}

/**
 * H-MEM ranks memories with a recency decay on the clock. Replaying a snapshot against today's clock changes the
 * recall (and so the prompts, and so the recording keys) as the recording ages, and replays stop matching.
 * Pin the clock to one minute after the snapshot's last ledger entry. Undefined when there is no snapshot.
 */
export function sampleMemoryClock(question: string, recordings = process.env.RECORDINGS_DIR ?? "recordings"): (() => number) | undefined {
  const name = inputNameForQuestion(question);
  const ledger = name ? join(recordings, "hmem", name, "ledger.jsonl") : "";
  if (!ledger || !existsSync(ledger)) return undefined;
  let last = 0;
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const ts = Number(JSON.parse(line).timestamp);
    if (Number.isFinite(ts) && ts > last) last = ts;
  }
  if (!last) return undefined;
  const at = last + 60_000;
  return () => at;
}
