/**
 * sweep.mjs — how much would each gate have to give, and what would it cost?
 *
 * The calibration question is never "is this threshold too strict"; it is "if I
 * loosen THIS one until the strings I can hear are confirmed, what starts being
 * confirmed that was never played". So every relaxation is measured twice:
 *
 *   detection   on a HARSHER world than the shipped thresholds were tuned in —
 *               the verifier's deep-beat polarisation (equal-amplitude modes
 *               6 cents apart, the partner ringing as long as the dominant) and
 *               the noise floor 10 dB higher.
 *   halluc.     on the ABLATION suite — strums where one string is genuinely
 *               not played. A string that was never plucked being "confirmed"
 *               is the failure mode that costs the user their tuning, and it is
 *               the reason the shipped thresholds are where they are.
 *
 * Both sets are CAPTURED ONCE (the expensive part is the FFT work inside the
 * real module) and then re-scored arithmetically for every parameter value, so
 * a full sweep costs one pass over the audio rather than one per value.
 */

import { captureStrum, fuse, GATE_DEFAULTS, EVID_DEFAULTS } from './strums.mjs';
import { harshTrials, ablationTrials, STANDARD } from './synthset.mjs';
import { micChain } from './micchain.mjs';

const median = (a) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

/**
 * Capture a list of synthetic trials once.
 * `asApp` puts every trial through the app's own mic chain first, which is what
 * the shipped estimator is actually handed (see micchain.mjs).
 */
export async function captureTrials(trials, { targets = STANDARD, asApp = true } = {}) {
  const out = [];
  for (const t of trials) {
    const sig = asApp ? micChain(t.x, t.fs) : { x: t.x, fs: t.fs };
    const cap = await captureStrum(sig.x, sig.fs, targets);
    out.push({ cap, truth: t.cents, missing: t.missing, seed: t.seed, world: t.world, asApp });
  }
  return out;
}

/** Score a captured set under one parameter set. */
export function score(set, params = {}) {
  const gate = { ...GATE_DEFAULTS, ...(params.gate || {}) };
  const evid = { ...EVID_DEFAULTS, ...(params.evid || {}) };
  let played = 0;
  let detected = 0;
  let skipped = 0;
  let halluc = 0;
  const errs = [];
  for (const rec of set) {
    const rows = fuse(rec.cap, { gate, evid });
    for (let s = 0; s < rows.length; s++) {
      const isPlayed = !rec.missing?.includes(s);
      if (isPlayed) {
        played++;
        if (rows[s].detected) {
          detected++;
          if (isFinite(rows[s].cents)) errs.push(Math.abs(rows[s].cents - rec.truth[s]));
        }
      } else {
        skipped++;
        if (rows[s].detected) halluc++;
      }
    }
  }
  return {
    played,
    detected,
    detectRate: played ? detected / played : NaN,
    skipped,
    halluc,
    hallucRate: skipped ? halluc / skipped : NaN,
    medErr: median(errs),
    p95Err: pct(errs, 0.95),
    maxErr: errs.length ? Math.max(...errs) : NaN,
  };
}

/**
 * The knobs, in the units the report has to talk in. `apply` puts one value
 * into a parameter set; `scan` is the ordered list of values from SHIPPED to
 * MOST RELAXED, so the first value that reaches the target is the smallest
 * relaxation that does.
 */
