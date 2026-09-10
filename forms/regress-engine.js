#!/usr/bin/env node
// regress-engine.js - prove an edit to the compositor SHARED BLOCK did not change a single output byte.
//
//   node regress-engine.js run <page.html> <out.json>     run the block of that page over all garments
//   node regress-engine.js compare <a.json> <b.json>      diff two runs (exit 1 when any hash differs)
//
// It extracts the block between the "// ===== SHARED BLOCK" / "// ===== END SHARED BLOCK" markers, runs it
// in node-canvas over every garment in GARMENTS (2 flatlays + 10 model photos, mocks and maps cached from the
// CDN in the OS temp dir), and hashes every analysis field plus the composed pixels of two compose() calls
// per garment (with trim + model calibration, and without). ~30 s per run. Deterministic, so the same page
// twice gives the same json. Typical use:
//   node regress-engine.js run flatlay-composite.html before.json   (on the committed page)
//   ...edit the block...
//   node regress-engine.js run flatlay-composite.html after.json && node regress-engine.js compare before.json after.json
// Needs the `canvas` npm package resolvable from here (npm i canvas in a scratch dir, then NODE_PATH=<dir>/node_modules).
// The block only needs document.createElement('canvas'), Image, createImageBitmap and fetch, all shimmed below.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { createCanvas, loadImage, Image, ImageData } = require('canvas');

const [,, cmd, arg1, arg2] = process.argv;
if (cmd === 'compare') { process.exit(compare(arg1, arg2)); }
if (cmd !== 'run' || !arg1 || !arg2) { console.error('usage: run <page.html> <out.json> | compare <a.json> <b.json>'); process.exit(2); }

function compare(a, b) {
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'ms' || k === 'analyzeMs') ? undefined : v));
  const A = strip(JSON.parse(fs.readFileSync(a, 'utf8'))), B = strip(JSON.parse(fs.readFileSync(b, 'utf8')));
  let bad = 0;
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)]))
    if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) { bad++; console.log('DIFF', k); }
  console.log(bad ? 'MISMATCH ' + bad : 'IDENTICAL over ' + Object.keys(A).length + ' keys');
  return bad ? 1 : 0;
}

const html = fs.readFileSync(arg1, 'utf8');
// The page-local GARMENT DATA block (CDN, V, GARMENTS, FLAT_KEYS, model helpers) sits just above the SHARED
// BLOCK engine; eval both together so GARMENTS/FLAT_KEYS/modelName resolve. The engine itself stays equal
// across pages (sync-shared.ps1); the garment table differs (the dev tool lists more garments than the form).
const a = html.indexOf('// ===== GARMENT DATA'), b = html.indexOf('// ===== END SHARED BLOCK =====');
if (a < 0 || b < a) throw new Error('garment-data / shared-block markers missing in ' + arg1);
const shared = html.slice(a, b);

const document = { createElement: () => createCanvas(1, 1) };
const createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));
global.window = {};
const ASSETS = path.join(os.tmpdir(), 'zum-regress-assets'); fs.mkdirSync(ASSETS, { recursive: true });
// CDN -> local cache -> data URI. loadImg sets Image.src, loadPng does fetch(url).blob(): node's fetch takes data: URIs.
async function cached(url) {
  const name = url.split('/').pop().replace(/\?v=/, '_v'), p = path.join(ASSETS, name);
  if (!fs.existsSync(p)) {
    const r = await fetch(url, { headers: { Accept: 'image/png' } });
    if (!r.ok) throw new Error('download failed: ' + url);
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
  return 'data:' + (/\.png/.test(name) ? 'image/png' : 'image/jpeg') + ';base64,' + fs.readFileSync(p).toString('base64');
}
const eng = new Function('document', 'Image', 'ImageData', 'createImageBitmap', 'fetch', 'window',
  shared + '\nreturn {GARMENTS,FLAT_KEYS,modelName,analyzeGarment,compose,dominantColor,trimHexFrom,genderFromHex,parseHex,hexToRgb,rgbToHsv,hsvToRgb};')
  (document, Image, ImageData, createImageBitmap, (u, o) => fetch(u, o), global.window);

// grid + directional glyph pattern: shows grain, phase and seam behaviour; a symmetric print would hide them
function makePattern() {
  const n = 480, cell = 60, c = createCanvas(n, n), d = c.getContext('2d');
  d.fillStyle = '#faf3ea'; d.fillRect(0, 0, n, n);
  const cols = ['#4678c8', '#d25a50', '#5aa06e', '#b48c3c']; let ci = 0;
  d.font = 'bold 40px sans-serif'; d.textBaseline = 'top';
  for (let gy = 0; gy < n; gy += cell) for (let gx = 0; gx < n; gx += cell) {
    d.strokeStyle = '#969696'; d.strokeRect(gx, gy, cell, cell);
    d.fillStyle = cols[ci++ % 4]; d.fillText('A', gx + 16, gy + 8);
  }
  return c;
}
const h = buf => crypto.createHash('sha1').update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)).digest('hex').slice(0, 16);
const hj = v => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);

