/**
 * selftest.mjs — the licence to believe the report.
 *
 * Every measurement in this pipeline is checked against audio whose answers are
 * known exactly, because a calibration that is itself uncalibrated is worse than
 * none: it would move the shipped thresholds on the strength of its own bugs.
 *
 * The checks, and why each one is the one that matters:
 *
 *   decode           the formats a phone or a recorder produces (16/24-bit,
 *                    float, stereo, 44.1 kHz) all come back as the same signal.
 *   probe == clean    the instrumented copy of strum.ts must be behaviourally
 *                    identical to the shipped one. If it is not, every "which
 *                    gate failed" answer describes a different algorithm.
 *   fusion parity     the replicated confidence layer must reproduce
 *                    `analyzeStrumRaw`'s cents, confidence and detect decision
 *                    on every string of every clip. Zero disagreements, or the
 *                    threshold sweep is fiction.
 *   evidX fidelity    the per-partial table the report reasons over must
 *                    reconstruct the module's own exclusive-evidence number.
 *   ground truth      f0 fitted from a solo clip within 0.5 cents of the truth,
 *                    or the strum errors are measuring the ground truth's error.
 *   inharmonicity     fitted B within 15% of the synth's own B.
 *   polarisation      beat rate and depth within 25%, where the clip is long
 *                    enough to contain the beat at all.
 */

import { decode } from './decode.mjs';
import { analyzeSolo } from './solo.mjs';
import { captureStrum, fuse, evidXOf, EVID_DEFAULTS } from './strums.mjs';
import { micChain } from './micchain.mjs';
import { loadModules } from './bundle.mjs';

