/**
 * Polyphonic (strum) tuning offset estimator — a faithful port of the research
 * spike (scratchpad/spike-poly/poly.mjs + dsp.mjs). Classical DSP, template
 * matched against the KNOWN expected per-string frequencies of the selected
 * tuning. No DOM, no Web Audio: give it samples, a rate and the targets.
 *
 * Stages, per analysis frame:
 *   A. Hann FFT. Peak list with an exact three-point Hann interpolator.
 *   B. PEEL, ascending in frequency. A string's fundamental can only be
 *      contaminated by LOWER strings' harmonics (higher strings have no
 *      subharmonics), so by the time we reach string s every contaminant of
 *      its fundamental is already estimated and can be masked out of the
 *      coarse comb search.
 *   C. Per-string (f0, B) fit in log-frequency over the matched partials, with
 *      B CONSTRAINED to the physical guitar range. That constraint is what
 *      stops string s from locking onto string t's harmonic series: if E4's
 *      "partials" are really E2's 4th/8th/12th, the implied B is 16x E2's and
 *      falls outside the range with a large residual.
 *   D. COLLISION STAGE: a projected matched filter in the COMPLEX spectrum.
 *      Colliding partials 2 Hz apart are hopelessly unresolved by peak picking
 *      (Hann main lobe 11.7 Hz at N=16384), but once the lower string's partial
 *      frequency is known, projecting its atom out of the local spectrum leaves
 *      the higher string's contribution behind. The residual-norm fraction after
 *      that projection is the partial's INFORMATIVENESS: it is near zero exactly
 *      when the two hypotheses are physically indistinguishable, which is also
 *      exactly when the answer is the same either way.
 *   E. Frames are fused with a median. Two unresolved partials df apart bias a
 *      peak by ~ r*df*cos(2*pi*df*t + phi); frames spanning ~1.1 s sample a
 *      whole beat cycle whenever df is large enough to matter.
 *
 * The only knowledge taken from the app is `targets` (Hz per string, already
 * carrying sweetened cents, capo transposition and A4 calibration).
 *
 * Port notes (differences from poly.mjs, all non-behavioural):
 *   - dsp.mjs primitives are inlined below; cplx.mjs was imported by the spike
 *     but never used (stage D builds a REAL atom, see `realAtom`).
 *   - poly.mjs's `masked`/`subtractFrom` pair is dead code there and is dropped.
 *   - the spike's `onFrame` debug hook is dropped.
 *   - FFT twiddles/bit-reversal and the Hann window are cached module-level per
 *     size, per the v2.0 verification conditions.
 *   - `analyzeStrum` wraps the spike's raw output with the whole-offset refusal
 *     gate; `analyzeStrumRaw` is the untouched spike behaviour (parity harness).
 */

/* ------------------------------------------------------------ public types */

export interface StrumStringResult {
  /** Offset from this string's target, in cents. null = no reading. */
  cents: number | null;
  confidence: number;
  detected: boolean;
}

export interface StrumResult {
  /** One per target, in the same order. */
  strings: StrumStringResult[];
  /** Condition 1 tripped: the whole instrument reads a long way off. */
  refusal: 'offset' | null;
  /** The median offset that caused the refusal; null when not refusing. */
  globalOffsetCents: number | null;
  analysisMs: number;
}

/* ------------------------------------------------------------------ tuning */

export interface StrumOptions {
  /** Analysis ceiling (Hz). B3/E4 get their only uncontaminated partials high. */
  fMax: number;
  /** +-window around each target (cents). */
  searchCents: number;
  coarseStep: number;
  /** Inharmonicity ceiling (physical). */
  bMax: number;
  bNominal: number;
  bGrid: number;
  maxPartials: number;
  frameStarts: readonly number[] | null;
  n: number | null;
  minFrames: number;
  peelPasses: number;
  /** Stage D (evidence). */
  fine: boolean;
  /** Let stage D move f0 too (measured: it makes it worse). */
  fineMove: boolean;
  finePasses: number;
  /** +- refinement window, cents (must stay inside fineR). */
  fineCents: number;
  fineStep: number;
  /** Regularises the ill-conditioned collision direction. */
  ridge: number;
  /** Half-width of the local bin window. */
  fineR: number;
  /** Contamination ratio above which a peak is 'blended'. */
  blendR: number;
  dcFloor: number;
  /** Another partial this close is inside our main lobe. */
  fuseBins: number;
  /** ... and this loud relative to the measured peak. */
  fuseAmp: number;
  recoarse: boolean;
  /** Separation that makes a partial exclusively ours. */
  clearBins: number;
  /** Cents a partial may deviate and still count as evidence. */
  exclDevC: number;
  /** dB above the noise floor a partial needs to count. */
  exclSnrDb: number;
  /** Partials needed for a re-search candidate to count. */
  clearMin: number;
  /** Cents; refine() re-fits afterwards so a fine grid is waste. */
  recoarseStep: number;
  /** Support the re-search must beat to be adopted. */
  recoarseGain: number;
  bPrior: number;
  bPriorSigma: number;
  /** cents^2 cost of B being one sigma from the prior (measured: hurts). */
  bPriorW: number;
  /** Partial-matching window per pass (cents). */
  tolSchedule: readonly number[];
  /** Clean partials needed before blended ones are dropped. */
  minCleanPts: number;
  /** Run the projected stage only when contamination bites. */
  fineIfR: number;
  /** Informativeness floor for a partial to count at all. */
  iotaMin: number;
  /** Exclusive evidence below this = not detected. */
  exclMin: number;
  exclSpan: number;
  confThreshold: number;
  spreadMaxCents: number;
  /** Onset time in seconds; null = detect it. */
  onset: number | null;
}

