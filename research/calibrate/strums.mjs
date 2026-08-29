/**
 * strums.mjs — run a strum through the SHIPPED estimator and open up the box.
 *
 * Two things happen here, and the difference matters:
 *
 *  1. `analyzeStrum` / `analyzeStrumRaw` are called on the CLEAN bundle of
 *     src/audio/strum.ts. Whatever they say is what the app says. No number
 *     reported as "the app's result" comes from anywhere else.
 *
 *  2. The same clip is run again through the PROBE bundle — the identical
 *     module with an added hook — driving the module's own `analyzeFrame`
 *     frame by frame so we know which frame produced which evidence, and
 *     catching the per-partial table `refine()` builds. From that we can
 *     reproduce the seven confidence terms exactly, and then ask the only
 *     question that matters for calibration: for a string the app did NOT
 *     confirm, WHICH term held it back and BY HOW MUCH, in the raw units of
 *     that term (dB, cents, partial count) rather than in the squashed 0..1
 *     score.
 *
 * The reproduction is not taken on trust: `verifyParity()` checks that the
 * replicated fusion layer agrees with `analyzeStrumRaw` on every string of
 * every clip — cents, confidence and the detect/no-detect decision.
 *
 * Because the evidence table is captured, the whole gate layer becomes pure
 * arithmetic over stored numbers: a threshold sweep re-scores thousands of
 * parameter sets without re-running a single FFT.
 */

import { loadModules } from './bundle.mjs';

/* ---------------------------------------------------------- the gate law */

/**
 * Every constant in strum.ts's confidence computation, named. The defaults
 * ARE the shipped values (four of them are inline literals in analyzeStrumRaw,
 * three come from StrumOptions) — `verifyParity` proves the equivalence.
 */
export const GATE_DEFAULTS = Object.freeze({
  ownDbLo: 4, //         tSnr    = clamp01((ownDb - 4) / 12)
  ownDbSpan: 12,
  evidLo: 1.15, //       tEvid   = clamp01((evid - 1.15) / 1.1)
  evidSpan: 1.1,
  exclMin: 1.8, //       tExcl   = clamp01((evidX - exclMin) / exclSpan)
  exclSpan: 1.0,
  spreadMaxCents: 14, // tSpread = clamp01((14 - spread) / (14 * 0.7))
  spreadSpanFrac: 0.7,
  residMax: 16, //       tResid  = clamp01((16 - resid) / 12)
  residSpan: 12,
  bMax: 5.5e-4, //       tB      = Bmed <= bMax * 0.97
  bMaxFrac: 0.97,
  framesLo: 2, //        tFrames = clamp01((frames - 2) / 2)
  framesSpan: 2,
  minFrames: 3, //       fewer usable frames than this = no reading at all
  confThreshold: 0.15,
});

/**
 * The constants that decide EXCLUSIVE EVIDENCE inside refine(). They are
 * separated from the gate because they act on the per-partial table, but they
 * are still re-applicable offline: the table carries every input they need.
 * (clearBins also steers recoarse()'s candidate search, so re-scoring it here
 * models its effect on evidX only — flagged wherever it is used.)
 */
