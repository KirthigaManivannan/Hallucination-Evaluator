'use strict';
/**
 * AI Hallucination Demo server. Zero npm dependencies (Node 18+).
 * The OpenRouter key lives ONLY here, read from the environment / .env file.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Tiny .env loader (real environment variables win) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (_) { /* no .env file: fine, env vars may come from the host */ }

const env = process.env;
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const CONFIG = {
  port: num(env.PORT, 3000),
  apiKey: (env.OPENROUTER_API_KEY || '').trim(),
  baseUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  accessCode: (env.ACCESS_CODE || '').trim(),
  trustProxy: env.TRUST_PROXY === 'true',
  compareLimit: num(env.COMPARE_LIMIT_PER_10MIN, 6),
  checkLimit: num(env.CHECK_LIMIT_PER_10MIN, 6),
  dailyCap: num(env.DAILY_REQUEST_CAP, 300),
  checkerModel: env.CHECKER_MODEL || 'perplexity/sonar',
  maxQuestion: 300,
  timeoutMs: 45000,
};
const MODELS = [
  { id: 'openai/gpt-4o-mini', name: 'OpenAI GPT-4o mini', maker: 'OpenAI' },
  { id: 'google/gemini-2.5-flash', name: 'Google Gemini 2.5 Flash', maker: 'Google' },
];
// Identical for both models: same prompt, same settings.
const SETTINGS = {
  system: 'You are a helpful assistant. Answer the question directly and concisely, in under 150 words.',
  temperature: 0.3,
  max_tokens: 400,
};
const hasKey = () => CONFIG.apiKey && CONFIG.apiKey !== 'put_your_key_here';

// ---- Protections: per-IP rate limit, daily cap, short-lived result store ----
const hits = new Map();
function limited(ip, bucket, max) {
  const now = Date.now(), key = bucket + '|' + ip;
  const arr = (hits.get(key) || []).filter((t) => now - t < 600000);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
let day = '', dayCount = 0;
function dailyCapReached() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; }
  return dayCount >= CONFIG.dailyCap;
}
const store = new Map(); // id -> {question, results, t}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.t > 1800000) store.delete(k);
  for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k);
}, 60000).unref();

