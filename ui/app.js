// FINMOZG Variance Detective — UI. No framework: the page is a working paper, rows are rows.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cad = (x, sign = true) => {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const v = Math.round(Number(x));
  const s = Math.abs(v).toLocaleString("en-CA");
  return v < 0 ? `−${s}` : sign && v > 0 ? `+${s}` : s;
};
const pp = (x) => (x === undefined || x === null ? "" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2)}`);
const cls = (x) => (Math.abs(x) < 0.5 ? "zero" : x < 0 ? "neg" : "pos");

const TICKS = {
  rows: '<svg class="tk" viewBox="0 0 24 24" aria-label="agreed to source rows"><title>agreed to source rows</title><path d="M4 13l5 5L20 6"/></svg>',
  cross: '<svg class="tk" viewBox="0 0 24 24" aria-label="confirmed in two systems"><title>confirmed in two systems</title><circle cx="12" cy="12" r="8"/><path d="M12 6v12M6 12h12"/></svg>',
  ties: '<svg class="tk" viewBox="0 0 24 24" aria-label="ties to the bridge"><title>ties to the bridge</title><path d="M17 5H7l6 7-6 7h10"/></svg>',
};
const SYSTEM_OF = (s) =>
  /vendor_payment|fm_bank/.test(s) ? "Bank" : /vendor_bill|purchase_line|fm_procure|vendor\b/.test(s) ? "AP" : /gl_balance|fm_erp/.test(s) ? "GL" : /sales_line|customer|product|fm_orders/.test(s) ? "Orders" : /fx_rate|fm_boc/.test(s) ? "BoC" : "";
const DRIVER_LABEL = { price: "Price", volume: "Volume", mix: "Mix", supplier_price: "Supplier price", fx: "FX", booking_error: "Booking error", packaging: "Packaging", other_cost: "Other cost", opex: "Opex", data_gap: "Data gap" };

let current = null; // RunOutput
let live = false; // true while following a run that started in this page
let evidenceById = new Map();

// ------------------------------------------------------------------ status
async function loadHealth() {
  try {
    const h = await (await fetch("/health")).json();
    setStatus("zetaris", h.zetaris.status, h.zetaris.status === "recorded" ? "recorded" : h.zetaris.status);
    const served = (h.llm.pinned?.deep || "").replace("local-runtime/", "");
    setStatus("llm", h.llm.status, h.llm.status === "online" ? `${h.llm.routes.length} routes · ${served}` : h.llm.status);
    setStatus("memory", h.memory.total ? "online" : "", `${h.memory.findings} findings · ${h.memory.rulings} rulings`);
    if (h.sampleMode) $("#run-hint").textContent = "Sample mode: replays recorded live runs. Pick one of the five example questions.";
  } catch {
    setStatus("zetaris", "offline", "server unreachable");
  }
}
function setStatus(k, state, text) {
  const li = $(`#status [data-k="${k}"]`);
  li.dataset.state = state || "";
  $(".val", li).textContent = text;
}

