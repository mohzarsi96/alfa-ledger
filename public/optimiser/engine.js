/* Glass sheet optimiser engine: guillotine 2D cutting (every cut runs edge to edge of the piece it splits).
   Runs in a Web Worker in the page (index.html embeds this file's text) and in Node for tests.

   job = {panels:[{mark,w,h,qty,lock,gx,gy}] (mm; gx/gy = grinding allowance added to the width/height for cutting), stocks:[{name,w,h,qty (blank = unlimited)}], trimX / trimY (mm off each left-right / top-bottom edge; trim = both), kerf (mm per cut), timeLimit (ms)}
   Identical panels (same size; a rotatable w×h equals h×w) are merged into types. Each sheet is packed with a guillotine
   free-rectangle packer; the pattern is then repeated as often as the remaining quantities allow. Many strategies
   (panel order × fit rule × split rule, plus randomised orders until the time limit) are tried and the best plan kept:
   fewest panels left over, then least sheet area, then fewest distinct patterns, then the biggest usable offcut. */
function optimise(job, progress){
  const kerf = Math.max(0, +job.kerf || 0), tr = Math.max(0, +job.trim || 0);
  const trimX = Math.max(0, job.trimX === undefined || job.trimX === '' ? tr : +job.trimX || 0), trimY = Math.max(0, job.trimY === undefined || job.trimY === '' ? tr : +job.trimY || 0);
  const t0 = Date.now(), limit = Math.max(200, +job.timeLimit || 3000);
  const EPS = 1e-6;

  // panel types: packed at the cut size (finished size + grinding allowance), shown at the finished size (dw x dh)
  const tmap = new Map(), types = [];
  (job.panels || []).forEach((p, row) => {
    const dw = +p.w, dh = +p.h, q = Math.round(+p.qty), gx = Math.max(0, +p.gx || 0), gy = Math.max(0, +p.gy || 0);
    if (!(dw > 0 && dh > 0 && q > 0)) return;
    const w = dw + gx, h = dh + gy, rot = !p.lock && w !== h;
    const key = rot ? (w >= h ? `${w}x${h}|${dw}x${dh}` : `${h}x${w}|${dh}x${dw}`) : `${w}x${h}|${dw}x${dh}L`;
    let t = tmap.get(key);
    if (!t) { t = {id: types.length, w, h, dw, dh, rot, qty: 0, rows: []}; tmap.set(key, t); types.push(t); }
    t.qty += q; t.rows.push({row, mark: String(p.mark || '').trim(), qty: q});
  });
  // stock sheets (usable area inside the edge trim)
  const stocks = [];
  (job.stocks || []).forEach((s, i) => {
    const w = +s.w, h = +s.h, qty = s.qty === '' || s.qty === null || s.qty === undefined ? Infinity : Math.floor(+s.qty);
    if (w > 2 * trimX && h > 2 * trimY && qty > 0) stocks.push({i, w, h, W: w - 2 * trimX, H: h - 2 * trimY, qty, name: s.name || ''});
  });
  const fitsStock = (t, s) => (t.w <= s.W + EPS && t.h <= s.H + EPS) || (t.rot && t.h <= s.W + EPS && t.w <= s.H + EPS);
  const unfit = types.filter(t => !stocks.some(s => fitsStock(t, s)));
  const live = types.filter(t => !unfit.includes(t));
  const minDim = live.length ? Math.min(...live.map(t => Math.min(t.w, t.h))) : 0;

  const SCORE = {
    baf: (fr, pw, ph) => fr.w * fr.h - pw * ph,
    bssf: (fr, pw, ph) => Math.min(fr.w - pw, fr.h - ph),
    blsf: (fr, pw, ph) => Math.max(fr.w - pw, fr.h - ph),
  };
  // true = cut across the full width of the free rectangle first (the strip above the panel spans it)
  const SPLIT = {
    slas: (fr, cw, ch) => (fr.w - cw) <= (fr.h - ch),
    llas: (fr, cw, ch) => (fr.w - cw) > (fr.h - ch),
    minas: (fr, cw, ch) => cw * (fr.h - ch) > (fr.w - cw) * ch,
    maxas: (fr, cw, ch) => cw * (fr.h - ch) <= (fr.w - cw) * ch,
  };
  const GLOBAL_CAP = 60;   // global mode looks at this many remaining types per placement (keeps big jobs fast)

  function packSheet(s, left, strat, order){
    const free = [{x: 0, y: 0, w: s.W, h: s.H}], placed = [], cnt = new Map(), rem = left.slice(), cuts = [], scrap = [];
    const score = SCORE[strat.fit], split = SPLIT[strat.split];
    let area = 0;
    const best = cands => {
      let b = null;
      for (let fi = 0; fi < free.length; fi++) {
        const fr = free[fi];
        for (const t of cands) {
          for (let o = 0; o < (t.rot ? 2 : 1); o++) {
            const pw = o ? t.h : t.w, ph = o ? t.w : t.h;
            if (pw > fr.w + EPS || ph > fr.h + EPS) continue;
            const sc = score(fr, pw, ph), a = t.w * t.h;
            if (!b || sc < b.sc - EPS || (Math.abs(sc - b.sc) <= EPS && (a > b.a || (a === b.a && (fr.y < b.fr.y || (fr.y === b.fr.y && fr.x < b.fr.x))))))
              b = {fi, fr, t, o, pw, ph, sc, a};
          }
        }
      }
      return b;
    };
    const put = b => {
      const fr = b.fr;
      free.splice(b.fi, 1);
      const cw = Math.min(b.pw + kerf, fr.w), ch = Math.min(b.ph + kerf, fr.h);   // the cut eats the kerf (or what is left of the edge)
      placed.push({t: b.t.id, x: fr.x, y: fr.y, w: b.pw, h: b.ph, r: b.o === 1});
      rem[b.t.id]--; cnt.set(b.t.id, (cnt.get(b.t.id) || 0) + 1); area += b.pw * b.ph;
      // first cut across (at y + ph, full width) or along (at x + pw, full height); the second cut frees the panel.
      // The strip beside the panel ends at the panel's edge, since the cut there eats the kerf.
      const across = split(fr, cw, ch);
      const A = across ? {x: fr.x + cw, y: fr.y, w: fr.w - cw, h: b.ph} : {x: fr.x + cw, y: fr.y, w: fr.w - cw, h: fr.h};
      const B = across ? {x: fr.x, y: fr.y + ch, w: fr.w, h: fr.h - ch} : {x: fr.x, y: fr.y + ch, w: b.pw, h: fr.h - ch};
      // the two cuts, edge to edge of the piece they split, down the middle of the kerf: [x1, y1, x2, y2]
      const xc = fr.x + (b.pw + cw) / 2, yc = fr.y + (b.ph + ch) / 2, cutX = fr.w - b.pw > EPS, cutY = fr.h - b.ph > EPS;
      if (across) { if (cutY) cuts.push([fr.x, yc, fr.x + fr.w, yc]); if (cutX) cuts.push([xc, fr.y, xc, fr.y + b.ph]); }
      else { if (cutX) cuts.push([xc, fr.y, xc, fr.y + fr.h]); if (cutY) cuts.push([fr.x, yc, fr.x + b.pw, yc]); }
      for (const r of [A, B]) {
        if (r.w >= minDim - EPS && r.h >= minDim - EPS) free.push(r);
        else if (r.w > EPS && r.h > EPS) scrap.push(r);   // too small for any panel: waste, still shown on the layout
      }
    };
    // largest free rectangle area: a panel bigger than that cannot go in, so it is skipped without a scan
    let maxA = s.W * s.H;
    const refresh = () => { maxA = 0; for (const f of free) if (f.w * f.h > maxA) maxA = f.w * f.h; };
    if (strat.mode === 'order') {
      for (const t of order) {
        if (!free.length) break;
        if (rem[t.id] <= 0 || t.w * t.h > maxA + EPS) continue;
        while (rem[t.id] > 0) { const b = best([t]); if (!b) break; put(b); refresh(); }
      }
    } else {
      for (;;) {
        if (!free.length) break;
        const cands = [];
        for (const t of order) { if (rem[t.id] > 0 && t.w * t.h <= maxA + EPS) { cands.push(t); if (cands.length >= GLOBAL_CAP) break; } }
        if (!cands.length) break;
        const b = best(cands); if (!b) break; put(b); refresh();
      }
    }
    return {placed, cnt, area, free, cuts, scrap};
  }

  // one plan: sheet after sheet, each packed with every [strategy, order] given (one = a plain run; several = the best
  // sheet of all of them each time), on every stock size left; the highest-yield sheet wins and is repeated.
  function run(strat, order, mix, deadline){   // past the deadline a run gives up (null)
    const tries = mix || [[strat, order]];
    const rem = types.map(t => unfit.includes(t) ? 0 : t.qty), sLeft = stocks.map(s => s.qty), patterns = [];
    while (rem.some(q => q > 0)) {
      if (deadline && Date.now() > deadline) return null;
      let pick = null;
      stocks.forEach((s, si) => {
        if (sLeft[si] <= 0) return;
        for (const [st, ord] of tries) {
          const p = packSheet(s, rem, st, ord);
          if (!p.placed.length) continue;
          const y = p.area / (s.w * s.h);
          if (!pick || y > pick.y + 1e-9 || (Math.abs(y - pick.y) <= 1e-9 && p.area > pick.p.area)) pick = {s, si, p, y};
        }
      });
      if (!pick) break;
      let k = sLeft[pick.si];
      for (const [t, c] of pick.p.cnt) k = Math.min(k, Math.floor(rem[t] / c));
      k = Math.max(1, k);
      for (const [t, c] of pick.p.cnt) rem[t] -= c * k;
      sLeft[pick.si] -= k;
      patterns.push({stock: pick.s.i, count: k, placed: pick.p.placed, free: pick.p.free, scrap: pick.p.scrap, cuts: pick.p.cuts, area: pick.p.area});
    }
    const left = rem.reduce((a, b) => a + b, 0);
    const sheetArea = patterns.reduce((a, p) => { const s = stocks.find(x => x.i === p.stock); return a + p.count * s.w * s.h; }, 0);
    const last = patterns[patterns.length - 1];
    const offcut = last ? Math.max(0, ...last.free.map(r => r.w * r.h)) : 0;
    return {patterns, rem, key: [left, sheetArea, patterns.length, -offcut]};
  }
  const better = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i] - 1e-6) return true; if (a[i] > b[i] + 1e-6) return false; } return false; };

  // strategies
  const SORTS = {
    area: (a, b) => b.w * b.h - a.w * a.h || Math.max(b.w, b.h) - Math.max(a.w, a.h),
    side: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h,
    perim: (a, b) => (b.w + b.h) - (a.w + a.h) || b.w * b.h - a.w * a.h,
    height: (a, b) => b.h - a.h || b.w - a.w,
    width: (a, b) => b.w - a.w || b.h - a.h,
  };
  const strategies = [];
  for (const sort of Object.keys(SORTS)) for (const fit of ['baf', 'bssf', 'blsf']) for (const split of ['slas', 'llas', 'minas', 'maxas'])
    strategies.push({mode: 'order', sort, fit, split});
  for (const fit of ['baf', 'bssf', 'blsf']) for (const split of ['slas', 'llas', 'minas'])
    strategies.push({mode: 'global', sort: 'area', fit, split});

  // the best plan so far goes out with the progress (at most once a second) so the page can stop early and keep it
  let bestRun = null, bestStrat = null, runs = 0, improvedAt = 0, dirty = false, lastSnap = 0;
  const consider = (r, st) => {
    if (!r) return;
    runs++;
    if (!bestRun || better(r.key, bestRun.key)) { bestRun = r; bestStrat = st; improvedAt = Date.now() - t0; dirty = true; }
    if (progress && dirty && (lastSnap === 0 || Date.now() - lastSnap >= 1000)) {
      dirty = false; lastSnap = Date.now();
      progress({runs, best: bestRun.key, improvedAt, snapshot: result()});
    }
  };
  if (live.length) {
    // sheet by sheet, the best of all the ordered strategies
    const ordered = strategies.filter(st => st.mode === 'order').map(st => [st, live.slice().sort(SORTS[st.sort])]);
    consider(run(null, null, ordered), {mode: 'mix', of: ordered.length});
    if (progress) progress({runs, best: bestRun.key, improvedAt});
    for (const st of strategies) {
      consider(run(st, live.slice().sort(SORTS[st.sort]), null, bestRun ? t0 + limit : 0), st);
      if (progress && runs % 6 === 0) progress({runs, best: bestRun.key, improvedAt});
      if (Date.now() - t0 > limit * 0.8) break;
    }
    // randomised panel orders until the time runs out
    let seed = 12345;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const fits = ['baf', 'bssf', 'blsf'], splits = ['slas', 'llas', 'minas', 'maxas'];
    // alternate: a plain run on one shuffled order, then a sheet-by-sheet mix of the standard orders plus a few shuffled ones
    const shuffled = () => { const noise = 0.1 + rnd() * 0.6, keyOf = new Map(live.map(t => [t.id, t.w * t.h * (1 + (rnd() - 0.5) * noise)]));
      return live.slice().sort((a, b) => keyOf.get(b.id) - keyOf.get(a.id)); };
    const randStrat = () => ({mode: 'order', sort: 'random', fit: fits[Math.floor(rnd() * 3)], split: splits[Math.floor(rnd() * 4)]});
    let turn = 0;
    while (Date.now() - t0 < limit) {
      if (turn++ % 2) {
        const base = ordered.filter(() => rnd() < 0.5), extra = Array.from({length: 4 + Math.floor(rnd() * 8)}, () => [randStrat(), shuffled()]);
        consider(run(null, null, base.concat(extra), t0 + limit), {mode: 'mix', of: base.length + extra.length, random: extra.length});
        if (progress && runs % 10 === 0) progress({runs, best: bestRun.key, improvedAt});
        continue;
      }
      const lead = bestStrat && bestStrat.fit ? bestStrat : null;   // the mix has no fit/split of its own
      const st = {mode: 'order', sort: 'random', fit: lead && rnd() < 0.5 ? lead.fit : fits[Math.floor(rnd() * 3)],
        split: lead && rnd() < 0.5 ? lead.split : splits[Math.floor(rnd() * 4)]};
      const noise = 0.1 + rnd() * 0.5, keyOf = new Map(live.map(t => [t.id, t.w * t.h * (1 + (rnd() - 0.5) * noise)]));
      consider(run(st, live.slice().sort((a, b) => keyOf.get(b.id) - keyOf.get(a.id))), st);
      if (progress && runs % 10 === 0) progress({runs, best: bestRun.key, improvedAt});
    }
  }

  return result();

  // result: patterns with the marks they carry (rows are handed out in order across the sheets)
  function result(){
  const queue = types.map(t => t.rows.map(r => ({...r})));
  const takeMark = tid => { const q = queue[tid]; while (q.length && q[0].qty <= 0) q.shift(); if (!q.length) return ''; q[0].qty--; return q[0].mark; };
  const patterns = (bestRun ? bestRun.patterns : []).map((p, n) => {
    const marks = new Map();   // type id -> Map(mark -> pcs) over all the pattern's sheets
    for (let c = 0; c < p.count; c++) for (const pl of p.placed) {
      const m = takeMark(pl.t), mm = marks.get(pl.t) || new Map(); mm.set(m, (mm.get(m) || 0) + 1); marks.set(pl.t, mm);
    }
    const s = stocks.find(x => x.i === p.stock);
    const offcuts = p.free.concat(p.scrap || []).filter(r => r.w > EPS && r.h > EPS).sort((a, b) => b.w * b.h - a.w * a.h);   // every leftover piece
    return {no: n + 1, stock: p.stock, sheetW: s.w, sheetH: s.h, count: p.count, area: p.area, yield: p.area / (s.w * s.h),
      placed: p.placed, offcuts, cuts: p.cuts || [], marks: [...marks].map(([t, mm]) => ({t, marks: [...mm].map(([mark, pcs]) => ({mark, pcs}))}))};
  });
  const unplaced = [];
  unfit.forEach(t => unplaced.push({t: t.id, qty: t.qty, reason: 'too big for the sheets'}));
  if (bestRun) bestRun.rem.forEach((q, i) => { if (q > 0 && !unfit.includes(types[i])) unplaced.push({t: i, qty: q, reason: 'not enough sheets'}); });
  return {types: types.map(({rows, ...t}) => ({...t, marks: rows.map(r => r.mark).filter((m, i, a) => m && a.indexOf(m) === i)})),
    patterns, unplaced, trimX, trimY, kerf, runs, ms: Date.now() - t0, improvedAt, strategy: bestStrat};
  }
}
if (typeof module !== 'undefined') module.exports = {optimise};
