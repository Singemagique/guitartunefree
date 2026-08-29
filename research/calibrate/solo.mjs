/**
 * solo.mjs — everything a SINGLE plucked string can tell us.
 *
 * Per solo clip:
 *   f0 (MPM)        the app's own src/audio/pitch.ts, run exactly as the tuner
 *                   runs it (2048-sample frames, 25 ms cadence). This is the
 *                   number the user reads off Single mode, so it is the
 *                   ground-truth pitch the strum results are scored against.
 *   f0, B (comb)    a high-resolution partial fit: peak-pick a long Hann
 *                   spectrum, match partials to k f0 sqrt(1 + B k^2), and fit
 *                   (f0, B) in log-frequency on a FINE B grid — much finer than
 *                   the 26-point grid the shipped analyzer can afford. This is
 *                   the measured INHARMONICITY, the first thing the synthetic
 *                   assumptions have to answer for.
 *   envelope        measured amplitude at every owned partial, plus the best
 *                   L k^-q |sin(pi k p)| fit — the exact parametric family
 *                   strum.ts's fitEnv() assumes — and how far the truth is from
 *                   it, in dB.
 *   polarisation    per partial: complex-demodulate to the partial's own
 *                   baseband, strip the decay, and read the BEAT off what is
 *                   left. Rate in Hz and depth in [0,1] (depth == the amplitude
 *                   ratio of the two polarisations). This is the one parameter
 *                   the v2.0 accuracy claim rests on and has never been measured.
 *   noise/SNR       room floor from the pre-onset silence, clip SNR over the
 *                   first second of ring.
 */

import { loadModules } from './bundle.mjs';

const LN2 = Math.LN2;
export const cents = (f, ref) => (1200 * Math.log(f / ref)) / LN2;
const partialFreq = (f0, B, k) => k * f0 * Math.sqrt(1 + B * k * k);