// ------------------------------------------------------------------ log
const AGENT_SHORT = (a) => a.replace("Investigator-", "Inv·").replace("Orchestrator", "Run");
function logLine(e) {
  const t = e.type;
  const q = (s, n = 110) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
  switch (t) {
    case "run_start": return { what: `run started · ${e.provider}`, kind: "" };
    case "recall": return { what: `H-MEM recalled ${e.memories.filter((m) => !m.tags.includes("schema-map")).length} memories`, kind: "" };
    case "schema_from_memory": return { what: `schema map from memory (${e.tables} tables) · discovery skipped`, kind: "is-ok" };
    case "schema_discovered": return { what: `mapped ${e.tables} USL tables via DESCRIBE`, kind: "" };
    case "plan": return { what: `plan: ${e.hypotheses.length} hypotheses · ${e.periodA} → ${e.periodB}`, kind: "" };
    case "coverage_added": return { what: `coverage check added: ${e.added.join(", ")}`, kind: "" };
    case "plan_fallback": return { what: "plan JSON invalid → default tree", kind: "is-err" };
    case "sql": return { what: e.evidenceId ? `${e.evidenceId} · ${e.rowCount} rows · ${q(e.purpose || e.sql, 80)}` : `${q(e.label, 40)} · ${e.rowCount} rows`, kind: "" };
    case "sql_error": return { what: `${e.evidenceId} SQL error → repairing: ${q(e.error, 70)}`, kind: "is-err" };
    case "llm_call": return { what: `${e.ok ? "" : "✗ "}${(e.servedBy || e.provider || "").replace("local-runtime/", "")} · ${(e.latencyMs / 1000).toFixed(1)}s${e.toolCalls ? ` · ${e.toolCalls} tool call` : ""}`, kind: "is-llm" };
    case "finding": return { what: `finding ${e.supported ? "" : "(not supported) "}${q(e.claim, 90)}`, kind: "" };
    case "bridge": return { what: `bridge ${e.gmPctA}% → ${e.gmPctB}% · ΔGM ${cad(e.deltaGm)}`, kind: "is-ok" };
    case "review_start": return { what: `Markovian review of ${e.rows} rows`, kind: "" };
    case "review": return { what: `Markovian · ${e.chunks} chunk(s) · ${e.verdict}`, kind: e.verdict === "contradicted" ? "is-veto" : "is-ok" };
    case "verdict": return { what: `${e.hypothesisId} ${e.verdict}: ${q(e.reason, 90)}`, kind: e.verdict === "accepted" ? "is-ok" : e.verdict === "rejected" ? "is-veto" : "is-back" };
    case "send_back": return { what: `sent ${e.hypothesisId} back: ${q(e.request, 90)}`, kind: "is-back" };
    case "memo_draft": case "memo_rewrite": return { what: `memo ${t === "memo_rewrite" ? "rewritten" : "drafted"} · ${e.issues.length ? e.issues.length + " reviewer issues" : "fact check passed"}`, kind: e.issues.length ? "is-back" : "is-ok" };
    case "memo_truncated": return { what: "memo truncated → retry with a bigger budget", kind: "is-back" };
    case "run_end": return { what: `done · ${(e.stats.durationMs / 1000).toFixed(0)}s · SQL ${e.stats.sqlCalls} · LLM ${e.stats.llmCalls}`, kind: "is-ok" };
    case "run_error": return { what: `stopped: ${q(e.error, 120)}`, kind: "is-err" };
    default: return { what: t, kind: "" };
  }
}
// ------------------------------------------------------------------ live case board
const BRIDGE_LABEL = { volume: "Volume", mix: "Customer / product mix", price: "Selling price", supplierPrice: "Supplier unit price", fx: "USD/CAD exchange rate", otherCost: "Other goods cost", bookingError: "Booking error (duplicate invoice)", packagingReal: "Packaging spend", residual: "Unexplained residual" };
function boardRow(id) { return document.querySelector(`#board .brow[data-h="${CSS.escape(id)}"]`); }
function setBoard(id, cls, text, live = false) {
  const row = boardRow(id);
  if (!row) return;
  row.className = `brow ${cls}`;
  $(".st", row).innerHTML = `${live ? '<span class="dotl"></span>' : ""}${esc(text)}`;
}
function liveUpdate(e) {
  const hid = (e.agent || "").startsWith("Investigator-") ? e.agent.slice("Investigator-".length) : e.hypothesisId;
  switch (e.type) {
    case "run_start":
      $("#board-block").hidden = false;
      $("#board").innerHTML = `<p class="empty">Recalling memory and mapping the semantic layer…</p>`;
      $("#board-sub").textContent = "live";
      break;
    case "plan":
      $("#board").innerHTML = e.hypotheses.map((h) => `<div class="brow" data-h="${esc(h.id)}"><span class="hid">${esc(h.id)}</span><span class="drv">${esc(DRIVER_LABEL[h.driverType] || h.driverType)}</span><span class="txt">${esc(h.text)}</span><span class="st"><span class="dotl"></span>queued</span></div>`).join("");
      $("#board-sub").textContent = `${e.hypotheses.length} hypotheses · ${e.periodA} → ${e.periodB}`;
      break;
    case "sql": if (hid) setBoard(hid, "", `${e.evidenceId} · ${e.rowCount} rows`, true); break;
    case "sql_error": if (hid) setBoard(hid, "is-back", `${e.evidenceId} SQL error → repairing`, true); break;
    case "finding": if (hid) setBoard(hid, "is-done", e.supported ? "finding filed → Skeptic" : "no support found → Skeptic", true); break;
    case "verdict":
      if (e.verdict === "accepted") setBoard(e.hypothesisId, "is-accepted", "✓ accepted");
      else if (e.verdict === "rejected") setBoard(e.hypothesisId, "is-rejected", "✗ struck out");
      else setBoard(e.hypothesisId, "is-back", e.sendBack ? "↩ sent back" : "measured, not traced", !!e.sendBack);
      break;
    case "send_back": setBoard(e.hypothesisId, "is-back", "↩ re-investigating", true); break;
    case "bridge": {
      const head = $("#headline");
      if (!head.querySelector(".headline__fig")) head.insertAdjacentHTML("beforeend", `<div class="headline__fig reveal"><span class="fig fig--from">${e.gmPctA.toFixed(2)}%</span><span class="fig__arrow">→</span><span class="fig">${e.gmPctB.toFixed(2)}%</span><span class="delta">${pp(e.gmPctB - e.gmPctA)} pp · GM ${cad(e.deltaGm)} CAD</span></div>`);
      $("#bridge-block").hidden = false;
      $("#bridge-periods").textContent = "computed by Quant, findings still under review";
      const max = Math.max(...e.components.map((c) => Math.abs(c.amountCad)), 1);
      $("#bridge-rows").innerHTML = e.components.filter((c) => c.key !== "residual" || Math.abs(c.amountCad) >= 0.5).map((c, i) => `<div class="lrow reveal" style="--d:${i * 0.05}s"><span class="label">${esc(BRIDGE_LABEL[c.key] || c.key)}</span><span class="num ${cls(c.amountCad)}">${cad(c.amountCad)}</span><span class="num"></span><span class="ticks"></span><span><span class="bar">${Math.abs(c.amountCad) >= 0.5 ? `<i class="${c.amountCad < 0 ? "neg" : "pos"}" style="width:${(Math.abs(c.amountCad) / max) * 50}%;--d:${0.2 + i * 0.06}s"></i>` : ""}</span></span></div>`).join("");
      break;
    }
    case "memo_draft": $("#board-sub").textContent = "Writer drafting the memo"; break;
  }
}

