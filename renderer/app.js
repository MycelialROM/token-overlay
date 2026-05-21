'use strict';

// ─── PRICES (per 1M tokens, USD) ─────────────────────────────────────────────
const PRICES = {
  'claude-opus-4-7':           { inp: 15.0,  out: 75.0,  cr: 1.50,  cw: 18.75 },
  'claude-opus-4-6':           { inp: 15.0,  out: 75.0,  cr: 1.50,  cw: 18.75 },
  'claude-sonnet-4-6':         { inp: 3.0,   out: 15.0,  cr: 0.30,  cw: 3.75  },
  'claude-sonnet-4-5':         { inp: 3.0,   out: 15.0,  cr: 0.30,  cw: 3.75  },
  'claude-haiku-4-5':          { inp: 0.80,  out: 4.0,   cr: 0.08,  cw: 1.0   },
  'claude-haiku-4-5-20251001': { inp: 0.80,  out: 4.0,   cr: 0.08,  cw: 1.0   },
};

function priceFor(model) {
  if (!model) return PRICES['claude-sonnet-4-6'];
  const exact = PRICES[model];
  if (exact) return exact;
  for (const [k, v] of Object.entries(PRICES)) {
    if (model.startsWith(k)) return v;
  }
  return PRICES['claude-sonnet-4-6'];
}

function calcCosts(u) {
  const M = 1_000_000;
  const p = priceFor(u.model);
  const inp = (u.input_tokens          || 0) / M * p.inp;
  const out = (u.output_tokens         || 0) / M * p.out;
  const cr  = (u.cache_read_tokens     || 0) / M * p.cr;
  const cw  = (u.cache_creation_tokens || 0) / M * p.cw;
  return { inp, out, cr, cw, total: inp + out + cr + cw };
}

// ─── FORMATTING ───────────────────────────────────────────────────────────────
function fmtTok(n) {
  n = Math.round(n);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 100_000)   return (n / 1_000).toFixed(1) + 'K';
  if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toString();
}

