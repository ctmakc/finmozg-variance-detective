// llama-server-compatible lane shim -> Ollama OpenAI-compat endpoint.
// Config via env (set by start.sh): OLLAMA_BASE (default http://127.0.0.1:11434),
// LANE_UPSTREAM_MODEL (default nemotron-3-super:cloud).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (...names) => { for (const n of names) { const i = argv.indexOf(n); if (i >= 0) return argv[i + 1]; } return undefined; };
const host = arg('--host') || '127.0.0.1';
const port = Number(arg('--port') || 8080);
const modelPath = arg('-m', '--model') || '';
const alias = arg('-a', '--alias') || path.basename(modelPath).replace(/\.gguf$/i, '') || 'lane';
const ctx = Number(arg('-c', '--ctx-size') || 32768);
const parallel = Number(arg('-np', '--parallel') || 1);
const OLLAMA = (process.env.OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/$/, '');
const UPSTREAM = process.env.LANE_UPSTREAM_MODEL || 'nemotron-3-super:cloud';
const logf = process.env.LANE_SHIM_LOG;
const log = (s) => { const line = `[${new Date().toISOString()}] [lane-shim ${alias}:${port}] ${s}\n`; if (logf) fs.appendFileSync(logf, line); else process.stderr.write(line); };
log(`argv: ${JSON.stringify(argv)}`);
log(`upstream: ${OLLAMA}/v1 model=${UPSTREAM}`);

const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
const modelsDoc = () => ({ object: 'list', data: [{ id: alias, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'ollama', meta: { upstream: UPSTREAM, n_ctx_train: ctx } }], models: [{ name: alias, model: alias }] });
const DROP = new Set(['cache_prompt', 'chat_template_kwargs', 'n_probs', 'slot_id', 'id_slot', 'n_predict', 'samplers', 'top_k', 'min_p', 'typical_p', 'repeat_penalty', 'mirostat', 'grammar', 'json_schema', 'reasoning_format']);

async function forward(req, res, pathname, body) {
  let payload = {};
  try { payload = body.length ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: { message: 'bad json' } }); }
  const requested = payload.model;
  // llama.cpp lanes take {chat_template_kwargs:{enable_thinking:false}} (the
  // jobs plane sends it on a thinking lane's retry); Ollama's equivalent is
  // reasoning_effort "none".
  const thinkingOff = payload.chat_template_kwargs && payload.chat_template_kwargs.enable_thinking === false;
  for (const k of DROP) delete payload[k];
  payload.model = UPSTREAM;
  if (thinkingOff) payload.reasoning_effort = 'none';
  const t0 = Date.now();
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  let up;
  try {
    up = await fetch(`${OLLAMA}/v1${pathname.replace(/^\/v1/, '')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal });
  } catch (e) { log(`upstream error: ${e.message}`); return json(res, 502, { error: { message: `ollama_unreachable: ${e.message}` } }); }
  res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
  let bytes = 0;
  if (payload.stream) {
    for await (const chunk of up.body) { bytes += chunk.length; res.write(chunk); }
    res.end();
  } else {
    const txt = await up.text(); bytes = txt.length;
    // keep the lane alias as the reported model so the fabric's bookkeeping matches
    let out = txt;
    try { const j = JSON.parse(txt); if (j && typeof j === 'object') { j.model = alias; j.upstream_model = UPSTREAM; out = JSON.stringify(j); } } catch {}
    res.end(out);
  }
  log(`${pathname} requested=${requested} -> ${UPSTREAM} status=${up.status} stream=${!!payload.stream} tools=${Array.isArray(payload.tools) ? payload.tools.length : 0}${thinkingOff ? ' thinking=off' : ''} ${Date.now() - t0}ms ${bytes}B`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && p === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) return json(res, 200, modelsDoc());
    if (req.method === 'GET' && p === '/props') return json(res, 200, { default_generation_settings: { n_ctx: ctx }, total_slots: parallel, model_path: modelPath, chat_template: '', build_info: 'ollama-lane-shim' });
    if (req.method === 'GET' && p === '/slots') return json(res, 200, Array.from({ length: parallel }, (_, i) => ({ id: i, n_ctx: ctx, is_processing: false })));
    if (req.method === 'GET' && p === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(''); }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions' || p === '/v1/completions' || p === '/v1/embeddings')) return forward(req, res, p.startsWith('/v1') ? p : '/v1' + p, body);
    log(`unhandled ${req.method} ${p}`);
    json(res, 404, { error: { message: `not supported by lane shim: ${req.method} ${p}` } });
  });
});
server.listen(port, host, () => log(`listening on ${host}:${port}`));
const stop = () => { log('stopping'); server.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