let llmSeen = 0;
function appendLog(e) {
  if (live) liveUpdate(e);
  const log = $("#log");
  if (e.type === "llm_call") llmSeen++;
  const { what, kind } = logLine(e);
  const li = document.createElement("li");
  li.className = kind;
  li.innerHTML = `<time>${esc(e.ts.slice(11, 19))}</time><span class="who">${esc(AGENT_SHORT(e.agent))}</span><span class="what">${esc(what)}</span>`;
  log.appendChild(li);
  if (log.children.length > 400) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
  $("#log-count").textContent = `${log.children.length} events · ${llmSeen} model calls`;
}

// ------------------------------------------------------------------ render run
function renderRun(r) {
  current = r;
  $("#board-block").hidden = true;
  evidenceById = new Map(r.evidence.map((e) => [e.id, e]));
  const h = r.headline || {};
  const head = $("#headline");
  const up = (h.deltaPp ?? 0) > 0;
  head.innerHTML = `
    <h1 id="res-h" class="headline__q reveal">${esc(r.question)}</h1>
    ${h.gmPctA !== undefined ? `<div class="headline__fig reveal" style="--d:.08s">
      <span class="fig fig--from">${h.gmPctA.toFixed(2)}%</span><span class="fig__arrow">→</span>
      <span class="fig">${h.gmPctB.toFixed(2)}%</span>
      <span class="delta ${up ? "up" : ""}">${pp(h.deltaPp)} pp · GM ${cad(h.deltaGm)} CAD</span></div>` : ""}
    <div class="headline__meta reveal" style="--d:.16s">
      <span>gross margin ${esc(r.periodA)} → ${esc(r.periodB)}</span>
      ${h.revenueA ? `<span>revenue <b>${cad(h.revenueA, false)} → ${cad(h.revenueB, false)}</b></span>` : ""}
      <span>run <b>${esc(r.runId)}</b></span>
      <span><b>${(r.stats.durationMs / 1000).toFixed(0)} s</b> · SQL <b>${r.stats.sqlCalls}</b> (${r.stats.sqlRepairs} repaired) · model calls <b>${r.stats.llmCalls}</b></span>
      <span>served by <b>${esc((r.stats.servedBy || []).join(", ").replace(/local-runtime\//g, "") || r.stats.provider)}</b> via ${esc(r.stats.provider)}</span>
      ${r.stats.warmStart ? `<span><b>warm start</b> from H-MEM</span>` : ""}
    </div>`;
  renderBridge(r);
  renderFindings(r);
  renderStruck(r);
  renderMemo(r);
  renderMemory(r);
}

function findingFor(r, driverType) {
  return r.findings.find((f) => f.driverType === driverType && f.verdict?.verdict === "accepted");
}