(async () => {
  const out = {};
  const patImg = await loadImage(makePattern().toBuffer('image/png'));
  const c = eng.dominantColor(patImg); out.dominant = c; out.trimHex = c && eng.trimHexFrom(...c);
  out.gender = { blue: eng.genderFromHex('#4678c8'), pink: eng.genderFromHex('#d070b0'), grey: eng.genderFromHex('#888888'), bad: eng.genderFromHex('zz') };
  out.hsv = hj([eng.rgbToHsv(255, 250, 240), eng.hsvToRgb(0.3, 0.5, 0.7), eng.parseHex(' #AbCdEf '), eng.hexToRgb('ABCDEF')]);
  const trim = eng.hexToRgb('4678C8');
  for (const key of eng.FLAT_KEYS) {
    const g = eng.GARMENTS[key];
    const flats = g.flats || [g.flat];   // dev tool: flats:[...]; form: flat (single)
    const specs = [...flats.map((f, i) => [flats.length > 1 ? 'flat' + (i + 1) : 'flat', f, false]),
                   ...g.models.map(m => [eng.modelName(m), m, true])];
    let cal = null;
    for (const [name, spec, model] of specs) {
      const s = { mock: await cached(spec.mock), map: await cached(spec.map) };
      const t0 = Date.now();
      const G = await eng.analyzeGarment(s, model);
      const analyzeMs = Date.now() - t0;
      if (!model && cal === null) cal = G.gw / G.bodyW;   // first flatlay calibrates the models
      const arr = x => Array.from(x);
      const rec = {
        w: G.w, h: G.h, ids: h(G.ids), box: G.box, gw: G.gw, bodyW: G.bodyW, Lref: G.Lref, Fref: G.Fref,
        cnt: hj(arr(G.cnt)), cx: hj(arr(G.cx)), cy: hj(arr(G.cy)), cs: hj(arr(G.cs)), sn: hj(arr(G.sn)),
        pbox: hj(G.pbox.map(arr)), ext: hj([G.ext.x0, G.ext.x1, G.ext.y0, G.ext.y1].map(arr)),
        axes: G.axes.map((A, k) => A ? { k, n: A.n, px: h(A.px), py: h(A.py), s: h(A.s), wP: h(A.wP), wN: h(A.wN), fP: h(A.fP), fN: h(A.fN), near: h(A.near) } : null).filter(Boolean),
        tlo: G.tlo ? h(G.tlo) : null, analyzeMs, runs: [],
      };
      for (const [sc, tr] of [[1.0, trim], [0.7, null]]) {
        const t1 = Date.now();
        const disp = eng.compose(G, patImg, sc, tr, model ? cal : undefined);
        const d = disp.getContext('2d').getImageData(0, 0, disp.width, disp.height).data;
        rec.runs.push({ sc, trim: !!tr, w: disp.width, h: disp.height, px: h(d), ms: Date.now() - t1 });
      }
      out[key + '/' + name] = rec;
      console.log(key, name, 'analyze', analyzeMs + 'ms', 'compose', rec.runs.map(r => r.ms + 'ms').join('/'), rec.runs[0].px);
    }
  }
  fs.writeFileSync(arg2, JSON.stringify(out, null, 1));
  console.log('wrote', arg2);
})().catch(e => { console.error('ERR', e); process.exit(1); });
