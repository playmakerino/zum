// ads-trends: Meta Ads trends from Triple Whale, laid out like Shopify Analytics.
// /api/data?start&end returns one entry per day with 5 groups (all, tc, nontc, cat, rest),
// each { spend, imp, clk, rev, ord }. A comparison range is a second call.

const COLORS = ['#13acf0', '#133aaf']; // Shopify series 1 (measured), dark blue for series 2
const SVG_NS = 'http://www.w3.org/2000/svg';
let today = null;
let current = null; // { cur, prev, curRange, prevRange } of the last load
let loadSeq = 0;

// ── Dates (YYYY-MM-DD strings in the shop's time zone, as Triple Whale stores them)
const parseD = s => new Date(s + 'T00:00:00Z');
const fmtD = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return fmtD(d); };
const dayCount = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5) + 1;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = s => { const d = parseD(s); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
function rangeLabel(r) {
  const y = r.end.slice(0, 4);
  if (r.start === r.end) return `${shortDate(r.start)}, ${y}`;
  const y0 = r.start.slice(0, 4);
  return y0 === y ? `${shortDate(r.start)}–${shortDate(r.end)}, ${y}` : `${shortDate(r.start)}, ${y0}–${shortDate(r.end)}, ${y}`;
}

// "Last N days" = N full days ending yesterday: today is partial in Triple Whale (lags a few hours)
// and would drag every trend line down at the end (user 2026-10-28; Today / Yesterday removed too).
function currentRange() {
  const y = addDays(today, -1);
  return { start: addDays(y, 1 - Number($('rangeSelect').value)), end: y };
}
function compareRange(r) {
  const v = $('compareSelect').value;
  if (v === 'period') { const n = dayCount(r.start, r.end); return { start: addDays(r.start, -n), end: addDays(r.start, -1) }; }
  if (v === 'year') {
    const back = s => { const d = parseD(s); d.setUTCFullYear(d.getUTCFullYear() - 1); return fmtD(d); };
    return { start: back(r.start), end: back(r.end) };
  }
  return null;
}

// ── Metrics
const sumGroup = (days, g) => days.reduce((t, d) => { for (const k in t) t[k] += d[g][k]; return t; }, { spend: 0, imp: 0, clk: 0, rev: 0, ord: 0 });
const M = {
  spend: t => t.spend,
  cpm:   t => t.imp ? t.spend / t.imp * 1000 : null,
  cpc:   t => t.clk ? t.spend / t.clk : null,
  aov:   t => t.ord ? t.rev / t.ord : null,
  roas:  t => t.spend ? t.rev / t.spend : null,
  rev:   t => t.rev,
};
const money = v => v == null ? '–' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ratio = v => v == null ? '–' : v.toFixed(2);
const moneyAxis = v => '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: v < 10 ? 2 : 1 }).format(v);
const ratioAxis = v => v.toFixed(v < 10 ? 1 : 0);

const UP = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 2.5 9.5 7h-7z"/></svg>';
const DOWN = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 9.5 2.5 5h7z"/></svg>';
// change vs the comparison value; good = 'up' / 'down' / null (neutral grey)
function deltaHtml(cur, prev, good) {
  if (cur == null || prev == null || !prev) return prev === 0 && cur ? '<span class="delta">–</span>' : '';
  const pct = (cur - prev) / Math.abs(prev) * 100;
  const up = pct >= 0;
  const cls = !good || Math.abs(pct) < 0.05 ? '' : (up === (good === 'up') ? 'good' : 'bad');
  return `<span class="delta ${cls}">${up ? UP : DOWN}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%</span>`;
}

// ── Cards
const CARDS = [
  { id: 'c-spend', title: 'Ad spend', tip: 'Total Meta ad spend.', metric: 'spend', fmt: money, axis: moneyAxis, good: null, groups: [['all', 'Ad spend']] },
  { id: 'c-cpm', title: 'CPM', tip: 'Cost per 1,000 impressions: spend / impressions × 1,000.', metric: 'cpm', fmt: money, axis: moneyAxis, good: 'down', groups: [['all', 'CPM']] },
  { id: 'c-cpc', title: 'CPC', tip: 'Cost per click: spend / clicks (all clicks).', metric: 'cpc', fmt: money, axis: moneyAxis, good: 'down', groups: [['all', 'CPC']] },
  { id: 'c-aov', title: 'AOV', tip: 'Average order value: purchase value / purchases, as reported by Meta.', metric: 'aov', fmt: money, axis: moneyAxis, good: 'up', groups: [['all', 'AOV']] },
  { id: 'c-tc-spend', title: 'Ad spend', tip: 'Spend of campaigns named "TC | …" and of all other campaigns.', metric: 'spend', fmt: money, axis: moneyAxis, good: null, groups: [['tc', 'TC'], ['nontc', 'Non-TC']] },
  { id: 'c-tc-roas', title: 'ROAS', tip: 'Purchase value / spend of "TC | …" campaigns and of all other campaigns.', metric: 'roas', fmt: ratio, axis: ratioAxis, good: 'up', groups: [['tc', 'TC'], ['nontc', 'Non-TC']] },
  { id: 'c-cat-spend', title: 'Ad spend', tip: 'Spend of catalog ads (the creative uses a catalog product set) and of all other ads.', metric: 'spend', fmt: money, axis: moneyAxis, good: null, groups: [['cat', 'Catalog'], ['rest', 'Other ads']] },
  { id: 'c-cat-roas', title: 'ROAS', tip: 'Purchase value / spend of catalog ads and of all other ads.', metric: 'roas', fmt: ratio, axis: ratioAxis, good: 'up', groups: [['cat', 'Catalog'], ['rest', 'Other ads']] },
];

function renderCard(cfg) {
  const el = $(cfg.id);
  const { cur, prev, curRange, prevRange } = current;
  const fn = M[cfg.metric];
  const series = cfg.groups.map(([g, name], i) => ({
    name, color: COLORS[i],
    values: cur.days.map(d => fn(d[g])),
    prevValues: prev ? prev.days.map(d => fn(d[g])) : null,
    total: fn(sumGroup(cur.days, g)),
    prevTotal: prev ? fn(sumGroup(prev.days, g)) : null,
  }));
  const head = series.length === 1
    ? `<div class="metric-value-row"><span class="metric-value">${cfg.fmt(series[0].total)}</span>${prev ? deltaHtml(series[0].total, series[0].prevTotal, cfg.good) : ''}</div>`
    : `<div class="metric-split">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)} <b>${cfg.fmt(s.total)}</b> ${prev ? deltaHtml(s.total, s.prevTotal, cfg.good) : ''}</span>`).join('')}</div>`;
  const legend = series.length === 1
    ? [`<span><i style="background:${series[0].color}"></i>${rangeLabel(curRange)}</span>`, prev ? `<span><i class="dash" style="color:${series[0].color}"></i>${rangeLabel(prevRange)}</span>` : ''].join('')
    : series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') + (prev ? `<span><i class="dash" style="color:#8a8a8a"></i>${rangeLabel(prevRange)}</span>` : '');
  el.innerHTML = `<div class="metric-head"><span class="metric-title" data-tip-title="${esc(cfg.title)}" data-tip="${esc(cfg.tip)}">${esc(cfg.title)}</span>${head}</div><div class="chart"></div><div class="legend">${legend}</div>`;
  drawChart(el.querySelector('.chart'), cur.days.map(d => d.date), prev ? prev.days.map(d => d.date) : null, series, cfg);
}

// ── Line chart (SVG): y axis labels left, grid lines, x labels bottom, dashed comparison lines,
// hover = vertical line + dots + tooltip card listing every series on that day
function niceStep(max, ticks) {
  const raw = max / ticks, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
}

function drawChart(box, dates, prevDates, series, cfg) {
  const all = series.flatMap(s => [...s.values, ...(s.prevValues || [])]).filter(v => v != null);
  if (!all.length || all.every(v => v === 0)) { box.innerHTML = '<div class="chart-empty">No data for this date range</div>'; return; }
  const W = box.clientWidth, H = box.clientHeight;
  const step = niceStep(Math.max(...all) || 1, 4);
  const yMax = step * Math.ceil((Math.max(...all) || 1) / step);
  const ticks = []; for (let v = 0; v <= yMax + step / 2; v += step) ticks.push(v);
  const padL = Math.max(...ticks.map(t => cfg.axis(t).length)) * 6.5 + 10, padR = 8, padT = 8, padB = 22;
  const n = dates.length;
  const x = i => padL + (n === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1));
  const y = v => padT + (H - padT - padB) * (1 - v / yMax);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let s = '';
  for (const t of ticks) {
    s += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text class="axis" x="0" y="${y(t) + 4}">${cfg.axis(t)}</text>`;
  }
  const labelCount = Math.min(n, W < 400 ? 3 : 5);
  const labelIdx = labelCount === 1 ? [0] : [...new Set(Array.from({ length: labelCount }, (_, k) => Math.round(k * (n - 1) / (labelCount - 1))))];
  for (const i of labelIdx) s += `<text class="axis" x="${x(i)}" y="${H - 4}" text-anchor="${i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}">${shortDate(dates[i])}</text>`;
  const path = vals => { let d = '', pen = false; vals.forEach((v, i) => { if (i >= n || v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
  for (const se of series) if (se.prevValues) s += `<path d="${path(se.prevValues)}" fill="none" stroke="${se.color}" stroke-opacity=".45" stroke-width="2" stroke-dasharray="4 4" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const se of series) {
    s += `<path d="${path(se.values)}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (n === 1 && se.values[0] != null) s += `<circle cx="${x(0)}" cy="${y(se.values[0])}" r="3" fill="${se.color}"/>`;
  }
  s += `<line class="hover-line" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/>`;
  s += series.map(se => `<circle class="hover-dot" r="4" fill="#fff" stroke="${se.color}" stroke-width="2" visibility="hidden"/>`).join('');
  s += `<rect x="${padL}" y="0" width="${Math.max(0, W - padL - padR)}" height="${H}" fill="transparent"/>`;
  svg.innerHTML = s;
  box.innerHTML = '';
  box.appendChild(svg);

  const vline = svg.querySelector('.hover-line'), dots = svg.querySelectorAll('.hover-dot'), tip = $('chartTip');
  svg.querySelector('rect').addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect();
    const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - padL) / ((W - padL - padR) / (n - 1)))));
    vline.setAttribute('x1', x(i)); vline.setAttribute('x2', x(i)); vline.setAttribute('visibility', 'visible');
    series.forEach((se, k) => {
      const v = se.values[i];
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); }
    });
    const rows = series.map(se => `<div class="tip-row"><span><i style="background:${se.color}"></i>${series.length > 1 ? esc(se.name) + ', ' : ''}${shortDate(dates[i])}</span><b>${cfg.fmt(se.values[i])}</b></div>`
      + (se.prevValues && prevDates?.[i] ? `<div class="tip-row"><span><i style="background:${se.color};opacity:.45"></i>${series.length > 1 ? esc(se.name) + ', ' : ''}${shortDate(prevDates[i])}${prevDates[i].slice(0, 4) !== dates[i].slice(0, 4) ? ', ' + prevDates[i].slice(0, 4) : ''}</span><b>${cfg.fmt(se.prevValues[i])}</b></div>` : '')).join('');
    tip.innerHTML = rows;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight, vw = document.documentElement.clientWidth;
    let left = e.clientX + 16; if (left + tw > vw - 8) left = e.clientX - tw - 16;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, Math.min(e.clientY - th / 2, window.innerHeight - th - 8)) + 'px';
  });
  svg.querySelector('rect').addEventListener('mouseleave', () => {
    tip.hidden = true; vline.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden'));
  });
}

