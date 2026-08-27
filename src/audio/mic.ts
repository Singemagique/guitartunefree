import { ensureRunning, getAudioContext } from './context';

const DENIED = ['NotAllowedError', 'NotFoundError', 'SecurityError'];

/** Lowest pitch the detector accepts, mirroring MIN_FREQ in pitch.ts. */
const FLOOR_HZ = 28;
/** The smallest frame worth handing the detector. */
const MIN_FRAME = 2048;
/** AnalyserNode refuses an fftSize above this. */
const MAX_FRAME = 32768;

/* Analysis band. Below the lowest string there is nothing but room — traffic,
   HVAC, mains hum, footsteps — and above ~2 kHz nothing the period detector
   uses, since the highest pitch it accepts is 1100 Hz and its harmonics only
   sharpen a period the lower ones already fix. Trimming both ends before the
   analyser is free (two biquads) and takes several dB of noise out of the RMS
   the detector's gate sees. */
const HIGHPASS_DEFAULT = 20;
const HIGHPASS_MIN = 20;
const HIGHPASS_MAX = 90;
const LOWPASS_HZ = 2000;
/** Butterworth: the flattest passband, no resonant bump at the corner. */
const FILTER_Q = 0.707;
/**
 * A biquad whose cutoff is moving applies a phase shift that is also moving, and
 * a phase shift that moves IS a frequency offset — dφ/dt, spread over whatever
 * the analyser is looking at. At 50 ms the whole shift landed inside a single
 * 85 ms analysis frame: measured through Chrome's own scheme (coefficients
 * recomputed per 128-sample render quantum) a ringing low E read up to 40 cents
 * sharp for three to five consecutive frames, at clarity 0.99, which sails past
 * the clarity bar and straight onto the needle.
 *
 * Half a second is six analysis frames, so the residual offset per frame is a
 * few cents rather than tens. Nothing hears this ramp — the chain feeds the
 * analyser, never the speakers — so its only job is to be gentle on the
 * detector, and callers hold detection off across it anyway (see settleMs).
 */
const RAMP_S = 0.5;

/**
 * The analyser's stream is decimated to at most this rate before the detector
 * sees it. The lowpass above has already band-limited the signal to 2 kHz, so
 * folding starts 43 dB down and there is nothing up there to fold; what it saves
 * is real, because the NSDF costs frame × lag and both scale with the rate. On a
 * 96 kHz interface that is 22.2 M multiply-accumulates per call, 17 ms on a
 * desktop — more than a display frame, every frame — against 5.6 M and 4 ms once
 * decimated, with identical resolution in time and therefore in cents.
 */
const MAX_ANALYSIS_RATE = 48000;

/**
 * The detector needs a lag of one FLOOR_HZ period and never looks past half the
 * frame, so the frame has to span two of them. A fixed size cannot: 2048 tops
 * out at 43 Hz even at 44.1 kHz — no bass at all — and bottoms out at 93.75 Hz
 * on a 96 kHz interface, hiding the lowest string of every tuning. Deriving the
 * size from the live rate keeps the floor at FLOOR_HZ whatever the hardware
 * runs, and lands on 4096 (~90 ms) at both 44.1 and 48 kHz.
 */
function frameSize(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return MIN_FRAME;
  const needed = 2 * (Math.ceil(sampleRate / FLOOR_HZ) + 2);
  if (needed >= MAX_FRAME) return MAX_FRAME;
  return Math.max(MIN_FRAME, 1 << Math.ceil(Math.log2(needed)));
}

/** Smallest power of two that brings the rate down to MAX_ANALYSIS_RATE: 1 at
    44.1 and 48 kHz, 2 at 88.2 and 96 kHz, 4 at 192 kHz. A power of two keeps the
    decimated frame a power of two, which the analyser's size already is. */
function decimation(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= MAX_ANALYSIS_RATE) return 1;
  return 1 << Math.ceil(Math.log2(sampleRate / MAX_ANALYSIS_RATE));
}

/**
 * The band the highpass can actually be put at. Exported because the caller that
 * chooses the cutoff also has to reason about what the filter is passing, and
 * asking for 222 Hz on a ukulele while the filter sits at its 90 Hz ceiling is
 * how the view came to discard a band the filter was passing at full level.
 */
export function clampAnalysisFloor(hz: number): number {
  return Number.isFinite(hz)
    ? Math.min(HIGHPASS_MAX, Math.max(HIGHPASS_MIN, hz))
    : HIGHPASS_DEFAULT;
}

export class MicCapture {
  /** Frame the analyser is asked for, in samples of the hardware's own rate. */
  readonly bufferSize: number = frameSize(getAudioContext().sampleRate);
  private readonly step: number = decimation(getAudioContext().sampleRate);
  /** …and the frame and rate the detector should be built for. */
  readonly analysisSize: number = this.bufferSize / this.step;
  readonly analysisRate: number = getAudioContext().sampleRate / this.step;

  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private floorHz = HIGHPASS_DEFAULT;
  private readonly frame = new Float32Array(this.bufferSize);

  get running(): boolean {
    return this.analyser !== null;
  }

  get sampleRate(): number {
    return getAudioContext().sampleRate;
  }

  /**
   * One analysis frame, in milliseconds. For this long after the graph is built
   * the analyser is still handing back part of the silence it was created with,
   * and the step from that silence into the signal is a transient the detector
   * will happily find a pitch in — ten cents off, at full confidence.
   */
  get frameMs(): number {
    return (this.bufferSize / getAudioContext().sampleRate) * 1000;
  }

  /**
   * How long after a live cutoff change nothing the analyser returns can be
   * trusted: the ramp, plus one whole frame, because the window still holds
   * audio filtered through a moving cutoff for that much longer. Callers hold
   * detection off for this long rather than showing a reading the ramp bent.
   */
  get settleMs(): number {
    return RAMP_S * 1000 + this.frameMs;
  }

  /**
   * Move the bottom of the analysis band, clamped to 20-90 Hz, and return the
   * cutoff that was actually applied. Callers pass a little under the lowest
   * string of the selected tuning: a guitar's low E puts it at ~70 Hz, which is
   * above every mains hum in the world, while a 5-string bass's low B pins it at
   * the 20 Hz floor and a ukulele's C would ask for 222 Hz and get the 90 Hz
   * ceiling. Returning the applied value is what lets the caller keep its own
   * reasoning about the band in step with the filter. Safe before or during
   * capture — the frame size is keyed to the global 28 Hz floor, so changing
   * this never costs a mic restart.
   */
  setAnalysisFloor(hz: number): number {
    const clamped = clampAnalysisFloor(hz);
    if (clamped === this.floorHz) return clamped;
    this.floorHz = clamped;
    const hp = this.highpass;
    if (!hp) return clamped; // applied when the graph is built
    // Stepping the cutoff mid-capture rings the filter and the detector reads
    // the click as a transient, so walk it across instead.
    const now = getAudioContext().currentTime;
    hp.frequency.cancelScheduledValues(now);
    hp.frequency.setValueAtTime(hp.frequency.value, now);
    hp.frequency.linearRampToValueAtTime(clamped, now + RAMP_S);
    return clamped;
  }

  async start(): Promise<void> {
    if (this.analyser) return;
    if (!this.pending) {
      const attempt = this.open(++this.generation).finally(() => {
        if (this.pending === attempt) this.pending = null;
      });
      this.pending = attempt;
    }
    await this.pending;
  }

  stop(): void {
    // Invalidate any start() still waiting on getUserMedia so it tears down
    // instead of wiring up a stream nobody asked for any more.
    this.generation++;
    this.pending = null;
    this.source?.disconnect();
    this.source = null;
    this.highpass?.disconnect();
    this.highpass = null;
    this.lowpass?.disconnect();
    this.lowpass = null;
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }

  read(target: Float32Array): void {
    if (!this.analyser) {
      target.fill(0);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.frame);
    const step = this.step;
    if (step === 1) {
      const n = Math.min(target.length, this.frame.length);
      target.set(this.frame.subarray(0, n));
      return;
    }
    // Take every step'th sample. The frame is oldest-first and spans the same
    // stretch of time either way, so the detector sees the same note through a
    // window of the same duration — just at a rate its lag search can afford.
    const n = Math.min(target.length, this.analysisSize);
    for (let i = 0, j = 0; i < n; i++, j += step) target[i] = this.frame[j];
  }

  private async open(generation: number): Promise<void> {
    const media: MediaDevices | undefined = navigator.mediaDevices;
    if (!media) throw new Error('mic-denied');

    const ctx = await ensureRunning();

    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (err) {
      const name = (err as DOMException | null)?.name ?? '';
      if (DENIED.includes(name)) throw new Error('mic-denied');
      throw err;
    }

    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.bufferSize;
    analyser.smoothingTimeConstant = 0;

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = this.floorHz;
    highpass.Q.value = FILTER_Q;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = LOWPASS_HZ;
    lowpass.Q.value = FILTER_Q;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(analyser);

    this.stream = stream;
    this.source = source;
    this.highpass = highpass;
    this.lowpass = lowpass;
    this.analyser = analyser;
  }
}