function medianOf(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(a, p) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const rms = (x, a, b) => {
  let e = 0;
  const lo = Math.max(0, a | 0);
  const hi = Math.min(x.length, b | 0);
  for (let i = lo; i < hi; i++) e += x[i] * x[i];
  return hi > lo ? Math.sqrt(e / (hi - lo)) : 0;
};

/* --------------------------------------------------------------- MPM f0 */

/**
 * Drive the shipped PitchDetector over the clip the way tuner-view does:
 * 2048-sample frames at the app's 25 ms detect cadence.
 */
export async function mpmPitch(x, fs, { from = 0, to = Infinity } = {}) {
  const { pitch } = await loadModules();
  const N = 2048;
  const det = new pitch.PitchDetector(fs, N, 25);
  const hop = Math.max(1, Math.round(0.025 * fs));
  const buf = new Float32Array(N);
  const freqs = [];
  const clar = [];
  const start = Math.max(0, Math.round(from * fs));
  const end = Math.min(x.length - N, Math.round(to * fs));
  for (let i = start; i <= end; i += hop) {
    for (let j = 0; j < N; j++) buf[j] = x[i + j];
    const r = det.detect(buf);
    if (r) {
      freqs.push(r.freq);
      clar.push(r.clarity);
    }
  }
  return {
    freq: medianOf(freqs),
    clarity: medianOf(clar),
    frames: freqs.length,
    spreadCents: freqs.length > 1 ? cents(percentile(freqs, 0.84), percentile(freqs, 0.16)) : NaN,
  };
}

/* ------------------------------------------------- high-resolution comb */

/**
 * Weighted (f0, B) fit of ln f_k = ln k + ln f0 + 0.5 ln(1 + B k^2).
 * Same model as strum.ts's fitComb, but on a 512-point log grid plus a
 * parabolic refinement — this is the reference, so it can afford it.
 */
export function fitCombFine(pts, { bLo = 1e-6, bHi = 1.5e-3 } = {}) {
  if (pts.length < 2) return null;
  const evalB = (B) => {
    let sw = 0;
    let sz = 0;
    for (const p of pts) {
      sw += p.w;
      sz += p.w * (Math.log(p.f / p.k) - 0.5 * Math.log(1 + B * p.k * p.k));
    }
    const lnf0 = sz / sw;
    let r = 0;
    for (const p of pts) {
      const d =
        (1200 / LN2) * (Math.log(p.f / p.k) - 0.5 * Math.log(1 + B * p.k * p.k) - lnf0);
      r += p.w * d * d;
    }
    return { r: r / sw, lnf0 };
  };
  const maxK = Math.max(...pts.map((p) => p.k));
  // B is only identifiable once the comb reaches partials whose stretch is
  // bigger than the measurement noise; below k=4 the fit is a straight line.
  if (maxK < 4 || pts.length < 3) {
    const at = evalB(1.2e-4);
    return { f0: Math.exp(at.lnf0), B: NaN, residCents: Math.sqrt(at.r), n: pts.length, weak: true };
  }
  const G = 512;
  let best = null;
  const grid = [];
  for (let i = 0; i < G; i++) {
    const B = bLo * Math.pow(bHi / bLo, i / (G - 1));
    const e = evalB(B);
    grid.push({ B, ...e });
    if (!best || e.r < best.r) best = { B, ...e, i };
  }
  // parabolic refinement in log B
  let B = best.B;
  if (best.i > 0 && best.i < G - 1) {
    const y0 = grid[best.i - 1].r;
    const y1 = grid[best.i].r;
    const y2 = grid[best.i + 1].r;
    const den = y0 - 2 * y1 + y2;
    if (den > 0) {
      const step = Math.log(bHi / bLo) / (G - 1);
      const d = (0.5 * (y0 - y2)) / den;
      B = best.B * Math.exp(step * Math.max(-1, Math.min(1, d)));
    }
  }
  const fin = evalB(B);
  return { f0: Math.exp(fin.lnf0), B, residCents: Math.sqrt(fin.r), n: pts.length, weak: false };
}

/**
 * fitCombFine with two rounds of outlier rejection. A partial whose measured
 * position is pulled by an unresolved neighbour, a body-mode shoulder or a
 * noise peak would otherwise drag B, which has a k^2 lever arm on the fit.
 */
export function fitCombRobust(pts) {
  let use = pts.slice();
  let fit = fitCombFine(use);
  if (!fit) return null;
  for (let it = 0; it < 2 && use.length > 5; it++) {
    const devs = use.map((p) => Math.abs(cents(p.f, partialFreq(fit.f0, fit.B, p.k))));
    const med = medianOf(devs);
    const scale = Math.max(1.2, 1.4826 * medianOf(devs.map((d) => Math.abs(d - med))) * 3);
    const keep = use.filter((p, i) => devs[i] <= med + scale);
    if (keep.length < 5 || keep.length === use.length) break;
    const next = fitCombFine(keep);
    if (!next) break;
    use = keep;
    fit = next;
  }
  return { ...fit, used: use.length, dropped: pts.length - use.length, pts: use };
}

/** One Hann spectrum of x[start .. start+n), with the app's own FFT/window. */
async function spectrumAt(x, start, n, fs) {
  const { probe } = await loadModules();
  const fft = probe.cachedFFT(n);
  const win = probe.cachedHann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = (x[start + i] ?? 0) * win[i];
    im[i] = 0;
  }
  fft.forward(re, im);
  const mag = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return { mag, n, binHz: fs / n };
}

/**
 * Partial table for one window: match k = 1.. against the current (f0, B),
 * tightening the tolerance, refitting each pass.
 */