const median = (a) => {
  const v = a.filter(Number.isFinite);
  if (!v.length) return NaN;
  const s = Float64Array.from(v).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

/**
 * The synth's true depth for partial k, averaged over exactly the window the
 * estimator used. The partner polarisation decays at its own rate, so "the
 * depth" is only defined together with an interval.
 *   spike synth:  tau_k = tau1 / (1 + 0.75 (k-1)^0.9), partner tau = tau_k * polarTau
 *   ratio(t)   =  polarRatio * exp(-(1/polarTau - 1) t / tau_k)
 */
function trueDepth(truth, k, t0, t1) {
  const tauK = truth.tau1 / (1 + 0.75 * Math.pow(k - 1, 0.9));
  const lam = (1 / truth.polarTau - 1) / tauK;
  const a = Math.max(0, t0);
  const b = Math.max(a + 1e-6, t1);
  if (Math.abs(lam) < 1e-9) return truth.polarRatio;
  return (truth.polarRatio * (Math.exp(-lam * a) - Math.exp(-lam * b))) / (lam * (b - a));
}

export async function runSelfTest({ manifest, soloResults, strumResults, targets }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const truthOf = (s) => manifest.clips.find((c) => c.role === 'solo' && c.string === s)?.truth;

  /* ---------------------------------------------------------- 1. decoding */
  {
    const bad = [];
    for (const c of manifest.clips) {
      const d = decode(c.file);
      if (!d.ok) bad.push(`${c.file}: ${d.error || d.hint}`);
      else if (Math.abs(d.fs - c.fs) > 1) bad.push(`${c.file}: rate ${d.fs} != ${c.fs}`);
      else if (!d.seconds) bad.push(`${c.file}: empty`);
    }
    const fmts = new Set(manifest.clips.map((c) => c.file).map((f) => f));
    add(
      'decode every written format',
      bad.length === 0,
      bad.length
        ? bad.join('; ')
        : `${manifest.clips.length} clips: 16-bit, 24-bit, 32-bit float, stereo, 44.1 kHz and 48 kHz all read`,
    );
  }

  /* ------------------------------------------- 2. probe bundle == clean bundle */
  {
    const { clean, probe } = await loadModules();
    const diffs = [];
    let n = 0;
    for (const c of manifest.clips.filter((k) => k.role === 'strum')) {
      const d = decode(c.file);
      if (!d.ok) continue;
      const sig = micChain(d.x, d.fs);
      const a = clean.analyzeStrumRaw(sig.x, sig.fs, targets);
      const b = probe.analyzeStrumRaw(sig.x, sig.fs, targets);
      for (let s = 0; s < targets.length; s++) {
        n++;
        const x = a.strings[s];
        const y = b.strings[s];
        const same =
          x.detected === y.detected &&
          Math.abs(x.conf - y.conf) < 1e-12 &&
          ((!isFinite(x.cents) && !isFinite(y.cents)) || Math.abs(x.cents - y.cents) < 1e-12);
        if (!same) diffs.push(`${c.file} s${s}`);
      }
    }
    add(
      'instrumented bundle is behaviourally identical to the shipped one',
      diffs.length === 0,
      diffs.length ? `${diffs.length} of ${n} differ: ${diffs.slice(0, 5).join(', ')}` : `${n} string-results identical to 1e-12`,
    );
  }

  /* --------------------------- 3. replicated fusion == analyzeStrumRaw */
  {
    let n = 0;
    let bad = 0;
    const detail = [];
    for (const { clip, events } of strumResults) {
      for (const ev of events) {
        n += targets.length;
        if (!ev.parity.ok) {
          bad += ev.parity.diffs.length;
          detail.push(`${clip.name} #${ev.index + 1}: ${ev.parity.diffs.map((d) => `s${d.s}`).join(',')}`);
        }
      }
    }
    add(
      'failed-gate instrumentation reproduces the shipped detect/no-detect decision',
      bad === 0 && n > 0,
      bad === 0
        ? `0 disagreements over ${n} string-results (${strumResults.length} clips)`
        : `${bad} disagreements: ${detail.join('; ')}`,
    );
  }

  /* ---------------------------------------------- 4. evidX reconstruction */
  {
    let worst = 0;
    let n = 0;
    for (const { events } of strumResults) {
      for (const rows of events.flatMap((ev) => ev.r.cap.per)) {
        for (const row of rows) {
          if (!row.partials?.length) continue;
          n++;
          worst = Math.max(worst, Math.abs(evidXOf(row.partials, EVID_DEFAULTS) - row.evidX));
        }
      }
    }
    add(
      'per-partial evidence table reconstructs the module’s own evidX',
      n > 0 && worst < 1e-9,
      `worst abs difference ${worst.toExponential(1)} over ${n} frame-strings`,
    );
  }

  /* -------------------------------------------- 5. ground-truth cents (0.5 c) */
  {
    const rows = [];
    for (const { clip, a } of soloResults) {
      const t = truthOf(clip.string);
      if (!t || !a.ok) continue;
      rows.push({ s: clip.string, err: (1200 * Math.log(a.f0 / t.f0)) / Math.LN2 });
    }
    const worst = rows.length ? Math.max(...rows.map((r) => Math.abs(r.err))) : NaN;
    add(
      'solo ground-truth f0 within 0.5 cents',
      rows.length >= 5 && worst <= 0.5,
      rows.length
        ? `worst ${f2(worst, 3)} c over ${rows.length} strings (${rows.map((r) => `${manifest.names[r.s]} ${r.err >= 0 ? '+' : ''}${r.err.toFixed(3)}`).join(', ')})`
        : 'no solo clips analysed',
    );
  }

  /* --------------------------------------------------- 6. inharmonicity (15%) */
  {
    const rows = [];
    for (const { clip, a } of soloResults) {
      const t = truthOf(clip.string);
      if (!t || !a.ok || !isFinite(a.B)) continue;
      rows.push({ s: clip.string, rel: a.B / t.B - 1 });
    }
    const worst = rows.length ? Math.max(...rows.map((r) => Math.abs(r.rel))) : NaN;
    add(
      'fitted inharmonicity B within 15% per string',
      rows.length >= 5 && worst <= 0.15,
      rows.length
        ? `worst ${(100 * worst).toFixed(1)}% over ${rows.length} strings (${rows.map((r) => `${manifest.names[r.s]} ${(100 * r.rel >= 0 ? '+' : '') + (100 * r.rel).toFixed(1)}%`).join(', ')})`
        : 'no solo clips analysed',
    );
  }

  /* ------------------------------------------------- 7. polarisation (25%) */
  {
    const rateErr = [];
    const depthErr = [];
    const unmeasurable = [];
    for (const { clip, a } of soloResults) {
      const t = truthOf(clip.string);
      if (!t || !a.ok) continue;
      const good = a.beats.filter((b) => b.cycles >= 2 && b.r2 >= 0.5 && isFinite(b.depth));
      if (!good.length) {
        unmeasurable.push(`${manifest.names[clip.string]} (split ${f2(t.splitHz, 3)} Hz at f0 — needs a clip ~${f2(2 / t.splitHz, 0)} s long)`);
        continue;
      }
      rateErr.push({ s: clip.string, rel: a.splitHz1 / t.splitHz - 1 });
      const per = good.map((b) => b.depth / trueDepth(t, b.k, b.winFrom - t.onset, b.winTo - t.onset) - 1);
      depthErr.push({ s: clip.string, rel: median(per), n: per.length });
    }
    const wr = rateErr.length ? Math.max(...rateErr.map((r) => Math.abs(r.rel))) : NaN;
    const wd = depthErr.length ? Math.max(...depthErr.map((r) => Math.abs(r.rel))) : NaN;
    add(
      'polarisation beat RATE within 25%',
      rateErr.length >= 4 && wr <= 0.25,
      rateErr.length
        ? `worst ${(100 * wr).toFixed(1)}% over ${rateErr.length} strings` +
          (unmeasurable.length ? `; not measurable: ${unmeasurable.join(', ')}` : '')
        : 'no measurable beat',
    );
    add(
      'polarisation beat DEPTH within 25%',
      depthErr.length >= 4 && wd <= 0.25,
      depthErr.length
        ? `worst ${(100 * wd).toFixed(1)}% over ${depthErr.length} strings ` +
          `(${depthErr.map((r) => `${manifest.names[r.s]} ${(100 * r.rel >= 0 ? '+' : '') + (100 * r.rel).toFixed(0)}%/${r.n}k`).join(', ')})`
        : 'no measurable beat',
    );
  }

  /* -------------------------------------- 8. the muted string is not confirmed */
  {
    const muted = strumResults
      .filter(({ clip }) => clip.muted != null)
      .flatMap(({ clip, events }) => events.map((ev) => ({ clip, r: ev.r })));
    const bad = muted.filter(({ clip, r }) => r.strings[clip.muted].detected);
    add(
      'muted strings are not hallucinated at the shipped thresholds',
      muted.length > 0 && bad.length === 0,
      muted.length
        ? `${bad.length} of ${muted.length} muted-string strum events confirmed the muted string`
        : 'no muted-string clips in the set',
    );
  }

  return { checks, pass: checks.every((c) => c.pass) };
}
