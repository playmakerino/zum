// split-render.js - pajama set with a DIFFERENT config for top and pants (pattern-mockup.html only has one trim + one rest).
//   node split-render.js <page.html> <outdir> <garmentKey> <topPat> <pantsPat> <topBg> <topTrim> <pantsTrim>
// Top = topPat as Body + rest (body file on panel 1, rest + body background = topBg, trim topTrim); pants = pantsPat all-over,
// trim pantsTrim. Each view is composed twice with the real SHARED BLOCK engine, then merged per pixel by an owner mask
// (top / pants) built from the map: fabric ids by set (default pants 4,5,7,8), trim per connected component (thin necks
// split by eroding ERODE px): touches a top non-body panel -> top, else touches pants -> pants.
// env: OVR=split-render-ovr.json  per-view fixes {view:{pants:[ids], rects:[[x0,y0,x1,y1,owner(1 top|2 pants),id?]], trim:[[nx,ny,owner]]}}
//      (trim = nearest trim component centroid; the run prints "trim" T/P size@cx,cy and per-id centroids "c" to pick them)
//      ONLY=view1,view2   IDVIS=1 (write the map coloured by id instead of rendering)   BR_MUL=1.05 (body print x)   FRAC=0.75
// Needs `canvas`: NODE_PATH=<dir>/node_modules (npm i canvas in the scratchpad). Contact sheet: split-sheet.js <dir> <garmentKey> <out.jpg>
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { createCanvas, loadImage, Image, ImageData } = require('canvas');
const [,, page, outdir, key, topPatF, pantsPatF, topBgH, topTrimH, pantsTrimH] = process.argv;
const html = fs.readFileSync(page, 'utf8');
const a = html.indexOf('// ===== GARMENT DATA'), b = html.indexOf('// ===== END SHARED BLOCK =====');
const shared = html.slice(a, b);
const document = { createElement: () => createCanvas(1, 1) };
const createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));
const ASSETS = path.join(os.tmpdir(), 'zum-regress-assets'); fs.mkdirSync(ASSETS, { recursive: true });
async function cached(url) {
  const name = url.split('/').pop().replace(/\?v=/, '_v'), p = path.join(ASSETS, name);
  if (!fs.existsSync(p)) { const r = await fetch(url); if (!r.ok) throw new Error('dl ' + url); fs.writeFileSync(p, Buffer.from(await r.arrayBuffer())); }
  return 'data:' + (/\.png/.test(name) ? 'image/png' : 'image/jpeg') + ';base64,' + fs.readFileSync(p).toString('base64');
}
const eng = new Function('document', 'Image', 'ImageData', 'createImageBitmap', 'fetch', 'window',
  shared + '\nreturn {GARMENTS,modelName,viewId,analyzeGarment,compose,bodyOpt,bodyBr,parseHex,hexToRgb};')
  (document, Image, ImageData, createImageBitmap, (u, o) => fetch(u, o), {});
const rgb = h => eng.hexToRgb(eng.parseHex(h));
const TOP = new Set([1, 2, 3, 6]), PANTS = new Set([4, 5, 7, 8]);   // default pants ids (model maps differ: see ovr json)
const BR_MUL = +(process.env.BR_MUL || 1), FRAC = +(process.env.FRAC || 0.75);

