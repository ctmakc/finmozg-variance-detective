/**
 * SAMPLE_MODE support. A recorded live run replays with no network: Zetaris results and model replies come from
 * recordings/, and H-MEM starts from the snapshot taken right before that input was recorded (so a warm-start run
 * replays warm). Snapshots are copied to a temp dir, so replays never change the recordings.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DetectiveMemory } from "./memory/hmem.js";

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
 * H-MEM ranks memories by recency, so a replay recalls the same memories only if "now" is the time of the
 * recording. Pin the clock to the newest ledger timestamp in the snapshot; an empty snapshot keeps the real clock.
 */
export function snapshotClock(dir: string): (() => number) | undefined {
  const ledger = join(dir, "ledger.jsonl");
  if (!existsSync(ledger)) return undefined;
  let latest = 0;
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = Number(JSON.parse(line).timestamp);
      if (Number.isFinite(t) && t > latest) latest = t;
    } catch {
      /* a torn last line must not break the replay */
    }
  }
  return latest > 0 ? () => latest : undefined;
}

/** H-MEM for a SAMPLE_MODE replay: the recorded snapshot, with the clock pinned to when it was taken. */
export function sampleMemory(question: string): DetectiveMemory {
  const dir = sampleMemoryDir(question);
  return new DetectiveMemory(dir, snapshotClock(dir));
}
