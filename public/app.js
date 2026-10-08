'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = { id: null, busy: false, cfg: null };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // always textContent: model output is never parsed as HTML
    return n;
  }
  function show(node, on) { node.hidden = !on; }
  function banner(node, msg) { node.textContent = msg || ''; show(node, !!msg); }
  function safeUrl(u) { try { var x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } }

  async function api(path, body) {
    var res, data;
    try {
      res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw new Error('Could not reach the server. Check your connection and try again.'); }
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.message) || 'Something went wrong. Try again.');
    return data;
  }

  function skeletonPanel(m, cls) {
    var p = el('article', 'panel ' + cls);
    p.appendChild(el('h3', null, m.name));
    p.appendChild(el('p', 'pmeta', m.id + ' · waiting for answer'));
    ['w1', 'w2', 'w3', 'w4'].forEach(function (w) { p.appendChild(el('div', 'sk ' + w)); });
    return p;
  }
  function renderResult(r, cls) {
    var p = el('article', 'panel ' + cls);
    p.appendChild(el('h3', null, r.name));
    p.appendChild(el('p', 'pmeta', r.model));
    if (r.ok) {
      p.appendChild(el('p', 'answer', r.answer));
      p.appendChild(el('div', 'stats', 'Answered in ' + (r.ms / 1000).toFixed(1) + ' s' + (r.tokens ? ' · ' + r.tokens + ' tokens' : '')));
    } else {
      p.appendChild(el('p', 'err', r.error || 'This model could not answer.'));
      p.appendChild(el('div', 'stats', 'The other model’s answer is unaffected.'));
    }
    return p;
  }

  function resetEvidence() {
    show($('verdicts'), false); $('verdicts').textContent = '';
    show($('check-caveat'), false); show($('check-loading'), false); banner($('check-error'), '');
  }

  async function ask(question) {
    var cfg = state.cfg;
    state.busy = true; state.id = null;
    $('go').disabled = true; $('go').textContent = 'Asking both models…';
    banner($('ask-error'), ''); resetEvidence();
    show($('check-row'), false); show($('empty-evidence'), true);
    show($('empty-answers'), false);
    var panels = $('panels'); panels.textContent = '';
    cfg.models.forEach(function (m, i) { panels.appendChild(skeletonPanel(m, i ? 'b' : 'a')); });
    show(panels, true);
    $('answers').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      var data = await api('/api/compare', { question: question, accessCode: $('code').value });
      state.id = data.id;
      panels.textContent = '';
      data.results.forEach(function (r, i) { panels.appendChild(renderResult(r, i ? 'b' : 'a')); });
      if (data.results.some(function (r) { return r.ok; })) {
        show($('empty-evidence'), false); show($('check-row'), true);
      }
    } catch (e) {
      show(panels, false); panels.textContent = '';
      show($('empty-answers'), true);
      banner($('ask-error'), e.message);
    } finally {
      state.busy = false; $('go').disabled = false; $('go').textContent = 'Ask both models';
    }
  }

  function renderVerdicts(data) {
    var box = $('verdicts'); box.textContent = '';
    var names = state.cfg.models.map(function (m) { return m.name; });
    var any = false;
    names.forEach(function (name) {
      var list = data.claims.filter(function (c) { return c.model === name; });
      var g = el('div', 'vgroup');
      g.appendChild(el('h3', null, name));
      var tally = el('div', 'tally');
      ['Supported', 'Contradicted', 'Unverified'].forEach(function (v) {
        var n = list.filter(function (c) { return c.verdict === v; }).length;
        tally.appendChild(el('span', 'badge v-' + v, n + ' ' + v));
      });
      g.appendChild(tally);
      if (!list.length) g.appendChild(el('p', 'fine', 'No checkable claims were found in this answer.'));
      list.forEach(function (c) {
        any = true;
        var card = el('div', 'claim v-' + c.verdict);
        card.appendChild(el('span', 'badge v-' + c.verdict, c.verdict));
        card.appendChild(el('p', 'ctext', c.claim));
        if (c.explanation) card.appendChild(el('p', 'why', c.explanation));
        var links = (c.sources || []).map(function (s) { return { t: s.title, u: safeUrl(s.url) }; }).filter(function (s) { return s.u; });
        if (links.length) {
          var ul = el('ul', 'sources');
          links.forEach(function (s) {
            var li = el('li'), a = el('a', null, s.t || s.u);
            a.href = s.u; a.target = '_blank'; a.rel = 'noopener noreferrer';
            li.appendChild(a); ul.appendChild(li);
          });
          card.appendChild(ul);
        } else {
          card.appendChild(el('p', 'nosrc', 'No verifiable source link.'));
        }
        g.appendChild(card);
      });
      box.appendChild(g);
    });
    if (data.note) box.appendChild(el('p', 'fine', 'Checker note: ' + data.note));
    box.appendChild(el('p', 'fine', 'Checker model: ' + data.checker + '. It saw the answers as “A” and “B”, without model names.'));
    show(box, true); show($('check-caveat'), true);
    if (!any) banner($('check-error'), 'The checker did not find specific claims to check. Try a more factual question.');
  }

  async function check() {
    if (!state.id || state.busy) return;
    state.busy = true; $('check').disabled = true;
    resetEvidence(); show($('check-loading'), true);
    try {
      renderVerdicts(await api('/api/check', { id: state.id, accessCode: $('code').value }));
    } catch (e) { banner($('check-error'), e.message); }
    finally { show($('check-loading'), false); $('check').disabled = false; $('check').textContent = 'Check key claims again'; state.busy = false; }
  }

  async function init() {
    var q = $('q');
    q.addEventListener('input', function () { $('count').textContent = q.value.length + ' / 300'; });
    document.querySelectorAll('.chip').forEach(function (b) {
      b.addEventListener('click', function () { q.value = b.dataset.q; q.dispatchEvent(new Event('input')); q.focus(); });
    });
    $('ask-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.busy) return;
      var v = q.value.replace(/\s+/g, ' ').trim();
      if (v.length < 3) { banner($('ask-error'), 'Type a question first (at least 3 characters).'); return; }
      ask(v);
    });
    $('check').addEventListener('click', check);
    try {
      var res = await fetch('/api/config'); var cfg = await res.json(); state.cfg = cfg;
      var s = cfg.settings;
      var line = 'Both models get the same prompt and settings: temperature ' + s.temperature + ', up to ' + s.max_tokens + ' tokens.';
      $('settings-line').textContent = line;
      $('how-settings').textContent = line + ' System instruction: “' + s.system + '”';
      show($('access-row'), cfg.accessCodeRequired);
      if (!cfg.configured) {
        var b = $('setup-banner'); b.className = 'banner info';
        banner(b, 'Setup needed: add your OpenRouter key to the .env file (OPENROUTER_API_KEY=...) and restart the server.');
        $('go').disabled = true;
      }
    } catch (e) {
      banner($('setup-banner'), 'Could not load the app settings. Reload the page.'); $('go').disabled = true;
    }
  }
  init();
})();