const clientIp = (req) =>
  (CONFIG.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

// ---- OpenRouter ----
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
function friendly(status) {
  if (status === 401 || status === 403) return 'The server’s OpenRouter key was rejected. Check the key in the server settings.';
  if (status === 402) return 'The OpenRouter account is out of credits.';
  if (status === 429) return 'The model is rate-limited right now. Wait a moment and try again.';
  if (status >= 500) return 'The model provider had a temporary problem. Try again.';
  return 'The model request failed. Try again.';
}
async function chat(body) {
  let res;
  try {
    res = await fetch(CONFIG.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + CONFIG.apiKey,
        'Content-Type': 'application/json',
        'X-Title': 'AI Hallucination Demo',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
  } catch (e) {
    throw new ApiError(e.name === 'TimeoutError' ? 'The model took too long to answer. Try again.' : 'Could not reach OpenRouter. Check the server’s internet connection.', 504);
  }
  if (!res.ok) { await res.text().catch(() => ''); throw new ApiError(friendly(res.status), res.status); }
  const data = await res.json().catch(() => null);
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!text) throw new ApiError('The model returned an empty answer. Try again.', 502);
  return { text, data, msg };
}

async function askModel(model, question) {
  const t0 = Date.now();
  try {
    const { text, data } = await chat({
      model: model.id,
      messages: [{ role: 'system', content: SETTINGS.system }, { role: 'user', content: question }],
      temperature: SETTINGS.temperature,
      max_tokens: SETTINGS.max_tokens,
    });
    const u = (data && data.usage) || {};
    return { model: model.id, name: model.name, ok: true, answer: text, ms: Date.now() - t0, tokens: u.total_tokens || null };
  } catch (e) {
    return { model: model.id, name: model.name, ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

// ---- Claim checker ----
const CHECK_SYSTEM = `You are a careful, skeptical fact-checker with web search. You will see a question and two anonymous answers, A and B.
For each answer, pick up to 4 key factual claims that can be checked (names, dates, numbers, events, quotations, citations, works).
For each claim choose exactly one verdict:
- "Supported": reliable sources you actually retrieved directly confirm it.
- "Contradicted": reliable sources you actually retrieved directly conflict with it.
- "Unverified": you could not find enough evidence either way, or the evidence is mixed.
Rules: never invent URLs; only cite pages you really retrieved; prefer primary or reputable sources; if unsure choose "Unverified"; keep each explanation to 1-2 plain sentences.
Respond with ONLY valid JSON, no markdown, in this shape:
{"claims":[{"answer":"A","claim":"...","verdict":"Supported","explanation":"...","sources":[{"title":"...","url":"https://..."}]}],"note":"one sentence on the main limits of this check"}`;

const normUrl = (u) => {
  try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, ''); } catch { return null; }
};
function collectUrls(data, msg) {
  const out = new Map();
  const add = (u, t) => { const n = normUrl(u); if (n && /^https?:/i.test(u)) out.set(n, { url: u, title: t || '' }); };
  for (const c of (data && data.citations) || []) typeof c === 'string' ? add(c) : c && add(c.url, c.title);
  for (const a of (msg && msg.annotations) || []) if (a && a.url_citation) add(a.url_citation.url, a.url_citation.title);
  return out;
}
function parseJson(text) {
  const s = text.replace(/```(?:json)?/gi, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('no json');
  return JSON.parse(s.slice(i, j + 1));
}
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

async function runCheck(entry) {
  const [a, b] = entry.results;
  const user = `Question: ${entry.question}\n\n=== Answer A ===\n${a.ok ? a.answer : '(no answer)'}\n\n=== Answer B ===\n${b.ok ? b.answer : '(no answer)'}`;
  const body = { model: CONFIG.checkerModel, temperature: 0, max_tokens: 2200, messages: [{ role: 'system', content: CHECK_SYSTEM }, { role: 'user', content: user }] };
  if (!/perplexity\//.test(CONFIG.checkerModel) && !/:online$/.test(CONFIG.checkerModel)) body.plugins = [{ id: 'web', max_results: 5 }];
  const { text, data, msg } = await chat(body);
  let parsed;
  try { parsed = parseJson(text); } catch { throw new ApiError('The checker returned something unreadable. Try again.', 502); }
  const allowed = collectUrls(data, msg);
  const claims = (Array.isArray(parsed.claims) ? parsed.claims : []).slice(0, 10).map((c) => {
    const idx = c.answer === 'B' ? 1 : 0;
    let verdict = ['Supported', 'Contradicted', 'Unverified'].includes(c.verdict) ? c.verdict : 'Unverified';
    // Only keep links the checker really retrieved (blocks invented URLs).
    const seen = new Set();
    const sources = (Array.isArray(c.sources) ? c.sources : []).map((s) => {
      const hit = s && allowed.get(normUrl(String(s.url || '')));
      return hit ? { url: hit.url, title: clip(s.title || hit.title || hit.url, 120) } : null;
    }).filter((s) => s && !seen.has(s.url) && seen.add(s.url)).slice(0, 3);
    let explanation = clip(c.explanation, 400);
    if (verdict !== 'Unverified' && !sources.length) {
      verdict = 'Unverified';
      explanation = (explanation + ' (Downgraded: no verifiable source link was returned.)').trim();
    }
    return { model: entry.results[idx].name, claim: clip(c.claim, 300), verdict, explanation, sources };
  }).filter((c) => c.claim);
  return { claims, note: clip(parsed.note, 300), checker: CONFIG.checkerModel };
}

// ---- HTTP helpers ----
const SEC = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};
function send(res, status, obj) {
  res.writeHead(status, { ...SEC, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJson(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new ApiError('Request too large.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new ApiError('Invalid request.', 400)); } });
    req.on('error', () => reject(new ApiError('Invalid request.', 400)));
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const PUB = path.join(__dirname, 'public');

function guard(req, res, body, bucket, max) {
  if (!hasKey()) { send(res, 503, { error: 'setup', message: 'The server has no OpenRouter key yet. Add OPENROUTER_API_KEY to the .env file and restart.' }); return false; }
  if (CONFIG.accessCode && !(typeof body.accessCode === 'string' && safeEq(body.accessCode, CONFIG.accessCode))) { send(res, 401, { error: 'access', message: 'Wrong or missing access code.' }); return false; }
  if (limited(clientIp(req), bucket, max)) { send(res, 429, { error: 'rate', message: 'Too many requests from your connection. Wait a few minutes and try again.' }); return false; }
  if (dailyCapReached()) { send(res, 429, { error: 'cap', message: 'This demo has reached its daily limit. Please try again tomorrow.' }); return false; }
  dayCount++;
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { configured: !!hasKey(), accessCodeRequired: !!CONFIG.accessCode, models: MODELS, settings: { temperature: SETTINGS.temperature, max_tokens: SETTINGS.max_tokens, system: SETTINGS.system }, maxQuestion: CONFIG.maxQuestion, checkerModel: CONFIG.checkerModel });
    }
    if (req.method === 'POST' && url.pathname === '/api/compare') {
      const body = await readJson(req);
      const question = typeof body.question === 'string' ? body.question.replace(/\s+/g, ' ').trim() : '';
      if (question.length < 3) return send(res, 400, { error: 'input', message: 'Type a question first (at least 3 characters).' });
      if (question.length > CONFIG.maxQuestion) return send(res, 400, { error: 'input', message: `Keep the question under ${CONFIG.maxQuestion} characters.` });
      if (!guard(req, res, body, 'compare', CONFIG.compareLimit)) return;
      const results = await Promise.all(MODELS.map((m) => askModel(m, question)));
      const id = crypto.randomBytes(12).toString('hex');
      if (store.size > 300) store.delete(store.keys().next().value);
      store.set(id, { question, results, t: Date.now() });
      return send(res, 200, { id, question, results });
    }
    if (req.method === 'POST' && url.pathname === '/api/check') {
      const body = await readJson(req);
      const entry = typeof body.id === 'string' ? store.get(body.id) : null;
      if (!entry) return send(res, 404, { error: 'gone', message: 'Those answers have expired. Ask the question again.' });
      if (!entry.results.some((r) => r.ok)) return send(res, 400, { error: 'input', message: 'There are no answers to check.' });
      if (!guard(req, res, body, 'check', CONFIG.checkLimit)) return;
      return send(res, 200, await runCheck(entry));
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.normalize(path.join(PUB, rel));
      if (file.startsWith(PUB + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { ...SEC, 'Cache-Control': 'no-cache', 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
      }
      res.writeHead(404, { ...SEC, 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    send(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status === 504 ? 504 : e.status || 500, { error: 'api', message: e.message });
    console.error('Unexpected error:', e && e.message);
    send(res, 500, { error: 'server', message: 'Something went wrong on the server.' });
  }
});
server.requestTimeout = 120000;
server.listen(CONFIG.port, () => {
  console.log(`\nAI Hallucination Demo running at http://localhost:${CONFIG.port}`);
  if (!hasKey()) console.log('WARNING: No API key found. Copy .env.example to .env and set OPENROUTER_API_KEY, then restart.');
  if (!CONFIG.accessCode) console.log('Tip: set ACCESS_CODE in .env before sharing a public URL.');
});
