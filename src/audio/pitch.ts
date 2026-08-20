export interface PitchResult {
  freq: number;
  clarity: number;
}

const MIN_FREQ = 55;
const MAX_FREQ = 1100;
const MIN_RMS = 0.005;
const MIN_CLARITY = 0.88;

/** McLeod's key-maximum ratio: accept the first peak within 10% of the tallest. */
const KEY_MAX_RATIO = 0.9;

/**
 * McLeod Pitch Method.
 *
 * Builds the Normalised Square Difference Function
 *   n(tau) = 2 * r(tau) / m(tau)
 * where r(tau) is the autocorrelation over the overlapping part of the frame and
 * m(tau) the sum of squares of that same overlap. Dividing by m removes the
 * amplitude taper that makes plain autocorrelation favour short lags, so octave
 * errors mostly disappear and the peak height doubles as a confidence measure.
 */
export class PitchDetector {
  private readonly sampleRate: number;
  private readonly bufferSize: number;
  private readonly lagLimit: number;
  private readonly signal: Float32Array;
  private readonly nsdf: Float32Array;
  private readonly peakLag: Float32Array;
  private readonly peakValue: Float32Array;

  constructor(sampleRate: number, bufferSize = 2048) {
    this.sampleRate = sampleRate;
    this.bufferSize = bufferSize;
    // One period of the lowest accepted pitch is the longest lag worth testing,
    // capped at half the frame so every lag keeps a substantial overlap.
    this.lagLimit = Math.min(bufferSize >> 1, Math.ceil(sampleRate / MIN_FREQ) + 2);
    this.signal = new Float32Array(bufferSize);
    this.nsdf = new Float32Array(this.lagLimit + 1);
    // Key maxima live in disjoint positive lobes, so at most one per two lags.
    const maxPeaks = (this.lagLimit >> 1) + 2;
    this.peakLag = new Float32Array(maxPeaks);
    this.peakValue = new Float32Array(maxPeaks);
  }

  detect(buf: Float32Array): PitchResult | null {
    const size = Math.min(buf.length, this.bufferSize);
    const maxLag = Math.min(size >> 1, this.lagLimit);
    if (maxLag < 4) return null;

    const x = this.signal;

    // Remove DC: a biased frame correlates with itself at every lag and drags
    // the NSDF towards a false low-frequency peak.
    let mean = 0;
    for (let i = 0; i < size; i++) mean += buf[i];
    mean /= size;

    let power = 0;
    for (let i = 0; i < size; i++) {
      const v = buf[i] - mean;
      x[i] = v;
      power += v * v;
    }
    if (Math.sqrt(power / size) < MIN_RMS) return null;

    const nsdf = this.nsdf;
    nsdf[0] = 1;
    // m(0) counts the whole frame twice; each further lag simply drops the one
    // sample that falls off each end of the overlap.
    let m = 2 * power;
    for (let tau = 1; tau <= maxLag; tau++) {
      const head = x[tau - 1];
      const tail = x[size - tau];
      m -= head * head + tail * tail;
      let r = 0;
      const end = size - tau;
      for (let j = 0; j < end; j++) r += x[j] * x[j + tau];
      nsdf[tau] = m > 1e-12 ? (2 * r) / m : 0;
    }

    // Skip the lobe around lag 0 (always 1) and the negative dip behind it; real
    // period candidates only start after the first negative-going zero crossing.
    let pos = 0;
    while (pos < maxLag && nsdf[pos] > 0) pos++;
    while (pos < maxLag && nsdf[pos] <= 0) pos++;
    if (pos >= maxLag) return null;

    // Take the tallest local maximum inside each positive lobe.
    const capacity = this.peakLag.length;
    let count = 0;
    let best = -1;
    while (pos < maxLag && count < capacity) {
      if (nsdf[pos] > nsdf[pos - 1] && nsdf[pos] >= nsdf[pos + 1]) {
        if (best < 0 || nsdf[pos] > nsdf[best]) best = pos;
      }
      pos++;
      if (pos < maxLag && nsdf[pos] <= 0) {
        if (best >= 0) {
          this.refinePeak(count++, best);
          best = -1;
        }
        while (pos < maxLag && nsdf[pos] <= 0) pos++;
      }
    }
    if (best >= 0 && count < capacity) this.refinePeak(count++, best);
    if (count === 0) return null;

    let highest = 0;
    for (let i = 0; i < count; i++) {
      if (this.peakValue[i] > highest) highest = this.peakValue[i];
    }

    // The first peak that comes close to the tallest is the true period; later
    // taller peaks are its multiples, earlier smaller ones are partials.
    const threshold = KEY_MAX_RATIO * highest;
    let chosen = 0;
    for (let i = 0; i < count; i++) {
      if (this.peakValue[i] >= threshold) {
        chosen = i;
        break;
      }
    }

    const clarity = Math.min(1, Math.max(0, this.peakValue[chosen]));
    if (clarity < MIN_CLARITY) return null;

    const freq = this.sampleRate / this.peakLag[chosen];
    if (freq < MIN_FREQ || freq > MAX_FREQ) return null;

    return { freq, clarity };
  }

  /**
   * Fit a parabola through the maximum and its two neighbours. Its vertex gives
   * the period to a fraction of a sample (a whole-sample lag is worth tens of
   * cents up high) and a peak height that is not truncated by the sample grid.
   */
  private refinePeak(slot: number, lag: number): void {
    const nsdf = this.nsdf;
    const s0 = nsdf[lag - 1];
    const s1 = nsdf[lag];
    const s2 = nsdf[lag + 1];
    const denom = 2 * s1 - s0 - s2;
    if (denom > 1e-12) {
      const delta = (0.5 * (s2 - s0)) / denom;
      this.peakLag[slot] = lag + delta;
      this.peakValue[slot] = s1 - 0.25 * (s0 - s2) * delta;
    } else {
      this.peakLag[slot] = lag;
      this.peakValue[slot] = s1;
    }
  }
}