export const DEFAULTS: StrumOptions = {
  fMax: 3400,
  searchCents: 100,
  coarseStep: 3,
  bMax: 5.5e-4,
  bNominal: 1.2e-4,
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
  bPrior: 1.1e-4,
  bPriorSigma: 1.7e-4,
  bPriorW: 0,
  tolSchedule: [16, 12, 8, 6],
  minCleanPts: 3,
  fineIfR: 0.06,
  iotaMin: 0.03,
  exclMin: 1.8,
  exclSpan: 1.0,
  confThreshold: 0.15,
  spreadMaxCents: 14,
  onset: null,
};

/* ------------------------------------------------- the refusal gate (cond 1) */

/**
 * A whole-instrument offset — a capo the app does not know about, a tuning
 * selected a semitone away from what is on the neck — puts every string near
 * the edge of the +-100 cent search window, where the estimator confidently
 * reports the edge rather than the truth. The verifier measured ~50% confident
 * ~200 cent lies without this gate, so a reading that looks like one is refused
 * outright rather than shown per string.
 */
const REFUSE_MEDIAN_CENTS = 70;
/** How close to the +-searchCents edge an estimate may sit before it is junk. */
const REFUSE_EDGE_MARGIN_CENTS = 15;
/**
 * ...and a whole-instrument offset near an ODD HALF-semitone (+-150, +-250,
 * +-350) does not reach the edge at all: it aliases into the middle of the
 * window at about +-searchCents/2, where the median test (70 c) and the edge
 * test (85 c) both wave it through and the board prints a confident ~50 c lie.
 * Measured over 8 seeds each, -150/+150/-250/+250 printed numbers in 21 of 32
 * runs, off by up to 200 cents.
 *
 * Two things give it away, and neither can happen to an instrument that is
 * merely out of tune:
 *   - the estimates STRADDLE both rails — some sit at ~+50, others at ~-50 —
 *     which would mean two halves of one guitar disagreeing by a semitone;
 *   - or they LOCK onto one rail: the median lands within a couple of cents of
 *     exactly +-searchCents/2, with at least two strings agreeing there.
 * The tolerance is what separates the two populations: a real +-40 c spread
 * sits 10 c clear of the rail, and every aliased run measured landed within 2.
 */
const REFUSE_RAIL_TOL_CENTS = 8;
/** How many strings must sit on the rail before "locked onto it" is fair. */
const REFUSE_RAIL_MIN_STRINGS = 2;

/* ------------------------------------------------------------- dsp: FFT etc */

interface FFT {
  readonly n: number;
  forward(re: Float64Array, im: Float64Array): void;
}

/** Iterative radix-2 complex FFT with cached twiddles + bit-reversal table. */
function makeFFT(n: number): FFT {
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  const levels = Math.log2(n) | 0;
  const cosT = new Float64Array(n / 2);
  const sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return {
    n,
    /** in-place forward transform of re/im (length n). */
    forward(re: Float64Array, im: Float64Array): void {
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
    },
  };
}

/** Periodic Hann window. */
function makeHann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Twiddles, bit-reversal and the window are the only expensive per-size setup,
 * and a strum analysis runs every few seconds for as long as the view is open.
 * Two sizes exist in practice (16384 / 32768), so the cache is two entries.
 */
const fftCache = new Map<number, FFT>();
const hannCache = new Map<number, Float64Array>();

function cachedFFT(n: number): FFT {
  let f = fftCache.get(n);
  if (!f) {
    f = makeFFT(n);
    fftCache.set(n, f);
  }
  return f;
}

function cachedHann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = makeHann(n);
    hannCache.set(n, w);
  }
  return w;
}

/** |W_hann(d)| in the large-N continuous approximation, normalised so W(0)=0.5.
    W(d) = sin(pi d) / (2 pi d (1 - d^2)). */
