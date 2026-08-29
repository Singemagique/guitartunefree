const MIN_FREQ = 28;
const MAX_FREQ = 1100;
const MIN_CLARITY = 0.88;
const MIN_RMS_ABS = 3e-3;
const GATE_MARGIN = 2.5;
const FLOOR_RISE = 0.02;
const FLOOR_FALL = 1.02;
const KEY_MAX_RATIO = 0.9;
const CONTINUITY_RATIO = 1.0905077326652577;
const MEMORY_SECONDS = 1.5;
const DEFAULT_DETECT_MS = 25;
const SLOW_SECONDS = 2;
const SLOW_STARVE_SECONDS = 5;
const SLOW_TAIL_SECONDS = 0.043;
const SLOW_LOW_PCT = 0.1;
const SLOW_HIGH_PCT = 0.9;
const SLOW_SPREAD_MAX = 1.2;
const SLOW_MARGIN = 1.25;
const SLOW_REFRESH = 4;
class PitchDetector {
  sampleRate;
  bufferSize;
  lagLimit;
  signal;
  nsdf;
  peakLag;
  peakValue;
  /** Frames, not milliseconds: detect() is handed no clock, so the caller's
      cadence is turned into a count of frames once, in the constructor. */
  memoryFrames;
  /** Ring of recent envelope levels, and the scratch it is sorted into. */
  slowRing;
  slowSorted;
  tailLength;
  /** Running background estimate, in RMS. */
  floor = MIN_RMS_ABS;
  /** Last confident pitch, 0 when the memory is empty. */
  lastFreq = 0;
  /** Unpitched frames since that pitch, saturating just past memoryFrames. */
  unpitchedFrames;
  /** Level a still room has to be cleared by, or 0 until one is measured. */
  slowGate = 0;
  slowAt = 0;
  slowCount = 0;
  slowSince = 0;
  /** Frames since the fast estimate last saw a frame with no pitch in it. */
  starvedFrames = 0;
  starveFrames;
  constructor(sampleRate, bufferSize = 2048, detectIntervalMs = DEFAULT_DETECT_MS) {
    this.sampleRate = sampleRate;
    this.bufferSize = bufferSize;
    const interval = Number.isFinite(detectIntervalMs) && detectIntervalMs > 0 ? detectIntervalMs : DEFAULT_DETECT_MS;
    this.memoryFrames = Math.max(1, Math.round(MEMORY_SECONDS * 1e3 / interval));
    this.unpitchedFrames = this.memoryFrames + 1;
    const slowFrames = Math.max(8, Math.round(SLOW_SECONDS * 1e3 / interval));
    this.slowRing = new Float32Array(slowFrames);
    this.slowSorted = new Float32Array(slowFrames);
    this.starveFrames = Math.max(slowFrames, Math.round(SLOW_STARVE_SECONDS * 1e3 / interval));
    this.tailLength = Math.min(
      bufferSize,
      Math.max(256, Math.round(sampleRate * SLOW_TAIL_SECONDS))
    );
    this.lagLimit = Math.min(bufferSize >> 1, Math.ceil(sampleRate / MIN_FREQ) + 2);
    this.signal = new Float32Array(bufferSize);
    this.nsdf = new Float32Array(this.lagLimit + 1);
    const maxPeaks = (this.lagLimit >> 1) + 2;
    this.peakLag = new Float32Array(maxPeaks);
    this.peakValue = new Float32Array(maxPeaks);
  }
  /**
   * Forget the room and the note. Callers invoke this when the microphone
   * (re)starts: a fresh stream may be a different device in a different room,
   * and a background estimate carried over from the old one would either deafen
   * the tuner or let the new room's noise through.
   */
  reset() {
    this.floor = MIN_RMS_ABS;
    this.lastFreq = 0;
    this.unpitchedFrames = this.memoryFrames + 1;
    this.slowGate = 0;
    this.slowAt = 0;
    this.slowCount = 0;
    this.slowSince = 0;
    this.starvedFrames = 0;
  }
  detect(buf) {
    const size = Math.min(buf.length, this.bufferSize);
    const maxLag = Math.min(size >> 1, this.lagLimit);
    if (maxLag < 4) {
      this.age();
      return null;
    }
    const x = this.signal;
    let mean = 0;
    for (let i = 0; i < size; i++) mean += buf[i];
    mean /= size;
    let power = 0;
    for (let i = 0; i < size; i++) {
      const v = buf[i] - mean;
      x[i] = v;
      power += v * v;
    }
    const rms = Math.sqrt(power / size);
    this.observeLevel(x, size);
    const gate = Math.max(MIN_RMS_ABS, this.floor * GATE_MARGIN);
    if (rms < gate) return this.noPitch(rms);
    if (this.starvedFrames >= this.starveFrames && rms < this.slowGate) {
      this.age();
      return null;
    }
    const nsdf = this.nsdf;
    nsdf[0] = 1;
    let m = 2 * power;
    for (let tau = 1; tau <= maxLag; tau++) {
      const head = x[tau - 1];
      const tail = x[size - tau];
      m -= head * head + tail * tail;
      let r = 0;
      const end = size - tau;
      for (let j = 0; j < end; j++) r += x[j] * x[j + tau];
      nsdf[tau] = m > 1e-12 ? 2 * r / m : 0;
    }
    let pos = 0;
    while (pos < maxLag && nsdf[pos] > 0) pos++;
    while (pos < maxLag && nsdf[pos] <= 0) pos++;
    if (pos >= maxLag) return this.noPitch(rms);
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
    if (count === 0) return this.noPitch(rms);
    let highest = 0;
    for (let i = 0; i < count; i++) {
      if (this.peakValue[i] > highest) highest = this.peakValue[i];
    }
    const threshold = KEY_MAX_RATIO * highest;
    let chosen = 0;
    for (let i = 0; i < count; i++) {
      if (this.peakValue[i] >= threshold) {
        chosen = i;
        break;
      }
    }
    const last = this.lastFreq;
    if (last > 0 && this.unpitchedFrames <= this.memoryFrames) {
      const lagLimit = 2 * this.peakLag[chosen];
      let closest = CONTINUITY_RATIO;
      let near = -1;
      for (let i = 0; i < count; i++) {
        if (this.peakValue[i] < threshold) continue;
        const lag = this.peakLag[i];
        if (lag <= 0 || lag >= lagLimit) continue;
        const f = this.sampleRate / lag;
        const ratio = f >= last ? f / last : last / f;
        if (ratio <= closest) {
          closest = ratio;
          near = i;
        }
      }
      if (near >= 0) chosen = near;
    }
    const clarity = Math.min(1, Math.max(0, this.peakValue[chosen]));
    if (clarity < MIN_CLARITY) return this.noPitch(rms);
    const freq = this.sampleRate / this.peakLag[chosen];
    if (freq < MIN_FREQ || freq > MAX_FREQ) return this.noPitch(rms);
    this.lastFreq = freq;
    this.unpitchedFrames = 0;
    return { freq, clarity };
  }
  /** Expire the continuity memory a frame at a time, saturating so a long
      silence cannot run the counter away. */
  age() {
    if (this.unpitchedFrames <= this.memoryFrames) this.unpitchedFrames++;
  }
  /**
   * A frame with no pitch in it is a sample of the room, so it — and only it —
   * moves the background estimate. Downwards it follows almost at once: the room
   * going quiet must restore the tuner's sensitivity before the next pluck.
   * Upwards it creeps, 2% of the gap per frame, so one door slam cannot deafen
   * the gate and an ordinary noisy room is rejected inside a second.
   *
   * That rise is never aimed higher than the gate itself. A loud frame with no
   * pitch in it is not a measurement of the background — it is a transient, a
   * note's attack, the moment a second string joins, the last of a decay, a door
   * closing. Aimed at such a frame's own level the estimate lands ABOVE whatever
   * arrives next: one 200 ms room bang within 100 ms of a pluck used to hand the
   * string a gate 8 dB over its own head, and because every later frame of a
   * decaying note is quieter than the last, the ratio then locked there for the
   * whole ring — the tuner went deaf to the string in front of it and stayed
   * deaf. Aimed no higher than the gate, the estimate still climbs out of a room
   * that has genuinely got louder — but at a fixed ~3% of a frame per frame, so
   * it can no longer be thrown anywhere by one frame. A room 8 dB over the cold
   * gate is rejected in 0.8 s and one 26 dB over in 2.5 s: a fixed ~10 dB per
   * second, measured, rather than one step of any size.
   */
  noPitch(rms) {
    this.age();
    this.starvedFrames = 0;
    if (rms < this.floor) {
      this.floor = Math.min(this.floor * FLOOR_FALL, rms);
      return null;
    }
    const target = Math.min(rms, this.floor * GATE_MARGIN);
    this.floor += (target - this.floor) * FLOOR_RISE;
    return null;
  }
  /**
   * Feed the slow estimate. The level measured is the RMS of the tail of the
   * frame — the freshest ~43 ms, which the analyser has only just handed over —
   * because the whole 85 ms frame averages a fast tremolo into something as
   * level as hum, and the whole point of this estimate is to tell those apart.
   */
  observeLevel(x, size) {
    if (this.starvedFrames <= this.starveFrames) this.starvedFrames++;
    const len = Math.min(this.tailLength, size);
    let power = 0;
    for (let i = size - len; i < size; i++) power += x[i] * x[i];
    const ring = this.slowRing;
    ring[this.slowAt] = Math.sqrt(power / len);
    this.slowAt = (this.slowAt + 1) % ring.length;
    if (this.slowCount < ring.length) this.slowCount++;
    if (++this.slowSince < SLOW_REFRESH) return;
    this.slowSince = 0;
    if (this.slowCount < ring.length) return;
    const sorted = this.slowSorted;
    sorted.set(ring);
    sorted.sort();
    const n = sorted.length;
    const low = sorted[Math.floor(SLOW_LOW_PCT * n)];
    const high = sorted[Math.min(n - 1, Math.floor(SLOW_HIGH_PCT * n))];
    if (low > 0 && high <= low * SLOW_SPREAD_MAX) this.slowGate = low * SLOW_MARGIN;
  }
  /**
   * Fit a parabola through the maximum and its two neighbours. Its vertex gives
   * the period to a fraction of a sample (a whole-sample lag is worth tens of
   * cents up high) and a peak height that is not truncated by the sample grid.
   */
  refinePeak(slot, lag) {
    const nsdf = this.nsdf;
    const s0 = nsdf[lag - 1];
    const s1 = nsdf[lag];
    const s2 = nsdf[lag + 1];
    const denom = 2 * s1 - s0 - s2;
    if (denom > 1e-12) {
      const delta = 0.5 * (s2 - s0) / denom;
      this.peakLag[slot] = lag + delta;
      this.peakValue[slot] = s1 - 0.25 * (s0 - s2) * delta;
    } else {
      this.peakLag[slot] = lag;
      this.peakValue[slot] = s1;
    }
  }
}
export {
  MIN_FREQ,
  PitchDetector
};