function ticksFor(f) {
  if (!f) return "";
  const ev = f.evidenceIds.map((id) => evidenceById.get(id)).filter((e) => e && e.rowCount > 0);
  const systems = new Set(ev.flatMap((e) => e.sources.map(SYSTEM_OF)).filter(Boolean));
  const out = [];
  if (ev.length) out.push(TICKS.rows);
  if (systems.size >= 2) out.push(TICKS.cross);
  if (/bridge/i.test(f.verdict?.reason || "")) out.push(TICKS.ties);
  return out.map((s, i) => s.replace("<svg", `<svg style="--d:${0.9 + i * 0.18}s"`)).join("");
}

function renderBridge(r) {
  const block = $("#bridge-block");
  if (!r.bridge?.length) { block.hidden = true; return; }
  block.hidden = false;
  $("#bridge-periods").textContent = `${r.periodA} → ${r.periodB} · CAD · pp of margin`;
  const max = Math.max(...r.bridge.map((c) => Math.abs(c.amountCad)), 1);
  const h = r.headline;
  const rows = [];
  rows.push(`<div class="lrow reveal" role="row"><span class="label">Gross margin ${esc(r.periodA)}<small>${h.gmPctA?.toFixed(2)}% of revenue</small></span><span class="num">${cad(h.gmA, false)}</span><span class="num zero"></span><span></span><span></span></div>`);
  r.bridge.forEach((c, i) => {
    if (c.key === "residual" && Math.abs(c.amountCad) < 0.5) return;
    const f = findingFor(r, c.driverType);
    const w = (Math.abs(c.amountCad) / max) * 50;
    rows.push(`<div class="lrow reveal" role="row" style="--d:${0.1 + i * 0.05}s">
      <span class="label">${esc(c.label)}${f && f.entities.length ? `<small>${esc(f.entities.slice(0, 2).join(" · "))}</small>` : ""}</span>
      <span class="num ${cls(c.amountCad)}">${cad(c.amountCad)}</span>
      <span class="num ${cls(c.amountCad)}">${pp(c.ppOfRevenueB)}</span>
      <span class="ticks">${ticksFor(f)}</span>
      <span><span class="bar">${Math.abs(c.amountCad) >= 0.5 ? `<i class="${c.amountCad < 0 ? "neg" : "pos"}" style="width:${w}%;--d:${0.45 + i * 0.07}s"></i>` : ""}</span></span>
    </div>`);
  });
  const residual = r.bridge.find((c) => c.key === "residual");
  rows.push(`<div class="lrow lrow--sub reveal" role="row" style="--d:.6s"><span class="label">Unexplained residual</span><span class="num zero">${cad(residual?.amountCad ?? 0)}</span><span class="num zero">${pp(residual?.ppOfRevenueB ?? 0)}</span><span></span><span class="note" style="margin:0">shown openly, not hidden in other lines</span></div>`);
  rows.push(`<div class="lrow lrow--total reveal" role="row" style="--d:.7s"><span class="label">Gross margin ${esc(r.periodB)}<small>${h.gmPctB?.toFixed(2)}% of revenue</small></span><span class="num dbl" style="--d:1.35s">${cad(h.gmB, false)}</span><span class="num neg">${pp(h.deltaPp)}</span><span></span><span></span></div>`);
  $("#bridge-rows").innerHTML = rows.join("");
  const recon = r.evidence.find((e) => e.id === "Q-gl") ? "Bridge computed by Quant from finance_usl (Zetaris USL), deterministic, no model arithmetic. Revenue and goods COGS tie to the general ledger." : "";
  $("#recon").textContent = recon;
}

function renderFindings(r) {
  const accepted = r.findings.filter((f) => f.verdict?.verdict === "accepted" || f.verdict?.verdict === "needs_more");
  const block = $("#findings-block");
  block.hidden = !accepted.length;
  const order = (f) => -Math.abs(r.bridge.find((c) => c.driverType === f.driverType)?.amountCad ?? 0);
  $("#findings").innerHTML = accepted
    .sort((a, b) => order(a) - order(b))
    .map((f, i) => {
      const comp = r.bridge.find((c) => c.driverType === f.driverType);
      const open = f.verdict?.verdict === "needs_more";
      return `<div class="frow reveal" data-id="${esc(f.id)}" style="--d:${0.1 + i * 0.06}s">
        <div class="frow__main">
          <span class="drv">${esc(DRIVER_LABEL[f.driverType] || f.driverType)}</span>
          <button class="claim" type="button" aria-expanded="false">${esc(f.claim)}<small>${open ? "measured by the bridge, not traced to named rows · " : ""}${f.evidenceIds.length} evidence · ${esc(f.agent)} · round ${f.round}</small></button>
          <span class="num ${cls(comp?.amountCad ?? 0)}">${comp ? cad(comp.amountCad) : "—"}</span>
          <span class="ticks">${ticksFor(f)}</span>
          <span class="fb">${f.driverType === "data_gap" ? "" : `<button class="btn btn--ghost" data-fb="confirmed" type="button">Confirm</button><button class="btn btn--ghost is-red" data-fb="rejected" type="button">Reject</button>`}</span>
        </div>
        <div class="frow__ev"></div>
      </div>`;
    })
    .join("");
}