export const KNOBS = [
  {
    name: 'exclMin',
    term: 'tExcl',
    unit: 'exclusive partials',
    shipped: GATE_DEFAULTS.exclMin,
    direction: 'lower',
    what: 'exclusive-evidence count the gate demands',
    scan: seq(1.8, 0.0, -0.05),
    apply: (v) => ({ gate: { exclMin: v } }),
  },
  {
    name: 'exclSnrDb',
    term: 'tExcl (evidence)',
    unit: 'dB over the frame noise floor',
    shipped: EVID_DEFAULTS.exclSnrDb,
    direction: 'lower',
    what: 'noise margin a partial needs before it counts as evidence',
    scan: seq(10, -12, -0.25),
    apply: (v) => ({ evid: { exclSnrDb: v } }),
  },
  {
    name: 'exclDevC',
    term: 'tExcl (evidence)',
    unit: 'cents',
    shipped: EVID_DEFAULTS.exclDevC,
    direction: 'higher',
    what: 'comb tolerance — how far a partial may sit from where the fit says',
    scan: seq(5, 60, 0.5),
    apply: (v) => ({ evid: { exclDevC: v } }),
  },
  {
    name: 'clearBins',
    term: 'tExcl (evidence)',
    unit: 'bins',
    shipped: EVID_DEFAULTS.clearBins,
    direction: 'lower',
    what: 'separation that makes a partial exclusively this string’s',
    note: 'evidX effect only — clearBins also steers recoarse(), which this re-scoring cannot model',
    scan: seq(1.6, 0.2, -0.05),
    apply: (v) => ({ evid: { clearBins: v } }),
  },
  {
    name: 'ownDbLo',
    term: 'tSnr',
    unit: 'dB',
    shipped: GATE_DEFAULTS.ownDbLo,
    direction: 'lower',
    what: 'own-energy floor of the projected matched filter',
    scan: seq(4, -30, -0.25),
    apply: (v) => ({ gate: { ownDbLo: v } }),
  },
  {
    name: 'evidLo',
    term: 'tEvid',
    unit: 'partials',
    shipped: GATE_DEFAULTS.evidLo,
    direction: 'lower',
    what: 'projected presence evidence the gate demands',
    scan: seq(1.15, 0, -0.025),
    apply: (v) => ({ gate: { evidLo: v } }),
  },
  {
    name: 'spreadMaxCents',
    term: 'tSpread',
    unit: 'cents',
    shipped: GATE_DEFAULTS.spreadMaxCents,
    direction: 'higher',
    what: 'frame-to-frame spread allowed before a reading is called unstable',
    scan: seq(14, 90, 0.5),
    apply: (v) => ({ gate: { spreadMaxCents: v } }),
  },
  {
    name: 'residMax',
    term: 'tResid',
    unit: 'cents',
    shipped: GATE_DEFAULTS.residMax,
    direction: 'higher',
    what: 'comb-fit residual allowed',
    scan: seq(16, 90, 0.5),
    apply: (v) => ({ gate: { residMax: v } }),
  },
  {
    name: 'bMax',
    term: 'tB',
    unit: 'B',
    shipped: GATE_DEFAULTS.bMax,
    direction: 'higher',
    what: 'inharmonicity ceiling a fitted string may claim',
    scan: seq(5.5e-4, 4e-3, 2.5e-5),
    apply: (v) => ({ gate: { bMax: v } }),
  },
  {
    name: 'confThreshold',
    term: 'all (the bar itself)',
    unit: 'confidence',
    shipped: GATE_DEFAULTS.confThreshold,
    direction: 'lower',
    what: 'the confidence a string must reach to be shown at all',
    scan: seq(0.15, 0.0, -0.005),
    apply: (v) => ({ gate: { confThreshold: v } }),
  },
];

function seq(from, to, step) {
  const out = [];
  const n = Math.floor(Math.abs((to - from) / step)) + 1;
  for (let i = 0; i < n; i++) out.push(from + i * step);
  return out;
}

/**
 * For every knob: the smallest relaxation that lifts detection on `hard` to
 * `target`, and what it costs on `ablation` (hallucinations) and in accuracy.
 */
export function sweep({ hard, ablation, clean = null, target = 0.9 }) {
  const base = { hard: score(hard), ablation: score(ablation), clean: clean ? score(clean) : null };
  const rows = [];
  for (const knob of KNOBS) {
    let hit = null;
    for (const v of knob.scan) {
      const p = knob.apply(v);
      const s = score(hard, p);
      if (s.detectRate >= target) {
        hit = { value: v, hard: s, ablation: score(ablation, p), clean: clean ? score(clean, p) : null };
        break;
      }
    }
    // where it got to if it never made the bar
    let bestReach = null;
    if (!hit) {
      const v = knob.scan[knob.scan.length - 1];
      const p = knob.apply(v);
      bestReach = { value: v, hard: score(hard, p), ablation: score(ablation, p), clean: clean ? score(clean, p) : null };
    }
    rows.push({ knob, hit, bestReach });
  }
  return { base, rows, target };
}