async function partialsIn(x, start, n, fs, f0Seed, fMax) {
  const { probe } = await loadModules();
  const { mag, binHz } = await spectrumAt(x, start, n, fs);
  const loBin = Math.max(2, Math.floor((f0Seed * 0.55) / binHz));
  const hiBin = Math.min(mag.length - 2, Math.ceil(fMax / binHz) + 4);
  const flr = probe.noiseFloor(mag, loBin, hiBin);
  const peaks = probe.findPeaks(mag, n, loBin, hiBin, flr * 2.0);
  peaks.sort((a, b) => a.bin - b.bin);
  const noiseAmp = flr / (n * 0.25);

  let f0 = f0Seed;
  let B = 1.2e-4;
  let table = [];
  let fit = null;
  for (const tolC of [45, 22, 12, 8]) {
    const kMax = Math.max(2, Math.min(30, Math.floor(fMax / f0)));
    table = [];
    for (let k = 1; k <= kMax; k++) {
      const fp = partialFreq(f0, B, k);
      const tol = Math.max(1.7 * binHz, fp * (Math.pow(2, tolC / 1200) - 1));
      let best = null;
      let bd = Infinity;
      for (const pk of peaks) {
        const d = Math.abs(pk.bin * binHz - fp);
        if (d < bd) {
          bd = d;
          best = pk;
        }
      }
      if (!best || bd > tol) continue;
      const f = best.bin * binHz;
      const snr = best.amp / (noiseAmp + 1e-30);
      if (snr < 3) continue;
      // weight ~ 1/variance of a peak position at this SNR and frequency
      const w = 1 / (Math.pow((1731 * binHz * 0.16) / (f * Math.min(snr, 200)), 2) + 1e-4);
      table.push({ k, f, amp: best.amp, snr, w });
    }
    const got = fitCombRobust(table);
    if (!got) break;
    fit = got;
    f0 = got.f0;
    if (isFinite(got.B)) B = got.B;
  }
  if (!fit) return null;
  for (const p of table) p.dev = cents(p.f, partialFreq(fit.f0, fit.B, p.k));
  return { fit, table, binHz, noiseAmp, flr, n };
}

/** L k^-q |sin(pi k p)| — the family strum.ts's fitEnv() assumes. */
export function fitEnvelope(table) {
  const src = table.filter((p) => p.snr > 4);
  if (src.length < 4) return null;
  let best = null;
  for (let pi = 0; pi <= 60; pi++) {
    const p = 0.04 + (pi * (0.34 - 0.04)) / 60;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const nn = src.length;
    for (const pt of src) {
      const X = Math.log(pt.k);
      const Y = Math.log(pt.amp) - Math.log(Math.max(0.14, Math.abs(Math.sin(Math.PI * pt.k * p))));
      sx += X;
      sy += Y;
      sxx += X * X;
      sxy += X * Y;
    }
    const den = nn * sxx - sx * sx;
    let q = den > 1e-9 ? -(nn * sxy - sx * sy) / den : 1.2;
    q = Math.max(0.2, Math.min(4, q));
    const lnL = (sy + q * sx) / nn;
    let r = 0;
    for (const pt of src) {
      const Y =
        Math.log(pt.amp) - Math.log(Math.max(0.14, Math.abs(Math.sin(Math.PI * pt.k * p))));
      r += Math.pow(Y - (lnL - q * Math.log(pt.k)), 2);
    }
    if (!best || r < best.r) best = { r, L: Math.exp(lnL), q, p };
  }
  const resDb = src.map((pt) => {
    const model =
      best.L * Math.pow(pt.k, -best.q) * Math.max(0.14, Math.abs(Math.sin(Math.PI * pt.k * best.p)));
    return 20 * Math.log10(pt.amp / model);
  });
  return {
    q: best.q,
    p: best.p,
    rmsDb: Math.sqrt(resDb.reduce((a, v) => a + v * v, 0) / resDb.length),
    maxDb: Math.max(...resDb.map(Math.abs)),
    n: src.length,
  };
}

/* --------------------------------------------------------- polarisation */

/**
 * Complex envelope of the partial at `f`, decimated to ~`envFs` Hz.
 * Demodulate to baseband, then two passes of a boxcar of length fs/bw (a
 * triangular FIR: first null at bw, ~-26 dB by 2 bw), then decimate. bw is set
 * below half the partial spacing so no neighbouring partial leaks in.
 */
export function partialEnvelope(x, fs, f, from, to, bw, envFs = 400) {
  const i0 = Math.max(0, Math.round(from * fs));
  const i1 = Math.min(x.length, Math.round(to * fs));
  const L = Math.max(4, Math.round(fs / bw));
  if (i1 - i0 < 4 * L) return null;
  const n = i1 - i0;
  const zr = new Float64Array(n);
  const zi = new Float64Array(n);
  const w = (-2 * Math.PI * f) / fs;
  for (let i = 0; i < n; i++) {
    const ph = w * (i0 + i);
    const c = Math.cos(ph);
    const s = Math.sin(ph);
    zr[i] = x[i0 + i] * c;
    zi[i] = x[i0 + i] * s;
  }
  const box = (a) => {
    const out = new Float64Array(a.length);
    let acc = 0;
    for (let i = 0; i < a.length; i++) {
      acc += a[i];
      if (i >= L) acc -= a[i - L];
      out[i] = acc / Math.min(L, i + 1);
    }
    return out;
  };
  const fr = box(box(zr));
  const fi = box(box(zi));
  const hop = Math.max(1, Math.round(fs / envFs));
  const skip = 2 * L; // filter start-up
  const out = [];
  const t = [];
  for (let i = skip; i < n; i += hop) {
    out.push(Math.hypot(fr[i], fi[i]));
    t.push((i0 + i) / fs);
  }
  return { env: Float64Array.from(out), t: Float64Array.from(t), fs: fs / hop, groupDelay: L / fs };
}