function evidenceHtml(e, focus) {
  const tpl = $("#evidence-tpl").content.cloneNode(true);
  const root = tpl.querySelector(".evi");
  if (focus) root.classList.add("is-focus");
  root.id = `ev-${e.id}`;
  const systems = [...new Set(e.sources.map(SYSTEM_OF).filter(Boolean))];
  root.querySelector(".evi__meta").innerHTML = `<b>${esc(e.id)}</b> · ${esc(e.agent)} · ${e.error ? `<span class="neg">error: ${esc(e.error.slice(0, 160))}</span>` : `${e.rowCount} rows`} · ${esc(e.sources.join(", "))}${systems.length ? ` · systems: ${esc(systems.join(" + "))}` : ""}${e.queryId ? ` · query ${esc(e.queryId.slice(0, 8))}` : ""}`;
  root.querySelector(".evi__sql").textContent = e.sql;
  if (e.headers?.length && e.rows?.length) {
    const head = `<tr>${e.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
    const body = e.rows.slice(0, 15).map((row) => `<tr class="${row.join(" ").includes("MRP-88213") ? "hit" : ""}">${row.map((c) => `<td>${esc(/^-?\d+\.\d{3,}$/.test(c) ? Number(c).toFixed(2) : c)}</td>`).join("")}</tr>`).join("");
    root.querySelector(".evi__table").innerHTML = `<table>${head}${body}</table>${e.rowCount > 15 ? `<p class="note">${e.rowCount - 15} more rows in the run log</p>` : ""}`;
  }
  return root;
}

function openFinding(row, focusId) {
  const f = current.findings.find((x) => x.id === row.dataset.id);
  const box = $(".frow__ev", row);
  if (!box.childElementCount) {
    const v = document.createElement("p");
    v.className = "verdict";
    v.innerHTML = `<b>Skeptic:</b> ${esc(f.verdict?.reason || "")}${f.review ? `<br><b>Markovian review:</b> ${esc(f.review.verdict)} in ${f.review.chunks} chunk(s) · ${esc(f.review.reasons.join("; "))}` : ""}`;
    box.appendChild(v);
    for (const id of f.evidenceIds) {
      const e = evidenceById.get(id);
      if (e) box.appendChild(evidenceHtml(e, id === focusId));
    }
    if (!f.evidenceIds.length) box.insertAdjacentHTML("beforeend", `<p class="empty">No row evidence cited.</p>`);
  }
  row.classList.add("open");
  $(".claim", row).setAttribute("aria-expanded", "true");
}

function renderStruck(r) {
  const struck = r.findings.filter((f) => f.verdict?.verdict === "rejected");
  $("#struck-block").hidden = !struck.length;
  $("#struck").innerHTML = struck
    .map((f, i) => {
      const hyp = r.plan.hypotheses.find((h) => h.id === f.hypothesisId);
      const text = hyp?.text || f.claim;
      return `<div class="srow reveal" style="--d:${0.1 + i * 0.08}s"><span class="drv">${esc(DRIVER_LABEL[f.driverType] || f.driverType)}</span>
        <div><span class="strike"><span class="hyp">${esc(text)}</span><svg viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M0 7 C 20 4, 40 9, 60 6 S 90 5, 100 6" style="--d:${0.5 + i * 0.15}s"/></svg></span>
        <span class="why">${esc(f.verdict.reason)}</span></div></div>`;
    })
    .join("");
}

function mdToHtml(md) {
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1<em>$2</em>")
      .replace(/\[((?:E|Q-)[\w-]+)\]/g, (_, id) => `<button type="button" class="cite" data-ev="${id}">${id}</button>`);
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (/^#{1,3}\s/.test(line)) html += `<h3>${inline(line.replace(/^#{1,3}\s/, ""))}</h3>`;
    else if (/^>\s?/.test(line)) html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

function renderMemo(r) {
  $("#memo-block").hidden = !r.memo;
  $("#memo").innerHTML = mdToHtml(r.memo || "");
}

async function renderMemory(r) {
  const block = $("#memory-block");
  const used = r.memoryUsed || [];
  let html = used.length
    ? used.map((m) => `<div class="mrow"><span class="mid">${esc(m.id)}</span><span>${esc(m.content)}</span><span class="rel">${m.relevance.toFixed(2)}</span></div>`).join("")
    : `<p class="empty">This run started cold: nothing in memory matched the question.</p>`;
  try {
    const mem = await (await fetch("/memory")).json();
    html += `<p class="note">H-MEM now holds ${mem.stats.total} memories: ${mem.stats.schemaMap} schema-map entries, ${mem.stats.findings} controller-confirmed or rejected findings, ${mem.stats.rulings} Skeptic rulings. Confirm or reject a finding above to teach the next close.</p>`;
  } catch {}
  block.hidden = false;
  $("#memory").innerHTML = html;
}

// ------------------------------------------------------------------ interactions
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("button");
  if (!t) return;
  if (t.closest("#examples")) { $("#q").value = t.textContent; $("#q").focus(); return; }
  if (t.classList.contains("claim")) {
    const row = t.closest(".frow");
    if (row.classList.contains("open")) { row.classList.remove("open"); t.setAttribute("aria-expanded", "false"); }
    else openFinding(row);
    return;
  }
  if (t.classList.contains("cite")) {
    const id = t.dataset.ev;
    const f = current.findings.find((x) => x.evidenceIds.includes(id));
    if (f) {
      const row = document.querySelector(`.frow[data-id="${CSS.escape(f.id)}"]`);
      if (row) { openFinding(row, id); document.getElementById(`ev-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    }
    const e = evidenceById.get(id);
    if (e) {
      const box = $("#bridge-block");
      box.querySelector(".evi")?.remove();
      box.appendChild(evidenceHtml(e, true));
      box.querySelector(".evi").scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return;
  }
  if (t.dataset.fb) {
    const row = t.closest(".frow");
    t.disabled = true;
    const res = await fetch("/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: current.runId, findingId: row.dataset.id, verdict: t.dataset.fb }) });
    const j = await res.json();
    t.closest(".fb").innerHTML = res.ok ? `<span class="fb-done">${t.dataset.fb === "confirmed" ? "✓ remembered" : "✗ remembered"} · ${esc(j.memoryId)}</span>` : `<span class="neg">${esc(j.error)}</span>`;
    loadHealth();
    renderMemory(current);
  }
});

$("#ask-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const question = $("#q").value.trim();
  if (!question) return;
  const btn = $("#run-btn");
  btn.disabled = true;
  $(".btn__label", btn).textContent = "Investigating…";
  $("#log").innerHTML = "";
  llmSeen = 0;
  const res = await fetch("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
  const j = await res.json();
  if (!res.ok) { $("#run-hint").textContent = j.error; btn.disabled = false; $(".btn__label", btn).textContent = "Investigate"; return; }
  history.replaceState(null, "", `?run=${j.runId}`);
  live = true;
  $("#headline").innerHTML = `<h1 id="res-h" class="headline__q">${esc(question)}</h1>`;
  ["#bridge-block", "#findings-block", "#struck-block", "#memo-block", "#memory-block"].forEach((s) => ($(s).hidden = true));
  follow(j.runId, () => { live = false; btn.disabled = false; $(".btn__label", btn).textContent = "Investigate"; });
});

function follow(runId, onDone) {
  const es = new EventSource(`/runs/${runId}/events`);
  es.onmessage = (m) => appendLog(JSON.parse(m.data));
  es.addEventListener("done", async () => {
    es.close();
    const r = await (await fetch(`/runs/${runId}`)).json();
    if (r.runId) renderRun(r);
    onDone?.();
    loadHealth();
  });
  es.onerror = () => { es.close(); onDone?.(); };
}

async function boot() {
  loadHealth();
  const want = new URLSearchParams(location.search).get("run");
  let runId = want;
  if (!runId) {
    try {
      const list = await (await fetch("/runs")).json();
      runId = list.live[0] || list.runs.find((r) => r.status === "completed")?.runId;
    } catch {}
  }
  if (!runId) { $("#log").innerHTML = `<li class="log-empty">No runs yet. Ask a question to start.</li>`; return; }
  follow(runId);
}
boot();
