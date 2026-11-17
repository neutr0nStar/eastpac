import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

/* ============================== utilities ============================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => (window.DOMPurify ? DOMPurify.sanitize(marked.parse(s || '')) : marked.parse(s || ''));
const fmtCost = (c) => (!c ? '$0.00' : c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(c < 1 ? 3 : 2));
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const hl = (code, lang) => { try { return hljs.highlight(code || '', { language: lang }).value; } catch { return esc(code); } };
const timeOf = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const groupBy = (arr, f) => arr.reduce((m, x) => ((m[f(x)] ||= []).push(x), m), {});

async function api(path, opts = {}) {
  const r = await fetch(path, opts.body && !(opts.body instanceof FormData)
    ? { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `Request failed (${r.status})`);
  return data;
}
function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/* ============================== state ============================== */
const S = {
  config: null, runs: [], run: null, route: { name: 'home' },
  ui: { tab: 'overview', module: null, editing: {}, codeTask: null, caseFilter: 'all' },
  lastKey: '',
};
const STEPS = [
  { id: 'discover', label: 'Discover' }, { id: 'design', label: 'Design' }, { id: 'build', label: 'Build' },
  { id: 'verify', label: 'Verify' }, { id: 'cost', label: 'Cost report' },
];
const TIER_COLOR = (t) => `var(--t${t ?? 0})`;
const model = (id) => S.config?.models[id] || { label: id, tier: 0, vendor: '' };
const persona = (id) => S.config?.personas.find((p) => p.id === id);
const statusClass = (s) => ({ running: 'running', review: 'review', approved: 'ok', done: 'ok', error: 'error' }[s] || '');

/* ============================== routing ============================== */
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'run' && parts[1]) { if (parts[3]) S.ui.tab = parts[3]; return { name: 'run', id: parts[1], step: parts[2] || 'discover' }; }
  if (parts[0] === 'forge') { if (parts[1]) S.ui.forgeEdit = decodeURIComponent(parts[1]); return { name: 'forge' }; }
  return { name: 'home' };
}
const go = (hash) => { location.hash = hash; };

window.addEventListener('hashchange', async () => {
  S.route = parseRoute();
  S.ui.codeTask = null;
  if (S.route.name === 'run') await loadRun(S.route.id);
  else if (S.route.name === 'home') S.runs = await api('/api/runs').catch(() => []);
  render(true);
});

async function loadRun(id) {
  try { S.run = await api(`/api/runs/${id}`); } catch (e) { toast(e.message, true); go('#/'); }
}

/* ============================== chrome ============================== */
function renderNav() {
  const r = S.route;
  let h = `
    <a class="nav-item ${r.name === 'home' ? 'active' : ''}" href="#/"><span class="num">⌂</span>Home</a>
    <a class="nav-item ${r.name === 'forge' ? 'active' : ''}" href="#/forge"><span class="num">⚒</span>AgentForge</a>`;
  if (S.run) {
    h += `<div class="nav-label">Migration</div>
      <div class="nav-item" style="pointer-events:none"><span class="run-name"><b>${esc(S.run.name)}</b></span></div>`;
    STEPS.forEach((s, i) => {
      const st = s.id === 'cost' ? (S.run.ledger.length ? 'done' : '') : S.run.stages[s.id].status;
      const cls = statusClass(st);
      h += `<a class="nav-item ${r.name === 'run' && r.step === s.id ? 'active' : ''}" href="#/run/${S.run.id}/${s.id}">
        <span class="num ${cls}">${cls === 'ok' ? '✓' : i + 1}</span>${s.label}</a>`;
    });
  }
  $('#nav').innerHTML = h;
  const c = S.config;
  $('#sidefoot').innerHTML = c ? `
    <div class="status-line"><span class="dot ${c.has_key ? 'ok' : 'bad'}"></span>OpenRouter ${c.has_key ? 'connected' : 'key missing'}</div>
    <div class="status-line"><span class="dot ${c.cache ? 'ok' : ''}"></span>Replay cache ${c.cache ? 'on' : 'off'}</div>
    <button class="btn ghost sm" data-action="theme" style="margin-top:6px;justify-content:flex-start;padding-left:0">◐ Toggle theme</button>` : '';
}

function ledgerTotals(ledger) {
  const cost = sum(ledger, (e) => e.cost);
  const base = sum(ledger, (e) => e.baseline_cost);
  return {
    cost, base, calls: ledger.length,
    tin: sum(ledger, (e) => e.tokens_in), tout: sum(ledger, (e) => e.tokens_out),
    saved: base > 0 ? Math.max(0, 1 - cost / base) : 0,
    esc: ledger.filter((e) => e.escalated).length,
  };
}

function renderTopbar() {
  const r = S.route;
  let crumbs = '<b>Eastpac UNITE</b>';
  if (r.name === 'forge') crumbs = 'Eastpac UNITE / <b>AgentForge</b>';
  if (r.name === 'run' && S.run) crumbs = `Migrations / <b>${esc(S.run.name)}</b> / ${STEPS.find((s) => s.id === r.step)?.label || ''}`;
  $('#crumbs').innerHTML = crumbs;
  if (r.name === 'run' && S.run) {
    const t = ledgerTotals(S.run.ledger);
    $('#meter').innerHTML = `
      <span class="hide-sm">calls <span class="v">${t.calls}</span></span>
      <span>tokens <span class="v">${fmtTok(t.tin + t.tout)}</span></span>
      <span class="cost">spent <span class="v">${fmtCost(t.cost)}</span></span>
      <span class="hide-sm">saved <span class="v" style="color:var(--ok)">${Math.round(t.saved * 100)}%</span></span>`;
  } else $('#meter').innerHTML = '';
}

const GLYPH = { Cartographer: '◎', Scribe: '✎', Draftsman: '◇', Architect: '△', Builder: '▣', Verifier: '✓', Orchestrator: '◈', Human: '☺' };
let feedSig = '';
function renderFeed() {
  const evs = S.run?.events || [];
  const running = S.run && Object.values(S.run.stages).some((s) => s.status === 'running');
  $('#live-dot').className = 'live-dot' + (running ? ' on' : '');
  const sig = evs.length + ':' + (evs.at(-1)?.ts || 0) + ':' + (S.run?.id || '');
  if (sig === feedSig) return;
  feedSig = sig;
  $('#feed').innerHTML = evs.length ? evs.slice().reverse().map((e) => `
    <div class="ev ${e.level}">
      <div class="g">${GLYPH[e.agent] || '•'}</div>
      <div><div class="who">${esc(e.agent)}<time>${timeOf(e.ts)}</time></div><div class="msg">${esc(e.msg)}</div></div>
    </div>`).join('') : `<div class="muted" style="padding:14px;font-size:13px">Agent events stream here as they happen: every call, route decision and escalation.</div>`;
}

/* ============================== render loop ============================== */
function viewKey() {
  const r = S.route, run = S.run;
  if (r.name !== 'run' || !run) return r.name + JSON.stringify(S.ui);
  const st = Object.values(run.stages).map((s) => s.status).join();
  const k = { discover: [Object.keys(run.docs).length, run.diagrams.length, !!run.overview],
    design: [run.tasks.length], build: [JSON.stringify(Object.values(run.build).map((b) => [b.status, b.model])), run.ledger.length],
    verify: [run.verify?.passed, run.verify?.total, run.verify?.round, Object.keys(run.verify?.modules || {}).length, run.ledger.length],
    cost: [run.ledger.length] }[r.step] || [];
  return [r.step, run.id, st, ...k, JSON.stringify(S.ui)].join('|');
}

function isEditing() {
  const a = document.activeElement;
  return a && $('#view').contains(a) && /TEXTAREA|INPUT|SELECT/.test(a.tagName);
}

function render(force = false) {
  renderNav();
  renderTopbar();
  renderFeed();
  const key = viewKey();
  if (!force && (key === S.lastKey || isEditing())) return;
  S.lastKey = key;
  const scroll = $('#view').scrollTop;
  const r = S.route;
  let html = '';
  if (r.name === 'home') html = viewHome();
  else if (r.name === 'forge') html = viewForge();
  else if (r.name === 'run' && S.run) html = ({ discover: viewDiscover, design: viewDesign, build: viewBuild, verify: viewVerify, cost: viewCost }[r.step] || viewDiscover)(S.run);
  $('#view').innerHTML = `<div class="view-inner">${html}</div>`;
  if (!force) $('#view').scrollTop = scroll;
  drawMermaid();
}

let mermaidN = 0;
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
async function drawMermaid() {
  const els = [...document.querySelectorAll('[data-mermaid]')];
  if (!els.length) return;
  mermaid.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'neutral', securityLevel: 'strict', fontFamily: 'Inter, sans-serif',
    themeVariables: { fontSize: '13px' } });
  for (const el of els) {
    const d = S.run?.diagrams.find((x) => x.id === el.dataset.mermaid);
    if (!d) continue;
    const id = 'mmd' + ++mermaidN;
    try {
      const { svg } = await mermaid.render(id, d.code);
      el.innerHTML = svg;
    } catch (e) {
      document.getElementById('d' + id)?.remove();
      el.innerHTML = `<div class="diagram-err">Diagram has a syntax error. Edit the source to fix it.\n\n${esc(String(e.message || e).slice(0, 400))}</div>`;
    }
  }
}

async function pollLive() {
  try { S.live = await api('/api/live'); } catch { return; }
  renderLive();
}

