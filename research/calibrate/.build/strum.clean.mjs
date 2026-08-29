const DEFAULTS = {
  fMax: 3400,
  searchCents: 100,
  coarseStep: 3,
  bMax: 55e-5,
  bNominal: 12e-5,
  bGrid: 26,
  maxPartials: 18,
  frameStarts: null,
  n: null,
  minFrames: 3,
  peelPasses: 4,
  fine: true,
  fineMove: false,
  finePasses: 2,
  fineCents: 4,
  fineStep: 0.2,
  ridge: 0.04,
  fineR: 7,
  blendR: 0.3,
  dcFloor: 32,
  fuseBins: 1.3,
  fuseAmp: 0.2,
  recoarse: true,
  clearBins: 1.6,
  exclDevC: 5,
  exclSnrDb: 10,
  clearMin: 3,
  recoarseStep: 1,
  recoarseGain: 1.15,
  bPrior: 11e-5,
  bPriorSigma: 17e-5,
  bPriorW: 0,
  tolSchedule: [16, 12, 8, 6],
  minCleanPts: 3,
  fineIfR: 0.06,
  iotaMin: 0.03,
  exclMin: 1.8,
  exclSpan: 1,
  confThreshold: 0.15,
  spreadMaxCents: 14,
  onset: null
};
const REFUSE_MEDIAN_CENTS = 70;
const REFUSE_EDGE_MARGIN_CENTS = 15;
const REFUSE_RAIL_TOL_CENTS = 8;
const REFUSE_RAIL_MIN_STRINGS = 2;
function makeFFT(n) {
  if ((n & n - 1) !== 0) throw new Error("FFT size must be a power of two");
  const levels = Math.log2(n) | 0;
  const cosT = new Float64Array(n / 2);
  const sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos(2 * Math.PI * i / n);
    sinT[i] = Math.sin(2 * Math.PI * i / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b++) {
      r = r << 1 | x & 1;
      x >>= 1;
    }
    rev[i] = r;
  }
  return {
    n,
    /** in-place forward transform of re/im (length n). */
    forward(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cosT[k] + im[l] * sinT[k];
            const tim = -re[l] * sinT[k] + im[l] * cosT[k];
            re[l] = re[j] - tre;
            im[l] = im[j] - tim;
            re[j] += tre;
            im[j] += tim;
          }
        }
      }
    }
  };
}
function makeHann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}
const fftCache = /* @__PURE__ */ new Map();
const hannCache = /* @__PURE__ */ new Map();
function cachedFFT(n) {
  let f = fftCache.get(n);
  if (!f) {
    f = makeFFT(n);
    fftCache.set(n, f);
  }
  return f;
}
function cachedHann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = makeHann(n);
    hannCache.set(n, w);
  }
  return w;
}
function hannKernelAbs(d) {
  if (Math.abs(d) < 1e-9) return 0.5;
  const den = 2 * Math.PI * d * (1 - d * d);
  if (Math.abs(den) < 1e-12) return 0.25;
  return Math.abs(Math.sin(Math.PI * d) / den);
}
function hannPeakOffset(a, b, c) {
  const den = c + a + 2 * b;
  if (den <= 0) return 0;
  const d = 2 * (c - a) / den;
  return d > 0.6 ? 0.6 : d < -0.6 ? -0.6 : d;
}
function findPeaks(mag, n, loBin, hiBin, floor) {
  const out = [];
  for (let i = Math.max(1, loBin); i < Math.min(hiBin, mag.length - 1); i++) {
    const b = mag[i];
    if (b <= floor) continue;
    if (b < mag[i - 1] || b < mag[i + 1]) continue;
    if (b === mag[i + 1] && b === mag[i - 1]) continue;
    const d = hannPeakOffset(mag[i - 1], b, mag[i + 1]);
    const g = hannKernelAbs(d);
    out.push({ bin: i + d, amp: b / (n * (g > 1e-6 ? g : 1e-6)), raw: b });
  }
  return out;
}
function noiseFloor(mag, loBin, hiBin) {
  const v = [];
  for (let i = loBin; i < hiBin; i += 3) v.push(mag[i]);
  v.sort((a, b) => a - b);
  return v.length ? v[v.length * 0.5 | 0] : 0;
}
function median(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(a) {
  const m = median(a);
  return median(a.map((v) => Math.abs(v - m)));
}
const LN2 = Math.LN2;
const toCents = (ln) => ln * 1200 / LN2;
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
function pickN(targets, fs) {
  const lo = Math.min(...targets);
  const n = 1 << Math.ceil(Math.log2(28 * fs / lo));
  return Math.max(16384, Math.min(32768, n));
}
function detectOnset(x, fs) {
  const hop = Math.round(5e-3 * fs);
  const nH = Math.floor(x.length / hop);
  const e = new Float64Array(nH);
  for (let h = 0; h < nH; h++) {
    let s = 0;
    for (let i = h * hop; i < (h + 1) * hop; i++) s += x[i] * x[i];
    e[h] = Math.sqrt(s / hop);
  }
  let pk = 0;
  for (let h = 0; h < Math.min(nH, 120); h++) pk = Math.max(pk, e[h]);
  for (let h = 0; h < nH; h++) if (e[h] > 0.25 * pk) return h * hop / fs;
  return 0;
}
const magAt = (mag, binF) => {
  const i = Math.floor(binF);
  return i < 1 || i + 1 >= mag.length ? 0 : Math.max(mag[i], mag[i + 1]);
};
const partialFreq = (f0, B, k) => k * f0 * Math.sqrt(1 + B * k * k);
function fitComb(pts, o) {
  if (!pts.length) return null;
  let maxK = 0;
  for (const p of pts) maxK = Math.max(maxK, p.k);
  const bs = [];
  if (maxK >= 4 && pts.length >= 3) {
    bs.push(0);
    for (let i = 0; i < o.bGrid; i++) {
      bs.push(1e-5 * Math.pow(o.bMax / 1e-5, i / (o.bGrid - 1)));
    }
  } else bs.push(o.bNominal);
  let best = null;
  for (const B of bs) {
    let sw = 0;
    let sz = 0;
    for (const p of pts) {
      sw += p.w;
      sz += p.w * (Math.log(p.f / p.k) - 0.5 * Math.log(1 + B * p.k * p.k));
    }
    if (sw <= 0) continue;
    const lnf0 = sz / sw;
    let r = 0;
    for (const p of pts) {
      const d = toCents(Math.log(p.f / p.k) - 0.5 * Math.log(1 + B * p.k * p.k) - lnf0);
      r += p.w * d * d;
    }
    r += sw * o.bPriorW * Math.pow((B - o.bPrior) / o.bPriorSigma, 2);
    if (!best || r < best.r) best = { r, lnf0, B, sw };
  }
  if (!best) return null;
  return {
    f0: Math.exp(best.lnf0),
    B: best.B,
    resid: Math.sqrt(
      Math.max(
        0,
        best.r / best.sw - o.bPriorW * Math.pow((best.B - o.bPrior) / o.bPriorSigma, 2)
      )
    ),
    wsum: best.sw
  };
}
function analyzeFrame(ctx, targets, o) {
  const { re, im, mag, n, fs } = ctx;
  const binHz = fs / n;
  const hiBin = Math.min(mag.length - 3, Math.ceil(o.fMax / binHz) + 6);
  const loBin = Math.max(2, Math.floor(Math.min(...targets) * 0.55 / binHz));
  const flr = noiseFloor(mag, loBin, hiBin);
  const noiseAmp = flr / (n * 0.25);
  const peaks = findPeaks(mag, n, loBin, hiBin, flr * 2.2);
  peaks.sort((a, b) => a.bin - b.bin);
  const peakF = peaks.map((p) => p.bin * binHz);
  const S = targets.length;
  const order = targets.map((f, i) => [f, i]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const st = targets.map((t, i) => ({
    i,
    target: t,
    f0: t,
    B: o.bNominal,
    env: null,
    pts: [],
    nGood: 0,
    resid: 0,
    ok: false,
    evid: 0,
    evidX: 0,
    ownDb: -99,
    wsum: 0,
    clean: null,
    meanR: 0,
    meanBias: 0
  }));
  const kMax = (f0) => Math.max(2, Math.min(o.maxPartials, Math.floor(o.fMax / f0)));
  function nearestPeak(f, tol) {
    let lo = 0;
    let hi = peakF.length - 1;
    let best = -1;
    let bd = Infinity;
    while (lo <= hi) {
      const m = lo + hi >> 1;
      const d = peakF[m] - f;
      if (Math.abs(d) < bd) {
        bd = Math.abs(d);
        best = m;
      }
      if (d < 0) lo = m + 1;
      else hi = m - 1;
    }
    for (let j = Math.max(0, best - 2); j <= Math.min(peakF.length - 1, best + 2); j++) {
      const d = Math.abs(peakF[j] - f);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    return best >= 0 && bd <= tol ? peaks[best] : null;
  }
  function predAmp(s, k) {
    const c = st[s];
    const env = c.env;
    if (!env) return 0;
    const m = c.clean;
    if (m && m.size) {
      const hit = m.get(k);
      if (hit !== void 0) return hit;
      let lo = -1;
      let hi = -1;
      for (const kk of m.keys()) {
        if (kk < k && (lo < 0 || kk > lo)) lo = kk;
        if (kk > k && (hi < 0 || kk < hi)) hi = kk;
      }
      const notch = (kk) => Math.max(0.14, Math.abs(Math.sin(Math.PI * kk * env.p)));
      if (lo > 0 && hi > 0) {
        const t = (Math.log(k) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
        return Math.exp(
          Math.log(m.get(lo)) * (1 - t) + Math.log(m.get(hi)) * t
        );
      }
      const anchor = lo > 0 ? lo : hi;
      if (anchor > 0) {
        return m.get(anchor) * Math.pow(k / anchor, -env.q) * (notch(k) / notch(anchor));
      }
    }
    return env.L * Math.pow(k, -env.q) * Math.max(0.14, Math.abs(Math.sin(Math.PI * k * env.p)));
  }
  function contamAt(f, me) {
    let c = 0;
    let cd = 0;
    let sep = 99;
    for (let t = 0; t < S; t++) {
      if (t === me) continue;
      const km = kMax(st[t].f0);
      for (let j = 1; j <= km; j++) {
        const ft = partialFreq(st[t].f0, st[t].B, j);
        const d = (ft - f) / (1.15 * binHz);
        if (Math.abs(d) > 4) continue;
        const a = (st[t].env ? predAmp(t, j) : 0) * Math.exp(-0.5 * d * d);
        c += a;
        cd += a * Math.abs(toCents(Math.log(ft / f)));
        const db = Math.abs(ft - f) / binHz;
        if (db < sep) sep = db;
      }
    }
    return { amp: c, dc: c > 0 ? cd / c : 0, sepBins: sep };
  }
  function contaminants(f, me, bins) {
    const out = [];
    for (let t = 0; t < S; t++) {
      if (t === me) continue;
      const km = kMax(st[t].f0);
      for (let j = 1; j <= km; j++) {
        const ft = partialFreq(st[t].f0, st[t].B, j);
        if (Math.abs(ft - f) > bins * binHz) continue;
        out.push({ t, j, f: ft, a: predAmp(t, j) });
      }
    }
    out.sort((a, b) => b.a - a.a);
    return out.slice(0, 3);
  }
  function coarse(s, spec) {
    const T = st[s].target;
    const km = Math.min(9, kMax(T));
    let bestC = 0;
    let bestV = -1;
    let bestB = o.bNominal;
    for (const B of [3e-5, 12e-5, 3e-4]) {
      for (let c = -o.searchCents; c <= o.searchCents; c += o.coarseStep) {
        const f0 = T * Math.pow(2, c / 1200);
        let v = 0;
        for (let k = 1; k <= km; k++) {
          const f = partialFreq(f0, B, k);
          if (f > o.fMax) break;
          v += magAt(spec, f / binHz) / Math.sqrt(k);
        }
        if (v > bestV) {
          bestV = v;
          bestC = c;
          bestB = B;
        }
      }
    }
    st[s].f0 = T * Math.pow(2, bestC / 1200);
    st[s].B = bestB;
  }
  function refine(s, useContam, tolC) {
    const cur = st[s];
    const km = kMax(cur.f0);
    const pts = [];
    let nGood = 0;
    for (let k = 1; k <= km; k++) {
      const fp = partialFreq(cur.f0, cur.B, k);
      const pk = nearestPeak(fp, Math.max(1.7 * binHz, fp * (Math.pow(2, tolC / 1200) - 1)));
      if (!pk) continue;
      const f = pk.bin * binHz;
      const amp = pk.amp;
      const snr = amp / (noiseAmp + 1e-12);
      if (snr < 2.5) continue;
      const ca = contamAt(f, s);
      const r = Math.min(1.6, ca.amp / (amp + 1e-12));
      const fused = ca.sepBins < o.fuseBins && (!useContam || ca.amp > o.fuseAmp * amp);
      const bias = r * Math.min(Math.max(ca.dc, o.dcFloor), 90);
      const vRes = Math.pow(1731 * binHz * 0.16 / (f * Math.min(snr, 60)), 2);
      const w = 1 / (vRes + Math.pow(0.8 * bias, 2) + 0.02);
      pts.push({
        k,
        f,
        w,
        amp,
        q: Math.max(0, 1 - r),
        snr,
        r,
        bias,
        fused,
        exclusive: ca.sepBins >= o.clearBins
      });
      if (r < 0.55 && snr > 4) nGood++;
    }
    if (!pts.length) {
      cur.pts = [];
      cur.ok = false;
      cur.nGood = 0;
      return;
    }
    const clean = pts.filter((p) => !p.fused && p.r < o.blendR && p.snr > 3.5);
    const fitPts = clean.length >= o.minCleanPts ? clean : pts;
    let fit = fitComb(fitPts, o);
    if (fit && fitPts.length >= 4) {
      const theFit = fit;
      const res = fitPts.map(
        (p) => Math.abs(
          toCents(Math.log(p.f / (p.k * theFit.f0 * Math.sqrt(1 + theFit.B * p.k * p.k))))
        )
      );
      const m = median(res);
      const sc = Math.max(4, 3 * (mad(res) || 2));
      const keep = fitPts.filter((p, i2) => Math.abs(res[i2] - m) < sc || res[i2] < 6);
      if (keep.length >= 3) fit = fitComb(keep, o) || fit;
    }
    if (!fit || Math.abs(toCents(Math.log(fit.f0 / cur.target))) > o.searchCents * 1.15) {
      cur.ok = false;
      cur.nGood = 0;
      return;
    }
    cur.f0 = fit.f0;
    cur.B = fit.B;
    cur.resid = fit.resid;
    cur.pts = pts;
    cur.nGood = nGood;
    cur.wsum = fit.wsum;
    cur.ok = true;
    cur.evidX = 0;
    for (const p of pts) {
      if (!p.exclusive) continue;
      const dev = Math.abs(
        toCents(Math.log(p.f / (p.k * fit.f0 * Math.sqrt(1 + fit.B * p.k * p.k))))
      );
      if (dev > o.exclDevC) continue;
      cur.evidX += clamp01((20 * Math.log10(p.snr) - o.exclSnrDb) / 8);
    }
    cur.meanR = pts.reduce((a, p) => a + p.r * p.amp, 0) / (pts.reduce((a, p) => a + p.amp, 0) || 1);
    cur.clean = /* @__PURE__ */ new Map();
    for (const p of pts) if (p.r < 0.28 && p.snr > 3) cur.clean.set(p.k, p.amp);
    cur.meanBias = pts.reduce((a, p) => a + p.bias * p.amp, 0) / (pts.reduce((a, p) => a + p.amp, 0) || 1);
  }
  function fitEnv(s) {
    const cur = st[s];
    const use = cur.pts.filter((p) => p.q > 0.55 && p.snr > 3);
    const src = use.length >= 3 ? use : cur.pts.filter((p) => p.snr > 3);
    if (!src.length) {
      cur.env = null;
      return;
    }
    if (src.length < 4) {
      const p0 = src[0];
      cur.env = { L: p0.amp * Math.pow(p0.k, 1.2), q: 1.2, p: 1e-3 };
      return;
    }
    let best = null;
    for (let pi = 0; pi <= 24; pi++) {
      const p = 0.06 + pi * (0.3 - 0.06) / 24;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      let sw = 0;
      for (const pt of src) {
        const X = Math.log(pt.k);
        const Y = Math.log(pt.amp) - Math.log(Math.max(0.14, Math.abs(Math.sin(Math.PI * pt.k * p))));
        sw++;
        sx += X;
        sy += Y;
        sxx += X * X;
        sxy += X * Y;
      }
      const den = sw * sxx - sx * sx;
      let q = den > 1e-9 ? -(sw * sxy - sx * sy) / den : 1.2;
      q = Math.max(0.3, Math.min(3.2, q));
      const lnL = (sy + q * sx) / sw;
      let r = 0;
      for (const pt of src) {
        const Y = Math.log(pt.amp) - Math.log(Math.max(0.14, Math.abs(Math.sin(Math.PI * pt.k * p))));
        r += Math.pow(Y - (lnL - q * Math.log(pt.k)), 2);
      }
      if (!best || r < best.r) best = { r, L: Math.exp(lnL), q, p };
    }
    cur.env = best ? { L: best.L, q: best.q, p: best.p } : null;
  }
  const R = o.fineR;
  const W = 2 * R + 1;
  const aBuf = new Float64Array(W);
  const bBuf = [new Float64Array(W), new Float64Array(W), new Float64Array(W)];
  function realAtom(nu, b0, dst) {
    for (let i = 0; i < W; i++) {
      let d = nu - b0 - i;
      const nr = Math.round(d);
      if (Math.abs(d - nr) < 1e-6) d = nr + (d >= nr ? 1e-6 : -1e-6);
      dst[i] = 1 / (2 * Math.PI * d * (1 - d * d));
    }
    return dst;
  }
  const rdot = (u, v) => {
    let s = 0;
    for (let i = 0; i < W; i++) s += u[i] * v[i];
    return s;
  };
  function fine(s, lim, step) {
    const cur = st[s];
    if (!cur.ok) return;
    const km = kMax(cur.f0);
    const slots = [];
    for (let k = 1; k <= km; k++) {
      const fc = partialFreq(cur.f0, cur.B, k);
      const b0 = Math.round(fc / binHz) - R;
      if (b0 < 1 || b0 + W >= mag.length) continue;
      let e = 0;
      for (let i = 0; i < W; i++) e += mag[b0 + i] * mag[b0 + i];
      if (e < W * flr * flr * 3) continue;
      const cs = contaminants(fc, s, R - 2).filter((c) => c.a > 0);
      const basis = [];
      for (let ci = 0; ci < cs.length && basis.length < 3; ci++) {
        const v = realAtom(cs[ci].f / binHz, b0, bBuf[basis.length]);
        for (const u of basis) {
          const p = rdot(u, v);
          for (let i = 0; i < W; i++) v[i] -= p * u[i];
        }
        const nn = Math.sqrt(rdot(v, v));
        if (nn < 1e-12) continue;
        for (let i = 0; i < W; i++) v[i] /= nn;
        basis.push(Float64Array.from(v));
      }
      const xr = new Float64Array(W);
      const xi = new Float64Array(W);
      for (let i = 0; i < W; i++) {
        xr[i] = re[b0 + i];
        xi[i] = im[b0 + i];
      }
      for (const u of basis) {
        let pr = 0;
        let pi2 = 0;
        for (let i = 0; i < W; i++) {
          pr += u[i] * xr[i];
          pi2 += u[i] * xi[i];
        }
        for (let i = 0; i < W; i++) {
          xr[i] -= pr * u[i];
          xi[i] -= pi2 * u[i];
        }
      }
      slots.push({ k, b0, basis, xr, xi, iota: 0, n0: 0, use: false });
    }
    if (!slots.length) return;
    for (const sl of slots) {
      const nu = partialFreq(cur.f0, cur.B, sl.k) / binHz;
      const a = realAtom(nu, sl.b0, aBuf);
      const n0 = rdot(a, a);
      for (const u of sl.basis) {
        const p = rdot(u, a);
        for (let i = 0; i < W; i++) a[i] -= p * u[i];
      }
      sl.iota = rdot(a, a) / (n0 + 1e-30);
      sl.n0 = n0;
      sl.use = sl.iota >= o.iotaMin;
    }
    function score(c, info2) {
      const f0 = cur.f0 * Math.pow(2, c / 1200);
      let tot = 0;
      for (const sl of slots) {
        if (!sl.use) continue;
        const nu = partialFreq(f0, cur.B, sl.k) / binHz;
        if (nu - sl.b0 < 2.5 || nu - sl.b0 > W - 3.5) continue;
        const a = realAtom(nu, sl.b0, aBuf);
        for (const u of sl.basis) {
          const p = rdot(u, a);
          for (let i = 0; i < W; i++) a[i] -= p * u[i];
        }
        const n1 = rdot(a, a) + o.ridge * sl.n0;
        let pr = 0;
        let pi2 = 0;
        for (let i = 0; i < W; i++) {
          pr += a[i] * sl.xr[i];
          pi2 += a[i] * sl.xi[i];
        }
        const ex = (pr * pr + pi2 * pi2) / n1;
        tot += ex;
        if (info2) info2.push({ k: sl.k, iota: sl.iota, ex });
      }
      return tot;
    }
    let bc = 0;
    let bv = -1;
    let bi = 0;
    const grid = [];
    for (let c = -lim, i = 0; c <= lim + 1e-9; c += step, i++) {
      const v = score(c, null);
      grid.push(v);
      if (v > bv) {
        bv = v;
        bc = c;
        bi = i;
      }
    }
    if (bi > 0 && bi < grid.length - 1) {
      const y0 = grid[bi - 1];
      const y1 = grid[bi];
      const y2 = grid[bi + 1];
      const den = y0 - 2 * y1 + y2;
      if (den < 0) bc += step * 0.5 * (y0 - y2) / den;
    }
    if (Math.abs(toCents(Math.log(cur.f0 / cur.target)) + bc) > o.searchCents * 1.05) bc = 0;
    const info = [];
    score(bc, info);
    if (o.fineMove) cur.f0 *= Math.pow(2, bc / 1200);
    const noiseE = W * flr * flr;
    let evid = 0;
    let ownE = 0;
    for (const p of info) {
      const snrDb = 10 * Math.log10((p.ex + 1e-30) / (noiseE + 1e-30));
      evid += p.iota * clamp01((snrDb - 5) / 9);
      ownE += p.ex;
    }
    cur.evid = evid;
    cur.ownDb = 10 * Math.log10((ownE / Math.max(1, info.length) + 1e-30) / (noiseE + 1e-30));
  }
  function recoarse(s) {
    const cur = st[s];
    const km = kMax(cur.target);
    const others = [];
    for (let t = 0; t < S; t++) {
      if (t === s || !st[t].ok) continue;
      const kt = kMax(st[t].f0);
      for (let j = 1; j <= kt; j++) others.push(partialFreq(st[t].f0, st[t].B, j));
    }
    others.sort((a, b) => a - b);
    const clearOf = (f) => {
      let lo = 0;
      let hi = others.length - 1;
      let bd = Infinity;
      while (lo <= hi) {
        const m = lo + hi >> 1;
        const d = others[m] - f;
        if (Math.abs(d) < bd) bd = Math.abs(d);
        if (d < 0) lo = m + 1;
        else hi = m - 1;
      }
      return bd / binHz >= o.clearBins;
    };
    let best = null;
    for (const B of [3e-5, 12e-5, 3e-4]) {
      for (let c = -o.searchCents; c <= o.searchCents; c += o.recoarseStep) {
        const f0 = cur.target * Math.pow(2, c / 1200);
        let v = 0;
        let cnt = 0;
        for (let k = 1; k <= km; k++) {
          const f = partialFreq(f0, B, k);
          if (f > o.fMax) break;
          if (!clearOf(f)) continue;
          v += magAt(mag, f / binHz) / Math.sqrt(k);
          cnt++;
        }
        if (cnt < o.clearMin) continue;
        const sc = v / cnt;
        if (!best || sc > best.sc) best = { sc, f0, B, cnt };
      }
    }
    if (best) {
      cur.f0 = best.f0;
      cur.B = best.B;
    }
    return !!best;
  }
  for (const s of order) coarse(s, mag);
  for (let p = 0; p < o.peelPasses; p++) {
    const tolC = o.tolSchedule[Math.min(p, o.tolSchedule.length - 1)];
    for (const s of order) {
      refine(s, p > 0, tolC);
      fitEnv(s);
    }
  }
  if (o.recoarse) {
    for (const s of order) {
      const cur = st[s];
      if (!cur.ok) continue;
      const keep = {
        f0: cur.f0,
        B: cur.B,
        resid: cur.resid,
        pts: cur.pts,
        nGood: cur.nGood,
        wsum: cur.wsum,
        clean: cur.clean,
        meanR: cur.meanR
      };
      const restore = () => {
        cur.f0 = keep.f0;
        cur.B = keep.B;
        cur.resid = keep.resid;
        cur.pts = keep.pts;
        cur.nGood = keep.nGood;
        cur.wsum = keep.wsum;
        cur.clean = keep.clean;
        cur.meanR = keep.meanR;
      };
      if (!recoarse(s)) {
        restore();
        continue;
      }
      refine(s, true, o.tolSchedule[1]);
      const moved = Math.abs(toCents(Math.log(cur.f0 / keep.f0)));
      const better = cur.ok && cur.wsum > keep.wsum * o.recoarseGain;
      if (!cur.ok || moved > 1 && !better) {
        restore();
        cur.ok = true;
      }
      fitEnv(s);
    }
    for (const s of order) {
      refine(s, true, o.tolSchedule[3]);
      fitEnv(s);
    }
  }
  if (o.fine) {
    const need = o.fineMove ? order.filter((s) => st[s].ok && st[s].meanR > o.fineIfR) : [];
    for (let p = 0; p < o.finePasses; p++) for (const s of need) fine(s, o.fineCents, o.fineStep);
    for (const s of order) if (!need.includes(s)) fine(s, 0, 1);
  }
  return st.map(
    (c) => !c.ok || !c.pts.length ? { cents: NaN, f0: NaN, B: NaN, nGood: 0, evid: 0, evidX: 0, ownDb: -99, resid: 99 } : {
      cents: toCents(Math.log(c.f0 / c.target)),
      f0: c.f0,
      B: c.B,
      nGood: c.nGood,
      evid: c.evid,
      evidX: c.evidX,
      ownDb: c.ownDb,
      resid: c.resid
    }
  );
}
function defaultStarts() {
  const out = [];
  for (let i = 0; i < 9; i++) out.push(0.035 + i * 1.21 / 8);
  return out;
}
function analyzeStrumRaw(x, fs, targets, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = o.n || pickN(targets, fs);
  const fft = cachedFFT(n);
  const win = cachedHann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n / 2 + 1);
  const ctx = { re, im, mag, n, fs };
  const t0 = o.onset != null ? o.onset : detectOnset(x, fs);
  const starts = o.frameStarts || defaultStarts();
  const S = targets.length;
  const per = Array.from({ length: S }, () => []);
  let frames = 0;
  for (const off of starts) {
    const s0 = Math.round((t0 + off) * fs);
    if (s0 < 0 || s0 + n > x.length) continue;
    for (let i = 0; i < n; i++) {
      re[i] = x[s0 + i] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let i = 0; i <= n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    const r = analyzeFrame(ctx, targets, o);
    frames++;
    for (let s = 0; s < S; s++) if (isFinite(r[s].cents)) per[s].push(r[s]);
  }
  const out = [];
  for (let s = 0; s < S; s++) {
    const rows = per[s];
    if (rows.length < o.minFrames) {
      out.push({
        string: s,
        target: targets[s],
        cents: NaN,
        conf: 0,
        detected: false,
        frames: rows.length,
        spread: NaN
      });
      continue;
    }
    const cents = median(rows.map((r) => r.cents));
    const spread = mad(rows.map((r) => r.cents)) * 1.4826;
    const evid = median(rows.map((r) => r.evid));
    const evidX = median(rows.map((r) => r.evidX));
    const ownDb = median(rows.map((r) => r.ownDb));
    const resid = median(rows.map((r) => r.resid));
    const Bmed = median(rows.map((r) => r.B));
    const terms = [
      clamp01((ownDb - 4) / 12),
      // tSnr
      clamp01((evid - 1.15) / 1.1),
      // tEvid
      clamp01((evidX - o.exclMin) / o.exclSpan),
      // tExcl
      clamp01((o.spreadMaxCents - spread) / (o.spreadMaxCents * 0.7)),
      // tSpread
      clamp01((16 - resid) / 12),
      // tResid
      Bmed <= o.bMax * 0.97 ? 1 : 0,
      // tB
      clamp01((rows.length - 2) / 2)
      // tFrames
    ];
    const conf = Math.min(...terms);
    out.push({
      string: s,
      target: targets[s],
      cents,
      conf,
      detected: conf >= o.confThreshold,
      frames: rows.length,
      spread
    });
  }
  return { strings: out, n, frames, onset: t0 };
}
function hasOctavePair(midis) {
  for (let i = 0; i < midis.length; i++) {
    for (let j = i + 1; j < midis.length; j++) {
      if (Math.abs(midis[i] - midis[j]) === 12) return true;
    }
  }
  return false;
}
function analyzeStrum(samples, sampleRate, targetFreqs) {
  const t0 = now();
  if (!targetFreqs.length || !samples.length) {
    return {
      strings: targetFreqs.map(() => ({ cents: null, confidence: 0, detected: false })),
      refusal: null,
      globalOffsetCents: null,
      analysisMs: now() - t0
    };
  }
  const raw = analyzeStrumRaw(samples, sampleRate, targetFreqs);
  const edge = DEFAULTS.searchCents - REFUSE_EDGE_MARGIN_CENTS;
  const shown = raw.strings.filter((r) => r.detected && isFinite(r.cents));
  let refusal = null;
  let globalOffsetCents = null;
  if (shown.length) {
    const cents = shown.map((r) => r.cents);
    const med = median(cents);
    const atEdge = cents.some((c) => Math.abs(c) >= edge);
    const rail = DEFAULTS.searchCents / 2;
    const onRail = (c, sign) => Math.abs(c - sign * rail) <= REFUSE_RAIL_TOL_CENTS;
    const straddles = cents.some((c) => onRail(c, 1)) && cents.some((c) => onRail(c, -1));
    const locked = Math.abs(Math.abs(med) - rail) <= REFUSE_RAIL_TOL_CENTS && cents.filter((c) => onRail(c, Math.sign(med))).length >= REFUSE_RAIL_MIN_STRINGS;
    if (Math.abs(med) > REFUSE_MEDIAN_CENTS || atEdge || straddles || locked) {
      refusal = "offset";
      globalOffsetCents = med;
    }
  }
  const strings = raw.strings.map((r) => {
    const usable = !refusal && r.detected && isFinite(r.cents);
    return { cents: usable ? r.cents : null, confidence: r.conf, detected: usable };
  });
  return { strings, refusal, globalOffsetCents, analysisMs: now() - t0 };
}
function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
export {
  DEFAULTS,
  analyzeStrum,
  analyzeStrumRaw,
  detectOnset,
  hasOctavePair,
  median,
  pickN
};
