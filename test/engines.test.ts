/** Pure pieces of the vendored engines: World Model ids and resolution, Markovian markers, carryover cascade, config math. */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CarryoverService, canonicalBlock } from "../src/engines/markovian/carryover.js";
import { DOC_DEFAULTS, modelTotals, projectionCurve, resolveConfig, runEfficiency } from "../src/engines/markovian/configManager.js";
import { HistoryService } from "../src/engines/markovian/history.js";
import { cleanMarkers, parseMarkers } from "../src/engines/markovian/markers.js";
import { ProgressService } from "../src/engines/markovian/progress.js";
import { ConfigValidationError, DEFAULT_CONFIG, type MarkovianRun } from "../src/engines/markovian/types.js";
import { decide, jaccard, levenshtein, nameSimilarity } from "../src/engines/world-model/resolve.js";
import { canonicalJson, contextIdFromAttrs, entityIdFromName, factId, normalizeName, relationshipId, sha256Hex } from "../src/engines/world-model/stableIds.js";

describe("World Model stable ids", () => {
  it("sha256Hex matches node:crypto across block boundaries and multi-byte text", () => {
    const inputs = ["", "abc", "é漢字🙂", ...[55, 56, 63, 64, 65, 119, 120, 128, 1000].map((n) => "x".repeat(n))];
    for (const s of inputs) expect(sha256Hex(s), `len ${s.length}`).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
  });

  it("canonicalJson sorts keys at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"z":1}]},"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("normalizeName folds accents, NBSP, zero-width chars and case, but never abbreviates", () => {
    expect(normalizeName("  José  García​ ")).toBe("jose garcia");
    expect(entityIdFromName("Vendor", "Sierra Nut Co.")).toBe(entityIdFromName("Vendor", "SIERRA  NUT CO."));
    expect(entityIdFromName("Vendor", "Acme Corp")).not.toBe(entityIdFromName("Vendor", "Acme Corporation"));
    expect(entityIdFromName("Vendor", "Acme")).not.toBe(entityIdFromName("Customer", "Acme"));
    expect(entityIdFromName("Vendor", "Acme")).toMatch(/^ent_[0-9a-f]{16}$/);
  });

  it("context, relationship and fact ids are deterministic and sensitive to every component", () => {
    expect(contextIdFromAttrs("week", { n: 14 }, "season:145")).not.toBe(contextIdFromAttrs("week", { n: 14 }, "season:144"));
    expect(contextIdFromAttrs("week", { a: 1, b: 2 })).toBe(contextIdFromAttrs("week", { b: 2, a: 1 }));
    expect(relationshipId("a", "R", "b")).toBe(relationshipId("a", "R", "b"));
    expect(relationshipId("a", "R", "b")).not.toBe(relationshipId("b", "R", "a"));
    expect(relationshipId("a", "R", "b", "c1")).not.toBe(relationshipId("a", "R", "b"));
    expect(factId("e", "amount", { v: 1 }, "t", "sql")).toBe(factId("e", "amount", { v: 1 }, "t", "sql"));
    expect(factId("e", "amount", 1, "t", "sql")).not.toBe(factId("e", "amount", "1", "t", "sql"));
  });
});

describe("World Model entity resolution", () => {
  it("levenshtein basics", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });

  it("similarity is computed on normalized names", () => {
    expect(nameSimilarity("Café Nord", "cafe  nord")).toBe(1);
    expect(nameSimilarity("", "")).toBe(1);
    expect(nameSimilarity("abcd", "abcx")).toBe(0.75);
  });

  it("band boundaries: 0.85 merges, 0.82 queues for review, below is new", () => {
    expect(decide(0.85)).toBe("auto-merge");
    expect(decide(0.8499)).toBe("review");
    expect(decide(0.82)).toBe("review");
    expect(decide(0.8199)).toBe("new");
    expect(decide(0.9, 0.95, 0.9)).toBe("review");
  });

  it("jaccard on entity sets, empty sets give 0", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
    expect(jaccard(["a", "a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard([], ["a"])).toBe(0);
  });
});

describe("Markovian marker protocol", () => {
  it("the last CARRYOVER block wins over a [STATE_CHECKPOINT] tail", () => {
    const p = parseMarkers("work <CARRYOVER>first</CARRYOVER> more <CARRYOVER> second </CARRYOVER>\n[STATE_CHECKPOINT] tail");
    expect(p.state).toBe("second");
  });

  it("state tails in canonical and compatible forms", () => {
    expect(parseMarkers("x\n[STATE_CHECKPOINT]\nCOMPLETED: a").state).toBe("COMPLETED: a");
    expect(parseMarkers("x @@@STATE@@@ s1").state).toBe("s1");
    expect(parseMarkers("x ---STATE--- s2").state).toBe("s2");
    expect(parseMarkers("x\n[STATE] s3").state).toBe("s3");
    expect(parseMarkers("plain text").state).toBeUndefined();
  });

  it("detects completion in every documented form", () => {
    for (const m of ["[TASK_COMPLETE]", "@@@FINAL@@@", "\n[FINAL]", "---FINAL---", "<DONE>", "<DONE/>"]) expect(parseMarkers(`answer ${m}`).done, m).toBe(true);
    expect(parseMarkers("answer [TASK_COMPLETE_NOT]").done).toBe(false);
    expect(parseMarkers("still going").done).toBe(false);
  });

  it("parses progress, tool requests with either quote style, and clarifications", () => {
    const p = parseMarkers(`<PROGRESS> 2/3 </PROGRESS>\n<NEEDS_TOOL tool="run_sql" input='SELECT "a"' />\n[NEEDS_CLARIFICATION] which month?\nrest`);
    expect(p.progress).toBe("2/3");
    expect(p.needsTool).toEqual({ tool: "run_sql", input: 'SELECT "a"' });
    expect(p.needsClarification).toBe("which month?");
    expect(parseMarkers('[NEEDS_TOOL tool="x" input=""]').needsTool).toEqual({ tool: "x", input: "" });
  });

  it("cleanMarkers strips every marker form but keeps the prose", () => {
    const raw = "Findings: A and B.\n<PROGRESS>p</PROGRESS>\n\n\n\nMore text.   \n<CARRYOVER>s</CARRYOVER>\n[TASK_COMPLETE]\n[STATE_CHECKPOINT]\nCOMPLETED: x";
    expect(cleanMarkers(raw)).toBe("Findings: A and B.\n\nMore text.");
    // a bare [STATE] inside a sentence is prose, not a marker line
    expect(cleanMarkers("We keep [STATE] here.")).toBe("We keep [STATE] here.");
  });
});

describe("Markovian carryover cascade", () => {
  const cfg = { ...DEFAULT_CONFIG, carryoverTokens: 128 };
  const longState = "COMPLETED: batches 1-2; REMAINING: batch 3";

  it("level 1: a marker state of ≥24 chars within budget is used as is (marker noise stripped)", async () => {
    const r = await new CarryoverService().next({ markerState: `${longState} @@@`, previousCarryover: "", chunkText: "", config: cfg });
    expect(r).toEqual({ carryover: longState, level: "marker" });
  });

  it("level 2: a short marker falls through to the LLM compressor, which sees the previous state", async () => {
    let seen = "";
    const svc = new CarryoverService(async (prompt) => ((seen = prompt), canonicalBlock({ completed: "a", remaining: "b", decisions: "c", context: "d" })));
    const r = await svc.next({ markerState: "too short", previousCarryover: "PREV", chunkText: "chunk", config: cfg });
    expect(r.level).toBe("llm");
    expect(r.carryover).toBe("COMPLETED: a\nREMAINING: b\nDECISIONS: c\nCONTEXT: d");
    expect(seen).toContain("Previous state:\nPREV");
  });

  it("level 3: compressor failure falls back to key phrases (max 5)", async () => {
    const svc = new CarryoverService(async () => {
      throw new Error("model down");
    });
    const text = "Intro. Decision: use the bridge. Next: check AP. Status: two batches left. Noise here.";
    const r = await svc.next({ markerState: undefined, previousCarryover: "", chunkText: text, config: cfg });
    expect(r.level).toBe("heuristic");
    expect(r.carryover).toBe("Decision: use the bridge; Next: check AP; Status: two batches left");
  });

  it("level 4: no phrases → tail words truncated to the token budget", async () => {
    const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const r = await new CarryoverService().next({ markerState: undefined, previousCarryover: "", chunkText: words, config: cfg });
    expect(r.level).toBe("truncation");
    expect(Math.ceil(r.carryover.length / 4)).toBeLessThanOrEqual(128);
    expect(r.carryover.endsWith("w399")).toBe(true);
    // empty chunk keeps the previous carryover
    const kept = await new CarryoverService().next({ markerState: undefined, previousCarryover: "old state words", chunkText: "", config: cfg });
    expect(kept.carryover).toBe("old state words");
  });
});

describe("Markovian config and efficiency math", () => {
  it("defaults are valid; out-of-bounds, NaN and too-small chunks throw ConfigValidationError", () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
    expect(() => resolveConfig({ maxChunks: 0 })).toThrow(ConfigValidationError);
    expect(() => resolveConfig({ chunkSize: Number.NaN })).toThrow(/must be a number/);
    expect(() => resolveConfig({ chunkSize: 2000, carryoverTokens: 800 })).toThrow(/chunkSize=2000 </);
    expect(resolveConfig({ chunkSize: 2400, carryoverTokens: 800 }).chunkSize).toBe(2400); // 400 + 800 + 1200 exactly
  });

  it("modelTotals reproduces the documented 86% example at N=20", () => {
    const t = modelTotals(20, DOC_DEFAULTS);
    expect(t.naiveTotal).toBe(20 * 900 + (1200 * 20 * 19) / 2);
    expect(t.markovianTotal).toBe(20 * 1700);
    expect(Math.round(t.efficiency * 100)).toBe(86);
  });

  it("runEfficiency: standard cost is the growing prefix; savings never negative", () => {
    const chunks = [1, 2, 3].map((id) => ({ id, tokens: 1000 }) as never);
    const e = runEfficiency(chunks, { ...DEFAULT_CONFIG, carryoverTokens: 200 });
    expect(e.standardCost).toBe(1000 + 2000 + 3000);
    expect(e.markovianCost).toBe(3 * 200 + 3000);
    expect(e.tokensSaved).toBe(2400);
    expect(runEfficiency([{ id: 1, tokens: 10 } as never], DEFAULT_CONFIG).tokensSaved).toBe(0);
    expect(runEfficiency([], DEFAULT_CONFIG).efficiencyPercent).toBe(0);
  });

  it("projectionCurve: standard grows linearly, markovian stays flat", () => {
    const c = projectionCurve(DEFAULT_CONFIG, 3);
    expect(c.map((x) => x.standard)).toEqual([8000, 16000, 24000]);
    expect(new Set(c.map((x) => x.markovian))).toEqual(new Set([8800]));
  });
});

describe("Markovian progress and history services", () => {
  it("progress keeps the last 15 log lines, notifies subscribers and stops after unsubscribe", () => {
    let t = 0;
    const p = new ProgressService(() => ++t, 4);
    const seen: number[] = [];
    const off = p.subscribe((s) => seen.push(s.logs.length));
    for (let i = 0; i < 20; i++) p.update({}, `l${i}`);
    expect(p.get().logs).toHaveLength(15);
    expect(p.get().logs[0]).toBe("l5");
    off();
    p.phase("complete");
    expect(seen).toHaveLength(20);
    expect(p.get()).toMatchObject({ phase: "complete", isActive: false });
    p.phase("generating", "chunk 2");
    expect(p.get().isActive).toBe(true);
    expect(p.get().logs.at(-1)).toBe("phase: generating chunk 2");
  });

  it("get() returns a copy that callers cannot mutate", () => {
    const p = new ProgressService(() => 0, 1);
    p.get().logs.push("x");
    expect(p.get().logs).toEqual([]);
  });

  it("history persists runs, requires a chunkConfig snapshot and recomputes efficiency per run", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-hist-"));
    const h = new HistoryService(dir);
    const run = (id: string, carry: number): MarkovianRun =>
      ({ id, timestamp: 5, status: "completed", chunkConfig: { ...DEFAULT_CONFIG, carryoverTokens: carry }, chunks: [{ id: 1, tokens: 1000 }, { id: 2, tokens: 1000 }] }) as never;
    h.record(run("a", 128));
    h.record(run("b", 900));
    expect(() => h.record({ ...run("c", 1), chunkConfig: undefined } as never)).toThrow(/chunkConfig snapshot/);
    const again = new HistoryService(dir);
    expect(again.list().map((r) => r.id)).toEqual(["a", "b"]);
    const st = again.cumulativeStats();
    expect(st.totalRuns).toBe(2);
    expect(st.efficiencyHistory.map((e) => e.tokensSaved)).toEqual([3000 - 2256, 0]);
    expect(again.performanceByStep()).toEqual([{ step: 1, avgTokens: 1000, samples: 2 }, { step: 2, avgTokens: 1000, samples: 2 }]);
    again.delete("a");
    expect(new HistoryService(dir).list().map((r) => r.id)).toEqual(["b"]);
  });
});
