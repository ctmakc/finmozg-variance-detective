/** Checks the configured LLM provider end to end. Never prints tokens. Usage: npm run provider:check */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { Llm, providerFromEnv } from "../src/llm/index.js";
import { MeterlessProvider, autoDetect, meterlessSettingsFromEnv, probe, readToken } from "../src/llm/providers/meterless.js";

async function main() {
  const lines: string[] = [`provider check ${new Date().toISOString()}`];
  const log = (s: string) => {
    console.log(s);
    lines.push(s);
  };
  const provider = providerFromEnv();
  log(`provider: ${provider.name} (${provider.id})`);
  const st = await provider.status();
  log(`status: ${st.status} at ${st.baseUrl}; ${st.models.filter((m) => m.startsWith("meterless/")).length} meterless/* routes`);
  if (provider instanceof MeterlessProvider) {
    log(`routes: ${st.models.filter((m) => m.startsWith("meterless/")).join(", ")}`);
    const wrong = await probe(provider.baseUrl, "wrong-token-for-check");
    log(`wrong token → ${wrong.status} (${wrong.detail ?? ""})`);
    const s = meterlessSettingsFromEnv();
    const found = await autoDetect(readToken(s));
    log(`auto detect → ${found ? `${found.baseUrl} ${found.status}` : "nothing found"}`);
  }
  const llm = new Llm({ provider, mode: "live" });
  const plain = await llm.chat({ role: "deep", agent: "check", maxTokens: 1024, messages: [{ role: "user", content: "Reply with one sentence confirming this connection works, and name the model you are." }] });
  log(`plain text (${plain.latencyMs} ms, requested ${plain.requestedModel}, served by ${plain.servedBy}, receipt ${plain.receiptId ?? "-"}): ${plain.content.trim().slice(0, 200)}`);
  const tool = await llm.chat({
    role: "fast",
    agent: "check",
    maxTokens: 1024,
    messages: [{ role: "user", content: "How many vendor invoices were booked in September 2026? Use the tool." }],
    tools: [{ type: "function", function: { name: "run_sql", description: "Run one SQL statement against Zetaris and return rows", parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } } }],
  });
  log(`tool call (${tool.latencyMs} ms, served by ${tool.servedBy}): ${tool.toolCalls.map((t) => `${t.function.name}(${t.function.arguments})`).join("; ") || "none: " + tool.content.slice(0, 120)}`);
  mkdirSync("docs/evidence", { recursive: true });
  writeFileSync("docs/evidence/provider-check.txt", lines.join("\n") + "\n");
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
