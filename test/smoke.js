'use strict';
// Offline smoke test: starts a fake OpenRouter, runs the real server against it, and checks behavior.
// Uses a fake key only. Run with: npm test
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const FAKE_KEY = 'test_key_not_real';
let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer ' + FAKE_KEY) { res.writeHead(401); return res.end('{}'); }
    const j = JSON.parse(b);
    if (j.model === 'google/gemini-2.5-flash' && /fail-gemini/.test(JSON.stringify(j.messages))) { res.writeHead(500); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (j.model === 'perplexity/sonar') {
      return res.end(JSON.stringify({
        citations: ['https://example.org/real'],
        choices: [{ message: { content: '```json\n' + JSON.stringify({ claims: [
          { answer: 'A', claim: 'Claim one', verdict: 'Supported', explanation: 'ok', sources: [{ title: 'Real', url: 'https://www.example.org/real/' }] },
          { answer: 'B', claim: 'Claim two', verdict: 'Contradicted', explanation: 'bad', sources: [{ title: 'Invented', url: 'https://made-up.example/x' }] },
          { answer: 'B', claim: 'Claim three', verdict: 'Unverified', explanation: 'unclear', sources: [] }], note: 'n' }) + '\n```' } }] }));
    }
    res.end(JSON.stringify({ choices: [{ message: { content: 'Answer from ' + j.model + ' t=' + j.temperature + ' max=' + j.max_tokens } }], usage: { total_tokens: 42 } }));
  });
});

const post = (port, p, body) => fetch(`http://localhost:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, j: await r.json() }));

mock.listen(0, async () => {
  const mp = mock.address().port, port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: port, OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: `http://localhost:${mp}`, COMPARE_LIMIT_PER_10MIN: '3', CHECK_LIMIT_PER_10MIN: '4' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  try {
    const home = await fetch(`http://localhost:${port}/`); const html = await home.text();
    ok(home.status === 200 && html.includes('Ask both models'), 'serves the page');
    ok(home.headers.get('content-security-policy'), 'sends security headers');
    ok((await fetch(`http://localhost:${port}/..%2fserver.js`)).status === 404, 'blocks path traversal');
    const cfg = await (await fetch(`http://localhost:${port}/api/config`)).json();
    ok(cfg.configured && cfg.models.length === 2 && !JSON.stringify(cfg).includes(FAKE_KEY), 'config OK and does not leak key');
    ok((await post(port, '/api/compare', { question: 'hi' })).s === 400, 'rejects too-short question');
    ok((await post(port, '/api/compare', { question: 'x'.repeat(301) })).s === 400, 'rejects too-long question');
    const c = await post(port, '/api/compare', { question: 'What is 2+2 please?' });
    ok(c.s === 200 && c.j.results.every((r) => r.ok && /t=0.3 max=400/.test(r.answer)), 'both models get identical settings');
    ok(c.j.results[0].model === 'openai/gpt-4o-mini' && c.j.results[1].model === 'google/gemini-2.5-flash', 'correct model IDs');
    const k = await post(port, '/api/check', { id: c.j.id });
    const cl = k.j.claims || [];
    ok(k.s === 200 && cl.length === 3, 'checker returns claims');
    ok(cl[0].verdict === 'Supported' && cl[0].sources.length === 1, 'keeps a genuinely retrieved source');
    ok(cl[1].verdict === 'Unverified' && cl[1].sources.length === 0, 'invented link dropped and verdict downgraded');
    ok(cl[0].model === 'OpenAI GPT-4o mini' && cl[1].model === 'Google Gemini 2.5 Flash', 'A/B mapped back to model names');
    ok((await post(port, '/api/check', { id: 'nope' })).s === 404, 'unknown result id rejected');
    const f = await post(port, '/api/compare', { question: 'fail-gemini please' });
    ok(f.s === 200 && f.j.results[0].ok && !f.j.results[1].ok, 'one model failing does not break the other');
    await post(port, '/api/compare', { question: 'another question' });
    const lim = await post(port, '/api/compare', { question: 'one more question' });
    ok(lim.s === 429, 'rate limit kicks in');
    const leaks = ['public', '.'].flatMap((d) => fs.readdirSync(path.join(__dirname, '..', d)).filter((n) => /\.(js|html|css)$/.test(n)).map((n) => path.join(__dirname, '..', d, n)));
    ok(!leaks.some((f) => fs.readFileSync(f, 'utf8').includes('sk-or-')), 'no key-like strings in source');
  } catch (e) { console.log('FAIL exception', e); failed++; }
  child.kill(); mock.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
});