/**
 * Solve the least-squares system A c = b for a small symmetric normal-equation
 * matrix (Gaussian elimination with partial pivoting). Returns null if singular.
 */
function solveSym(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i][i]);
}

/**
 * Fit  env(t)^2 ~ (p0 + p1 t + p2 t^2) + Ac cos(2 pi r t) + As sin(2 pi r t)
 * at a given beat rate r, and return the modulation depth that implies.
 *
 * The SQUARED envelope of two modes is exactly sinusoidal —
 *   env^2 = a^2 (1 + q^2 + 2 q cos(2 pi r t + phi))
 * — with q the amplitude ratio of the two polarisations. So the depth falls out
 * of a LINEAR fit: with M = hypot(Ac, As) and A0 the smooth part,
 *   M / A0 = 2q / (1 + q^2)   ->   q = A0/M - sqrt((A0/M)^2 - 1).
 * The quadratic in t absorbs what is left of the exponential decay after the
 * log-linear flattening, so the decay can no longer masquerade as beat depth
 * (which is exactly what a running-max estimator does when the beat is slow).
 */
function beatFitAt(y, t, rate) {
  const n = y.length;
  const basis = (i) => {
    const w = 2 * Math.PI * rate * t[i];
    return [1, t[i], t[i] * t[i], Math.cos(w), Math.sin(w)];
  };
  const m = 5;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    const g = basis(i);
    for (let r = 0; r < m; r++) {
      b[r] += g[r] * y[i];
      for (let c = 0; c < m; c++) A[r][c] += g[r] * g[c];
    }
  }
  const c = solveSym(A, b);
  if (!c) return null;
  let ss = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const g = basis(i);
    let v = 0;
    for (let j = 0; j < m; j++) v += g[j] * c[j];
    ss += (y[i] - v) * (y[i] - v);
    sy += y[i];
  }
  const mean = sy / n;
  let tot = 0;
  for (let i = 0; i < n; i++) tot += (y[i] - mean) * (y[i] - mean);
  const M = Math.hypot(c[3], c[4]);
  // smooth part evaluated at the middle of the window
  const tm = t[(n / 2) | 0];
  const A0 = c[0] + c[1] * tm + c[2] * tm * tm;
  const ratio = A0 > 0 ? M / A0 : NaN;
  let q = NaN;
  if (isFinite(ratio)) {
    if (ratio >= 1) q = 1;
    else {
      const u = 1 / ratio;
      q = u - Math.sqrt(u * u - 1);
    }
  }
  return { q, M, A0, modulation: ratio, r2: tot > 0 ? 1 - ss / tot : 0 };
}

/**
 * Beat rate (Hz) and depth (== the amplitude ratio of the two polarisations)
 * of one partial, with the energy-weighted centre of the measurement window so
 * the truth can be evaluated at the same instant.
 */