function renderLive() {
  const calls = S.live?.calls || [];
  const n = calls.length;
  const thinking = calls.filter((c) => c.state !== 'queued').length;
  $('#live-pill').className = 'live-pill' + (n ? ' on' : '');
  $('#live-pill').innerHTML = n
    ? `<span class="pdot"></span><b>${n}</b> agent${n === 1 ? '' : 's'} working${n > thinking ? ` <span class="faint">· ${n - thinking} queued</span>` : ''}`
    : `<span class="pdot"></span>Agents idle`;
  const byAgent = groupBy(calls, (c) => c.agent);
  const curRun = S.run?.id;
  const w = $('#working');
  if (!n) {
    if (!w.querySelector('.working-idle')) w.innerHTML = `<div class="working-idle"><span class="pdot"></span>No agents working right now</div>`;
    return;
  }
  // Patch the panel in place instead of replacing it on every poll: replacing restarts every
  // spinner and fade-in, and resets the list's scroll position.
  if (!w.querySelector('.working-list')) w.innerHTML = `<div class="working-head"></div><div class="working-agents"></div><div class="working-list"></div>`;
  w.querySelector('.working-head').innerHTML = `<span>Working now</span><span class="chip accent">${n}</span><span class="spacer"></span>
    <span class="faint" style="font-size:11px">max ${S.live.max_parallel} in parallel</span>`;
  w.querySelector('.working-agents').innerHTML = Object.entries(byAgent).map(([a, cs]) => `<span class="chip">${GLYPH[a] || '◆'} ${esc(a)} ×${cs.length}</span>`).join('');
  const list = w.querySelector('.working-list');
  const keep = new Set();
  calls.forEach((c, i) => {
    keep.add(c.id);
    const other = c.run_id && c.run_id !== curRun ? ` · ${c.run_name}` : '';
    const sig = [c.state, c.attempt, c.task, other, c.label, c.tier].join('|');
    let el = [...list.children].find((x) => x.dataset.id === c.id);
    if (!el || el.dataset.sig !== sig) {
      const fresh = document.createElement('div');
      fresh.className = `wk ${c.state}`;
      fresh.dataset.id = c.id;
      fresh.dataset.sig = sig;
      fresh.innerHTML = `
        <div class="g">${c.state === 'queued' ? '⏳' : '<div class="spinner"></div>'}</div>
        <div class="wk-body">
          <div class="wk-top"><b>${esc(c.agent)}</b><span class="faint wk-state">${esc(c.state)}${c.attempt ? ` · retry ${c.attempt}` : ''}</span>
            <span class="mono wk-time"></span></div>
          <div class="mono faint wk-task">${esc(c.task + other)}</div>
          <span class="chip t${c.tier} wk-model" title="${esc(c.label)}">${esc(c.label)}</span>
        </div>`;
      if (el) { fresh.style.animation = 'none'; el.replaceWith(fresh); }
      el = fresh;
    }
    el.querySelector('.wk-time').textContent = fmtElapsed(c.elapsed);
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  [...list.children].forEach((x) => { if (!keep.has(x.dataset.id)) x.remove(); });
}
const fmtElapsed = (s) => (s < 60 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`);

async function poll() {
  pollLive();
  if (S.route.name === 'run' && S.route.id) {
    try {
      S.run = await api(`/api/runs/${S.route.id}`);
      render();
    } catch { /* transient */ }
  }
}

/* ============================== shared bits ============================== */
const stageHead = (eyebrow, title, desc, right = '') => `
  <div class="stage-head"><div><div class="eyebrow">${eyebrow}</div><h1 class="serif">${title}</h1><p>${desc}</p></div>
  <div class="spacer"></div><div class="row">${right}</div></div>`;

const tierChip = (t) => t ? `<span class="chip t${t}">T${t} · ${S.config.tier_names[t]}</span>` : `<span class="chip t0">Static · no LLM</span>`;

function agentTile(pid, extra = '') {
  const p = persona(pid);
  if (!p) return '';
  const tiers = p.llm ? (p.min_tier === p.max_tier ? tierChip(p.min_tier) : `${tierChip(p.min_tier)}<span class="faint">→</span>${tierChip(p.max_tier)}`) : tierChip(0);
  return `<div class="card agent-tile"><div class="agent-glyph">${esc(p.glyph)}</div><div style="flex:1;min-width:0">
    <h4>${esc(p.name)}</h4><div class="row wrap" style="gap:4px;margin:6px 0 8px">${tiers}${modelChip(p)}</div>
    <p>${esc(p.description)}</p>${extra}</div></div>`;
}

const errorBanner = (st) => st.status === 'error'
  ? `<div class="banner bad">⚠ ${esc(st.error || 'Something went wrong')}</div>` : '';
const runningBanner = (msg) => `<div class="banner"><div class="spinner"></div>${msg}</div>`;
const locked = (msg, step) => `<div class="card pad empty"><h3>Locked</h3><p class="muted">${msg}</p>
  <a class="btn" href="#/run/${S.run.id}/${step}">Go to ${step} →</a></div>`;

/* ============================== HOME ============================== */
function viewHome() {
  const runs = S.runs.length ? `
    <div class="section-title"><h2>Recent migrations</h2></div>
    <div class="card"><table class="table">
      <thead><tr><th>Project</th><th>Started</th><th>Progress</th><th class="num">Tokens</th><th class="num">Spend</th></tr></thead>
      <tbody>${S.runs.map((r) => `<tr class="click" data-action="open-run" data-id="${r.id}">
        <td><b>${esc(r.name)}</b><div class="faint mono" style="font-size:11.5px">${r.id}</div></td>
        <td class="muted">${new Date(r.created * 1000).toLocaleString()}</td>
        <td><div class="pills">${Object.values(r.stages).map((s) => `<span class="pill ${statusClass(s)}"></span>`).join('')}</div></td>
        <td class="num">${fmtTok(r.tokens)}</td><td class="num">${fmtCost(r.cost)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const steps = [
    ['01', 'Discover', 'Static map + AI docs + UML', 'Gate 1 · human review'],
    ['02', 'Design', 'Target architecture on the UNITE standard', 'Gate 2 · plan & budget'],
    ['03', 'Build', 'Parallel Builder swarm along the dependency DAG', 'auto-escalates on failure'],
    ['04', 'Verify', 'Differential tests: legacy Python vs new JS', 'auto-fix loop'],
    ['05', 'Report', 'Tokens & dollars per agent and model', 'vs all-frontier baseline'],
  ];
  return `
  <div class="hero">
    <span class="chip accent">UNITE · Code modernisation</span>
    <h1 class="serif" style="margin-top:14px">See it. Shape it.<br><em>Ship it.</em></h1>
    <p>Agents reverse-engineer legacy code into docs and UML, people approve every decision, a build swarm ports the code to the UNITE standard, and a Verifier proves that old and new behave the same. Every token is accounted for.</p>
  </div>
  <div class="grid g2" style="margin-top:30px">
    <div class="drop" id="drop">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0l-4 4m4-4l4 4"/><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
      <h3 style="margin-top:10px">Drop a legacy codebase</h3>
      <p class="muted" style="margin:0">A .zip or a folder of Python source</p>
      <div class="row" style="justify-content:center;margin-top:18px">
        <label class="btn">Choose .zip<input type="file" accept=".zip" hidden id="zipin"></label>
        <label class="btn">Choose folder<input type="file" webkitdirectory hidden id="dirin"></label>
      </div>
      <p class="faint" style="font-size:12px;margin:14px 0 0">GitHub import: next on the roadmap</p>
    </div>
    <div class="card pad stack" style="gap:12px">
      <div class="row"><span class="chip">Sample project</span><span class="spacer"></span><span class="chip t0">Python 2-era</span></div>
      <h3 style="font-size:20px" class="serif">legacy-bank</h3>
      <p class="muted" style="margin:0">A 2014 banking core: money, interest, fees, validation and accounts. It relies on behaviour a naive JavaScript port gets wrong: banker's rounding, floor division and modulo of negatives, and <code>str.title()</code>.</p>
      <div class="row wrap"><span class="chip">5 modules</span><span class="chip">222 LOC</span><span class="chip">18 functions</span><span class="chip">2 classes</span></div>
      <div class="spacer"></div>
      <div><button class="btn primary" data-action="sample">Start with the sample →</button></div>
    </div>
  </div>
  <div class="section-title"><h2>The pipeline</h2><span class="muted">Five stages, two human gates, one ledger</span></div>
  <div class="card pipeline">${steps.map(([n, t, d, g]) => `<div class="pipe-step"><div class="n">${n}</div><h4>${t}</h4><p>${d}</p><div class="gate"><span class="chip ${g.startsWith('Gate') ? 'accent' : ''}">${g}</span></div></div>`).join('')}</div>
  ${runs}`;
}

async function createRun(fd) {
  try {
    toast('Uploading…');
    const { id } = await api('/api/runs', { method: 'POST', body: fd });
    go(`#/run/${id}/discover`);
  } catch (e) { toast(e.message, true); }
}

/* ============================== DISCOVER ============================== */
function viewDiscover(run) {
  const st = run.stages.discover;
  const a = run.analysis;
  let actions = '';
  if (['idle', 'error'].includes(st.status)) actions = `<button class="btn primary" data-action="discover">Run discovery</button>`;
  const head = stageHead('Stage 1 · Discover', 'Understand the legacy system',
    'Cartographer maps the code with static analysis at zero token cost. Scribes document every module in parallel, and Draftsman draws the architecture. You then review and correct everything.', actions);

  if (st.status === 'idle') {
    return head + `<div class="grid g3">${['cartographer', 'scribe', 'draftsman'].map((p) => agentTile(p)).join('')}</div>`;
  }
  const total = a ? a.modules.length : 0;
  const done = Object.keys(run.docs).length;
  let h = head + errorBanner(st);
  if (st.status === 'running') h += runningBanner(a ? `Scribes at work: ${done}/${total} modules documented${done === total ? ' · drawing diagrams & overview' : ''}` : 'Cartographer is mapping the repository…');
  if (st.status === 'approved') h += `<div class="banner ok">✓ Approved. This documentation is now the source of truth for the Architect.
    <span class="spacer"></span><a class="btn sm" href="#/run/${run.id}/design">Continue to Design →</a></div>`;

  if (a) {
    const t = a.totals;
    h += `<div class="kpis">
      <div class="card kpi"><div class="label">Modules</div><div class="value">${t.modules}</div><div class="sub">${esc(a.language)}</div></div>
      <div class="card kpi"><div class="label">Lines of code</div><div class="value">${t.loc}</div><div class="sub">parsed via AST</div></div>
      <div class="card kpi"><div class="label">Functions · Classes</div><div class="value">${t.functions} · ${t.classes}</div><div class="sub">${t.methods} methods</div></div>
      <div class="card kpi feature"><div class="label">Cartographer cost</div><div class="value">$0.00</div><div class="sub">static analysis, 0 tokens</div></div>
    </div>`;
  }
  const tabs = [['overview', 'Overview'], ['modules', 'Modules'], ['diagrams', `Diagrams${run.diagrams.length ? ' · ' + run.diagrams.length : ''}`]];
  h += `<div class="row" style="margin:24px 0 14px"><div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.ui.tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}">${l}</button>`).join('')}</div></div>`;
  h += ({ overview: discoverOverview, modules: discoverModules, diagrams: discoverDiagrams }[S.ui.tab] || discoverOverview)(run);

  if (st.status === 'review') {
    h += `<div class="gatebar">
      <div class="gl"><div class="eyebrow">Gate 1</div><b>Human review</b></div>
      <div style="flex:1"><label class="faint" style="font-size:12px">Notes for the Architect (constraints, corrections, decisions)</label>
        <textarea id="notes" placeholder="e.g. Keep integer cents everywhere. Preserve banker's rounding: finance signed off on it.">${esc(run.notes || '')}</textarea></div>
      <button class="btn primary" data-action="approve-discover">Approve & design →</button></div>`;
  }
  return h;
}

function editable(key, content, render) {
  const editing = S.ui.editing[key];
  const canEdit = S.run.stages.discover.status === 'review';
  const btn = canEdit ? `<button class="btn sm ${editing ? 'primary' : ''}" data-action="edit" data-key="${esc(key)}">${editing ? 'Done' : 'Edit'}</button>` : '';
  return { btn, body: editing ? `<textarea class="code" data-edit="${esc(key)}">${esc(content)}</textarea>` : render(content) };
}

function discoverOverview(run) {
  if (!run.overview) return `<div class="card pad muted">The system overview appears once all modules are documented.</div>`;
  const e = editable('overview', run.overview, (c) => `<div class="md">${md(c)}</div>`);
  return `<div class="card pad"><div class="row" style="margin-bottom:12px"><h3>System overview</h3><span class="chip">Scribe</span><span class="spacer"></span>${e.btn}</div>${e.body}</div>`;
}

function discoverModules(run) {
  const mods = run.analysis?.modules || [];
  if (!mods.length) return '';
  const cur = S.ui.module && mods.find((m) => m.path === S.ui.module) ? S.ui.module : mods[0].path;
  const m = mods.find((x) => x.path === cur);
  const doc = run.docs[cur];
  const e = doc ? editable('doc:' + cur, doc, (c) => `<div class="md">${md(c)}</div>`) : { btn: '', body: `<div class="row muted"><div class="spinner"></div>Scribe is writing…</div>` };
  const showSrc = S.ui.editing['src:' + cur];
  return `<div class="split">
    <div class="card list">${mods.map((x) => `<div class="list-item ${x.path === cur ? 'active' : ''}" data-action="module" data-path="${esc(x.path)}">
      <span class="t">${esc(x.path)}</span><span class="s">${run.docs[x.path] ? x.loc + ' LOC' : '<span class="spinner" style="width:12px;height:12px"></span>'}</span></div>`).join('')}</div>
    <div class="card pad">
      <div class="row wrap" style="margin-bottom:14px;gap:8px"><h3 class="mono" style="overflow-wrap:anywhere">${esc(cur)}</h3>
        <span class="chip">${m.functions?.length || 0} fn</span><span class="chip">${m.classes?.length || 0} cls</span>
        ${(m.internal_deps || []).map((d) => `<span class="chip accent">→ ${esc(d)}</span>`).join('')}
        <span class="spacer"></span><button class="btn sm ghost" data-action="toggle-src" data-key="${esc(cur)}">${showSrc ? 'Hide' : 'View'} source</button>${e.btn}</div>
      ${showSrc ? `<div class="code-pane" style="border-radius:10px;overflow:hidden;margin-bottom:16px"><pre><code class="hljs">${hl(run.files[cur], 'python')}</code></pre></div>` : ''}
      ${e.body}
    </div></div>`;
}

function discoverDiagrams(run) {
  if (!run.diagrams.length) return `<div class="card pad muted">No diagrams yet.</div>`;
  return `<div class="stack">${run.diagrams.map((d) => {
    const key = 'dia:' + d.id;
    const editing = S.ui.editing[key];
    const canEdit = run.stages.discover.status === 'review';
    return `<div class="card diagram">
      <div class="diagram-head"><h3>${esc(d.title)}</h3>
        <span class="chip ${d.source === 'static' ? 't0' : 'accent'}">${d.source === 'static' ? 'Static · exact' : 'Draftsman · AI'}</span>
        <span class="spacer"></span>${canEdit ? `<button class="btn sm ${editing ? 'primary' : ''}" data-action="edit" data-key="${key}">${editing ? 'Render' : 'Edit source'}</button>` : ''}</div>
      ${editing ? `<div style="padding:14px"><textarea class="code" style="min-height:260px" data-edit="${key}">${esc(d.code)}</textarea></div>` : ''}
      <div class="diagram-body" data-mermaid="${esc(d.id)}"><div class="spinner"></div></div></div>`;
  }).join('')}</div>`;
}

function applyEdit(key, value) {
  const run = S.run;
  if (key === 'overview') run.overview = value;
  else if (key.startsWith('doc:')) run.docs[key.slice(4)] = value;
  else if (key.startsWith('dia:')) { const d = run.diagrams.find((x) => x.id === key.slice(4)); if (d) d.code = value; }
}
const saveDocs = () => api(`/api/runs/${S.run.id}/docs`, { method: 'PUT', body: {
  docs: S.run.docs, overview: S.run.overview, diagrams: S.run.diagrams, notes: $('#notes')?.value ?? S.run.notes } });

/* ============================== DESIGN ============================== */
function viewDesign(run) {
  const st = run.stages.design;
  if (run.stages.discover.status !== 'approved') return stageHead('Stage 2 · Design', 'Shape the target', '') + locked('Approve the discovery documentation first (Gate 1).', 'discover');
  const actions = ['idle', 'error'].includes(st.status) ? `<button class="btn primary" data-action="design">Generate design</button>` : '';
  let h = stageHead('Stage 2 · Design', 'Shape the target architecture',
    'Architect turns the approved documentation into a design that follows the UNITE JavaScript standard, plus a risk register and a task plan. You edit it, toggle tasks, and approve the budget.', actions);
  h += errorBanner(st);
  if (st.status === 'idle') return h + `<div class="grid g2">${agentTile('architect')}<div class="card pad"><h3>UNITE target standard</h3><pre class="muted" style="white-space:pre-wrap;font-size:12px;margin:8px 0 0">${esc(S.config.standard)}</pre></div></div>`;
  if (st.status === 'running') return h + runningBanner('Architect is reasoning about the target design on the Frontier tier, where the stakes are highest…') + agentTile('architect');
  const d = run.design || {};
  const tasks = run.tasks;
  const on = tasks.filter((t) => t.enabled);
  const est = sum(on, (t) => t.estimate), base = sum(on, (t) => t.baseline_estimate);
  if (st.status === 'approved') h += `<div class="banner ok">✓ Plan approved. <span class="spacer"></span><a class="btn sm" href="#/run/${run.id}/build">Go to Build →</a></div>`;
  const canEdit = st.status === 'review';
  const editing = S.ui.editing['design'];
  h += `<div class="grid design-grid">
    <div class="card pad"><div class="row" style="margin-bottom:10px"><h3>Target design</h3><span class="chip t3">Architect</span><span class="spacer"></span>
      ${canEdit ? `<button class="btn sm ${editing ? 'primary' : ''}" data-action="edit" data-key="design">${editing ? 'Done' : 'Edit'}</button>` : ''}</div>
      ${editing ? `<textarea class="code" data-edit="design">${esc(d.summary || '')}</textarea>` : `<div class="md">${md(d.summary || '')}</div>`}
      ${(d.principles || []).length ? `<div class="row wrap" style="margin-top:14px">${d.principles.map((p) => `<span class="chip long">${esc(p)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="card pad stack" style="gap:10px"><h3>Risk register</h3>
      ${(d.risks || []).map((r) => `<div class="risk ${esc((r.severity || '').toLowerCase())}"><div class="row"><b>${esc(r.title)}</b><span class="spacer"></span><span class="chip ${r.severity === 'high' ? 'bad' : r.severity === 'medium' ? 'warn' : 'ok'}">${esc(r.severity)}</span></div><p>${esc(r.mitigation)}</p></div>`).join('') || '<p class="muted">No risks listed.</p>'}
    </div></div>`;
  h += `<div class="section-title"><h2>Migration plan</h2><span class="muted">${on.length}/${tasks.length} tasks · estimated <b class="mono" style="color:var(--accent)">${fmtCost(est)}</b> vs ${fmtCost(base)} on all-frontier</span></div>
    <div class="grid g3">${tasks.map((t) => taskCard(t, canEdit)).join('')}</div>`;
  if (canEdit) h += `<div class="gatebar"><div class="gl"><div class="eyebrow">Gate 2</div><b>Approve plan & budget</b></div>
    <div style="flex:1" class="muted">Approving commits an estimated <b class="mono" style="color:var(--text)">${fmtCost(est)}</b>. AgentForge routes each task to the cheapest capable tier and escalates only on failure.</div>
    <button class="btn primary" data-action="approve-design">Approve & build →</button></div>`;
  return h;
}

function taskCard(t, canEdit) {
  const r = t.route, p = t.profile;
  const exp = (t.exports || []).map((e) => e.js || e.python);
  return `<div class="card task ${t.enabled ? '' : 'off'}">
    <div class="task-top"><span class="task-id">${esc(t.id)}</span><h4>${esc(t.title)}</h4>
      ${canEdit ? `<label class="switch" title="Include task"><input type="checkbox" data-toggle-task="${esc(t.id)}" ${t.enabled ? 'checked' : ''}><span></span></label>` : ''}</div>
    <div class="path">${esc(t.source)}<span class="arrow">→</span>${esc(t.target)}</div>
    ${t.depends_on.length ? `<div class="row wrap" style="gap:6px"><span class="faint" style="font-size:12px">after</span>${t.depends_on.map((d) => `<span class="chip">${esc(d)}</span>`).join('')}</div>` : ''}
    <div class="faint" style="font-size:12px">${exp.length} exports: <span class="mono">${esc(exp.slice(0, 5).join(', '))}${exp.length > 5 ? '…' : ''}</span></div>
    <div><div class="row" style="font-size:12px"><span class="faint">profile: ${p.size_tokens} tok · cx ${p.complexity} · risk ${p.risk_hits}</span><span class="spacer"></span><span class="mono">${p.score.toFixed(2)}</span></div>
      <div class="scorebar"><i style="width:${Math.max(4, p.score * 100)}%"></i></div></div>
    <div class="row">${tierChip(r.tier)}<span class="muted" style="font-size:12.5px">${esc(model(r.model).label)}</span><span class="spacer"></span><span class="mono" style="font-size:12.5px">~${fmtCost(t.estimate)}</span></div>
    ${canEdit ? `<textarea data-task-notes="${esc(t.id)}" placeholder="Notes for the Builder…" style="min-height:54px">${esc(t.notes || '')}</textarea>` : t.notes ? `<div class="muted" style="font-size:12.5px">${esc(t.notes)}</div>` : ''}
  </div>`;
}

/* ============================== BUILD ============================== */
function waves(tasks) {
  const ids = new Set(tasks.map((t) => t.id)), done = new Set(), out = [];
  let pending = [...tasks];
  while (pending.length) {
    let ready = pending.filter((t) => t.depends_on.every((d) => done.has(d) || !ids.has(d)));
    if (!ready.length) ready = pending;
    out.push(ready);
    ready.forEach((t) => done.add(t.id));
    pending = pending.filter((t) => !ready.includes(t));
  }
  return out;
}

function taskCalls(run, t) {
  return run.ledger.filter((e) => e.agent === 'Builder' && (e.task === 'port ' + t.source || e.task === 'fix ' + t.source));
}
function modelTrail(calls) {
  return calls.map((e, i) => `${i ? '<span class="sep">→</span>' : ''}<span class="chip t${e.tier}" title="${esc(e.route?.reason || '')}">${esc(model(e.model).label)}</span>`).join('');
}

function viewBuild(run) {
  const st = run.stages.build;
  if (run.stages.design.status !== 'approved') return stageHead('Stage 3 · Build', 'Ship it', '') + locked('Approve the design and plan first (Gate 2).', 'design');
  const actions = ['idle', 'error'].includes(st.status) ? `<button class="btn primary" data-action="build">${st.status === 'error' ? 'Retry build' : 'Start build'}</button>` : '';
  let h = stageHead('Stage 3 · Build', 'The Builder swarm',
    "Builders run in parallel waves along the dependency DAG. Every output is syntax-checked and checked against the agreed export contract. If validation fails, AgentForge escalates the task to a stronger model.", actions);
  h += errorBanner(st);
  const tasks = run.tasks.filter((t) => t.enabled);
  if (st.status === 'idle') return h + `<div class="grid g2">${agentTile('builder')}<div class="card pad"><h3>Ready to build</h3><p class="muted">${tasks.length} tasks in ${waves(tasks).length} waves. Click <b>Start build</b>.</p></div></div>`;
  if (st.status === 'running') h += runningBanner('Swarm is building…');
  if (st.status === 'done') h += `<div class="banner ok">✓ All modules compile and expose the agreed API.
    <span class="spacer"></span><a class="btn sm" href="/api/runs/${run.id}/download">Download code</a><button class="btn sm primary" data-action="verify">Verify equivalence →</button></div>`;
  waves(tasks).forEach((w, i) => {
    h += `<div class="wave-label">Wave ${i + 1} · ${w.length} in parallel</div><div class="grid g3">`;
    for (const t of w) {
      const b = run.build[t.id] || { status: 'queued' };
      const calls = taskCalls(run, t);
      const icon = { queued: '<span class="chip">queued</span>', running: '<div class="spinner"></div>', done: '<span class="chip ok">✓ built</span>', failed: '<span class="chip bad">failed</span>' }[b.status];
      h += `<div class="card build-card ${b.status}" data-action="code" data-id="${esc(t.id)}">
        <div class="row"><span class="task-id">${esc(t.id)}</span><b style="flex:1">${esc(t.target)}</b>${icon}</div>
        <div class="path" style="margin:6px 0 10px">${esc(t.source)}</div>
        <div class="models-trail">${modelTrail(calls) || '<span class="faint" style="font-size:12px">awaiting route</span>'}</div>
        <div class="mono faint" style="font-size:12px;margin-top:8px">${calls.length} call${calls.length === 1 ? '' : 's'} · ${fmtTok(sum(calls, (e) => e.tokens_in + e.tokens_out))} tok · ${fmtCost(sum(calls, (e) => e.cost))}</div>
        ${b.error ? `<div class="diagram-err" style="margin-top:8px">${esc(b.error.slice(0, 300))}</div>` : ''}</div>`;
    }
    h += `</div>`;
  });
  const ct = S.ui.codeTask && run.tasks.find((t) => t.id === S.ui.codeTask);
  if (ct) {
    const b = run.build[ct.id] || {};
    h += `<div class="section-title"><h2>${esc(ct.source)} → ${esc(ct.target)}</h2><span class="spacer"></span><button class="btn sm ghost" data-action="code" data-id="">Close</button></div>
      <div class="card code-split">
        <div class="code-pane"><div class="ch"><span class="chip t0">legacy</span>Python · ${esc(ct.source)}</div><pre><code class="hljs">${hl(run.files[ct.source], 'python')}</code></pre></div>
        <div class="code-pane"><div class="ch"><span class="chip accent">UNITE</span>JavaScript · ${esc(ct.target)}</div><pre><code class="hljs">${b.code ? hl(b.code, 'javascript') : '<span style="color:#6b7389">// not built yet</span>'}</code></pre></div>
      </div>`;
  } else if (Object.values(run.build).some((b) => b.code)) {
    h += `<p class="faint" style="margin-top:16px;font-size:12.5px">Tip: click a card to compare legacy and migrated code side by side.</p>`;
  }
  return h;
}

/* ============================== VERIFY ============================== */
function ring(passed, total) {
  const r = 62, c = 2 * Math.PI * r, p = total ? passed / total : 0;
  const color = p === 1 ? 'var(--ok)' : p > 0.8 ? 'var(--warn)' : 'var(--bad)';
  return `<svg class="ring" viewBox="0 0 150 150"><circle class="bg" cx="75" cy="75" r="${r}"/>
    <circle class="fg" cx="75" cy="75" r="${r}" stroke="${color}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}"/>
    <text x="75" y="76" text-anchor="middle">${pct(passed, total)}%</text><text class="s" x="75" y="98" text-anchor="middle">${passed}/${total} match</text></svg>`;
}
const jv = (v) => JSON.stringify(v);
function showVal(res) {
  if (!res) return '—';
  if (res.error) return `⚠ ${res.error}${res.message ? ': ' + res.message : ''}`;
  if (Array.isArray(res.ok) && res.ok.every((s) => s && typeof s === 'object' && ('ok' in s || 'error' in s))) {
    return res.ok.map((s) => (s.error ? `⚠ ${s.error}` : jv(s.ok))).join('\n');
  }
  return jv(res.ok);
}
function callSig(c) {
  const args = (a) => (a || []).map(jv).join(', ');
  if (c.kind === 'class') return `new ${c.target}(${args(c.ctor_args)})\n` + (c.calls || []).map((s) => `  .${s.method}(${args(s.args)})`).join('\n');
  return `${c.target}(${args(c.args)})`;
}

function viewVerify(run) {
  const st = run.stages.verify;
  if (run.stages.build.status !== 'done') return stageHead('Stage 4 · Verify', 'Prove it', '') + locked('Finish the build first.', 'build');
  const actions = ['idle', 'error'].includes(st.status) ? `<button class="btn primary" data-action="verify">Run differential tests</button>` : '';
  let h = stageHead('Stage 4 · Verify', 'Prove old and new are equivalent',
    'Verifier designs adversarial inputs and runs them on the legacy Python, which is the ground truth. It then runs the same inputs on the new JavaScript and compares every result.', actions);
  h += errorBanner(st);
  const v = run.verify;
  if (st.status === 'idle' || !v) return h + (st.status === 'running' ? runningBanner('Verifier is designing test cases…') : '') + `<div class="grid g2">${agentTile('verifier')}
    <div class="card pad"><h3>How equivalence is proven</h3><ol class="muted" style="margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.8">
    <li>LLM designs edge-case inputs (no expected values)</li><li>Legacy Python executes them → <b>ground truth</b></li>
    <li>New JS executes the same inputs</li><li>Deep-diff every result, error paths included</li><li>Failures → escalated Builder fixes → re-test</li></ol></div></div>`;
  if (st.status === 'running') h += runningBanner(v.round > 1 ? `Fix round ${v.round - 1}: escalated Builders are repairing divergences…` : 'Executing characterization tests on legacy and migrated code…');
  const allOk = v.total > 0 && v.passed === v.total;
  h += `<div class="card pad row" style="gap:28px;align-items:center">${ring(v.passed, v.total)}
    <div style="flex:1"><div class="eyebrow" style="color:var(--accent);font:600 12px Inter;letter-spacing:.12em;text-transform:uppercase">Equivalence${v.round > 1 ? ` · after ${v.round - 1} fix round${v.round > 2 ? 's' : ''}` : ''}</div>
      <h2 class="serif" style="font-size:30px;margin:4px 0">${v.passed} of ${v.total} behaviours preserved</h2>
      <p class="muted" style="margin:0">${allOk ? 'The migrated modules are drop-in equivalent to the legacy code for every tested behaviour.' : `${v.total - v.passed} divergences found. These are exactly the subtle differences that reach production when a port isn't tested this way.`}</p>
      <div class="row" style="margin-top:14px">${allOk ? '<span class="chip ok">✓ Drop-in ready</span>' : '<span class="chip warn">Divergences found</span>'}
        ${st.status === 'review' ? `<button class="btn primary" data-action="fix">Auto-fix with escalated Builder →</button>` : ''}
        ${allOk ? `<a class="btn" href="#/run/${run.id}/cost">See the cost report →</a>` : ''}
        <a class="btn ghost" href="/api/runs/${run.id}/download">Download code</a></div></div></div>`;
  const mods = Object.entries(v.modules);
  h += `<div class="section-title"><h2>By module</h2></div><div class="card pad stack" style="gap:12px">${mods.map(([k, m]) => `
    <div class="modbar"><span class="mono">${esc(m.source)}</span><div class="bar"><i style="width:${pct(m.passed, m.total)}%;background:var(--ok)"></i><i style="width:${100 - pct(m.passed, m.total)}%;background:var(--bad)"></i></div>
    <span class="mono" style="text-align:right">${m.passed}/${m.total}${m.fix_rounds ? ` <span class="chip t3" title="fix rounds">fix×${m.fix_rounds}</span>` : ''}</span></div>`).join('')}</div>`;
  const cases = mods.flatMap(([k, m]) => m.cases.map((c) => ({ ...c, module: m.source })));
  const shown = (S.ui.caseFilter === 'fail' ? cases.filter((c) => !c.pass) : cases).sort((a, b) => a.pass - b.pass);
  h += `<div class="section-title"><h2>Test cases</h2><span class="muted">${cases.length} cases</span><span class="spacer"></span>
    <div class="tabs"><button class="tab ${S.ui.caseFilter === 'all' ? 'active' : ''}" data-action="cases" data-f="all">All</button><button class="tab ${S.ui.caseFilter === 'fail' ? 'active' : ''}" data-action="cases" data-f="fail">Failures · ${cases.filter((c) => !c.pass).length}</button></div></div>
    <div class="card" style="overflow:auto"><table class="table"><thead><tr><th></th><th>Case</th><th>Call</th><th>Legacy Python</th><th>UNITE JavaScript</th></tr></thead><tbody>
    ${shown.map((c) => `<tr><td>${c.pass ? '<span class="ok-mark">✓</span>' : '<span class="bad-mark">✗</span>'}</td>
      <td style="min-width:180px"><b style="font-size:12.5px">${esc(c.label || c.id)}</b><div class="faint mono" style="font-size:11px">${esc(c.module)}</div></td>
      <td><div class="case-val">${esc(callSig(c))}</div></td><td><div class="case-val">${esc(showVal(c.py))}</div></td>
      <td><div class="case-val ${c.pass ? '' : 'bad'}">${esc(showVal(c.js))}</div></td></tr>`).join('')}</tbody></table></div>`;
  return h;
}

/* ============================== COST ============================== */
function hbars(rows, max, colorFn, valFn = (r) => fmtCost(r.v)) {
  return `<div class="hbars">${rows.map((r) => `<div class="hbar"><span class="${r.mono ? 'mono' : ''}" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.k)}">${esc(r.k)}</span>
    <div class="track">${(r.parts || [{ v: r.v, c: colorFn?.(r) }]).map((p) => `<i style="width:${max ? (p.v / max) * 100 : 0}%;background:${p.c}" title="${esc(p.t || '')}"></i>`).join('')}</div>
    <span class="val">${valFn(r)}</span></div>`).join('')}</div>`;
}

function viewCost(run) {
  const L = run.ledger;
  const t = ledgerTotals(L);
  let h = stageHead('Stage 5 · Report', 'Every token, accounted for',
    'Each LLM call goes through one metered gateway. Here is where the money went, and what it would have cost to run every call on the strongest model.',
    `<a class="btn" href="/api/runs/${run.id}/ledger.csv">Export ledger CSV</a>${run.stages.build.status === 'done' ? `<a class="btn primary" href="/api/runs/${run.id}/download">Download migration</a>` : ''}`);
  if (!L.length) return h + `<div class="card pad empty"><h3>No spend yet</h3><p class="muted">Run discovery to start the meter.</p></div>`;
  const baseLabel = model(S.config.baseline).label;
  h += `<div class="kpis">
    <div class="card kpi feature"><div class="label">Total spend</div><div class="value">${fmtCost(t.cost)}</div><div class="sub">across ${t.calls} LLM calls</div></div>
    <div class="card kpi"><div class="label">Tokens</div><div class="value">${fmtTok(t.tin + t.tout)}</div><div class="sub">${fmtTok(t.tin)} in · ${fmtTok(t.tout)} out</div></div>
    <div class="card kpi"><div class="label">Saved vs all-${esc(baseLabel)}</div><div class="value" style="color:var(--ok)">${Math.round(t.saved * 100)}%</div><div class="sub">${fmtCost(t.base - t.cost)} not spent</div></div>
    <div class="card kpi"><div class="label">Escalations</div><div class="value">${t.esc}</div><div class="sub">tasks bumped to a stronger tier</div></div></div>`;
  const maxC = Math.max(t.cost, t.base);
  h += `<div class="section-title"><h2>Smart routing vs brute force</h2></div><div class="card pad compare">
    ${hbars([{ k: 'Eastpac UNITE routing', v: t.cost, parts: Object.entries(groupBy(L, (e) => e.tier)).map(([tier, es]) => ({ v: sum(es, (e) => e.cost), c: TIER_COLOR(tier), t: `T${tier}` })) },
      { k: `All on ${baseLabel}`, v: t.base, parts: [{ v: t.base, c: 'var(--line-strong)' }] }], maxC)}
    <div class="legend" style="margin-top:6px">${[1, 2, 3].map((x) => `<span><i style="background:${TIER_COLOR(x)}"></i>T${x} · ${S.config.tier_names[x]}</span>`).join('')}<span><i style="background:var(--line-strong)"></i>baseline</span><span class="spacer"></span><span>Cartographer static analysis: <b>$0.00</b></span></div></div>`;
  const byAgent = Object.entries(groupBy(L, (e) => e.agent)).map(([k, es]) => ({ k, v: sum(es, (e) => e.cost), tok: sum(es, (e) => e.tokens_in + e.tokens_out),
    parts: Object.entries(groupBy(es, (e) => e.tier)).map(([tier, x]) => ({ v: sum(x, (e) => e.cost), c: TIER_COLOR(tier), t: `T${tier}` })) })).sort((a, b) => b.v - a.v);
  const byModel = Object.entries(groupBy(L, (e) => e.model)).map(([k, es]) => ({ k: model(k).label, v: sum(es, (e) => e.cost), tier: model(k).tier, tok: sum(es, (e) => e.tokens_in + e.tokens_out), n: es.length })).sort((a, b) => b.v - a.v);
  const byStage = ['discover', 'design', 'build', 'verify'].map((s) => ({ k: s[0].toUpperCase() + s.slice(1), v: sum(L.filter((e) => e.stage === s), (e) => e.cost), tok: sum(L.filter((e) => e.stage === s), (e) => e.tokens_in + e.tokens_out) }));
  const mx = (rows) => Math.max(...rows.map((r) => r.v), 1e-9);
  h += `<div class="grid g3" style="margin-top:16px">
    <div class="card pad compact"><h3 style="margin-bottom:14px">By agent</h3>${hbars(byAgent, mx(byAgent), null, (r) => fmtCost(r.v))}</div>
    <div class="card pad compact"><h3 style="margin-bottom:14px">By model</h3>${hbars(byModel, mx(byModel), (r) => TIER_COLOR(r.tier), (r) => fmtCost(r.v))}</div>
    <div class="card pad compact"><h3 style="margin-bottom:14px">By stage</h3>${hbars(byStage, mx(byStage), () => 'var(--accent)', (r) => fmtCost(r.v))}</div></div>`;
  h += `<div class="section-title"><h2>Model usage</h2></div><div class="card"><table class="table"><thead><tr><th>Model</th><th>Tier</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Share</th></tr></thead><tbody>
    ${byModel.map((r) => `<tr><td><b>${esc(r.k)}</b></td><td>${tierChip(r.tier)}</td><td class="num">${r.n}</td><td class="num">${fmtTok(r.tok)}</td><td class="num">${fmtCost(r.v)}</td><td class="num">${pct(r.v, t.cost)}%</td></tr>`).join('')}</tbody></table></div>`;
  h += `<div class="section-title"><h2>Call ledger</h2><span class="muted">${L.length} calls</span></div><div class="card" style="overflow:auto"><table class="table"><thead><tr>
    <th>Time</th><th>Agent</th><th>Task</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Latency</th><th class="num">Cost</th><th></th></tr></thead><tbody>
    ${L.slice().reverse().map((e) => `<tr><td class="faint mono" style="font-size:12px">${timeOf(e.ts)}</td><td>${esc(e.agent)}</td><td class="mono" style="font-size:12px">${esc(e.task)}</td>
      <td><span class="chip t${e.tier}">${esc(model(e.model).label)}</span></td><td class="num">${fmtTok(e.tokens_in)}</td><td class="num">${fmtTok(e.tokens_out)}</td>
      <td class="num">${(e.latency_ms / 1000).toFixed(1)}s</td><td class="num">${fmtCost(e.cost)}</td>
      <td>${e.escalated ? '<span class="chip t3">escalated</span>' : ''}${e.replayed ? '<span class="chip">replay</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  return h;
}

/* ============================== FORGE ============================== */
function tierRange(p) {
  if (!p.llm) return tierChip(0);
  return p.min_tier === p.max_tier ? tierChip(p.min_tier) : `${tierChip(p.min_tier)}<span class="faint">→</span>${tierChip(p.max_tier)}`;
}
function modelChip(p) {
  if (!p.llm) return '';
  return p.model_override
    ? `<span class="chip t${model(p.model_override).tier}" title="Pinned model">📌 ${esc(model(p.model_override).label)}</span>`
    : `<span class="chip accent" title="Router picks the model per task">Auto router</span>`;
}
function tierLadder(p) {
  const c = S.config;
  return [1, 2, 3].map((t) => {
    const m = model(c.tiers[t]);
    const on = !p.model_override && t >= p.min_tier && t <= p.max_tier;
    return `<div class="rung ${on ? 'on' : ''}"><span class="tn" style="color:${TIER_COLOR(t)}">T${t}</span><span>${esc(m.label)}</span><span class="spacer"></span><span class="mono faint" style="font-size:11.5px">$${m.in} / $${m.out} per M</span></div>`;
  }).join('') + `<div class="faint" style="font-size:12px;margin-top:6px">${p.model_override
    ? `📌 Pinned: every call uses <b>${esc(model(p.model_override).label)}</b> and tiers are ignored.`
    : 'Each task starts at its profiled tier within this range and escalates on failure, up to the cap.'}</div>`;
}
const SAMPLE_PROMPTS = {
  scribe: 'Document this function:\n```python\ndef to_cents(amount):\n    return int(round(amount * 100))\n```',
  draftsman: 'Draw a Mermaid sequenceDiagram: a teller deposits $10.50 into an Account, which converts dollars to cents via the money module.',
  architect: 'In 5 bullets: how should we port a Python module that relies on round() half-even semantics to JavaScript, safely?',
  builder: 'Port to JavaScript:\n```python\ndef split_evenly(total_cents, ways):\n    base, remainder = divmod(total_cents, ways)\n    return [base + 1 if i < remainder else base for i in range(ways)]\n```',
  verifier: 'List 6 adversarial inputs for `split_evenly(total_cents, ways)` where a JavaScript port might diverge, and say why.',
};

function forgeModal() {
  const c = S.config;
  if (S.ui.forgeNew) {
    return `<div class="modal-bg" data-action="forge-close-bg"><div class="modal sm">
      <div class="modal-head"><h3>New persona</h3><span class="spacer"></span><button class="icon-btn" data-action="forge-close">✕</button></div>
      <div class="modal-body stack" style="gap:14px">
        <label class="field"><span>Start from</span><select id="np-base">${c.personas.filter((p) => p.llm).map((p) => `<option value="${p.id}" ${p.id === S.ui.forgeNew ? 'selected' : ''}>${esc(p.name)} (fills ${p.acts_as})</option>`).join('')}</select></label>
        <label class="field"><span>Name</span><input id="np-name" placeholder="e.g. Secure Builder" autocomplete="off"></label>
        <p class="faint" style="font-size:12.5px;margin:0">It starts with the base persona's prompt, tiers and model, and fills the same pipeline role. Activate it to swap it into the pipeline.</p>
      </div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn ghost" data-action="forge-close">Cancel</button><button class="btn primary" data-action="forge-create">Create & configure</button></div>
    </div></div>`;
  }
  const p = S.ui.forgeEdit && c.personas.find((x) => x.id === S.ui.forgeEdit);
  if (!p) return '';
  const tierOpt = (sel) => [1, 2, 3].map((t) => `<option value="${t}" ${t === sel ? 'selected' : ''}>T${t} · ${c.tier_names[t]}</option>`).join('');
  const routed = p.model_override || c.tiers[p.min_tier];
  return `<div class="modal-bg" data-action="forge-close-bg"><div class="modal">
    <div class="modal-head"><div class="agent-glyph">${esc(p.glyph)}</div>
      <div><h3>${esc(p.name)}</h3><div class="faint" style="font-size:12px">fills the <b>${p.acts_as}</b> role · ${p.active ? '<span style="color:var(--ok)">● active</span>' : 'standby'} · ${p.custom ? `custom, cloned from ${esc(p.cloned_from)}` : 'built-in'}</div></div>
      <span class="spacer"></span><button class="icon-btn" data-action="forge-close" title="Close (Esc)">✕</button></div>
    <div class="modal-body forge-grid">
      <div class="stack" style="gap:12px">
        <div class="subhead">Identity</div>
        <div class="row" style="gap:10px;align-items:flex-end"><label class="field" style="width:72px"><span>Icon</span><input id="pf-glyph" value="${esc(p.glyph)}" maxlength="2" style="text-align:center"></label>
          <label class="field" style="flex:1"><span>Name</span><input id="pf-name" value="${esc(p.name)}"></label></div>
        <label class="field"><span>Role (one line)</span><input id="pf-role" value="${esc(p.role)}"></label>
        <label class="field"><span>Description</span><textarea id="pf-description" style="min-height:66px">${esc(p.description)}</textarea></label>
        <div class="subhead">Model & cost</div>
        <label class="field"><span>Model</span><select id="pf-model"><option value="">Auto: router picks the model per task</option>
          ${Object.entries(c.models).map(([id, m]) => `<option value="${id}" ${p.model_override === id ? 'selected' : ''}>Pin ${esc(m.label)} · T${m.tier} · $${m.in}/$${m.out} per M</option>`).join('')}</select></label>
        <div class="row" style="gap:10px"><label class="field" style="flex:1"><span>Lowest tier</span><select id="pf-min">${tierOpt(p.min_tier)}</select></label>
          <label class="field" style="flex:1"><span>Escalation cap</span><select id="pf-max">${tierOpt(p.max_tier)}</select></label></div>
        <div class="tier-ladder">${tierLadder(p)}</div>
        <div class="row" style="gap:10px;align-items:flex-end"><label class="field" style="flex:1"><span>Temperature <b class="mono" id="pf-temp-v">${(+p.temperature).toFixed(2)}</b></span>
          <input type="range" id="pf-temperature" min="0" max="1.5" step="0.05" value="${p.temperature}"></label>
          <label class="field" style="width:150px"><span>Max output tokens</span><input id="pf-max_tokens" type="number" min="256" step="256" placeholder="stage default" value="${p.max_tokens ?? ''}"></label></div>
      </div>
      <div class="stack" style="gap:12px">
        <div class="subhead">Behaviour</div>
        <label class="field"><span>System prompt</span><textarea id="pf-system" class="code" style="min-height:230px">${esc(p.system)}</textarea></label>
        <div class="subhead">Playground <span class="faint" style="font-weight:400;text-transform:none;letter-spacing:0;margin-left:6px">uses the settings above, saved or not · metered</span></div>
        <textarea id="pg-prompt" style="min-height:96px">${esc(SAMPLE_PROMPTS[p.acts_as] || '')}</textarea>
        <div class="row"><select id="pg-model" style="flex:1"><option value="">As configured (${esc(model(routed).label)})</option>
          ${Object.entries(c.models).map(([id, m]) => `<option value="${id}">${esc(m.label)} · T${m.tier}</option>`).join('')}</select>
          <button class="btn" data-action="forge-try" data-id="${p.id}">▶ Run</button></div>
        <div id="pg-out"></div>
      </div>
    </div>
    <div class="modal-foot">
      ${p.custom ? `<button class="btn ghost" style="color:var(--bad)" data-action="forge-delete" data-id="${p.id}">Delete persona</button>`
        : `<button class="btn ghost" data-action="forge-reset" data-id="${p.id}">Reset to default</button>`}
      <span class="spacer"></span>
      <button class="btn ghost" data-action="forge-close">Cancel</button>
      ${!p.active ? `<button class="btn" data-action="forge-save" data-id="${p.id}" data-activate="1">Save & activate</button>` : ''}
      <button class="btn primary" data-action="forge-save" data-id="${p.id}">Save</button></div>
  </div></div>`;
}

function personaCard(p) {
  return `<div class="card persona ${p.active ? '' : 'inactive'}">
    <div class="row"><div class="agent-glyph">${esc(p.glyph)}</div><div style="flex:1;min-width:0"><h4>${esc(p.name)}</h4><div class="faint" style="font-size:12px">${esc(p.role)}</div></div></div>
    <p>${esc(p.description)}</p>
    <div class="row wrap" style="gap:6px">${p.llm ? (p.active ? '<span class="chip ok">● active</span>' : '<span class="chip">standby</span>') : ''}<span class="chip">${p.llm ? 'role: ' + p.acts_as : 'stage: ' + p.stage}</span>${tierRange(p)}${modelChip(p)}
      ${p.custom ? `<span class="chip warn">custom · from ${esc(p.cloned_from)}</span>` : ''}
      ${p.llm && +p.temperature !== 0.2 ? `<span class="chip">temp ${(+p.temperature).toFixed(2)}</span>` : ''}</div>
    <div class="spacer"></div>
    <div class="row" style="gap:6px">${p.llm
      ? `<button class="btn sm" data-action="forge-edit" data-id="${p.id}">Configure</button><button class="btn sm ghost" data-action="forge-clone" data-id="${p.id}">Clone</button>
         ${!p.active ? `<button class="btn sm ghost" data-action="forge-activate" data-id="${p.id}">Activate</button>` : ''}`
      : '<span class="faint" style="font-size:12px">Deterministic: nothing to configure, nothing to pay</span>'}</div>
  </div>`;
}

function viewForge() {
  const c = S.config;
  const opts = (sel) => Object.entries(c.models).map(([id, m]) => `<option value="${id}" ${sel === id ? 'selected' : ''}>${esc(m.label)} · T${m.tier}</option>`).join('');
  let h = stageHead('AgentForge', 'The right agent, at the right price',
    'Personas define what an agent does, and the router decides which model does it. Configure, clone and test personas, then choose which one runs each stage of the pipeline.',
    `<button class="btn primary" data-action="forge-new">+ New persona</button>`);

  const slots = ['cartographer', ...c.roles];
  h += `<div class="section-title" style="margin-top:4px"><h2>Active line-up</h2><span class="muted">who runs each stage right now · click to configure</span></div>
    <div class="card lineup">${slots.map((role) => {
      const p = role === 'cartographer' ? persona('cartographer') : c.personas.find((x) => x.acts_as === role && x.active);
      if (!p) return '';
      return `<div class="slot" ${p.llm ? `data-action="forge-edit" data-id="${p.id}"` : ''}>
        <div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.12em">${role}</div>
        <div class="row" style="gap:8px;margin-top:8px"><span class="agent-glyph sm">${esc(p.glyph)}</span><b style="font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</b></div>
        <div class="row wrap" style="gap:4px;margin-top:10px">${p.llm ? (p.model_override ? modelChip(p) : tierRange(p)) : tierChip(0)}</div></div>`;
    }).join('')}</div>`;

  const custom = c.personas.filter((p) => p.custom).length;
  h += `<div class="section-title"><h2>Persona portfolio</h2><span class="muted">${c.personas.length - custom} built-in · ${custom} custom</span></div>
    <div class="grid g3">${c.personas.map(personaCard).join('')}</div>`;

  h += `<div class="section-title"><h2>Tier models</h2><span class="muted">what "Auto router" resolves to</span></div>
    <div class="grid g3">${[1, 2, 3].map((tier) => { const m = c.models[c.tiers[tier]];
    return `<div class="card tier-col"><div class="row"><span class="tn" style="color:${TIER_COLOR(tier)}">Tier ${tier} · ${c.tier_names[tier]}</span></div>
      <select data-tier="${tier}">${opts(c.tiers[tier])}</select>
      <div class="row muted mono" style="font-size:12px"><span>$${m.in}/M in</span><span>$${m.out}/M out</span></div>
      <p class="faint" style="margin:0;font-size:12.5px">${['Docs, simple modules, test design', 'Complex or risky ports, first escalation', 'Architecture, final escalation'][tier - 1]}</p></div>`; }).join('')}</div>`;
  h += `<div class="card pad" style="margin-top:16px"><div class="row wrap" style="gap:24px"><div style="flex:1;min-width:260px"><h3>Routing policy</h3>
    <p class="muted" style="margin:6px 0 0;font-size:13px">A deterministic profile is computed for every task <b>without an LLM call</b>, so we don't pay to decide what to pay for.</p></div>
    <code class="mono" style="font-size:12.5px;background:var(--panel-2);padding:12px 14px;border-radius:10px;line-height:1.8">score = 0.35·size + 0.35·complexity + 0.30·risk<br>tier&nbsp;&nbsp;= score&lt;0.33 ? T1 : score&lt;0.66 ? T2 : T3<br>on validation failure → tier + 1 (clamped to persona range)</code></div></div>`;
  h += `<div class="section-title"><h2>Model catalogue</h2><span class="muted">via OpenRouter</span></div><div class="card"><table class="table"><thead><tr><th>Model</th><th>Vendor</th><th>Tier</th><th class="num">$/M in</th><th class="num">$/M out</th></tr></thead><tbody>
    ${Object.entries(c.models).map(([id, m]) => `<tr><td><b>${esc(m.label)}</b><div class="faint mono" style="font-size:11.5px">${esc(id)}</div></td><td class="muted">${esc(m.vendor)}</td><td>${tierChip(m.tier)}</td><td class="num">${m.in}</td><td class="num">${m.out}</td></tr>`).join('')}</tbody></table></div>`;
  if (S.run?.ledger.length) {
    h += `<div class="section-title"><h2>Routing log</h2><span class="muted">${esc(S.run.name)}</span></div><div class="card" style="overflow:auto"><table class="table"><thead><tr><th>Agent</th><th>Task</th><th class="num">Score</th><th>Routed to</th><th>Why</th></tr></thead><tbody>
      ${S.run.ledger.slice().reverse().map((e) => `<tr><td>${esc(e.agent)}</td><td class="mono" style="font-size:12px">${esc(e.task)}</td><td class="num">${e.route?.profile?.score != null ? e.route.profile.score.toFixed(2) : '–'}</td>
      <td><span class="chip t${e.tier}">${esc(model(e.model).label)}</span></td><td class="muted" style="font-size:12.5px">${esc(e.route?.reason || '')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  return h + forgeModal();
}

/* ============================== events ============================== */
const actions = {
  async sample() { const fd = new FormData(); fd.append('sample', 'legacy-bank'); await createRun(fd); },
  'open-run'(el) { go(`#/run/${el.dataset.id}/discover`); },
  async theme() {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('unitai-theme', next);
    render(true);
  },
  async discover() { await api(`/api/runs/${S.run.id}/discover`, { method: 'POST' }); await poll(); },
  tab(el) { S.ui.tab = el.dataset.tab; render(true); },
  module(el) { S.ui.module = el.dataset.path; render(true); },
  'toggle-src'(el) { const k = 'src:' + el.dataset.key; S.ui.editing[k] = !S.ui.editing[k]; render(true); },
  async edit(el) {
    const k = el.dataset.key;
    if (S.ui.editing[k]) {
      const ta = document.querySelector(`[data-edit="${CSS.escape(k)}"]`);
      if (ta) {
        if (k === 'design') { S.run.design.summary = ta.value; await api(`/api/runs/${S.run.id}/design`, { method: 'PUT', body: { summary: ta.value } }); }
        else { applyEdit(k, ta.value); await saveDocs(); }
        toast('Saved. The next agent will use your version.');
      }
    }
    S.ui.editing[k] = !S.ui.editing[k];
    render(true);
  },
  async 'approve-discover'() {
    S.run.notes = $('#notes')?.value || '';
    await saveDocs();
    await api(`/api/runs/${S.run.id}/approve/discover`, { method: 'POST' });
    await api(`/api/runs/${S.run.id}/design`, { method: 'POST' });
    S.ui.editing = {};
    go(`#/run/${S.run.id}/design`);
  },
  async design() { await api(`/api/runs/${S.run.id}/design`, { method: 'POST' }); await poll(); },
  async 'approve-design'() {
    const tasks = S.run.tasks.map((t) => ({ id: t.id, enabled: t.enabled, notes: document.querySelector(`[data-task-notes="${CSS.escape(t.id)}"]`)?.value ?? t.notes }));
    await api(`/api/runs/${S.run.id}/design`, { method: 'PUT', body: { tasks } });
    await api(`/api/runs/${S.run.id}/approve/design`, { method: 'POST' });
    await api(`/api/runs/${S.run.id}/build`, { method: 'POST' });
    go(`#/run/${S.run.id}/build`);
  },
  async build() { await api(`/api/runs/${S.run.id}/build`, { method: 'POST' }); await poll(); },
  code(el) { S.ui.codeTask = el.dataset.id || null; render(true); if (S.ui.codeTask) setTimeout(() => $('.code-split')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); },
  async verify() { await api(`/api/runs/${S.run.id}/verify`, { method: 'POST' }); go(`#/run/${S.run.id}/verify`); await poll(); },
  async fix() { await api(`/api/runs/${S.run.id}/fix`, { method: 'POST' }); await poll(); },
  cases(el) { S.ui.caseFilter = el.dataset.f; render(true); },
  // ---------- AgentForge ----------
  'forge-new'() { S.ui.forgeNew = 'builder'; S.ui.forgeEdit = null; render(true); setTimeout(() => $('#np-name')?.focus(), 30); },
  'forge-clone'(el) { S.ui.forgeNew = el.dataset.id; S.ui.forgeEdit = null; render(true); setTimeout(() => $('#np-name')?.focus(), 30); },
  'forge-edit'(el) { S.ui.forgeEdit = el.dataset.id; S.ui.forgeNew = null; render(true); },
  'forge-close'() { S.ui.forgeEdit = null; S.ui.forgeNew = null; render(true); },
  'forge-close-bg'() { actions['forge-close'](); },
  async 'forge-create'() {
    const name = $('#np-name').value.trim();
    if (!name) { $('#np-name').focus(); return toast('Give the persona a name', true); }
    const p = await api('/api/personas', { method: 'POST', body: { base: $('#np-base').value, name } });
    S.config = await api('/api/config');
    S.ui.forgeNew = null; S.ui.forgeEdit = p.id;
    render(true);
    toast(`${p.name} created on standby. Configure it, then activate it.`);
  },
  async 'forge-save'(el) {
    const id = el.dataset.id;
    const v = (k) => $('#pf-' + k)?.value;
    const body = {
      name: v('name'), glyph: v('glyph') || '◆', role: v('role'), description: v('description'), system: v('system'),
      model_override: v('model') || null, min_tier: +v('min'), max_tier: +v('max'), temperature: +v('temperature'),
      max_tokens: v('max_tokens') ? +v('max_tokens') : null,
    };
    await api(`/api/personas/${id}`, { method: 'PUT', body });
    if (el.dataset.activate) await api(`/api/personas/${id}/activate`, { method: 'POST' });
    S.config = await api('/api/config');
    S.ui.forgeEdit = null;
    render(true);
    toast(el.dataset.activate ? `${body.name} saved and now runs the pipeline` : `${body.name} saved`);
  },
  async 'forge-reset'(el) {
    await api(`/api/personas/${el.dataset.id}/reset`, { method: 'POST' });
    S.config = await api('/api/config');
    render(true);
    toast('Restored built-in defaults');
  },
  async 'forge-delete'(el) {
    const p = persona(el.dataset.id);
    if (!confirm(`Delete ${p.name}? If it is active, the built-in ${p.acts_as} takes over again.`)) return;
    await api(`/api/personas/${p.id}`, { method: 'DELETE' });
    S.config = await api('/api/config');
    S.ui.forgeEdit = null;
    render(true);
    toast(`${p.name} deleted`);
  },
  async 'forge-activate'(el) {
    const p = await api(`/api/personas/${el.dataset.id}/activate`, { method: 'POST' });
    S.config = await api('/api/config');
    render(true);
    toast(`${p.name} now runs the ${p.acts_as} stage`);
  },
  async 'forge-try'(el) {
    const out = $('#pg-out');
    const prompt = $('#pg-prompt').value.trim();
    if (!prompt) return toast('Write a prompt to test', true);
    el.disabled = true;
    out.innerHTML = `<div class="row muted" style="padding:10px 2px"><div class="spinner"></div>Calling the model…</div>`;
    try {
      const r = await api(`/api/personas/${el.dataset.id}/try`, { method: 'POST', body: {
        prompt, model: $('#pg-model').value || $('#pf-model').value || null, tier: +$('#pf-min').value,
        system: $('#pf-system').value, temperature: +$('#pf-temperature').value } });
      const saved = r.baseline_cost > 0 ? Math.max(0, Math.round((1 - r.cost / r.baseline_cost) * 100)) : 0;
      out.innerHTML = `<div class="pg-result"><div class="row wrap" style="gap:6px;margin-bottom:12px">
        <span class="chip t${r.tier}">${esc(model(r.model).label)}</span><span class="chip">${r.tokens_in} in · ${r.tokens_out} out</span>
        <span class="chip accent">${fmtCost(r.cost)}</span><span class="chip">${(r.latency_ms / 1000).toFixed(1)}s</span>
        ${saved ? `<span class="chip ok">${saved}% cheaper than ${esc(model(S.config.baseline).label)}</span>` : ''}${r.replayed ? '<span class="chip">replay</span>' : ''}</div>
        <div class="md">${md(r.text)}</div></div>`;
    } catch (e) {
      out.innerHTML = `<div class="banner bad" style="margin:0">⚠ ${esc(e.message)}</div>`;
    } finally { el.disabled = false; }
  },
};

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'forge-close-bg' && ev.target !== el) return; // clicks inside the modal
  ev.preventDefault();
  try { await actions[el.dataset.action]?.(el); } catch (e) { toast(e.message, true); }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  try {
    if (el.id === 'zipin' && el.files[0]) { const fd = new FormData(); fd.append('files', el.files[0], el.files[0].name); await createRun(fd); }
    if (el.id === 'dirin' && el.files.length) {
      const fd = new FormData();
      [...el.files].filter((f) => f.name.endsWith('.py') && !/(^|\/)(\.git|venv|\.venv|node_modules|__pycache__)\//.test(f.webkitRelativePath))
        .forEach((f) => fd.append('files', f, f.webkitRelativePath));
      await createRun(fd);
    }
    if (el.dataset.toggleTask) {
      const t = S.run.tasks.find((x) => x.id === el.dataset.toggleTask);
      t.enabled = el.checked;
      await api(`/api/runs/${S.run.id}/design`, { method: 'PUT', body: { tasks: [{ id: t.id, enabled: t.enabled, notes: t.notes }] } });
      el.blur();
      render(true);
    }
    if (el.dataset.tier) { await api('/api/config/tiers', { method: 'PUT', body: { [el.dataset.tier]: el.value } }); S.config = await api('/api/config'); el.blur(); render(true); toast('Tier model updated'); }
    if (el.dataset.persona) { await api(`/api/personas/${el.dataset.persona}`, { method: 'PUT', body: { model_override: el.value } }); S.config = await api('/api/config'); el.blur(); render(true); toast('Persona model updated'); }
    if (el.dataset.taskNotes) { const t = S.run.tasks.find((x) => x.id === el.dataset.taskNotes); t.notes = el.value; }
  } catch (e) { toast(e.message, true); }
});

document.addEventListener('dragover', (e) => { const d = $('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
document.addEventListener('dragleave', (e) => { if (e.target.id === 'drop') e.target.classList.remove('over'); });
document.addEventListener('drop', async (e) => {
  const d = $('#drop');
  if (!d) return;
  e.preventDefault();
  d.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (!f.name.endsWith('.zip')) return toast('Drop a .zip, or use "Choose folder"', true);
  const fd = new FormData(); fd.append('files', f, f.name); await createRun(fd);
});

$('#live-pill').addEventListener('click', () => {
  const app = $('.app');
  if (innerWidth > 1280) app.classList.remove('no-activity'); else app.classList.add('show-activity');
});
$('#toggle-activity').addEventListener('click', () => {
  const app = $('.app');
  if (innerWidth > 1280) app.classList.toggle('no-activity'); else app.classList.toggle('show-activity');
});

/* ============================== boot ============================== */
(async function boot() {
  const theme = store.get('unitai-theme');
  if (theme) document.documentElement.dataset.theme = theme;
  S.config = await api('/api/config');
  S.route = parseRoute();
  if (S.route.name === 'run') await loadRun(S.route.id);
  else S.runs = await api('/api/runs').catch(() => []);
  render(true);
  pollLive();
  setInterval(poll, 1200);
})();

/* ---------- AgentForge editor live bits ---------- */
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'pf-temperature') $('#pf-temp-v').textContent = (+ev.target.value).toFixed(2);
});
document.addEventListener('change', (ev) => {
  if (!['pf-min', 'pf-max', 'pf-model'].includes(ev.target.id)) return;
  let lo = +$('#pf-min').value, hi = +$('#pf-max').value;
  if (lo > hi) { if (ev.target.id === 'pf-min') $('#pf-max').value = hi = lo; else $('#pf-min').value = lo = hi; }
  $('.tier-ladder').innerHTML = tierLadder({ min_tier: lo, max_tier: hi, model_override: $('#pf-model').value || null });
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && (S.ui.forgeEdit || S.ui.forgeNew)) actions['forge-close']();
  if (ev.key === 'Enter' && ev.target.id === 'np-name') actions['forge-create']().catch((e) => toast(e.message, true));
});