(async () => {
  fs.mkdirSync(outdir, { recursive: true });
  const topPat = await loadImage(fs.readFileSync(topPatF)), pantsPat = await loadImage(fs.readFileSync(pantsPatF));
  const bg = rgb(topBgH), tTrim = rgb(topTrimH), pTrim = rgb(pantsTrimH);
  const g = eng.GARMENTS[key];
  const views = [...g.flats.map(v => [v, false]), ...g.models.map(v => [v, true])];
  const ana = async (v, m) => eng.analyzeGarment({ mock: await cached(v.mock), map: await cached(v.map) }, m);
  const rf = g.flats[g.bodyRef || 0]; const BR = eng.bodyBr(await ana(rf, false), rf.r);
  const lopt = { center: true, body: { frac: FRAC, bg }, rest: { solid: bg } };
  for (const [v, model] of views) {
    const G = await ana(v, model);
    const name = v.mock.split('/').pop().replace(/^zum-(flatlay-mock|model)-/, '').replace(/\.(jpg|png).*$/, '');
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) continue;
    if (process.env.IDVIS) { const W = G.w, H = G.h, [x0, y0, x1, y1] = G.ebox, EW = x1 - x0 + 1, sc = 0.25;
      const CL = [[0,0,0],[230,230,230],[60,120,255],[0,200,200],[255,60,60],[255,170,0],[160,0,255],[0,180,0],[255,0,200],[40,40,40]];
      const c = createCanvas(Math.round(W * sc), Math.round(H * sc)), d = c.getContext('2d'); d.drawImage(G.mockImg, 0, 0, c.width, c.height);
      const im = d.getImageData(0, 0, c.width, c.height), sx = {}, sy = {}, n = {};
      for (let Y = 0; Y < c.height; Y++) for (let X = 0; X < c.width; X++) { const x = Math.floor(X / sc), y = Math.floor(Y / sc);
        if (x < x0 || x > x1 || y < y0 || y > y1) continue; const k = G.ids[(y - y0) * EW + x - x0]; if (!k || k > 9) continue;
        const o = (Y * c.width + X) * 4; for (let q = 0; q < 3; q++) im.data[o + q] = im.data[o + q] * 0.35 + CL[k][q] * 0.65;
        sx[k] = (sx[k] || 0) + X; sy[k] = (sy[k] || 0) + Y; n[k] = (n[k] || 0) + 1; }
      d.putImageData(im, 0, 0); d.font = 'bold 40px sans-serif'; d.lineWidth = 6;
      for (const k in n) if (k != 9) { const X = sx[k] / n[k], Y = sy[k] / n[k]; d.strokeStyle = '#fff'; d.strokeText(k, X, Y); d.fillStyle = '#000'; d.fillText(k, X, Y); }
      fs.writeFileSync(path.join(outdir, key + '_' + name + '.jpg'), c.toBuffer('image/jpeg', { quality: 0.8 })); console.log('idvis', name); continue; }
    const top = eng.compose(G, topPat, v.r, tTrim, eng.bodyOpt(lopt, G, v, (v.br || BR) * BR_MUL));
    const tw = top.width, th = top.height, td = top.getContext('2d').getImageData(0, 0, tw, th);
    const pants = eng.compose(G, pantsPat, v.r, pTrim, { center: true });
    const pd = pants.getContext('2d').getImageData(0, 0, tw, th).data;
    // owner map at analysis size: 1 = top, 2 = pants, trim -> nearest fabric owner (BFS)
    const W = G.w, H = G.h, [x0, y0, x1, y1] = G.ebox, EW = x1 - x0 + 1, EH = y1 - y0 + 1;
    const own = new Uint8Array(W * H), hist = {};
    const OVA = (process.env.OVR ? JSON.parse(fs.readFileSync(process.env.OVR, 'utf8')) : {})[name] || {};
    const VP = new Set(OVA.pants || [...PANTS]), RECTS = OVA.rects || [];   // rects: [x0,y0,x1,y1,owner(,id)] normalised
    const id = new Uint8Array(EW * EH); id.set(G.ids.subarray(0, EW * EH));
    for (let e = 0; e < G.edge.j.length; e++) if (!id[G.edge.j[e]]) id[G.edge.j[e]] = G.edge.k[e];
    let q = [];
    for (let j = 0; j < EW * EH; j++) { const k = id[j]; if (!k) continue; hist[k] = (hist[k] || 0) + 1;
      const i = (y0 + ((j / EW) | 0)) * W + x0 + j % EW;
      if (k === 9) continue; let o = VP.has(k) ? 2 : 1; const nx = (i % W) / W, ny = ((i / W) | 0) / H;
      for (const [a, b, c, d, oo, kk] of RECTS) if (nx >= a && nx <= c && ny >= b && ny <= d && (kk === undefined || kk === k)) o = oo;
      own[i] = o; }
    const isTrim = new Uint8Array(W * H);
    for (let j = 0; j < EW * EH; j++) if (id[j] === 9) isTrim[(y0 + ((j / EW) | 0)) * W + x0 + j % EW] = 1;
    // trim: per connected component. Touches a sleeve (2/3) or the collar inside (6) -> top; else touches pants -> pants; else top
    const fab = new Uint8Array(W * H);
    for (let j = 0; j < EW * EH; j++) fab[(y0 + ((j / EW) | 0)) * W + x0 + j % EW] = id[j];
    const nb = i => { const x = i % W; return [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W].filter(n => n >= 0 && n < W * H); };
    // split trim regions joined by a thin neck (cuff lying on the waistband): erode ER px, label, grow labels back inside the trim
    const ER = +(process.env.ERODE || 8); let ero = isTrim.slice();
    for (let it = 0; it < ER; it++) { const nx = ero.slice(); for (let i = 0; i < W * H; i++) if (ero[i]) for (const n of nb(i)) if (!ero[n]) { nx[i] = 0; break; } ero = nx; }
    const lab = new Int32Array(W * H); let L = 0, fr = [];
    for (let s = 0; s < W * H; s++) { if (!ero[s] || lab[s]) continue; lab[s] = ++L; const st = [s];
      while (st.length) { const i = st.pop(); fr.push(i); for (const n of nb(i)) if (ero[n] && !lab[n]) { lab[n] = L; st.push(n); } } }
    while (fr.length) { const nf = []; for (const i of fr) for (const n of nb(i)) if (isTrim[n] && !lab[n]) { lab[n] = lab[i]; nf.push(n); } fr = nf; }
    for (let s = 0; s < W * H; s++) { if (!isTrim[s] || lab[s]) continue; lab[s] = ++L; const st = [s];   // bits that eroded away entirely
      while (st.length) { const i = st.pop(); for (const n of nb(i)) if (isTrim[n] && !lab[n]) { lab[n] = L; st.push(n); } } }
    const bd = new Int32Array(L + 1), sl = new Int32Array(L + 1), pt = new Int32Array(L + 1), sz = new Int32Array(L + 1), comps = [];
    for (let i = 0; i < W * H; i++) { if (!lab[i]) continue; sz[lab[i]]++;
      for (const n of nb(i)) if (!isTrim[n]) { const k = fab[n]; if (!k || k === 9) continue; if (own[n] === 2) pt[lab[i]]++; else if (k === 1) bd[lab[i]]++; else sl[lab[i]]++; } }
    const OV = OVA.trim || [];   // [[nx,ny,1|2]]: nearest trim component
    const cxs = new Float64Array(L + 1), cys = new Float64Array(L + 1);
    for (let i = 0; i < W * H; i++) if (lab[i]) { cxs[lab[i]] += i % W; cys[lab[i]] += (i / W) | 0; }
    const fix = {}; for (const [nx, ny, o] of OV) { let best = 0, bdst = 1e9;   // nearest centroid of a sizeable component
      for (let l = 1; l <= L; l++) { if (sz[l] < 2000) continue; const d = Math.hypot(cxs[l] / sz[l] / W - nx, cys[l] / sz[l] / H - ny); if (d < bdst) { bdst = d; best = l; } }
      if (best) fix[best] = o; }
    const ow = l => fix[l] || (sl[l] ? 1 : pt[l] ? 2 : 1);
    for (let i = 0; i < W * H; i++) if (lab[i]) own[i] = ow(lab[i]);
    for (let l = 1; l <= L; l++) if (sz[l] > 2000) comps.push((ow(l) === 1 ? 'T' : 'P') + sz[l] + '@' + (cxs[l] / sz[l] / W).toFixed(2) + ',' + (cys[l] / sz[l] / H).toFixed(2));
    hist.trim = comps.join(' ');
    { const sx = {}, sy = {}; for (let j = 0; j < EW * EH; j++) { const k = id[j]; if (!k || k === 9) continue; sx[k] = (sx[k] || 0) + x0 + j % EW; sy[k] = (sy[k] || 0) + y0 + ((j / EW) | 0); }
      hist.c = Object.keys(sx).map(k => k + '@' + (sx[k] / hist[k] / W).toFixed(2) + ',' + (sy[k] / hist[k] / H).toFixed(2)).join(' '); }
    // fill unowned (background) with nearest owner too, so the down-scaled mask has no fringe from 0
    const mc = createCanvas(W, H), mctx = mc.getContext('2d'), mi = mctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) { const v2 = own[i] === 2 ? 255 : 0; mi.data[i * 4] = v2; mi.data[i * 4 + 3] = 255; }
    mctx.putImageData(mi, 0, 0);
    const sc = createCanvas(tw, th), sctx = sc.getContext('2d'); sctx.imageSmoothingQuality = 'high'; sctx.drawImage(mc, 0, 0, tw, th);
    const md = sctx.getImageData(0, 0, tw, th).data, out = td.data;
    for (let p = 0; p < tw * th; p++) { const f = md[p * 4] / 255; if (!f) continue; const o = p * 4;
      for (let c = 0; c < 3; c++) out[o + c] = out[o + c] + f * (pd[o + c] - out[o + c]); }
    const oc = createCanvas(tw, th); oc.getContext('2d').putImageData(td, 0, 0);
    const f = path.join(outdir, key + '_' + name + '.jpg');
    fs.writeFileSync(f, oc.toBuffer('image/jpeg', { quality: 0.92 }));
    console.log(f, JSON.stringify(hist));
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });
