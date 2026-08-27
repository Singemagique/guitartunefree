export interface PitchResult {
  freq: number;
  clarity: number;
}

/** Low B of a 5-string bass is 30.87 Hz; leave a little room under it. */
export const MIN_FREQ = 28;
const MAX_FREQ = 1100;
const MIN_CLARITY = 0.88;

/** Nothing quieter than this is ever a string, however quiet the room is. */
const MIN_RMS_ABS = 0.003;
/** …and above that floor a frame must clear the background by ~8 dB. */
const GATE_MARGIN = 2.5;
/** Share of the gap an unpitched frame closes when the room gets louder. */
const FLOOR_RISE = 0.02;
/** Ceiling on the drop to a quieter frame. It never binds — a frame under the
    estimate is under `estimate * 1.02` too — which is the point: sensitivity
    comes back the moment the room does, and only the rise is slow. */
const FLOOR_FALL = 1.02;

/** McLeod's key-maximum ratio: accept the first peak within 10% of the tallest. */
const KEY_MAX_RATIO = 0.9;

/** How far a peak may sit from the note we were just hearing and still count as
    the same note: a whole tone and a half — wider than any vibrato or bend
    between two frames, far narrower than the octave the traps live at. */
const CONTINUITY_RATIO = 1.0905077326652577; // 2 ** (150 / 1200)
/** The memory of that note survives this long without a confident frame. */
const MEMORY_SECONDS = 1.5;
/**
 * How often the caller hands us a frame. detect() keeps no clock, so this is the
 * one number that turns the seconds above into a count of frames.
 *
 * It cannot be derived from bufferSize / sampleRate: the analyser returns a
 * sliding window, so consecutive frames overlap heavily and arrive about three
 * times faster than their own duration. Deriving it that way made MEMORY_SECONDS
 * mean 0.40-0.60 s in the app, and made it depend on the sound card's rate.
 */
const DEFAULT_DETECT_MS = 25;

/* The second, slower background estimator.
 *
 * The fast estimate below only ever learns from frames that carried no pitch,
 * which is the right rule for a note — a sustained string is not background —
 * but it means a background that is ITSELF periodic (mains hum, a fan whine, a
 * transformer) is invisible to it: every frame is "pitched", the estimate never
 * moves, and the tuner parks on the hum from the moment the mic opens.
 *
 * So a second estimate watches the level alone, on every frame, pitched or not.
 * Two things must both be true before it is allowed to turn a frame away, and
 * each covers the other's blind spot.
 *
 * 1. The room is holding still — a level that holds still is the one thing a
 *    struck string never does, since it starts decaying the moment it is struck.
 *    The measurement is the dynamic range (p90/p10) of a short-envelope level
 *    over a couple of seconds, and it separates the two populations cleanly
 *    (measured through the real mic chain at the app's own frame and hop):
 *
 *      mains hum, alone or under a quiet room  1.05 - 1.14      (background)
 *      a fan whine                             1.01
 *      ---------------------------------- SLOW_SPREAD_MAX 1.20
 *      a mandolin tremolo, picks 60-100 ms     1.25 - 1.52      (instrument)
 *      a plucked string, t60 8-14 s            2.18 - 4.40
 *      a bass low B, t60 14 s                  2.07 - 2.49
 *
 *    The envelope is deliberately shorter than the frame: an 85 ms frame
 *    averages a fast tremolo into something as level as hum, while a 43 ms tail
 *    still sees the gap between two picks.
 *
 * 2. The fast estimate has had nothing to go on for a long time — not one frame
 *    without a pitch in it since well before this window began. That is what
 *    tells a hum apart from a note held at a dead-steady level over a room the
 *    fast estimate has already measured: the note is loud because it is a note,
 *    and the quiet frames that preceded it told the fast estimate what the room
 *    underneath was. A hum starves the fast estimate from the first frame after
 *    the microphone opens and never stops.
 *
 * The cost of both being true wrongly is bounded: a frame is turned away, and
 * turned-away frames are not fed back into the fast estimate, so nothing
 * ratchets. The one thing this cannot read is a tone held at a dead-constant
 * level for more than SLOW_STARVE_SECONDS in a room that has been silent since
 * the microphone opened — a synthesised reference tone, not a string. A struck
 * string begins decaying in the same instant it is struck.
 */
const SLOW_SECONDS = 2;
/** How long the fast estimate must have been starved of unpitched frames before
    the slow one may overrule it. Longer than any sustain that still holds a
    steady level, short enough that a hum room comes right within a few seconds
    of opening the microphone. */
const SLOW_STARVE_SECONDS = 5;
/** Length of the envelope block: the freshest audio in the frame. */
const SLOW_TAIL_SECONDS = 0.043;
const SLOW_LOW_PCT = 0.1;
const SLOW_HIGH_PCT = 0.9;
/** Widest p90/p10 that still counts as a room holding still. */
const SLOW_SPREAD_MAX = 1.2;
/** A frame must stand this far over a still room to be worth looking at. Small
    on purpose, unlike GATE_MARGIN: this estimate is a percentile of a room that
    is not moving, so it needs no allowance for its own noise. A note 2.5 dB
    QUIETER than the room already lifts the frame's level past it. */
const SLOW_MARGIN = 1.25;
/** Frames between percentile recomputes. A background estimate does not need
    25 ms resolution, and this keeps the sort off most frames. */
const SLOW_REFRESH = 4;

/**
 * McLeod Pitch Method.
 *
 * Builds the Normalised Square Difference Function
 *   n(tau) = 2 * r(tau) / m(tau)
 * where r(tau) is the autocorrelation over the overlapping part of the frame and
 * m(tau) the sum of squares of that same overlap. Dividing by m removes the
 * amplitude taper that makes plain autocorrelation favour short lags, so octave
 * errors mostly disappear and the peak height doubles as a confidence measure.
 *
 * A fixed loudness gate cannot tell a quiet string from a loud room, so the
 * detector also tracks the background level itself — from the frames that carry
 * no pitch, which is the only honest evidence of what silence sounds like here —
 * and asks a candidate frame to stand clear of it. Backgrounds that are
 * themselves periodic never produce such a frame, so a second, slower estimate
 * watches the level on every frame and is consulted only while the room is
 * holding still, which is the one thing a played string never does. A short
 * memory of the last
 * confident pitch then breaks ties between period candidates that are equally
 * good and nearly the same note, so a string that is already ringing keeps its
 * own reading rather than stepping to a neighbouring lobe frame by frame.
 */
export class PitchDetector {
  private readonly sampleRate: number;
  private readonly bufferSize: number;
  private readonly lagLimit: number;
  private readonly signal: Float32Array;
  private readonly nsdf: Float32Array;
  private readonly peakLag: Float32Array;
  private readonly peakValue: Float32Array;
  /** Frames, not milliseconds: detect() is handed no clock, so the caller's
      cadence is turned into a count of frames once, in the constructor. */
  private readonly memoryFrames: number;
  /** Ring of recent envelope levels, and the scratch it is sorted into. */
  private readonly slowRing: Float32Array;
  private readonly slowSorted: Float32Array;
  private readonly tailLength: number;

  /** Running background estimate, in RMS. */
  private floor = MIN_RMS_ABS;
  /** Last confident pitch, 0 when the memory is empty. */
  private lastFreq = 0;
  /** Unpitched frames since that pitch, saturating just past memoryFrames. */
  private unpitchedFrames: number;
  /** Level a still room has to be cleared by, or 0 until one is measured. */
  private slowGate = 0;
  private slowAt = 0;
  private slowCount = 0;
  private slowSince = 0;
  /** Frames since the fast estimate last saw a frame with no pitch in it. */
  private starvedFrames = 0;
  private readonly starveFrames: number;

  constructor(sampleRate: number, bufferSize = 2048, detectIntervalMs = DEFAULT_DETECT_MS) {
    this.sampleRate = sampleRate;
    this.bufferSize = bufferSize;
    const interval =
      Number.isFinite(detectIntervalMs) && detectIntervalMs > 0
        ? detectIntervalMs
        : DEFAULT_DETECT_MS;
    this.memoryFrames = Math.max(1, Math.round((MEMORY_SECONDS * 1000) / interval));
    this.unpitchedFrames = this.memoryFrames + 1;
    const slowFrames = Math.max(8, Math.round((SLOW_SECONDS * 1000) / interval));
    this.slowRing = new Float32Array(slowFrames);
    this.slowSorted = new Float32Array(slowFrames);
    this.starveFrames = Math.max(slowFrames, Math.round((SLOW_STARVE_SECONDS * 1000) / interval));
    this.tailLength = Math.min(
      bufferSize,
      Math.max(256, Math.round(sampleRate * SLOW_TAIL_SECONDS)),
    );
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

  /**
   * Forget the room and the note. Callers invoke this when the microphone
   * (re)starts: a fresh stream may be a different device in a different room,
   * and a background estimate carried over from the old one would either deafen
   * the tuner or let the new room's noise through.
   */
  reset(): void {
    this.floor = MIN_RMS_ABS;
    this.lastFreq = 0;
    this.unpitchedFrames = this.memoryFrames + 1;
    this.slowGate = 0;
    this.slowAt = 0;
    this.slowCount = 0;
    this.slowSince = 0;
    this.starvedFrames = 0;
  }

  detect(buf: Float32Array): PitchResult | null {
    const size = Math.min(buf.length, this.bufferSize);
    const maxLag = Math.min(size >> 1, this.lagLimit);
    // Too short to hold a period: no pitch, but no evidence about the room
    // either, so the background estimate is left alone.
    if (maxLag < 4) {
      this.age();
      return null;
    }

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
    // The gate: loud enough in absolute terms, and clear of whatever this room
    // has been humming to itself between notes.
    const rms = Math.sqrt(power / size);
    this.observeLevel(x, size);
    const gate = Math.max(MIN_RMS_ABS, this.floor * GATE_MARGIN);
    if (rms < gate) return this.noPitch(rms);
    // …and, if the room has been holding perfectly still for long enough to have
    // starved the estimate above, clear of that too. A frame turned away here is
    // deliberately NOT fed to the fast estimate: the slow one has already
    // accounted for this level, and letting the same evidence raise the fast
    // floor as well would ratchet the gate up onto whatever is sounding — the
    // failure the cap in noPitch() exists to prevent.
    if (this.starvedFrames >= this.starveFrames && rms < this.slowGate) {
      this.age();
      return null;
    }

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
    if (pos >= maxLag) return this.noPitch(rms);

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
    if (count === 0) return this.noPitch(rms);

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

    // Continuity only ever re-picks *among* those same qualifying peaks, so it
    // cannot promote a peak the k = 0.9 bar rejected — a chattering neighbour
    // never wins, and the octave traps are decided before we get here. When a
    // note is already ringing and two periods are within a hair of each other,
    // the one that continues that note is the better bet than the earlier lag.
    //
    // …but only within an octave of the plain rule's answer. Two strings ringing
    // together are periodic at their common sub-period — an A and a D a fourth
    // apart repeat as one waveform two octaves and a fifth below the A, with an
    // NSDF peak taller than either string's — and that phantom period is exactly
    // what "the earliest qualifying peak wins" exists to reject. Left unbounded,
    // one such frame becomes the memory, and the memory then re-elects it on
    // every later frame: the tuner would sit on a note nobody played until both
    // strings died away.
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

    // A note is not background, however long it is held: the estimate stays put.
    this.lastFreq = freq;
    this.unpitchedFrames = 0;
    return { freq, clarity };
  }

  /** Expire the continuity memory a frame at a time, saturating so a long
      silence cannot run the counter away. */
  private age(): void {
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
  private noPitch(rms: number): null {
    this.age();
    // Evidence about the room, of the only kind the fast estimate accepts.
    this.starvedFrames = 0;
    if (rms < this.floor) {
      // A pure min-tracker (FLOOR_FALL can never bind, since a frame under the
      // estimate is under `estimate * 1.02` too) and load-bearing: sensitivity
      // has to come back the moment the room goes quiet, or the next pluck is
      // measured against a level the room no longer has.
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
  private observeLevel(x: Float32Array, size: number): void {
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
    // A partly-filled ring says nothing about how still the room is over the
    // whole window, and the window is the measurement.
    if (this.slowCount < ring.length) return;

    const sorted = this.slowSorted;
    sorted.set(ring);
    sorted.sort();
    const n = sorted.length;
    const low = sorted[Math.floor(SLOW_LOW_PCT * n)];
    const high = sorted[Math.min(n - 1, Math.floor(SLOW_HIGH_PCT * n))];
    // Only a room that is holding still may set this gate. While anything is
    // happening the last still measurement stands: the hum did not go anywhere
    // because someone played a note over it, and re-deriving the level from a
    // window a note dominates would simply hand the note its own gate again.
    if (low > 0 && high <= low * SLOW_SPREAD_MAX) this.slowGate = low * SLOW_MARGIN;
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
