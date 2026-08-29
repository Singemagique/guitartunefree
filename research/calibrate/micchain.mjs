/**
 * micchain.mjs — hear the recording the way the APP hears it.
 *
 * This is not cosmetic. src/audio/mic.ts puts every microphone sample through
 *
 *     highpass 20 Hz (Q 0.707)  ->  lowpass 2000 Hz (Q 0.707)  ->  analyser
 *
 * and src/audio/strumcapture.ts taps THAT node — the SPEC's condition 3 says so
 * in as many words ("strum capture taps the SAME filtered chain"). Meanwhile
 * strum.ts analyses up to `fMax = 3400 Hz`. So the partials between 2 and
 * 3.4 kHz — which for B3 and E4 are the only ones no lower string can reach,
 * i.e. exactly the partials the exclusive-evidence gate is counting — arrive
 * 3 to 10 dB down before the estimator ever sees them.
 *
 * A raw phone recording has none of that. Analysing the user's clips raw would
 * therefore flatter the algorithm and calibrate the thresholds for a signal the
 * app never receives. Every strum in this pipeline is run BOTH ways, and the
 * difference is reported.
 *
 * The biquads are the Audio EQ Cookbook forms, which is what Chrome's
 * BiquadFilterNode implements, at the app's own constants.
 */

/** src/audio/mic.ts constants, mirrored. */
export const MIC = Object.freeze({
  highpassHz: 20, //   HIGHPASS_DEFAULT (the view may raise it to <= 90)
  highpassMax: 90, //  HIGHPASS_MAX
  lowpassHz: 2000, //  LOWPASS_HZ
  q: 0.707, //         FILTER_Q (Butterworth)
  maxAnalysisRate: 48000, // MAX_ANALYSIS_RATE
});

function biquadCoeffs(type, fs, f0, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0;
  let b1;
  let b2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
  } else {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Direct-form-I biquad, in place on a copy. */
function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
    y[i] = yn;
  }
  return y;
}

/** mic.ts's `decimation()`: a power of two that brings fs to <= 48 kHz. */
export function decimation(fs) {
  if (!Number.isFinite(fs) || fs <= MIC.maxAnalysisRate) return 1;
  return 1 << Math.ceil(Math.log2(fs / MIC.maxAnalysisRate));
}

/**
 * Put samples through the app's analysis chain.
 * Returns { x, fs } — the rate changes only when the app would decimate.
 */
export function micChain(x, fs, { highpassHz = MIC.highpassHz, lowpassHz = MIC.lowpassHz, decimate = true } = {}) {
  let y = biquad(x, biquadCoeffs('highpass', fs, highpassHz, MIC.q));
  y = biquad(y, biquadCoeffs('lowpass', fs, lowpassHz, MIC.q));
  let outFs = fs;
  if (decimate) {
    const d = decimation(fs);
    if (d > 1) {
      const z = new Float64Array(Math.floor(y.length / d));
      for (let i = 0; i < z.length; i++) z[i] = y[i * d];
      y = z;
      outFs = fs / d;
    }
  }
  return { x: y, fs: outFs };
}

/** Magnitude response of the chain at one frequency, in dB. */
export function chainGainDb(f, fs = 48000, { highpassHz = MIC.highpassHz, lowpassHz = MIC.lowpassHz } = {}) {
  const at = (coeffs) => {
    const [b0, b1, b2, a1, a2] = coeffs;
    const w = (2 * Math.PI * f) / fs;
    const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
    const ni = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
    const dr = 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w);
    const di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  };
  const g =
    at(biquadCoeffs('highpass', fs, highpassHz, MIC.q)) *
    at(biquadCoeffs('lowpass', fs, lowpassHz, MIC.q));
  return 20 * Math.log10(g + 1e-30);
}
