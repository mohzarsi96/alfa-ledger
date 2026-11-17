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
  const GLOBAL_CAP = job.globalCap || 60, STRIP_CAP = job.stripCap || 120;
  const REFILL = job.refill === false ? null : {mode: 'global', fit: job.refillFit || 'baf', split: job.refillSplit || 'minas'};
  const BY_AREA = live.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  let VAL = null, valGen = 0;   // piece values during a value-correction pass (null = plain area), and their version
  const stripMemo = new Map();
  let KNAP = new Uint8Array(0);   // the strip knapsack's choice table, reused
  /* Strip packer (as glass optimisers like Optima do): the sheet is cut into strips across its whole length; each strip
     is filled along its length with columns (best combination by a knapsack over the length); each column is a stack
     of pieces no wider than the column, the first sets its width; a piece narrower than its column is trimmed with one
     more cut. dir 'h' = strips along the sheet width (W), 'v' = along its height (worked out transposed, then mapped back).
     score: 'eff' = the fullest strip first, 'val' = the most glass; noise > 0 randomises the choice (deeper searches). */
  function stripSheet(s, left, opt){
    const T = opt.dir === 'v', L = T ? s.H : s.W, HS = T ? s.W : s.H, rem = left.slice();
    const rnd = opt.rnd || Math.random, noise = opt.noise || 0;
    // each type's orientations in strip space: [along the strip, across it, real rotation flag]
    const O = types.map(t => {
      const real = [[t.w, t.h, false]]; if (t.rot) real.push([t.h, t.w, true]);
      return real.map(([a, b, r]) => T ? [b, a, r] : [a, b, r]).filter(o => o[0] <= L + EPS && o[1] <= HS + EPS);
    });
    // on big jobs only the biggest remaining sizes are considered (keeps it fast; small ones fill in on later sheets)
    const ids = types.filter(t => rem[t.id] > 0 && O[t.id].length).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, STRIP_CAP).map(t => t.id);
    const P = [], C = [], F = [];   // strip-space pieces, cuts, leftovers
    let area = 0;
    // a column of width cw (set by the leader) and height hs: the leader stacked as often as it fits, then the biggest pieces that fit above
    function column(lead, o, hs, cnt){
      const cw = o[0], items = []; let used = 0, a = 0, v = 0;
      const room = () => hs - used - (items.length ? kerf : 0);
      const take = (id, oo) => { used += (items.length ? kerf : 0) + oo[1]; items.push({id, o: oo}); cnt[id]--; a += oo[0] * oo[1]; v += VAL ? VAL[id] : oo[0] * oo[1]; };
      take(lead, o);
      while (cnt[lead] > 0 && o[1] <= room() + EPS) take(lead, o);
      for (;;) {
        let b = null; const r = room();
        if (r < minDim - EPS) break;
        for (const id of ids) {
          if (cnt[id] <= 0) continue;
          for (const oo of O[id]) if (oo[0] <= cw + EPS && oo[1] <= r + EPS && (!b || oo[0] * oo[1] > b.oo[0] * b.oo[1])) b = {id, oo};
        }
        if (!b) break;
        take(b.id, b.oo);
      }
      return {cw, items, a, v};
    }
    // fill a strip of height hs: knapsack over the length with the best column for each width, then build the columns
    // in that order with the real counts, and fill what is left of the length again until nothing fits
    function fillStrip(hs, cnt0){
      const key = (T ? 'v' : 'h') + L + 'x' + HS + ':' + hs + '|' + (VAL ? valGen : 'a') + '|' + cnt0.join(',');
      const hit = stripMemo.get(key); if (hit) return hit;
      if (stripMemo.size > 20000) stripMemo.clear();
      const out = fillStripRaw(hs, cnt0); stripMemo.set(key, out); return out;
    }
    function fillStripRaw(hs, cnt0){
      const cnt = cnt0.slice(), cols = []; let x = 0;
      for (let guard = 0; guard < 20; guard++) {
        const len = L - x - (cols.length ? kerf : 0);
        if (len < minDim - EPS) break;
        // candidate columns, each as often as its leader's quantity allows (a bounded knapsack: near-equal sizes only
        // fill a strip exactly when each piece counts once); per width only as many as could fit, the best first
        const cap = Math.floor(len + kerf + 1e-9), byW = new Map();
        for (const id of ids) {
          if (cnt[id] <= 0) continue;
          for (const o of O[id]) {
            if (o[1] > hs + EPS || o[0] > len + EPS) continue;
            const c = column(id, o, hs, cnt.slice()), k = Math.ceil(c.cw + kerf - 1e-9);
            let per = 0; for (const it of c.items) if (it.id === id) per++;
            const copies = Math.min(Math.max(1, Math.floor(cnt[id] / per)), Math.floor(cap / k));
            const e = byW.get(k) || []; e.push({c, id, o, m: copies}); byW.set(k, e);
          }
        }
        if (!byW.size) break;
        // per width at most as many columns as fit, the best first; m copies of a column go in as 1, 2, 4, ... (binary split)
        const items = [];
        for (const [k, e] of byW) {
          e.sort((a, b) => b.c.v - a.c.v);
          let room = Math.floor(cap / k);
          for (const it of e) {
            let m = Math.min(it.m, room); room -= m;
            for (let c = 1; m > 0; c *= 2) { const q = Math.min(c, m); items.push([k * q, it, q]); m -= q; }
            if (room <= 0) break;
          }
        }
        const n = items.length, dp = new Float64Array(cap + 1), W1 = cap + 1;
        if (KNAP.length < n * W1) KNAP = new Uint8Array(n * W1 * 2); else KNAP.fill(0, 0, n * W1);
        for (let i = 0; i < n; i++) {
          const k = items[i][0], val = items[i][1].c.v * items[i][2], row = i * W1;
          for (let v = cap; v >= k; v--) if (dp[v - k] + val > dp[v] + 1e-9) { dp[v] = dp[v - k] + val; KNAP[row + v] = 1; }
        }
        const pick = []; for (let i = n - 1, v = cap; i >= 0; i--) if (KNAP[i * W1 + v]) { for (let q = 0; q < items[i][2]; q++) pick.push(items[i][1]); v -= items[i][0]; }
        let added = 0;
        for (const p of pick.sort((a, b) => b.c.cw - a.c.cw)) {
          if (cnt[p.id] <= 0) continue;
          const room = L - x - (cols.length ? kerf : 0);
          if (p.o[0] > room + EPS) continue;
          const c = column(p.id, p.o, hs, cnt);   // takes from the real counts
          x += (cols.length ? kerf : 0) + c.cw; cols.push(c); added++;
        }
        if (!added) break;
      }
      return {cols, cnt, a: cols.reduce((s, c) => s + c.a, 0), v: cols.reduce((s, c) => s + c.v, 0), len: x};
    }
    // score 'dp': first choose the best set of strip heights for the whole sheet (a knapsack over its height, each
    // strip filled as if it were the only one), then build them in turn with the real counts; the rest is chosen strip by strip
    const plan = [];
    if (opt.score === 'dp') {
      const hm = new Map();
      for (const id of ids) for (const o of O[id]) if (o[1] <= HS + EPS) hm.set(o[1], (hm.get(o[1]) || 0) + o[0] * o[1] * rem[id]);
      const items = [...hm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([h]) => ({h, f: fillStrip(h, rem)})).filter(x => x.f.a > 0)
        .map(x => ({...x, k: Math.ceil(x.h + kerf - 1e-9), v: x.f.v * (noise ? 1 + (rnd() - 0.5) * noise : 1)}));
      const cap = Math.floor(HS + kerf + 1e-9), dp = new Float64Array(cap + 1), ch = new Int32Array(cap + 1).fill(-1);
      for (let v = 1; v <= cap; v++) {
        dp[v] = dp[v - 1];
        for (let i = 0; i < items.length; i++) if (items[i].k <= v && dp[v - items[i].k] + items[i].v > dp[v]) { dp[v] = dp[v - items[i].k] + items[i].v; ch[v] = i; }
      }
      for (let v = cap; v > 0;) { if (ch[v] < 0) v--; else { plan.push(items[ch[v]]); v -= items[ch[v]].k; } }
      plan.sort((a, b) => b.f.v / b.h - a.f.v / a.h);
    }
    let y = 0;
    for (;;) {
      const hr = HS - y - (y > 0 ? kerf : 0);
      if (hr < minDim - EPS) break;
      let planned = null;
      while (plan.length && !planned) { const h = plan.shift().h; if (h <= hr + EPS) { const f = fillStrip(h, rem); if (f.a) planned = {sc: 0, h, f}; } }
      // candidate strip heights: the across-size of each remaining piece that fits (at most 14, the most glass first)
      const hm = new Map();
      for (const id of ids) if (rem[id] > 0) for (const o of O[id]) if (o[1] <= hr + EPS) hm.set(o[1], (hm.get(o[1]) || 0) + o[0] * o[1] * rem[id]);
      if (!hm.size) break;
      const hs = [...hm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
      let best = planned;
      if (!best) for (const h of hs) {
        const f = fillStrip(h, rem); if (!f.a) continue;
        let sc = opt.score === 'val' ? f.v * Math.pow(f.a / (L * h), 2) : f.v / (L * h);
        if (noise) sc *= 1 + (rnd() - 0.5) * noise;
        if (!best || sc > best.sc) best = {sc, h, f};
      }
      if (!best) break;
      // place the strip at y: columns along the length, pieces stacked in each column
      // the strip is only as high as its tallest column: its height was picked before it was filled, and when no panel
      // of that height went in (taken by an earlier strip, or the knapsack chose others) a band would be left empty
      // across the whole sheet between this strip and the next
      let h = 0;
      for (const c of best.f.cols) { let t = 0; c.items.forEach((it, i) => { t += (i ? kerf : 0) + it.o[1]; }); h = Math.max(h, t); }
      const y0 = y + (y > 0 ? kerf : 0);
      if (y > 0) C.push([0, y + kerf / 2, L, y + kerf / 2]);
      let x = 0;
      best.f.cols.forEach((c, ci) => {
        const x0 = x + (ci ? kerf : 0);
        if (ci) C.push([x + kerf / 2, y0, x + kerf / 2, y0 + h]);
        let yy = y0;
        c.items.forEach((it, ii) => {
          const yp = yy + (ii ? kerf : 0), [pw, ph, r] = it.o;
          if (ii) C.push([x0, yy + kerf / 2, x0 + c.cw, yy + kerf / 2]);
          P.push({t: it.id, x: x0, y: yp, w: pw, h: ph, r}); area += pw * ph;
          if (c.cw - pw > EPS) {   // trim a piece narrower than its column
            const cons = Math.min(pw + kerf, c.cw);
            C.push([x0 + (pw + cons) / 2, yp, x0 + (pw + cons) / 2, yp + ph]);
            if (c.cw - cons > EPS) F.push({x: x0 + cons, y: yp, w: c.cw - cons, h: ph});
          }
          yy = yp + ph;
        });
        if (y0 + h - yy > EPS) {   // above the stack
          const cons = Math.min(kerf, y0 + h - yy);
          if (c.items.length) C.push([x0, yy + cons / 2, x0 + c.cw, yy + cons / 2]);
          if (y0 + h - yy - cons > EPS) F.push({x: x0, y: yy + cons, w: c.cw, h: y0 + h - yy - cons});
        }
        x = x0 + c.cw;
      });
      if (L - x > EPS) {   // the rest of the strip's length
        const cons = Math.min(kerf, L - x);
        C.push([x + cons / 2, y0, x + cons / 2, y0 + h]);
        if (L - x - cons > EPS) F.push({x: x + cons, y: y0, w: L - x - cons, h});
      }
      for (let i = 0; i < rem.length; i++) rem[i] = best.f.cnt[i];
      y = y0 + h;
    }
    if (HS - y > EPS) {
      const cons = y > 0 ? Math.min(kerf, HS - y) : 0;
      if (y > 0) C.push([0, y + cons / 2, L, y + cons / 2]);
      if (HS - y - cons > EPS) F.push({x: 0, y: y + cons, w: L, h: HS - y - cons});
    }
    // back to sheet space
    const placed = P.map(p => T ? {t: p.t, x: p.y, y: p.x, w: p.h, h: p.w, r: p.r} : p);
    const cuts = C.map(c => T ? [c[1], c[0], c[3], c[2]] : c);
    const free = [], scrap = [];
    for (const f of F) { const r = T ? {x: f.y, y: f.x, w: f.h, h: f.w} : f; (r.w >= minDim - EPS && r.h >= minDim - EPS ? free : scrap).push(r); }
    const cnt = new Map(); for (const p of placed) cnt.set(p.t, (cnt.get(p.t) || 0) + 1);
    // the gaps the strips leave (beside a narrower piece, above a column, the end of a strip) are filled with what is
    // left, by the free-rectangle packer (deeper guillotine levels, as Optima does)
    if (REFILL && free.length && rem.some(q => q > 0)) return packSheet(s, null, REFILL, BY_AREA, {free, placed, cnt, rem, cuts, scrap, area});
    return {placed, cnt, area, free, cuts, scrap};
  }

  // init: carry on from a part-packed sheet {free, placed, cnt, rem, cuts, scrap, area} (its arrays are taken over)
  function packSheet(s, left, strat, order, init){
    if (strat.mode === 'strip') return stripSheet(s, left, strat);
    const free = init ? init.free : [{x: 0, y: 0, w: s.W, h: s.H}], placed = init ? init.placed : [], cnt = init ? init.cnt : new Map(),
      rem = init ? init.rem : left.slice(), cuts = init ? init.cuts : [], scrap = init ? init.scrap : [];
    const score = SCORE[strat.fit], split = SPLIT[strat.split];
    let area = init ? init.area : 0;
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
  function run(strat, order, mix, deadline, vals, start){   // past the deadline a run gives up (null); vals = value-correction pass
    VAL = vals || null;
    const tries = mix || [[strat, order]];
    const rem = start ? start.rem.slice() : types.map(t => unfit.includes(t) ? 0 : t.qty), sLeft = start ? start.sLeft.slice() : stocks.map(s => s.qty);
    const patterns = start ? start.patterns.slice() : [];
    while (rem.some(q => q > 0)) {
      if (deadline && Date.now() > deadline) { VAL = null; return null; }
      let pick = null;
      stocks.forEach((s, si) => {
        if (sLeft[si] <= 0) return;
        for (const [st, ord] of tries) {
          const p = packSheet(s, rem, st, ord);
          if (!p.placed.length) continue;
          const y = (VAL ? p.placed.reduce((a, q) => a + VAL[q.t], 0) : p.area) / (s.w * s.h);
          if (!pick || y > pick.y + 1e-9 || (Math.abs(y - pick.y) <= 1e-9 && p.area > pick.p.area)) pick = {s, si, p, y};
        }
      });
      if (!pick) break;
      commit(pick, rem, sLeft, patterns);
    }
    VAL = null;
    return {patterns, rem, key: keyOf(patterns, rem)};
  }
  // take a packed sheet: repeat it as often as the quantities (and that stock) allow
  function commit(pick, rem, sLeft, patterns){
    let k = sLeft[pick.si];
    for (const [t, c] of pick.p.cnt) k = Math.min(k, Math.floor(rem[t] / c));
    k = Math.max(1, k);
    for (const [t, c] of pick.p.cnt) rem[t] -= c * k;
    sLeft[pick.si] -= k;
    patterns.push({stock: pick.s.i, count: k, yield: pick.p.area / (pick.s.w * pick.s.h), placed: pick.p.placed, free: pick.p.free, scrap: pick.p.scrap, cuts: pick.p.cuts, area: pick.p.area});
  }
  function keyOf(patterns, rem){
    const left = rem.reduce((a, b) => a + b, 0);
    const sheetArea = patterns.reduce((a, p) => { const s = stocks.find(x => x.i === p.stock); return a + p.count * s.w * s.h; }, 0);
    const last = patterns[patterns.length - 1];
    const offcut = last ? Math.max(0, ...last.free.map(r => r.w * r.h)) : 0;
    // the least-used sheet: the less glass on it, the tighter all the others and the bigger the remnant left
    const leastUsed = patterns.length ? Math.min(...patterns.map(p => p.area)) : 0;
    return [left, sheetArea, leastUsed, patterns.length, -offcut];
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
  // strip packers: strips along the width or the height, fullest strip first or most glass
  const STRIPS = [];
  for (const dir of ['h', 'v']) for (const score of ['eff', 'val', 'dp']) STRIPS.push([{mode: 'strip', dir, score}, null]);

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
    // the strip packers are slow on jobs with very many sizes: if a plan with them does not finish in 40% of the time, they are left out
    let useStrips = true;
    { const r = run(null, null, ordered.concat(STRIPS), t0 + limit * 0.4); if (r) consider(r, {mode: 'mix', of: ordered.length + STRIPS.length}); else useStrips = false; }
    const noStrip = tries => useStrips ? tries : tries.filter(([st]) => st.mode !== 'strip');
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
    /* value correction (sequential value correction, as glass optimisers do): sheet after sheet is packed to the
       highest value per area; after each plan, pieces that sat on poorly used sheets are worth more, so the next plan
       places them earlier and in better company. Each pass packs every sheet with the strip packers (two randomised)
       and a few free-rectangle orders by value. */
    const SVC_EXP = job.svcExp || 1.5, SVC_G = job.svcG || 0.5, SVC_NOISE = job.svcNoise ?? 0.05;
    const vals = new Float64Array(types.length); types.forEach(t => { vals[t.id] = t.w * t.h; });
    const svc = () => {
      const jit = () => 1 + (rnd() - 0.5) * 0.1;
      const byVal = () => { const k = new Map(live.map(t => [t.id, vals[t.id] * jit()])); return live.slice().sort((a, b) => k.get(b.id) - k.get(a.id)); };
      const tries = STRIPS.concat([[{mode: 'strip', dir: 'h', score: 'eff', noise: 0.3, rnd}, null], [{mode: 'strip', dir: 'v', score: 'eff', noise: 0.3, rnd}, null],
        [{mode: 'strip', dir: 'h', score: 'dp', noise: 0.3, rnd}, null], [{mode: 'strip', dir: 'v', score: 'dp', noise: 0.3, rnd}, null]]);
      for (let i = 0; i < 6; i++) tries.push([{mode: 'order', fit: fits[i % 3], split: splits[Math.floor(rnd() * 4)]}, byVal()]);
      const r = run(null, null, noStrip(tries), t0 + limit, vals);
      if (!r) return;
      consider(r, {mode: 'value', of: tries.length});
      // a piece on a sheet used y is worth area / y^1.5 next time (the emptier its sheet, the earlier it should go)
      const sum = new Float64Array(types.length), n = new Float64Array(types.length);
      for (const p of r.patterns) for (const q of p.placed) { const t = types[q.t]; sum[q.t] += p.count * t.w * t.h / Math.pow(Math.max(p.yield, 0.05), SVC_EXP); n[q.t] += p.count; }
      types.forEach(t => { if (n[t.id]) vals[t.id] = (1 - SVC_G) * vals[t.id] + SVC_G * sum[t.id] / n[t.id] * (1 + (rnd() - 0.5) * SVC_NOISE); });
      valGen++;
      if (progress && runs % 3 === 0) progress({runs, best: bestRun.key, improvedAt});
    };
    /* repack: take the least-used sheet of the best plan and a few others, and pack their pieces again on their own
       (value-corrected passes on the small job), so the glass moves onto the fuller sheets and the last one empties. */
    const REPACK_K = job.repackK || 3, REPACK_PASSES = job.repackPasses || 6, REPACK_P = job.repackP ?? 0.5;
    const repack = () => {
      const sheets = [];
      bestRun.patterns.forEach((p, i) => { for (let c = 0; c < p.count; c++) sheets.push(i); });
      if (sheets.length < 2) return;
      let low = 0; bestRun.patterns.forEach((p, i) => { if (p.area < bestRun.patterns[low].area) low = i; });
      const take = new Set([sheets.lastIndexOf(low)]);
      const k = Math.min(sheets.length, 2 + Math.floor(rnd() * REPACK_K));
      while (take.size < k) {
        // emptier sheets more often
        const j = Math.floor(rnd() * sheets.length), y = bestRun.patterns[sheets[j]].yield;
        if (rnd() < 1.15 - y) take.add(j);
      }
      const rem = types.map(() => 0), sLeft = stocks.map(s => s.qty), keep = new Map();
      sheets.forEach((pi, j) => {
        const p = bestRun.patterns[pi];
        if (take.has(j)) { for (const q of p.placed) rem[q.t]++; }
        else { keep.set(pi, (keep.get(pi) || 0) + 1); const si = stocks.findIndex(s => s.i === p.stock); sLeft[si]--; }
      });
      // pieces the best plan left unplaced go in too
      const done = types.map(() => 0); for (const p of bestRun.patterns) for (const q of p.placed) done[q.t] += p.count;
      types.forEach((t, i) => { if (!unfit.includes(t)) rem[i] += t.qty - done[i]; });
      const patterns = [...keep].map(([pi, c]) => ({...bestRun.patterns[pi], count: c}));
      const start = {rem, sLeft, patterns};
      const v = new Float64Array(types.length); types.forEach(t => { v[t.id] = t.w * t.h; });
      const sub = live.filter(t => rem[t.id] > 0);
      for (let pass = 0; pass < REPACK_PASSES; pass++) {
        const jit = () => 1 + (rnd() - 0.5) * 0.2;
        const byVal = () => { const kk = new Map(sub.map(t => [t.id, v[t.id] * jit()])); return sub.slice().sort((a, b) => kk.get(b.id) - kk.get(a.id)); };
        const tries = STRIPS.concat([[{mode: 'strip', dir: 'h', score: 'dp', noise: 0.3, rnd}, null], [{mode: 'strip', dir: 'v', score: 'dp', noise: 0.3, rnd}, null]]);
        for (let i = 0; i < 6; i++) tries.push([{mode: 'order', fit: fits[i % 3], split: splits[Math.floor(rnd() * 4)]}, byVal()]);
        const r = run(null, null, noStrip(tries), t0 + limit, pass ? v : null, start);
        if (!r) return;
        consider(r, {mode: 'repack', sheets: k, pass});
        const sum = new Float64Array(types.length), n = new Float64Array(types.length);
        for (const p of r.patterns.slice(patterns.length)) for (const q of p.placed) { const t = types[q.t]; sum[q.t] += p.count * t.w * t.h / Math.pow(Math.max(p.yield, 0.05), SVC_EXP); n[q.t] += p.count; }
        types.forEach(t => { if (n[t.id]) v[t.id] = 0.5 * v[t.id] + 0.5 * sum[t.id] / n[t.id] * (1 + (rnd() - 0.5) * 0.1); });
        valGen++;
      }
    };
    /* drain: improve the best plan two sheets at a time. The emptiest sheet (plus any panels not placed) and one other
       sheet are packed again: the first as full as it can be, then the rest on the second. Kept when fewer panels are
       left over or the emptiest sheet gets emptier (equal: kept now and then, to move on); a sheet that empties is
       dropped. Each step is small, so thousands run in the time a full plan takes. */
    const DRAIN_P = job.drainP ?? 1, DRAIN_T = job.drainT ?? 0.002, maxStock = Math.max(...stocks.map(s => s.w * s.h));
    let D = null;   // the drain's working plan, kept between turns while it is still built on the best plan
    const drain = () => {
      const end = Math.min(t0 + limit, Date.now() + Math.max(200, limit * 0.04));
      if (!D || D.base !== bestRun) {
        const sheets = [];
        bestRun.patterns.forEach(p => {
          const si = stocks.findIndex(s => s.i === p.stock), cnt = new Map(); for (const q of p.placed) cnt.set(q.t, (cnt.get(q.t) || 0) + 1);
          const pp = {...p, cnt}; for (let c = 0; c < p.count; c++) sheets.push({si, p: pp});
        });
        const sLeft = stocks.map(s => s.qty); for (const sh of sheets) sLeft[sh.si]--;
        D = {base: bestRun, sheets, pool: bestRun.rem.slice(), sLeft};
      }
      const {sheets, pool, sLeft} = D;
      if (!sheets.length) return;
      const areaOf = cnts => cnts.reduce((a, q, i) => a + q * types[i].w * types[i].h, 0);
      const ordAll = Object.keys(SORTS).map(k => live.slice().sort(SORTS[k]));
      // the fullest sheet these panels give on stock si (the free-rectangle orders and the strip packers)
      const fullest = (si, left) => {
        let b = null;
        const take = p => { if (p.placed.length && (!b || p.area > b.area + EPS)) b = p; };
        for (const ord of ordAll) {
          const sub = ord.filter(t => left[t.id] > 0); if (!sub.length) return null;
          for (let i = 0; i < 3; i++) take(packSheet(stocks[si], left, {mode: 'order', fit: fits[Math.floor(rnd() * 3)], split: splits[Math.floor(rnd() * 4)]}, sub));
        }
        if (useStrips) for (const [st] of STRIPS) take(packSheet(stocks[si], left, st));
        return b;
      };
      let changed = false;
      while (Date.now() < end) {
        const n = sheets.length, hasPool = pool.some(q => q > 0);
        if (!n || (n < 2 && !hasPool)) break;
        // one of the emptier sheets, and one or two others at random
        const fill = sh => sh.p.area / (stocks[sh.si].w * stocks[sh.si].h);   // emptiest by how full it is (sizes may differ)
        const asc = sheets.map((sh, i) => i).sort((a, b) => fill(sheets[a]) - fill(sheets[b]));
        const pick = [asc[Math.floor(Math.pow(rnd(), 3) * n)]];
        const k = Math.min(n, rnd() < 0.5 ? 2 : 3);
        while (pick.length < k) { const j = Math.floor(rnd() * n); if (!pick.includes(j)) pick.push(j); }
        const left = pool.slice(), avail = sLeft.slice();
        for (const j of pick) { for (const [t, c] of sheets[j].p.cnt) left[t] += c; avail[sheets[j].si]++; }
        const oldPool = areaOf(pool), oldSq = pick.reduce((a, j) => a + sheets[j].p.area * sheets[j].p.area, 0);
        // the others' stocks first, packed as full as they go; the last sheet on the stock that takes the most
        const slots = pick.slice(1).concat(pick[0]).map(j => sheets[j].si), out = [];
        let rest = left;
        for (let s = 0; s < slots.length && rest.some(q => q > 0); s++) {
          let p = null, psi = -1;
          const cands = s < slots.length - 1 ? [slots[s]] : stocks.map((x, i) => i);
          for (const ci of cands) {
            if (avail[ci] <= 0) continue;
            const q = fullest(ci, rest); if (!q) continue;
            if (!p || q.area > p.area + EPS || (Math.abs(q.area - p.area) <= EPS && stocks[ci].w * stocks[ci].h < stocks[psi].w * stocks[psi].h)) { p = q; psi = ci; }
          }
          if (!p) continue;
          avail[psi]--; out.push({si: psi, p});
          rest = rest.slice(); for (const [t, c] of p.cnt) rest[t] -= c;
        }
        const newPool = areaOf(rest), newSq = out.reduce((a, o) => a + o.p.area * o.p.area, 0);
        // annealing: early on a slightly worse spread is taken now and then (to get out of a dead end), less so as time runs out
        const temp = DRAIN_T * Math.pow(Math.max(0, 1 - (Date.now() - t0) / limit), 2), d = (newSq - oldSq) / (maxStock * maxStock);
        const ok = newPool < oldPool - EPS || (newPool <= oldPool + EPS && (newSq > oldSq * (1 + 1e-9) || (newSq >= oldSq * (1 - 1e-9) && rnd() < 0.3) || (temp > 0 && rnd() < Math.exp(d / temp))));
        if (!ok) continue;
        for (const j of pick.slice().sort((a, b) => b - a)) sheets.splice(j, 1);
        sheets.push(...out);
        for (let i = 0; i < pool.length; i++) pool[i] = rest[i];
        for (let i = 0; i < sLeft.length; i++) sLeft[i] = avail[i];
        changed = true;
      }
      if (!changed) return;
      // back to patterns: identical sheets are one pattern repeated
      const pats = new Map();
      for (const sh of sheets) {
        const key = sh.si + '|' + sh.p.placed.map(q => `${q.t},${q.x},${q.y},${q.r ? 1 : 0}`).join(';');
        const e = pats.get(key);
        if (e) e.count++;
        else pats.set(key, {stock: stocks[sh.si].i, count: 1, yield: sh.p.area / (stocks[sh.si].w * stocks[sh.si].h), placed: sh.p.placed, free: sh.p.free, scrap: sh.p.scrap, cuts: sh.p.cuts, area: sh.p.area});
      }
      const patterns = [...pats.values()].sort((a, b) => b.yield - a.yield);
      const r = {patterns, rem: pool.slice(), key: keyOf(patterns, pool)};
      consider(r, {mode: 'drain'});
      if (bestRun === r) D.base = r;
    };
    let turn = 0;
    while (Date.now() - t0 < limit) {
      // the drain pays off on jobs of mostly one-off sheets (many sizes, few of each); where patterns repeat, value
      // correction and repack do better and the drain would only break the repeats up
      const sheetsN = bestRun ? bestRun.patterns.reduce((a, p) => a + p.count, 0) : 0;
      if (bestRun && sheetsN <= 1.5 * bestRun.patterns.length && rnd() < DRAIN_P) { drain(); continue; }
      if (bestRun && rnd() < REPACK_P) { repack(); continue; }
      if (turn % 4 !== 3) { turn++; svc(); continue; }
      if (turn++ % 8 === 7) {
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

  /* Re-plan the cuts of a finished layout (the panels stay where they are): the packers cut in the order they filled
     the sheet, which can split one leftover into several (a full-width cut through the offcut beside the last column).
     Here every region is split by a cut that peels off its first or last block, across or along, whichever leaves the
     biggest whole offcuts (sum of squared offcut areas; then fewer cuts). Returns null when it gives up (too many regions). */
  function recut(placed, W, H){
    const memo = new Map(); let budget = 30000;
    const sq = r => (r.w * r.h) * (r.w * r.h);
    function solve(x, y, w, h, ps){
      const key = x + ',' + y + ',' + w + ',' + h, hit = memo.get(key); if (hit) return hit;
      if (--budget < 0) throw new Error('budget');
      let best = null;
      if (!ps.length) best = {s: sq({w, h}), n: 0, cuts: [], offs: [{x, y, w, h}]};
      else if (ps.length === 1 && Math.abs(ps[0].w - w) <= EPS && Math.abs(ps[0].h - h) <= EPS) best = {s: 0, n: 0, cuts: [], offs: []};
      else {
        for (const ax of [0, 1]) {
          const R0 = ax ? y : x, R1 = R0 + (ax ? h : w), st = p => ax ? p.y : p.x, en = p => ax ? p.y + p.h : p.x + p.w;
          // blocks of panels no cut can pass between (closer than a kerf)
          const iv = [];
          for (const p of [...ps].sort((a, b) => st(a) - st(b))) {
            const l = iv[iv.length - 1];
            if (l && st(p) < l[1] + kerf - EPS) l[1] = Math.max(l[1], en(p)); else iv.push([st(p), en(p)]);
          }
          // options [cut position, end of the first part, start of the second]: an empty margin before the first block,
          // or the cut after the first block / after the last block (peel from either end)
          const opts = [];
          if (iv[0][0] - R0 >= kerf + EPS) opts.push([iv[0][0] - kerf / 2, iv[0][0] - kerf, iv[0][0]]);
          for (const i of new Set([0, iv.length - 1])) {
            const e = iv[i][1]; if (R1 - e <= EPS) continue;
            const cons = Math.min(kerf, R1 - e); opts.push([e + cons / 2, e, e + cons]);
          }
          for (const [c, a, b] of opts) {
            const L = ax ? solve(x, y, w, a - y, ps.filter(p => p.y < a - EPS)) : solve(x, y, a - x, h, ps.filter(p => p.x < a - EPS));
            const Rr = ax ? solve(x, b, w, y + h - b, ps.filter(p => p.y >= b - EPS)) : solve(b, y, x + w - b, h, ps.filter(p => p.x >= b - EPS));
            const s = L.s + Rr.s, n = L.n + Rr.n + 1;
            if (!best || s > best.s * (1 + 1e-9) || (s >= best.s * (1 - 1e-9) && n < best.n))
              best = {s, n, cut: ax ? [x, c, x + w, c] : [c, y, c, y + h], L, R: Rr};
          }
        }
        if (best) best = {s: best.s, n: best.n, cuts: [best.cut, ...best.L.cuts, ...best.R.cuts], offs: best.L.offs.concat(best.R.offs)};
        else if (ps.length === 1) best = {s: 0, n: 0, cuts: [], offs: []};   // only a sliver thinner than a kerf beside it
        else throw new Error('not guillotine');
      }
      memo.set(key, best);
      return best;
    }
    try { const r = solve(0, 0, W, H, placed); return {cuts: r.cuts, offcuts: r.offs}; } catch (e) { return null; }
  }

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
    const rc = recut(p.placed, s.W, s.H);
    const offcuts = (rc ? rc.offcuts : p.free.concat(p.scrap || [])).filter(r => r.w > EPS && r.h > EPS).sort((a, b) => b.w * b.h - a.w * a.h);   // every leftover piece
    return {no: n + 1, stock: p.stock, sheetW: s.w, sheetH: s.h, count: p.count, area: p.area, yield: p.area / (s.w * s.h),
      placed: p.placed, offcuts, cuts: rc ? rc.cuts : p.cuts || [], marks: [...marks].map(([t, mm]) => ({t, marks: [...mm].map(([mark, pcs]) => ({mark, pcs}))}))};
  });
  const unplaced = [];
  unfit.forEach(t => unplaced.push({t: t.id, qty: t.qty, reason: 'too big for the sheets'}));
  if (bestRun) bestRun.rem.forEach((q, i) => { if (q > 0 && !unfit.includes(types[i])) unplaced.push({t: i, qty: q, reason: 'not enough sheets'}); });
  return {types: types.map(({rows, ...t}) => ({...t, marks: rows.map(r => r.mark).filter((m, i, a) => m && a.indexOf(m) === i)})),
    patterns, unplaced, trimX, trimY, kerf, runs, ms: Date.now() - t0, improvedAt, strategy: bestStrat};
  }
}
if (typeof module !== 'undefined') module.exports = {optimise};