export function beatOf(x, fs, f, from, to, bw) {
  const e = partialEnvelope(x, fs, f, from, to, bw);
  if (!e || e.env.length < 48) return null;
  const { env, t: tAbs, fs: efs } = e;
  const span = env.length / efs;
  const t = Float64Array.from(tAbs, (v) => v - tAbs[0]);

  // 1. flatten the exponential decay so the modulation is what is left
  const ln = Array.from(env, (v) => Math.log(Math.max(v, 1e-14)));
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < ln.length; i++) {
    sx += t[i];
    sy += ln[i];
    sxx += t[i] * t[i];
    sxy += t[i] * ln[i];
  }
  const nn = ln.length;
  const den = nn * sxx - sx * sx;
  const slope = den > 0 ? (nn * sxy - sx * sy) / den : 0;
  const icpt = (sy - slope * sx) / nn;
  const flat = Float64Array.from(env, (v, i) => v / Math.exp(icpt + slope * t[i]));
  const y = Float64Array.from(flat, (v) => v * v); // exactly sinusoidal in the beat

  // energy-weighted centre: the instant the fitted depth actually describes
  let ew = 0;
  let et = 0;
  for (let i = 0; i < env.length; i++) {
    const w2 = env[i] * env[i];
    ew += w2;
    et += w2 * tAbs[i];
  }
  const tCentre = ew > 0 ? et / ew : tAbs[(env.length / 2) | 0];

  // 2. rate: the modulation frequency that explains most of env^2. Below ~1.2
  //    cycles per window a "beat" is indistinguishable from the decay, so that
  //    is the floor and `cycles` says when to believe the answer.
  const lo = Math.max(0.1, 1.2 / span);
  const hi = Math.min(bw * 0.5, efs / 3, 40);
  if (hi <= lo * 1.05) {
    return { rate: NaN, depth: NaN, cycles: 0, span, tCentre, tau: slope < 0 ? -1 / slope : Infinity };
  }
  let best = null;
  const coarse = 160;
  for (let i = 0; i < coarse; i++) {
    const r = lo * Math.pow(hi / lo, i / (coarse - 1));
    const fit = beatFitAt(y, t, r);
    if (fit && (!best || fit.M > best.M)) best = { rate: r, ...fit };
  }
  if (!best) {
    return { rate: NaN, depth: NaN, cycles: 0, span, tCentre, tau: slope < 0 ? -1 / slope : Infinity };
  }
  // refine
  const stepLog = Math.log(hi / lo) / (coarse - 1);
  for (let i = -10; i <= 10; i++) {
    const r = best.rate * Math.exp((stepLog * i) / 10);
    if (r < lo * 0.9 || r > hi * 1.1) continue;
    const fit = beatFitAt(y, t, r);
    if (fit && fit.M > best.M) best = { rate: r, ...fit };
  }
  return {
    rate: best.rate,
    depth: best.q,
    modulation: best.modulation,
    r2: best.r2,
    cycles: best.rate * span,
    span,
    tCentre,
    tau: slope < 0 ? -1 / slope : Infinity,
  };
}

/* -------------------------------------------------------------- the API */

/**
 * analyzeSolo(x, fs, opts) — the whole per-string measurement.
 * `target` is the nominal frequency for the string this clip is supposed to be
 * (used only to report cents; every fit is seeded from the audio itself).
 */