/** Which term is binding, over a whole captured set, as a histogram. */
export function failedGateHistogram(set, params = {}) {
  const gate = { ...GATE_DEFAULTS, ...(params.gate || {}) };
  const evid = { ...EVID_DEFAULTS, ...(params.evid || {}) };
  const hist = new Map();
  const deficits = new Map();
  let n = 0;
  for (const rec of set) {
    const rows = fuse(rec.cap, { gate, evid });
    for (let s = 0; s < rows.length; s++) {
      if (rec.missing?.includes(s)) continue;
      if (rows[s].detected) continue;
      n++;
      const b = rows[s].binding;
      hist.set(b.name, (hist.get(b.name) || 0) + 1);
      if (!deficits.has(b.name)) deficits.set(b.name, []);
      if (isFinite(b.deficit)) deficits.get(b.name).push(b.deficit);
    }
  }
  return {
    total: n,
    rows: [...hist.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        share: n ? count / n : 0,
        medDeficit: median(deficits.get(name) || []),
        p90Deficit: pct(deficits.get(name) || [], 0.9),
      })),
  };
}

/**
 * A joint relaxation, found greedily from the evidence rather than guessed:
 * relax whichever term is binding for the most undetected strings, only as far
 * as it has to go, then look again. Stops the moment the ablation suite starts
 * confirming a string that was never played — that is the hallucination guard,
 * and it is a hard stop, not a preference.
 */
export function recommend({ hard, ablation, clean = null, target = 0.9, maxSteps = 4, allowHalluc = 0 }) {
  let params = { gate: {}, evid: {} };
  const steps = [];
  for (let step = 0; step < maxSteps; step++) {
    const now = score(hard, params);
    if (now.detectRate >= target) break;
    const hist = failedGateHistogram(hard, params);
    if (!hist.rows.length) break;
    // knobs that act on the currently-binding term, most binding first
    const order = hist.rows.flatMap((r) => KNOBS.filter((k) => k.term.startsWith(r.name)));
    let took = null;
    for (const knob of order) {
      if (steps.some((s) => s.knob === knob.name)) continue;
      for (const v of knob.scan) {
        const cand = mergeParams(params, knob.apply(v));
        const sHard = score(hard, cand);
        const sAbl = score(ablation, cand);
        if (sAbl.halluc > allowHalluc) break; // guard: stop this knob here
        if (sHard.detectRate > now.detectRate + 1e-9) {
          took = { knob: knob.name, value: v, params: cand, hard: sHard, ablation: sAbl };
          if (sHard.detectRate >= target) break;
        }
      }
      if (took) break;
    }
    if (!took) break;
    params = took.params;
    steps.push(took);
  }
  return {
    params,
    steps,
    final: {
      hard: score(hard, params),
      ablation: score(ablation, params),
      clean: clean ? score(clean, params) : null,
    },
  };
}

function mergeParams(a, b) {
  return { gate: { ...(a.gate || {}), ...(b.gate || {}) }, evid: { ...(a.evid || {}), ...(b.evid || {}) } };
}

/** Build the synthetic worlds the sweep needs. */
export async function buildSweepSets({
  hardN = 24,
  cleanN = 16,
  ablationN = 30,
  hardWorld = 'extreme',
  asApp = true,
} = {}) {
  const hard = await captureTrials(await harshTrials({ n: hardN, world: hardWorld }), { asApp });
  const spec = await captureTrials(await harshTrials({ n: hardN, world: 'spec' }), { asApp });
  const clean = await captureTrials(await harshTrials({ n: cleanN, world: 'clean' }), { asApp });
  const ablation = await captureTrials(await ablationTrials({ n: ablationN }), { asApp });
  return { hard, spec, clean, ablation, hardWorld, asApp };
}