function hannKernelAbs(d: number): number {
  if (Math.abs(d) < 1e-9) return 0.5;
  const den = 2 * Math.PI * d * (1 - d * d);
  if (Math.abs(den) < 1e-12) return 0.25; // d = +-1 -> limit is 1/4
  return Math.abs(Math.sin(Math.PI * d) / den);
}

/** Exact three-point Hann peak interpolation.
    With bins a=|X[n-1]|, b=|X[n]|, c=|X[n+1]| around a local max, the true peak
    sits at n + d with  d = 2 (c - a) / (c + a + 2 b).
    Derived from |W(d)| above: (c/b) = (1+d)/(2-d), (a/b) = (1-d)/(2+d).
    Unlike log-parabolic interpolation this has no fractional-offset bias, which
    matters: 0.01 bin of bias is 0.6 cents at the low-E fundamental. */
function hannPeakOffset(a: number, b: number, c: number): number {
  const den = c + a + 2 * b;
  if (den <= 0) return 0;
  const d = (2 * (c - a)) / den;
  return d > 0.6 ? 0.6 : d < -0.6 ? -0.6 : d;
}

interface Peak {
  bin: number;
  amp: number;
  raw: number;
}

/** Local maxima above `floor`, with sub-bin position and amplitude estimate.
    Returned amp is the underlying sinusoid amplitude (peak, not RMS). */
function findPeaks(
  mag: Float64Array,
  n: number,
  loBin: number,
  hiBin: number,
  floor: number,
): Peak[] {
  const out: Peak[] = [];
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

/** Robust background level: median of the magnitude spectrum in a band. */
function noiseFloor(mag: Float64Array, loBin: number, hiBin: number): number {
  const v: number[] = [];
  for (let i = loBin; i < hiBin; i += 3) v.push(mag[i]);
  v.sort((a, b) => a - b);
  return v.length ? v[(v.length * 0.5) | 0] : 0;
}

export function median(a: readonly number[]): number {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(a: readonly number[]): number {
  const m = median(a);
  return median(a.map((v) => Math.abs(v - m)));
}

/* ------------------------------------------------------------- small helpers */

const LN2 = Math.LN2;
const toCents = (ln: number): number => (ln * 1200) / LN2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * FFT size: ~28 periods of the lowest target, clamped to [16384, 32768]. The
 * bin width that comes out is constant across sample rates by construction,
 * which is why the capture window length keys off this and not off a fixed
 * frequency threshold.
 */
export function pickN(targets: readonly number[], fs: number): number {
  const lo = Math.min(...targets);
  const n = 1 << Math.ceil(Math.log2((28 * fs) / lo));
  return Math.max(16384, Math.min(32768, n));
}

export function detectOnset(x: ArrayLike<number>, fs: number): number {
  const hop = Math.round(0.005 * fs);
  const nH = Math.floor(x.length / hop);
  const e = new Float64Array(nH);
  for (let h = 0; h < nH; h++) {
    let s = 0;
    for (let i = h * hop; i < (h + 1) * hop; i++) s += x[i] * x[i];
    e[h] = Math.sqrt(s / hop);
  }
  let pk = 0;
  for (let h = 0; h < Math.min(nH, 120); h++) pk = Math.max(pk, e[h]);
  for (let h = 0; h < nH; h++) if (e[h] > 0.25 * pk) return (h * hop) / fs;
  return 0;
}

const magAt = (mag: Float64Array, binF: number): number => {
  const i = Math.floor(binF);
  return i < 1 || i + 1 >= mag.length ? 0 : Math.max(mag[i], mag[i + 1]);
};

const partialFreq = (f0: number, B: number, k: number): number =>
  k * f0 * Math.sqrt(1 + B * k * k);

/* ---------------------------------------------------------- the comb fitter */

interface FitPoint {
  k: number;
  f: number;
  w: number;
}

interface CombFit {
  f0: number;
  B: number;
  resid: number;
  wsum: number;
}

/** Weighted fit of ln f_k = ln k + ln f0 + 0.5 ln(1 + B k^2), B on a grid. */
function fitComb(pts: readonly FitPoint[], o: StrumOptions): CombFit | null {
  if (!pts.length) return null;
  let maxK = 0;
  for (const p of pts) maxK = Math.max(maxK, p.k);
  const bs: number[] = [];
  if (maxK >= 4 && pts.length >= 3) {
    bs.push(0);
    for (let i = 0; i < o.bGrid; i++) {
      bs.push(1e-5 * Math.pow(o.bMax / 1e-5, i / (o.bGrid - 1)));
    }
  } else bs.push(o.bNominal);
  let best: { r: number; lnf0: number; B: number; sw: number } | null = null;
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
        best.r / best.sw - o.bPriorW * Math.pow((best.B - o.bPrior) / o.bPriorSigma, 2),
      ),
    ),
    wsum: best.sw,
  };
}

/* ------------------------------------------------------------- frame state */