export async function analyzeSolo(x, fs, { target = null, name = '?', fMax = null } = {}) {
  const { probe } = await loadModules();
  const onset = probe.detectOnset(x, fs);
  const dur = x.length / fs;

  // ---- room floor and clip SNR
  const preI = Math.round(Math.max(0, onset - 0.03) * fs);
  const hasPre = preI > 0.05 * fs;
  const noiseRms = hasPre
    ? rms(x, 0, preI)
    : // no silence before the pluck: use the quietest 150 ms anywhere (an
      // upper bound on the room, flagged as such)
      (() => {
        const w = Math.round(0.15 * fs);
        let best = Infinity;
        for (let i = 0; i + w < x.length; i += w) best = Math.min(best, rms(x, i, i + w));
        return best;
      })();
  const sigRms = rms(x, (onset + 0.05) * fs, (onset + 1.05) * fs);
  const snrDb = 20 * Math.log10((sigRms + 1e-30) / (noiseRms + 1e-30));

  // ---- ground-truth pitch, the app's own way
  const mpm = await mpmPitch(x, fs, { from: onset + 0.05, to: Math.min(dur, onset + 2.5) });
  const seed = isFinite(mpm.freq) && mpm.freq > 0 ? mpm.freq : target;
  if (!seed || !isFinite(seed)) {
    return { name, ok: false, reason: 'no pitch found (MPM silent and no target given)', onset, snrDb, dur };
  }

  // ---- high-resolution comb over up to three windows
  const ceilHz = fMax || Math.min(0.45 * fs, 6000);
  const avail = dur - onset - 0.06;
  // ~1.4 s of Hann: 0.7 Hz bins at 48 kHz. Long enough that the exact-Hann
  // interpolator resolves a partial to a hundredth of a bin, short enough that
  // the high partials have not decayed away inside it.
  let N = 1 << Math.ceil(Math.log2(0.7 * fs));
  while (N / fs > avail * 0.6 && N > 8192) N >>= 1;
  const offsets = [0.06, 0.06 + N / fs / 2, 0.06 + N / fs].filter((o) => onset + o + N / fs <= dur);
  const wins = [];
  for (const off of offsets.length ? offsets : [0.06]) {
    const got = await partialsIn(x, Math.round((onset + off) * fs), N, fs, seed, ceilHz);
    if (got) wins.push({ off, ...got });
  }
  if (!wins.length) return { name, ok: false, reason: 'no usable spectrum window', onset, snrDb, dur };

  // POOL the windows into one fit rather than taking a median of three fits.
  // Each window catches the polarisation beat at a different phase, so a
  // partial's position error is roughly independent between them; pooling
  // averages that away where a median of whole fits cannot.
  const pooled = [];
  for (const w of wins) for (const p of w.table) pooled.push({ ...p, w: p.w / wins.length });
  const joint = fitCombRobust(pooled) || wins[0].fit;
  const f0 = joint.f0;
  const B = joint.B;
  const residCents = joint.residCents;
  const perWindow = wins.map((w) => ({ off: w.off, f0: w.fit.f0, B: w.fit.B, resid: w.fit.residCents }));
  // envelope + partial table from the FIRST window (loudest, least decayed)
  const table = wins[0].table;
  const env = fitEnvelope(table);
  const partials = table.map((p) => ({
    k: p.k,
    f: p.f,
    devCents: p.dev,
    snrDb: 20 * Math.log10(p.snr),
    relDb: 20 * Math.log10(p.amp / (table[0]?.amp || p.amp)),
  }));

  // ---- polarisation, per partial, from the audio itself.
  // Both candidate models predict rate_k = k * rate_1 (a split constant in Hz
  // at f0, and one constant in cents, differ only in how rate_1 varies ACROSS
  // strings). So every partial measures the same underlying number once it is
  // divided by k — and the high partials are the measurable ones, because they
  // beat k times faster and a 3 s clip only resolves a beat it can complete.
  const beats = [];
  const bw = Math.min(0.45 * f0, 45);
  for (const p of table.slice(0, 10)) {
    if (p.snr < 8) continue;
    const width = Math.min(3.0, Math.max(1.2, dur - (onset + 0.10) - 0.05));
    const b = beatOf(x, fs, p.f, onset + 0.10, onset + 0.10 + width, bw);
    if (b && isFinite(b.rate)) {
      beats.push({ k: p.k, f: p.f, snrDb: 20 * Math.log10(p.snr), splitHz1: b.rate / p.k, ...b });
    }
  }
  const good = beats.filter((b) => b.cycles >= 1.8 && isFinite(b.depth));
  const primary = good[0] || beats.find((b) => isFinite(b.depth)) || null;
  const splitHz1 = good.length ? medianOf(good.map((b) => b.splitHz1)) : NaN;

  return {
    name,
    ok: true,
    dur,
    onset,
    fs,
    noiseRms,
    noiseDbfs: 20 * Math.log10(noiseRms + 1e-30),
    snrDb,
    preOnsetSilence: hasPre,
    mpm,
    f0,
    B,
    residCents,
    nWindows: wins.length,
    perWindow,
    partialsUsed: joint.used ?? NaN,
    partialsDropped: joint.dropped ?? NaN,
    fftN: N,
    binHz: fs / N,
    target,
    centsVsTarget: target ? cents(f0, target) : NaN,
    mpmCentsVsFit: isFinite(mpm.freq) ? cents(mpm.freq, f0) : NaN,
    partials,
    env,
    beats,
    /** Beat rate referred to the fundamental (Hz), pooled over partials. */
    splitHz1,
    /** Split expressed the other way: cents between the two polarisations. */
    splitCents: isFinite(splitHz1) ? (1200 * Math.log(1 + splitHz1 / f0)) / LN2 : NaN,
    beatRate: primary?.rate ?? NaN,
    beatDepth: primary?.depth ?? NaN,
    beatK: primary?.k ?? NaN,
    beatCycles: primary?.cycles ?? NaN,
    beatCentreSec: primary?.tCentre ?? NaN,
    measurablePartials: good.length,
  };
}