// ── Breakdown tables (one per split): spend, share of spend, purchase value, ROAS, purchases, AOV
function renderTable(id, groups) {
  const { cur, prev } = current;
  const rows = groups.map(([g, name], i) => ({ name, color: COLORS[i], t: sumGroup(cur.days, g), p: prev ? sumGroup(prev.days, g) : null }));
  const total = sumGroup(cur.days, 'all'), totalP = prev ? sumGroup(prev.days, 'all') : null;
  const cols = [
    ['Ad spend', t => t.spend, money, null],
    ['% of spend', t => total.spend ? t.spend / total.spend * 100 : null, v => v == null ? '–' : v.toFixed(1) + '%', null, true],
    ['Purchase value', t => t.rev, money, 'up'],
    ['ROAS', M.roas, ratio, 'up'],
    ['Purchases', t => t.ord, v => Math.round(v).toLocaleString('en-US'), 'up'],
    ['AOV', M.aov, money, 'up'],
    ['CPM', M.cpm, money, 'down'],
    ['CPC', M.cpc, money, 'down'],
  ];
  const cell = (t, p, [, fn, fmt, good, noDelta]) => `<td class="td-metric">${fmt(fn(t))}${p && !noDelta ? ' ' + deltaHtml(fn(t), fn(p), good) : ''}</td>`;
  $(id).innerHTML = `<div class="table-scroll"><table><thead><tr><th>Group</th>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>
    <tr class="total-row"><td>Total</td>${cols.map(c => cell(total, totalP, c)).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr><td><span class="swatch" style="background:${r.color}"></span>${esc(r.name)}</td>${cols.map(c => cell(r.t, r.p, c)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ── Revenue by product created month: last 12 months of the range + one "Older" column.
// Bars = selected range, dashed marks = comparison range.
let products = null; // { cur, prev, curRange, prevRange } or { error }
function renderProducts() {
  const el = $('c-products');
  const title = 'Revenue by product created month';
  const tip = 'Product revenue after discounts (no shipping, no tax) of orders Triple Whale attributes to Meta, by the month the product was created. Older also holds products no longer on Shopify.';
  const draw = (head, legend) => {
    el.innerHTML = `<div class="metric-head"><span class="metric-title" data-tip-title="${title}" data-tip="${tip}">${title}</span>${head}</div><div class="chart"></div><div class="legend">${legend}</div>`;
    return el.querySelector('.chart');
  };
  if (!products || products.error) {
    draw('', '').innerHTML = `<div class="chart-empty">${products ? esc(products.error) : 'Loading…'}</div>`;
    return;
  }
  const { cur, prev, curRange, prevRange } = products;
  const [ey, em] = curRange.end.split('-').map(Number);
  const keys = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(ey, em - 12 + i, 1)).toISOString().slice(0, 7));
  const fold = data => {
    const out = [0, ...keys.map(k => data.months[k] || 0)];
    for (const [m, v] of Object.entries(data.months)) if (m < keys[0]) out[0] += v;
    return out;
  };
  const vals = fold(cur), prevVals = prev ? fold(prev) : null;
  const total = a => a.reduce((x, y) => x + y, 0);
  const short = ['Older', ...keys.map(k => MONTHS[Number(k.slice(5)) - 1])];
  const full = [`Created before ${short[1]} ${keys[0].slice(0, 4)}`, ...keys.map((k, i) => `Created ${short[i + 1]} ${k.slice(0, 4)}`)];
  const box = draw(
    `<div class="metric-value-row"><span class="metric-value">${money(total(vals))}</span>${prev ? deltaHtml(total(vals), total(prevVals), 'up') : ''}</div>`,
    `<span><i style="background:${COLORS[0]}"></i>${rangeLabel(curRange)}</span>` + (prev ? `<span><i class="dash" style="color:${COLORS[1]}"></i>${rangeLabel(prevRange)}</span>` : ''));
  const max = Math.max(...vals, ...(prevVals || []));
  if (max <= 0) { box.innerHTML = '<div class="chart-empty">No data for this date range</div>'; return; }
  const W = box.clientWidth, H = box.clientHeight, n = vals.length;
  const step = niceStep(max, 4), yMax = step * Math.ceil(max / step);
  const ticks = []; for (let v = 0; v <= yMax + step / 2; v += step) ticks.push(v);
  const padL = Math.max(...ticks.map(t => moneyAxis(t).length)) * 6.5 + 10, padR = 8, padT = 8, padB = 22;
  const bw = (W - padL - padR) / n;
  const y = v => padT + (H - padT - padB) * (1 - Math.max(0, v) / yMax);
  let s = '';
  for (const t of ticks) s += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="0" y="${y(t) + 4}">${moneyAxis(t)}</text>`;
  const every = bw < 34 ? 3 : 1;
  vals.forEach((v, i) => {
    const x = padL + i * bw, x1 = x + bw * .2, w = bw * .6;
    s += `<rect x="${x1}" y="${y(v)}" width="${w}" height="${H - padB - y(v)}" rx="2" fill="${COLORS[0]}"/>`;
    if (prevVals) s += `<line x1="${x1}" x2="${x1 + w}" y1="${y(prevVals[i])}" y2="${y(prevVals[i])}" stroke="${COLORS[1]}" stroke-width="2" stroke-dasharray="4 4"/>`;
    if (i % every === 0) s += `<text class="axis" x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${short[i]}</text>`;
    s += `<rect class="bar-hit" data-i="${i}" x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"/>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${s}</svg>`;
  const card = $('chartTip');
  const row = (color, r, v, sum) => `<div class="tip-row"><span><i style="background:${color}"></i>${rangeLabel(r)}</span><b>${money(v)} (${sum ? (v / sum * 100).toFixed(1) : 0}%)</b></div>`;
  box.querySelectorAll('.bar-hit').forEach(hit => {
    const i = Number(hit.dataset.i);
    hit.addEventListener('mousemove', e => {
      card.innerHTML = `<b>${full[i]}</b>` + row(COLORS[0], curRange, vals[i], total(vals)) + (prevVals ? row(COLORS[1], prevRange, prevVals[i], total(prevVals)) : '');
      card.hidden = false;
      const tw = card.offsetWidth, th = card.offsetHeight, vw = document.documentElement.clientWidth;
      let left = e.clientX + 16; if (left + tw > vw - 8) left = e.clientX - tw - 16;
      card.style.left = Math.max(8, left) + 'px';
      card.style.top = Math.max(8, Math.min(e.clientY - th / 2, window.innerHeight - th - 8)) + 'px';
    });
    hit.addEventListener('mouseleave', () => { card.hidden = true; });
  });
}

// own request: a failure here shows in this card only
async function loadProducts(seq, curRange, prevRange, refresh) {
  products = null;
  renderProducts();
  const get = async r => {
    const res = await fetch(`/api/products?start=${r.start}&end=${r.end}${refresh ? '&refresh=1' : ''}`);
    if (!res.ok) throw await httpError(res);
    return res.json();
  };
  let next;
  try {
    const [cur, prev] = await Promise.all([get(curRange), prevRange ? get(prevRange) : null]);
    next = { cur, prev, curRange, prevRange };
  } catch (err) {
    next = { error: `${err.message}${err.detail ? ': ' + formatErrorDetail(err.detail) : ''}` };
  }
  if (seq !== loadSeq) return;
  products = next;
  renderProducts();
}

function renderAll() {
  renderProducts();
  if (!current) return;
  CARDS.forEach(renderCard);
  renderTable('t-tc', [['tc', 'TC campaigns'], ['nontc', 'Other campaigns']]);
  renderTable('t-cat', [['cat', 'Catalog ads'], ['rest', 'Other ads']]);
  const unknown = current.cur.catalogUnknown;
  $('footnote').textContent = 'Data: Triple Whale (Meta Ads, purchase value = Meta omni purchase value). Ranges end yesterday.'
    + (unknown ? ` ${unknown} creatives could not be read from Meta and are counted as other ads.` : '');
  $('updatedAt').textContent = 'Updated ' + new Date(current.cur.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function getRange(r, refresh) {
  const res = await fetch(`/api/data?start=${r.start}&end=${r.end}${refresh ? '&refresh=1' : ''}`);
  if (!res.ok) throw await httpError(res);
  return res.json();
}

async function load(refresh = false) {
  const seq = ++loadSeq;
  const curRange = currentRange(), prevRange = compareRange(curRange);
  loadProducts(seq, curRange, prevRange, refresh);
  document.body.classList.add('loading');
  lockLoadButtons(true);
  try {
    const [cur, prev] = await Promise.all([getRange(curRange, refresh), prevRange ? getRange(prevRange, refresh) : null]);
    if (seq !== loadSeq) return; // a newer selection is loading
    current = { cur, prev, curRange, prevRange };
    renderAll();
  } catch (err) {
    if (seq === loadSeq) toast(`${err.message}${err.detail ? ': ' + formatErrorDetail(err.detail) : ''}`, 'error');
  } finally {
    if (seq === loadSeq) { document.body.classList.remove('loading'); lockLoadButtons(false); }
  }
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderAll, 150); });

(async () => {
  today = (await (await fetch('/api/today')).json()).today;
  load();
})();