interface Pt {
  k: number;
  f: number;
  w: number;
  amp: number;
  q: number;
  snr: number;
  r: number;
  bias: number;
  fused: boolean;
  exclusive: boolean;
}

interface Env {
  L: number;
  q: number;
  p: number;
}

interface StringState {
  i: number;
  target: number;
  f0: number;
  B: number;
  env: Env | null;
  pts: Pt[];
  nGood: number;
  resid: number;
  ok: boolean;
  evid: number;
  evidX: number;
  ownDb: number;
  wsum: number;
  /** Measured amplitudes at the partials this string demonstrably owns. */
  clean: Map<number, number> | null;
  meanR: number;
  meanBias: number;
}

interface FrameRow {
  cents: number;
  f0: number;
  B: number;
  nGood: number;
  evid: number;
  evidX: number;
  ownDb: number;
  resid: number;
}

interface FrameCtx {
  re: Float64Array;
  im: Float64Array;
  mag: Float64Array;
  n: number;
  fs: number;
}

/* ------------------------------------------------------------------ 1 frame */

function analyzeFrame(
  ctx: FrameCtx,
  targets: readonly number[],
  o: StrumOptions,
): FrameRow[] {
  const { re, im, mag, n, fs } = ctx;
  const binHz = fs / n;
  const hiBin = Math.min(mag.length - 3, Math.ceil(o.fMax / binHz) + 6);
  const loBin = Math.max(2, Math.floor((Math.min(...targets) * 0.55) / binHz));
  const flr = noiseFloor(mag, loBin, hiBin);
  const noiseAmp = flr / (n * 0.25);
  const peaks = findPeaks(mag, n, loBin, hiBin, flr * 2.2);
  peaks.sort((a, b) => a.bin - b.bin);
  const peakF = peaks.map((p) => p.bin * binHz);

  const S = targets.length;
  const order = targets
    .map((f, i): [number, number] => [f, i])
    .sort((a, b) => a[0] - b[0])
    .map((p) => p[1]);
  const st: StringState[] = targets.map((t, i) => ({
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
    meanBias: 0,
  }));
  const kMax = (f0: number): number =>
    Math.max(2, Math.min(o.maxPartials, Math.floor(o.fMax / f0)));

  function nearestPeak(f: number, tol: number): Peak | null {
    let lo = 0;
    let hi = peakF.length - 1;
    let best = -1;
    let bd = Infinity;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
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

  /** How loud string s is at its own partial k.
      Body resonances, room comb filtering and the pluck-position notch make a
      parametric 1/k^q envelope wrong by 10 dB or more, and this number is what
      the whole contamination weighting rests on. So: use the MEASURED amplitude
      wherever s owns an uncontaminated partial, log-interpolate between those,
      and only fall back to the parametric envelope outside their range. */
  function predAmp(s: number, k: number): number {
    const c = st[s];
    const env = c.env;
    if (!env) return 0;
    const m = c.clean;
    if (m && m.size) {
      const hit = m.get(k);
      if (hit !== undefined) return hit;
      let lo = -1;
      let hi = -1;
      for (const kk of m.keys()) {
        if (kk < k && (lo < 0 || kk > lo)) lo = kk;
        if (kk > k && (hi < 0 || kk < hi)) hi = kk;
      }
      const notch = (kk: number): number =>
        Math.max(0.14, Math.abs(Math.sin(Math.PI * kk * env.p)));
      if (lo > 0 && hi > 0) {
        const t = (Math.log(k) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
        return Math.exp(
          Math.log(m.get(lo) as number) * (1 - t) + Math.log(m.get(hi) as number) * t,
        );
      }
      const anchor = lo > 0 ? lo : hi;
      if (anchor > 0) {
        return (
          (m.get(anchor) as number) * Math.pow(k / anchor, -env.q) * (notch(k) / notch(anchor))
        );
      }
    }
    return (
      env.L * Math.pow(k, -env.q) * Math.max(0.14, Math.abs(Math.sin(Math.PI * k * env.p)))
    );
  }

  /** Contaminating amplitude at f, AND the amplitude-weighted cent distance to
      the contaminants. The distance is the whole story for bias: an unresolved
      pair biases the measured peak by about r * (their separation), so a
      near-exact collision (E2's 3rd on B3's fundamental sits 2 cents away in
      equal temperament) is almost harmless however loud it is, while a 30-cent
      one is ruinous at the same r. Penalising by r alone throws away the most
      reliable measurement a string has. */
  function contamAt(f: number, me: number): { amp: number; dc: number; sepBins: number } {
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

  /** every other string's partial within `bins` of f, strongest first */
  function contaminants(
    f: number,
    me: number,
    bins: number,
  ): Array<{ t: number; j: number; f: number; a: number }> {
    const out: Array<{ t: number; j: number; f: number; a: number }> = [];
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

  function coarse(s: number, spec: Float64Array): void {
    const T = st[s].target;
    const km = Math.min(9, kMax(T));
    let bestC = 0;
    let bestV = -1;
    let bestB = o.bNominal;
    for (const B of [3e-5, 1.2e-4, 3e-4]) {
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

  function refine(s: number, useContam: boolean, tolC: number): void {
    const cur = st[s];
    const km = kMax(cur.f0);
    const pts: Pt[] = [];
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
      // GEOMETRIC exclusion, independent of the (fragile) amplitude model: if
      // another string's partial sits inside a Hann main lobe of this one, this
      // peak is a blend and its position is a weighted mean, full stop. This is
      // what octave-duplicate tunings need (DADGAD's D3 lives inside D2's even
      // partials) and it is decidable from the target table alone.
      const fused = ca.sepBins < o.fuseBins && (!useContam || ca.amp > o.fuseAmp * amp);
      // Floor the assumed separation. Using the MEASURED separation alone is a
      // feedback trap: once two strings have collapsed onto the same blended
      // peak their apparent separation is zero, the penalty vanishes, and the
      // error locks in. The floor keeps a permanent scepticism about any
      // contaminated peak.
      const bias = r * Math.min(Math.max(ca.dc, o.dcFloor), 90);
      const vRes = Math.pow((1731 * binHz * 0.16) / (f * Math.min(snr, 60)), 2);
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
        exclusive: ca.sepBins >= o.clearBins,
      });
      if (r < 0.55 && snr > 4) nGood++;
    }
    if (!pts.length) {
      cur.pts = [];
      cur.ok = false;
      cur.nGood = 0;
      return;
    }
    // A blended peak carries the WEIGHTED-MEAN position of two partials, not
    // this string's. Downweighting is not enough when a whole octave-duplicate
    // series is blended (DADGAD's D3 sits inside D2's even partials): drop the
    // blended points from the frequency fit outright whenever enough clean
    // partials survive. They are still kept in `pts` for the energy/evidence
    // bookkeeping.
    const clean = pts.filter((p) => !p.fused && p.r < o.blendR && p.snr > 3.5);
    const fitPts = clean.length >= o.minCleanPts ? clean : pts;
    let fit = fitComb(fitPts, o);
    if (fit && fitPts.length >= 4) {
      const theFit = fit;
      const res = fitPts.map((p) =>
        Math.abs(
          toCents(Math.log(p.f / (p.k * theFit.f0 * Math.sqrt(1 + theFit.B * p.k * p.k)))),
        ),
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
    // EXCLUSIVE evidence: partials of this string that no other string's
    // estimate can reach, that carry real level, and that land where this
    // string's own comb says they should. This is the statistic that decides
    // "is this string sounding at all", and it deliberately uses geometry and
    // measured level only — no amplitude-envelope extrapolation, which is the
    // part that body resonance and room comb filtering destroy. An unplayed
    // octave-duplicate (DADGAD's D3 inside D2) fills its low slots perfectly
    // and its exclusive high slots not at all.
    cur.evidX = 0;
    for (const p of pts) {
      if (!p.exclusive) continue;
      const dev = Math.abs(
        toCents(Math.log(p.f / (p.k * fit.f0 * Math.sqrt(1 + fit.B * p.k * p.k)))),
      );
      if (dev > o.exclDevC) continue;
      cur.evidX += clamp01((20 * Math.log10(p.snr) - o.exclSnrDb) / 8);
    }
    cur.meanR =
      pts.reduce((a, p) => a + p.r * p.amp, 0) / (pts.reduce((a, p) => a + p.amp, 0) || 1);
    // measured amplitudes at the partials this string demonstrably owns
    cur.clean = new Map<number, number>();
    for (const p of pts) if (p.r < 0.28 && p.snr > 3) cur.clean.set(p.k, p.amp);
    cur.meanBias =
      pts.reduce((a, p) => a + p.bias * p.amp, 0) / (pts.reduce((a, p) => a + p.amp, 0) || 1);
  }

  /** log-log envelope L*k^-q*|sin(pi k p)| from the least contaminated partials.
      The pluck-position comb matters: without it a notch at k~1/p is mistaken
      for "the contaminant is weak here". */
  function fitEnv(s: number): void {
    const cur = st[s];
    const use = cur.pts.filter((p) => p.q > 0.55 && p.snr > 3);
    const src = use.length >= 3 ? use : cur.pts.filter((p) => p.snr > 3);
    if (!src.length) {
      cur.env = null;
      return;
    }
    if (src.length < 4) {
      const p0 = src[0];
      cur.env = { L: p0.amp * Math.pow(p0.k, 1.2), q: 1.2, p: 0.001 };
      return;
    }
    let best: { r: number; L: number; q: number; p: number } | null = null;
    for (let pi = 0; pi <= 24; pi++) {
      const p = 0.06 + (pi * (0.3 - 0.06)) / 24;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      let sw = 0;
      for (const pt of src) {
        const X = Math.log(pt.k);
        const Y =
          Math.log(pt.amp) - Math.log(Math.max(0.14, Math.abs(Math.sin(Math.PI * pt.k * p))));
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
        const Y =
          Math.log(pt.amp) - Math.log(Math.max(0.14, Math.abs(Math.sin(Math.PI * pt.k * p))));
        r += Math.pow(Y - (lnL - q * Math.log(pt.k)), 2);
      }
      if (!best || r < best.r) best = { r, L: Math.exp(lnL), q, p };
    }
    cur.env = best ? { L: best.L, q: best.q, p: best.p } : null;
  }

  /* ---- stage D: projected matched filter in the complex spectrum ----
     The Hann atom factorises. Writing d_i = nu - b0 - i,
        G(d_i) = e^{j pi d_i (N-1)/N} * sin(pi d_i) / (2 pi d_i (1 - d_i^2))
     and  sin(pi d_i) = (-1)^i sin(pi delta),  e^{j pi d_i (N-1)/N} ~ (-1)^i * const
     for |d| < 10 and N >= 16384. Both (-1)^i factors cancel between the atom
     and the data, and the constants cancel in every normalised quantity. What
     is left is a REAL atom  hh_i = 1 / (2 pi d_i (1 - d_i^2))  against the raw
     complex bins — no trig in the inner loop at all, and every Gram entry is
     real. (An exact implementation would keep the O(1/N) phase correction; at
     N = 16384 it is 3e-3 rad across the window.) */
  const R = o.fineR;
  const W = 2 * R + 1;
  const aBuf = new Float64Array(W);
  const bBuf = [new Float64Array(W), new Float64Array(W), new Float64Array(W)];

  function realAtom(nu: number, b0: number, dst: Float64Array): Float64Array {
    for (let i = 0; i < W; i++) {
      let d = nu - b0 - i;
      const nr = Math.round(d);
      if (Math.abs(d - nr) < 1e-6) d = nr + (d >= nr ? 1e-6 : -1e-6);
      dst[i] = 1 / (2 * Math.PI * d * (1 - d * d));
    }
    return dst;
  }

  const rdot = (u: Float64Array, v: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < W; i++) s += u[i] * v[i];
    return s;
  };

  interface Slot {
    k: number;
    b0: number;
    basis: Float64Array[];
    xr: Float64Array;
    xi: Float64Array;
    iota: number;
    n0: number;
    use: boolean;
  }

  function fine(s: number, lim: number, step: number): void {
    const cur = st[s];
    if (!cur.ok) return;
    const km = kMax(cur.f0);
    // Freeze one local problem per partial: window, orthonormal contaminant
    // basis (real), and the spectrum with that basis projected out (complex).
    const slots: Slot[] = [];
    for (let k = 1; k <= km; k++) {
      const fc = partialFreq(cur.f0, cur.B, k);
      const b0 = Math.round(fc / binHz) - R;
      if (b0 < 1 || b0 + W >= mag.length) continue;
      let e = 0;
      for (let i = 0; i < W; i++) e += mag[b0 + i] * mag[b0 + i];
      if (e < W * flr * flr * 3) continue; // nothing here but noise
      const cs = contaminants(fc, s, R - 2).filter((c) => c.a > 0);
      const basis: Float64Array[] = [];
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

    // Informativeness is evaluated ONCE, at the current estimate, and the same
    // partial set is then used for every candidate. Deciding it per candidate
    // was a trap: moving away from a collision raises iota, so a partial that
    // was excluded at c = 0 re-enters with its full energy and the score climbs
    // for a reason that has nothing to do with fit quality. The ridge in the
    // denominator does the same job for partials that are merely ill
    // conditioned rather than fully excluded.
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

    function score(c: number, info: Array<{ k: number; iota: number; ex: number }> | null): number {
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
        if (info) info.push({ k: sl.k, iota: sl.iota, ex });
      }
      return tot;
    }

    let bc = 0;
    let bv = -1;
    let bi = 0;
    const grid: number[] = [];
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
      if (den < 0) bc += (step * 0.5 * (y0 - y2)) / den;
    }
    if (Math.abs(toCents(Math.log(cur.f0 / cur.target)) + bc) > o.searchCents * 1.05) bc = 0;
    const info: Array<{ k: number; iota: number; ex: number }> = [];
    score(bc, info);
    if (o.fineMove) cur.f0 *= Math.pow(2, bc / 1200);

    // presence evidence: partials carrying own-energy the already identified
    // strings cannot account for, discounted by informativeness.
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

  /** Full +-searchCents comb re-search that scores ONLY partials clear of every
      other string's current estimate. This is the escape hatch from the octave
      trap: string s's first estimate can lock onto a lower string's partial
      series (their combs overlap almost everywhere), and once locked, the tight
      matching tolerance keeps confirming it. Judging candidates on the partials
      that belong to s alone breaks the loop. The score is per-partial mean so a
      candidate is not rewarded for skipping more of them. */
  function recoarse(s: number): boolean {
    const cur = st[s];
    const km = kMax(cur.target);
    const others: number[] = [];
    for (let t = 0; t < S; t++) {
      if (t === s || !st[t].ok) continue;
      const kt = kMax(st[t].f0);
      for (let j = 1; j <= kt; j++) others.push(partialFreq(st[t].f0, st[t].B, j));
    }
    others.sort((a, b) => a - b);
    const clearOf = (f: number): boolean => {
      let lo = 0;
      let hi = others.length - 1;
      let bd = Infinity;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        const d = others[m] - f;
        if (Math.abs(d) < bd) bd = Math.abs(d);
        if (d < 0) lo = m + 1;
        else hi = m - 1;
      }
      return bd / binHz >= o.clearBins;
    };
    let best: { sc: number; f0: number; B: number; cnt: number } | null = null;
    for (const B of [3e-5, 1.2e-4, 3e-4]) {
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

  // ---- pass 0: coarse every string first, so the GEOMETRY of the collisions
  // is known before any fit runs. Fitting string by string with no idea where
  // the others sit lets an octave pair pull each other on the very first pass,
  // and a tight matching tolerance then keeps confirming the error.
  for (const s of order) coarse(s, mag);
  // ---- refinement passes, tolerance tightening as the estimates settle
  for (let p = 0; p < o.peelPasses; p++) {
    const tolC = o.tolSchedule[Math.min(p, o.tolSchedule.length - 1)];
    for (const s of order) {
      refine(s, p > 0, tolC);
      fitEnv(s);
    }
  }
  // ---- octave escape: re-search on exclusively-owned partials, keep it only
  // if the resulting fit is better supported than the incumbent
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
        meanR: cur.meanR,
      };
      const restore = (): void => {
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
      if (!cur.ok || (moved > 1 && !better)) {
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
  // ---- stage D: one WIDE projected sweep (recovers a coarse lock-on onto a
  // neighbour's partial — contaminants are projected out, so their positions
  // become score minima, not maxima), then fine sweeps for precision.
  if (o.fine) {
    // Only strings that are actually blended need the expensive stage; for a
    // clean partial the three-point Hann interpolator is already better than a
    // stationary-atom ML fit against a decaying, beating partial.
    const need = o.fineMove ? order.filter((s) => st[s].ok && st[s].meanR > o.fineIfR) : [];
    for (let p = 0; p < o.finePasses; p++) for (const s of need) fine(s, o.fineCents, o.fineStep);
    for (const s of order) if (!need.includes(s)) fine(s, 0, 1); // evidence only
  }

  return st.map((c) =>
    !c.ok || !c.pts.length
      ? { cents: NaN, f0: NaN, B: NaN, nGood: 0, evid: 0, evidX: 0, ownDb: -99, resid: 99 }
      : {
          cents: toCents(Math.log(c.f0 / c.target)),
          f0: c.f0,
          B: c.B,
          nGood: c.nGood,
          evid: c.evid,
          evidX: c.evidX,
          ownDb: c.ownDb,
          resid: c.resid,
        },
  );
}

/* ----------------------------------------------------------- raw public API */

export interface StrumRawString {
  string: number;
  target: number;
  /** NaN when the string produced no usable estimate. */
  cents: number;
  conf: number;
  detected: boolean;
  frames: number;
  spread: number;
}

export interface StrumRawResult {
  strings: StrumRawString[];
  n: number;
  frames: number;
  onset: number;
}

// Nine frames spanning ~1.21 s of starts. The span is what averages the
// collision beat away; the count is what makes the median robust.
function defaultStarts(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 9; i++) out.push(0.035 + (i * 1.21) / 8);
  return out;
}

/**
 * The spike's `analyzeStrum`, unchanged in behaviour: no refusal gate, cents
 * reported as NaN when a string had nothing to say. The parity harness drives
 * this; the app drives the wrapper below.
 */
export function analyzeStrumRaw(
  x: ArrayLike<number>,
  fs: number,
  targets: readonly number[],
  opts: Partial<StrumOptions> = {},
): StrumRawResult {
  const o: StrumOptions = { ...DEFAULTS, ...opts };
  const n = o.n || pickN(targets, fs);
  const fft = cachedFFT(n);
  const win = cachedHann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n / 2 + 1);
  const ctx: FrameCtx = { re, im, mag, n, fs };

  const t0 = o.onset != null ? o.onset : detectOnset(x, fs);
  const starts = o.frameStarts || defaultStarts();
  const S = targets.length;
  const per: FrameRow[][] = Array.from({ length: S }, () => []);
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

  const out: StrumRawString[] = [];
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
        spread: NaN,
      });
      continue;
    }
    // Plain median across frames. Weighting frames by their own evidence was
    // measurably WORSE: the frames where a blended string looks most confident
    // are exactly the frames where it has been captured by its neighbour.
    const cents = median(rows.map((r) => r.cents));
    const spread = mad(rows.map((r) => r.cents)) * 1.4826;
    const evid = median(rows.map((r) => r.evid));
    const evidX = median(rows.map((r) => r.evidX));
    const ownDb = median(rows.map((r) => r.ownDb));
    const resid = median(rows.map((r) => r.resid));
    const Bmed = median(rows.map((r) => r.B));

    const terms = [
      clamp01((ownDb - 4) / 12), // tSnr
      clamp01((evid - 1.15) / 1.1), // tEvid
      clamp01((evidX - o.exclMin) / o.exclSpan), // tExcl
      clamp01((o.spreadMaxCents - spread) / (o.spreadMaxCents * 0.7)), // tSpread
      clamp01((16 - resid) / 12), // tResid
      Bmed <= o.bMax * 0.97 ? 1 : 0, // tB
      clamp01((rows.length - 2) / 2), // tFrames
    ];
    const conf = Math.min(...terms);
    out.push({
      string: s,
      target: targets[s],
      cents,
      conf,
      detected: conf >= o.confThreshold,
      frames: rows.length,
      spread,
    });
  }
  return { strings: out, n, frames, onset: t0 };
}