export const EVID_DEFAULTS = Object.freeze({
  exclDevC: 5, //    a partial may deviate this far from the comb and still count
  exclSnrDb: 10, //  ...and must stand this far over the frame's noise floor
  exclSnrSpan: 8, // ...reaching full weight 8 dB above that
  clearBins: 1.6, // ...with no other string's partial closer than this
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** evidX for one frame's partial table, under any evidence parameters. */
export function evidXOf(partials, e = EVID_DEFAULTS) {
  let v = 0;
  for (const p of partials) {
    const excl = e.clearBins === EVID_DEFAULTS.clearBins ? p.exclusive : p.sepBins >= e.clearBins;
    if (!excl) continue;
    if (p.dev > e.exclDevC) continue;
    v += clamp01((20 * Math.log10(p.snr) - e.exclSnrDb) / e.exclSnrSpan);
  }
  return v;
}

/** The seven terms, their raw statistics, and what each would need. */
export function scoreString(stat, g = GATE_DEFAULTS) {
  const need = g.confThreshold;
  const terms = [
    {
      name: 'tSnr',
      label: 'own-energy over noise',
      unit: 'dB',
      value: clamp01((stat.ownDb - g.ownDbLo) / g.ownDbSpan),
      got: stat.ownDb,
      required: g.ownDbLo + need * g.ownDbSpan,
      higherIsBetter: true,
    },
    {
      name: 'tEvid',
      label: 'projected presence evidence',
      unit: 'partials',
      value: clamp01((stat.evid - g.evidLo) / g.evidSpan),
      got: stat.evid,
      required: g.evidLo + need * g.evidSpan,
      higherIsBetter: true,
    },
    {
      name: 'tExcl',
      label: 'exclusive evidence',
      unit: 'partials',
      value: clamp01((stat.evidX - g.exclMin) / g.exclSpan),
      got: stat.evidX,
      required: g.exclMin + need * g.exclSpan,
      higherIsBetter: true,
    },
    {
      name: 'tSpread',
      label: 'frame-to-frame spread',
      unit: 'cents',
      value: clamp01((g.spreadMaxCents - stat.spread) / (g.spreadMaxCents * g.spreadSpanFrac)),
      got: stat.spread,
      required: g.spreadMaxCents - need * g.spreadMaxCents * g.spreadSpanFrac,
      higherIsBetter: false,
    },
    {
      name: 'tResid',
      label: 'comb-fit residual',
      unit: 'cents',
      value: clamp01((g.residMax - stat.resid) / g.residSpan),
      got: stat.resid,
      required: g.residMax - need * g.residSpan,
      higherIsBetter: false,
    },
    {
      name: 'tB',
      label: 'inharmonicity plausible',
      unit: 'B',
      value: stat.Bmed <= g.bMax * g.bMaxFrac ? 1 : 0,
      got: stat.Bmed,
      required: g.bMax * g.bMaxFrac,
      higherIsBetter: false,
    },
    {
      name: 'tFrames',
      label: 'frames agreeing',
      unit: 'frames',
      value: clamp01((stat.frames - g.framesLo) / g.framesSpan),
      got: stat.frames,
      required: g.framesLo + need * g.framesSpan,
      higherIsBetter: true,
    },
  ];
  for (const t of terms) {
    t.deficit = t.higherIsBetter ? t.required - t.got : t.got - t.required;
    if (!isFinite(t.deficit)) t.deficit = Infinity;
  }
  const conf = Math.min(...terms.map((t) => t.value));
  let binding = terms[0];
  for (const t of terms) if (t.value < binding.value) binding = t;
  return { terms, conf, detected: conf >= g.confThreshold, binding };
}

/* ----------------------------------------------- capture: the real module */

const NAN_ROW = { cents: NaN };

/**
 * Run one clip through the probe module frame by frame, keeping every frame's
 * per-string estimate AND the per-partial evidence table behind it.
 *
 * This is the shipped `analyzeStrumRaw` outer loop, with the frame loop opened
 * up. The inner estimator (`analyzeFrame`) is the module's own, unmodified.
 */
export async function captureStrum(x, fs, targets, opts = {}) {
  const { probe } = await loadModules();
  const o = { ...probe.DEFAULTS, ...opts };
  const n = o.n || probe.pickN(targets, fs);
  const fft = probe.cachedFFT(n);
  const win = probe.cachedHann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n / 2 + 1);
  const ctx = { re, im, mag, n, fs };
  const t0 = o.onset != null ? o.onset : probe.detectOnset(x, fs);
  const starts = o.frameStarts || probe.defaultStarts();
  const S = targets.length;

  const per = Array.from({ length: S }, () => []);
  let frames = 0;
  let framesSkipped = 0;

  let bucket = new Map();
  probe.__setProbe((rec) => bucket.set(rec.s, rec));
  try {
    for (const off of starts) {
      const s0 = Math.round((t0 + off) * fs);
      if (s0 < 0 || s0 + n > x.length) {
        framesSkipped++;
        continue;
      }
      for (let i = 0; i < n; i++) {
        re[i] = x[s0 + i] * win[i];
        im[i] = 0;
      }
      fft.forward(re, im);
      for (let i = 0; i <= n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
      bucket = new Map();
      const r = probe.analyzeFrame(ctx, targets, o);
      frames++;
      for (let s = 0; s < S; s++) {
        if (!isFinite(r[s].cents)) continue;
        const rec = bucket.get(s);
        per[s].push({
          frame: frames - 1,
          startSec: t0 + off,
          cents: r[s].cents,
          f0: r[s].f0,
          B: r[s].B,
          nGood: r[s].nGood,
          evid: r[s].evid,
          evidX: r[s].evidX,
          ownDb: r[s].ownDb,
          resid: r[s].resid,
          noiseAmp: rec?.noiseAmp ?? NaN,
          partials: rec?.partials ?? [],
        });
      }
    }
  } finally {
    probe.__setProbe(null);
  }
  return { n, frames, framesSkipped, onset: t0, targets: Array.from(targets), fs, per, opts: o };
}

/* ------------------------------------------------- fusion: the gate layer */

function medianOf(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function madOf(a) {
  const m = medianOf(a);
  return medianOf(a.map((v) => Math.abs(v - m)));
}

/**
 * Reduce a capture to per-string statistics and a verdict, under any gate /
 * evidence parameters. With the defaults this reproduces `analyzeStrumRaw`
 * exactly (see verifyParity).
 */
export function fuse(cap, { gate = GATE_DEFAULTS, evid = EVID_DEFAULTS } = {}) {
  const g = { ...GATE_DEFAULTS, ...gate };
  const e = { ...EVID_DEFAULTS, ...evid };
  const reEvid = e.exclDevC !== EVID_DEFAULTS.exclDevC ||
    e.exclSnrDb !== EVID_DEFAULTS.exclSnrDb ||
    e.exclSnrSpan !== EVID_DEFAULTS.exclSnrSpan ||
    e.clearBins !== EVID_DEFAULTS.clearBins;

  return cap.per.map((rows, s) => {
    const base = {
      string: s,
      target: cap.targets[s],
      frames: rows.length,
    };
    if (rows.length < g.minFrames) {
      return {
        ...base,
        cents: NaN,
        spread: NaN,
        conf: 0,
        detected: false,
        reason: `only ${rows.length} usable frame(s), needs ${g.minFrames}`,
        terms: null,
        binding: { name: 'tFrames', label: 'frames agreeing', got: rows.length, required: g.minFrames, unit: 'frames', deficit: g.minFrames - rows.length },
        stat: null,
      };
    }
    const evidXs = rows.map((r) => (reEvid ? evidXOf(r.partials, e) : r.evidX));
    const stat = {
      cents: medianOf(rows.map((r) => r.cents)),
      spread: madOf(rows.map((r) => r.cents)) * 1.4826,
      evid: medianOf(rows.map((r) => r.evid)),
      evidX: medianOf(evidXs),
      ownDb: medianOf(rows.map((r) => r.ownDb)),
      resid: medianOf(rows.map((r) => r.resid)),
      Bmed: medianOf(rows.map((r) => r.B)),
      f0: medianOf(rows.map((r) => r.f0)),
      frames: rows.length,
    };
    const sc = scoreString(stat, g);
    return { ...base, cents: stat.cents, spread: stat.spread, conf: sc.conf, detected: sc.detected, terms: sc.terms, binding: sc.binding, stat };
  });
}

/* ---------------------------------------------------------- segmentation */

/**
 * Split a continuous recording into the windows the APP would actually have
 * analysed, by driving the shipped `StrumRecorder` sample-for-sample.
 *
 * This matters more than it looks. The README now asks for the five strums as
 * ONE take, because the reported symptom is "reads all strings at first, then
 * only one" — and that symptom has two completely different possible causes:
 *
 *   the ESTIMATOR gets less evidence from a later strum (the gates are the
 *   problem), or
 *   the RECORDER never delivers a later strum at all, or delivers a window
 *   that starts in the wrong place (the capture is the problem).
 *
 * Only running the real recorder can tell those apart, so that is what happens
 * here: the signal goes through the app's mic chain, into the app's onset
 * detector, in 128-sample render quanta, and out come the exact buffers
 * `analyzeStrum` would have been handed.
 */
export async function segmentStrums(x, fs, { targets = null, windowSeconds = null, quantum = 128, ...recOpts } = {}) {
  const { capture, clean } = await loadModules();
  if (capture?.error) return { error: capture.error, strums: [] };
  const win =
    windowSeconds ?? (targets ? capture.windowSecondsFor(targets, fs) : capture.windowSecondsFor([82.4], fs));
  const rec = new capture.StrumRecorder(fs, { windowSeconds: win, ...recOpts });
  const strums = [];
  const onsets = [];
  rec.onOnset = () => onsets.push(rec.written / fs);
  rec.onStrum = (samples, rate) => {
    strums.push({
      x: Float64Array.from(samples),
      fs: rate,
      startSec: rec.lastWindowStart / rate,
      index: strums.length,
    });
  };
  const buf = new Float32Array(quantum);
  for (let i = 0; i < x.length; i += quantum) {
    const n = Math.min(quantum, x.length - i);
    for (let j = 0; j < n; j++) buf[j] = x[i + j];
    rec.push(n === quantum ? buf : buf.subarray(0, n));
  }
  return {
    strums,
    rejected: rec.rejected,
    windowSeconds: win,
    // Attacks the recorder found but never delivered, because the recording
    // ended before the window filled.
    truncated: Math.max(0, onsets.length - strums.length),
    onsets,
    pickN: targets ? clean.pickN(targets, fs) : null,
  };
}

/**
 * WHY the recorder dropped an attack, measured rather than argued.
 *
 * `StrumRecorderOptions` exposes four of the constants the onset decision rests
 * on. Re-running the same recording under each, one at a time, says which one is
 * actually holding the missing strums out — the capture-side equivalent of the
 * confidence sweep. (JUMP_DB and the background tracker's BG_RISE are NOT
 * exposed, so if none of these recovers the drops, those two are what is left.)
 */
export async function captureProbe(x, fs, targets) {
  const variants = [
    { label: 'shipped defaults', opts: {} },
    { label: 'no 0.6 s warm-up', opts: { warmupSeconds: 0 }, knob: 'WARMUP_S' },
    { label: 'absolute floor /4', opts: { absFloorRms: 0.0003 }, knob: 'ABS_FLOOR_RMS' },
    { label: 'emphasis 300 Hz', opts: { emphasisHz: 300 }, knob: 'EMPHASIS_HZ' },
    { label: 'emphasis 1400 Hz', opts: { emphasisHz: 1400 }, knob: 'EMPHASIS_HZ' },
    { label: 'sustain bar 6 → 2 dB', opts: { sustainMinOverBgDb: 2 }, knob: 'SUSTAIN_MIN_OVER_BG_DB' },
  ];
  const out = [];
  for (const v of variants) {
    const seg = await segmentStrums(x, fs, { targets, ...v.opts });
    out.push({
      ...v,
      delivered: seg.strums?.length ?? 0,
      rejected: seg.rejected ?? 0,
      onsets: (seg.strums || []).map((s) => s.startSec + 0.1),
      error: seg.error,
    });
  }
  return out;
}

/**
 * An independent onset list, so "the recorder delivered N strums" can be
 * compared with "there are M attacks in this recording". A plain broadband
 * energy jump — deliberately not the app's rule, because agreeing with itself
 * would prove nothing.
 */
export function crudeOnsets(x, fs, { jumpDb = 10, holdOffS = 0.7 } = {}) {
  const hop = Math.max(1, Math.round(0.01 * fs));
  const n = Math.floor(x.length / hop);
  const e = new Float64Array(n);
  for (let h = 0; h < n; h++) {
    let s = 0;
    for (let i = h * hop; i < (h + 1) * hop; i++) s += x[i] * x[i];
    e[h] = Math.sqrt(s / hop);
  }
  const out = [];
  let bg = e[0] || 1e-9;
  let lock = -Infinity;
  const jump = Math.pow(10, jumpDb / 20);
  for (let h = 1; h < n; h++) {
    const t = (h * hop) / fs;
    if (e[h] > bg * jump && t - lock > holdOffS) {
      out.push(t);
      lock = t;
    }
    bg = e[h] < bg ? bg + 0.25 * (e[h] - bg) : bg + 0.02 * (e[h] - bg);
    if (bg < 1e-9) bg = 1e-9;
  }
  return out;
}

/* ---------------------------------------------------- partial-level detail */

/**
 * Why exclusive evidence came out where it did, for one string, pooled over
 * frames. Answers, in the raw units the calibration has to move:
 *   - how many exclusive partials were found at all,
 *   - of those, how many were thrown out by the 5-cent comb tolerance and by
 *     how much they missed,
 *   - of those that survived, how far over the 10 dB noise margin they stood,
 *   - and what each of the two would have to become for this string to reach
 *     the 1.8 the gate demands.
 */
export function evidenceDetail(rows, g = GATE_DEFAULTS, e = EVID_DEFAULTS) {
  const all = [];
  for (const r of rows) for (const p of r.partials) all.push(p);
  if (!all.length) return null;
  const excl = all.filter((p) => p.sepBins >= e.clearBins);
  const inTol = excl.filter((p) => p.dev <= e.exclDevC);
  const snrDbs = inTol.map((p) => 20 * Math.log10(p.snr));
  const perFrame = Math.max(1, rows.length);

  // What exclSnrDb would have to fall to for the MEDIAN frame to reach exclMin.
  const trySnr = (thr) =>
    medianOf(rows.map((r) => evidXOf(r.partials, { ...e, exclSnrDb: thr })));
  let snrNeeded = null;
  for (let thr = e.exclSnrDb; thr >= -20; thr -= 0.25) {
    if (trySnr(thr) >= g.exclMin) {
      snrNeeded = thr;
      break;
    }
  }
  // ...and what exclDevC would have to rise to.
  const tryDev = (thr) => medianOf(rows.map((r) => evidXOf(r.partials, { ...e, exclDevC: thr })));
  let devNeeded = null;
  for (let thr = e.exclDevC; thr <= 60; thr += 0.5) {
    if (tryDev(thr) >= g.exclMin) {
      devNeeded = thr;
      break;
    }
  }
  // ...and what clearBins would have to fall to (evidX effect only).
  let clearNeeded = null;
  for (let thr = e.clearBins; thr >= 0.2; thr -= 0.05) {
    if (medianOf(rows.map((r) => evidXOf(r.partials, { ...e, clearBins: thr }))) >= g.exclMin) {
      clearNeeded = thr;
      break;
    }
  }
  return {
    partialsPerFrame: all.length / perFrame,
    exclusivePerFrame: excl.length / perFrame,
    inTolPerFrame: inTol.length / perFrame,
    droppedByTolPerFrame: (excl.length - inTol.length) / perFrame,
    medDevOfDropped: medianOf(excl.filter((p) => p.dev > e.exclDevC).map((p) => p.dev)),
    medSnrDb: medianOf(snrDbs),
    maxSnrDb: snrDbs.length ? Math.max(...snrDbs) : NaN,
    marginDb: medianOf(snrDbs.map((v) => v - e.exclSnrDb)),
    medDev: medianOf(inTol.map((p) => p.dev)),
    snrThresholdNeeded: snrNeeded,
    devToleranceNeeded: devNeeded,
    clearBinsNeeded: clearNeeded,
  };
}

/* --------------------------------------------------------------- parity */

/**
 * The replicated fusion layer must agree with the shipped `analyzeStrumRaw` on
 * every string: same cents, same confidence, same detect decision. Any
 * disagreement means the instrumentation has drifted from the thing it claims
 * to explain, and every threshold recommendation built on it is worthless.
 */
export async function verifyParity(x, fs, targets, opts = {}) {
  const { clean } = await loadModules();
  const truth = clean.analyzeStrumRaw(x, fs, targets, opts);
  const cap = await captureStrum(x, fs, targets, opts);
  const mine = fuse(cap);
  const diffs = [];
  for (let s = 0; s < targets.length; s++) {
    const a = truth.strings[s];
    const b = mine[s];
    const dc =
      isFinite(a.cents) !== isFinite(b.cents)
        ? Infinity
        : isFinite(a.cents)
          ? Math.abs(a.cents - b.cents)
          : 0;
    const dConf = Math.abs(a.conf - b.conf);
    if (dc > 1e-9 || dConf > 1e-9 || a.detected !== b.detected || a.frames !== b.frames) {
      diffs.push({ s, truth: a, mine: { cents: b.cents, conf: b.conf, detected: b.detected, frames: b.frames }, dc, dConf });
    }
  }
  return { ok: diffs.length === 0, diffs, truth, cap, mine };
}

/* --------------------------------------------------------------- one clip */

/**
 * Full treatment of one strum clip: what the app reports, and why.
 * `truthCents[s]` (optional) is the string's real offset, measured from the
 * solo clips — the strum's error is scored against that, never against zero.
 */
export async function analyzeStrumClip(x, fs, targets, { truthCents = null, opts = {}, name = '?' } = {}) {
  const { clean } = await loadModules();
  const shipped = clean.analyzeStrum(Float32Array.from(x), fs, targets);
  const cap = await captureStrum(x, fs, targets, opts);
  const fused = fuse(cap);
  const strings = fused.map((f, s) => {
    const rows = cap.per[s];
    const err =
      truthCents && isFinite(truthCents[s]) && isFinite(f.cents) ? f.cents - truthCents[s] : NaN;
    return {
      ...f,
      shippedCents: shipped.strings[s].cents,
      shippedDetected: shipped.strings[s].detected,
      truthCents: truthCents ? truthCents[s] : NaN,
      errCents: err,
      evidence: rows.length ? evidenceDetail(rows) : null,
    };
  });
  return {
    name,
    fs,
    n: cap.n,
    frames: cap.frames,
    onset: cap.onset,
    refusal: shipped.refusal,
    globalOffsetCents: shipped.globalOffsetCents,
    analysisMs: shipped.analysisMs,
    strings,
    cap,
  };
}