function fmtCost(n) {
  if (n >= 10)   return '$' + n.toFixed(2);
  if (n >= 1)    return '$' + n.toFixed(3);
  if (n >= 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(5);
}

function fmtModel(m) {
  if (!m) return '—';
  return m
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

// ─── ANIMATED COUNTER ─────────────────────────────────────────────────────────
function animNum(el, from, to, dur, fmt) {
  if (Math.abs(to - from) < 0.000001) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const diff = to - from;
  function tick(now) {
    const p = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3); // cubic ease-out
    el.textContent = fmt(from + diff * e);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = fmt(to);
  }
  requestAnimationFrame(tick);
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let prev = {
  input_tokens: 0, output_tokens: 0,
  cache_read_tokens: 0, cache_creation_tokens: 0,
  total_cost_usd: 0, requests: 0,
  model: null, context_window: 200000,
  session_start: null, demo: true,
};
let collapsed  = false;
let pinned     = true;
let timerHandle = null;
let dragOrigin  = null;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const g = id => document.getElementById(id);
const el = {
  dot:       g('dot'),
  demoPill:  g('demoPill'),
  pctNum:    g('pctNum'),
  fill:      g('fill'),
  tokTotal:  g('tokTotal'),
  tokMax:    g('tokMax'),
  inpTok:    g('inpTok'),   outTok:  g('outTok'),
  crdTok:    g('crdTok'),   cwrTok:  g('cwrTok'),
  inpCost:   g('inpCost'),  outCost: g('outCost'),
  crdCost:   g('crdCost'),  cwrCost: g('cwrCost'),
  costVal:   g('costVal'),
  reqCount:  g('reqCount'),
  modelName: g('modelName'),
  sessTime:  g('sessTime'),
  miniPct:   g('miniPct'),
  miniCost:  g('miniCost'),
  miniFill:  g('miniFill'),
  body:      g('body'),
  mini:      g('mini'),
  colBtn:    g('colBtn'),
  xBtn:      g('xBtn'),
  pinBtn:    g('pinBtn'),
  bar:       g('bar'),
  apiToken:  g('apiToken'),
  apiPort:   g('apiPort'),
  dbMode:    g('dbMode'),
};

// ─── RENDER ───────────────────────────────────────────────────────────────────
function render(data) {
  const old = prev;
  prev = { ...prev, ...data };
  const D = 550; // animation duration ms

  // Demo badge
  el.demoPill.classList.toggle('on', !!data.demo);

  // Token counters
  animNum(el.inpTok, old.input_tokens          || 0, data.input_tokens          || 0, D, fmtTok);
  animNum(el.outTok, old.output_tokens         || 0, data.output_tokens         || 0, D, fmtTok);
  animNum(el.crdTok, old.cache_read_tokens     || 0, data.cache_read_tokens     || 0, D, fmtTok);
  animNum(el.cwrTok, old.cache_creation_tokens || 0, data.cache_creation_tokens || 0, D, fmtTok);

  // Costs
  const costs    = calcCosts(data);
  const oldCosts = calcCosts(old);
  animNum(el.inpCost,  oldCosts.inp,   costs.inp,   D, fmtCost);
  animNum(el.outCost,  oldCosts.out,   costs.out,   D, fmtCost);
  animNum(el.crdCost,  oldCosts.cr,    costs.cr,    D, fmtCost);
  animNum(el.cwrCost,  oldCosts.cw,    costs.cw,    D, fmtCost);

  const totalCost = data.total_cost_usd != null ? data.total_cost_usd : costs.total;
  animNum(el.costVal,  old.total_cost_usd || 0, totalCost, D, fmtCost);
  animNum(el.miniCost, old.total_cost_usd || 0, totalCost, D, fmtCost);

  // Tank
  const ctx      = data.context_window || 200000;
  const used     = (data.input_tokens || 0) + (data.output_tokens || 0);
  const oldUsed  = (old.input_tokens  || 0) + (old.output_tokens  || 0);
  const pct      = Math.min((used / ctx) * 100, 100);
  const pctStr   = pct.toFixed(1) + '%';

  el.fill.style.height = Math.max(pct, 2) + '%';

  el.fill.classList.toggle('warn', pct >= 60 && pct < 85);
  el.fill.classList.toggle('crit', pct >= 85);
  el.pctNum.classList.toggle('warn', pct >= 60 && pct < 85);
  el.pctNum.classList.toggle('crit', pct >= 85);

  animNum(el.pctNum,   (oldUsed / ctx) * 100, pct, D, v => Math.min(v, 100).toFixed(1));
  animNum(el.tokTotal, oldUsed, used, D, fmtTok);

  el.miniPct.textContent = pctStr;
  el.miniFill.style.width = Math.min(pct, 100) + '%';
  el.tokMax.textContent = ctx >= 1000 ? (ctx / 1000) + 'K' : ctx;

  // Requests
  const reqs = data.requests || 0;
  el.reqCount.textContent = reqs + ' request' + (reqs !== 1 ? 's' : '');

  // Model
  el.modelName.textContent = fmtModel(data.model);

  // Session start
  if (data.session_start && !prev.session_start) {
    prev.session_start = data.session_start;
    startTimer();
  } else if (data.session_start && data.session_start !== old.session_start) {
    prev.session_start = data.session_start;
    startTimer();
  }

  // Flash cost on change
  el.costVal.classList.remove('flash');
  requestAnimationFrame(() => el.costVal.classList.add('flash'));
}

// ─── SESSION TIMER ────────────────────────────────────────────────────────────
function startTimer() {
  if (timerHandle) clearInterval(timerHandle);
  updateTimer();
  timerHandle = setInterval(updateTimer, 30_000);
}

function updateTimer() {
  if (!prev.session_start) return;
  const ms   = Date.now() - new Date(prev.session_start).getTime();
  const mins = Math.floor(ms / 60_000);
  const hrs  = Math.floor(mins / 60);
  el.sessTime.textContent = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
}

// ─── DRAG ─────────────────────────────────────────────────────────────────────
el.bar.addEventListener('mousedown', e => {
  if (e.target.closest('.btn')) return;
  dragOrigin = { x: e.screenX, y: e.screenY };
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!dragOrigin) return;
  const dx = e.screenX - dragOrigin.x;
  const dy = e.screenY - dragOrigin.y;
  dragOrigin = { x: e.screenX, y: e.screenY };
  window.tok.drag({ dx, dy });
});
document.addEventListener('mouseup', () => { dragOrigin = null; });

// ─── CONTROLS ─────────────────────────────────────────────────────────────────
el.colBtn.addEventListener('click', () => {
  collapsed = !collapsed;
  el.body.classList.toggle('gone', collapsed);
  el.mini.classList.toggle('on',   collapsed);
  el.colBtn.textContent = collapsed ? '+' : '−';
  window.tok.collapse(collapsed);
});

el.xBtn.addEventListener('click', () => window.tok.close());

el.pinBtn.addEventListener('click', () => {
  pinned = !pinned;
  el.pinBtn.classList.toggle('on', pinned);
  el.pinBtn.title = pinned ? 'Unpin from top' : 'Pin on top';
  window.tok.pin(pinned);
});

// ─── API INFO ─────────────────────────────────────────────────────────────────
window.tok.onApiInfo(info => {
  el.apiToken.textContent = info.tokenPrefix;
  el.apiPort.textContent  = ':' + info.port;
  if (info.usingFallback) {
    el.dbMode.textContent = 'JSON';
    el.dbMode.classList.add('fallback');
    el.dbMode.title = 'SQLite unavailable — run npm run rebuild';
  } else {
    el.dbMode.textContent = 'SQLite';
    el.dbMode.title = 'Persistent SQLite storage active';
  }
});

// ─── IPC ──────────────────────────────────────────────────────────────────────
window.tok.onUpdate(data => render(data));
window.tok.onReset(() => {
  prev = {
    input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    total_cost_usd: 0, requests: 0,
    model: null, context_window: 200000,
    session_start: new Date().toISOString(), demo: false,
  };
  render(prev);
  startTimer();
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
(async () => {
  const init = await window.tok.getUsage();
  if (init) {
    if (!prev.session_start) prev.session_start = init.session_start;
    render(init);
  }
  if (!prev.session_start) prev.session_start = new Date().toISOString();
  startTimer();
  el.pinBtn.classList.add('on'); // starts pinned
})();