/* --------------------------------------------------------- shipping wrapper */

/**
 * Condition 2's helper: two strings an exact octave apart (Drop D, DADGAD,
 * Open D/G/E...) make the higher one's whole partial series a subset of the
 * lower one's, and the estimator cannot tell an unplayed high string from a
 * ringing low one. Standard's E2/E4 are TWO octaves apart, which both test
 * suites clear, so only a 12-semitone gap counts.
 */
export function hasOctavePair(midis: readonly number[]): boolean {
  for (let i = 0; i < midis.length; i++) {
    for (let j = i + 1; j < midis.length; j++) {
      if (Math.abs(midis[i] - midis[j]) === 12) return true;
    }
  }
  return false;
}

/**
 * The shipping entry point: the spike algorithm plus the whole-offset refusal.
 *
 * `samples` is the captured strum (mic rate), `targetFreqs` the per-string
 * target frequencies already carrying sweetening, capo and A4 calibration.
 */
export function analyzeStrum(
  samples: Float32Array,
  sampleRate: number,
  targetFreqs: readonly number[],
): StrumResult {
  const t0 = now();
  if (!targetFreqs.length || !samples.length) {
    return {
      strings: targetFreqs.map(() => ({ cents: null, confidence: 0, detected: false })),
      refusal: null,
      globalOffsetCents: null,
      analysisMs: now() - t0,
    };
  }

  const raw = analyzeStrumRaw(samples, sampleRate, targetFreqs);
  const edge = DEFAULTS.searchCents - REFUSE_EDGE_MARGIN_CENTS;

  // The gate judges the readings that would actually be shown. A string that
  // was never detected shows "couldn't confirm" whatever its arithmetic said,
  // so its estimate is not evidence about the instrument as a whole.
  const shown = raw.strings.filter((r) => r.detected && isFinite(r.cents));
  let refusal: 'offset' | null = null;
  let globalOffsetCents: number | null = null;
  if (shown.length) {
    const cents = shown.map((r) => r.cents);
    const med = median(cents);
    const atEdge = cents.some((c) => Math.abs(c) >= edge);
    // Where an odd half-semitone offset aliases to, and how many strings are
    // sitting on each of those two rails.
    const rail = DEFAULTS.searchCents / 2;
    const onRail = (c: number, sign: number): boolean =>
      Math.abs(c - sign * rail) <= REFUSE_RAIL_TOL_CENTS;
    const straddles = cents.some((c) => onRail(c, 1)) && cents.some((c) => onRail(c, -1));
    const locked =
      Math.abs(Math.abs(med) - rail) <= REFUSE_RAIL_TOL_CENTS &&
      cents.filter((c) => onRail(c, Math.sign(med))).length >= REFUSE_RAIL_MIN_STRINGS;
    if (Math.abs(med) > REFUSE_MEDIAN_CENTS || atEdge || straddles || locked) {
      refusal = 'offset';
      globalOffsetCents = med;
    }
  }

  // Condition 5: "no reading" is a first-class state. Accuracy was only ever
  // measured on DETECTED strings, so an unconfirmed string reports no number at
  // all rather than one the caller might render — and a refused analysis
  // reports nothing per string, structurally.
  const strings: StrumStringResult[] = raw.strings.map((r) => {
    const usable = !refusal && r.detected && isFinite(r.cents);
    return { cents: usable ? r.cents : null, confidence: r.conf, detected: usable };
  });

  return { strings, refusal, globalOffsetCents, analysisMs: now() - t0 };
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
