import { ensureRunning, getAudioContext } from './context';

/** Ticks per beat: quarter, eighth, triplet, sixteenth. */
export type Subdivision = 1 | 2 | 3 | 4;

const INTERVAL_MS = 25;
const LOOKAHEAD_S = 0.12;
const START_OFFSET_S = 0.06;

const MIN_BPM = 30;
const MAX_BPM = 300;
const MIN_BEATS = 1;
const MAX_BEATS = 12;

const TAP_GAP_MS = 2000;
const TAP_HISTORY = 5;

const ACCENT_HZ = 1800;
const BEAT_HZ = 1200;
const TICK_HZ = 900;
const ACCENT_GAIN = 0.7;
const BEAT_GAIN = 0.5;
const TICK_GAIN = BEAT_GAIN * 0.4;
const CLICK_ATTACK_S = 0.001;
const CLICK_DECAY_S = 0.04;
/** Exponential ramps cannot reach zero, so silence is this floor instead. */
const SILENT = 0.0001;
/** Long enough that muting the bus mid-click fades rather than pops. */
const STOP_FADE_S = 0.005;

function clamp(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return value < lo ? lo : value > hi ? hi : value;
}

export class Metronome {
  /** Clamped to 30-300 when read by the scheduler. */
  bpm = 120;
  /** Clamped to 1-12 when read by the scheduler. */
  beatsPerBar = 4;
  subdivision: Subdivision = 1;
  /** Fired ~when the beat is audible; subdivision ticks do not fire it. */
  onBeat: ((beatInBar: number, isAccent: boolean) => void) | null = null;

  private active = false;
  private timer: number | null = null;
  private nextStepTime = 0;
  private beatInBar = 0;
  private stepInBeat = 0;
  private taps: number[] = [];
  private beatTimers = new Set<number>();
  private master: GainNode | null = null;
  private stalled = false;

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.beatInBar = 0;
    this.stepInBeat = 0;
    void ensureRunning()
      .then((ctx) => {
        if (!this.active || this.timer !== null) return;
        const master = this.bus(ctx);
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(1, ctx.currentTime);
        this.prime(ctx);
        ctx.addEventListener('statechange', this.onStateChange);
        this.timer = window.setInterval(this.pump, INTERVAL_MS);
        this.pump();
      })
      .catch(() => this.stop());
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const id of this.beatTimers) window.clearTimeout(id);
    this.beatTimers.clear();
    // Clicks already handed to the audio clock inside the lookahead window keep
    // their start times and cannot be unscheduled, so silence the bus they all
    // share. Ramping rather than jumping to zero, which pops mid-click.
    if (this.master) {
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      ctx.removeEventListener('statechange', this.onStateChange);
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0, now + STOP_FADE_S);
    }
  }

  tap(): number | null {
    const now = performance.now();
    if (this.taps.length > 0 && now - this.taps[this.taps.length - 1] > TAP_GAP_MS) {
      this.taps.length = 0;
    }
    this.taps.push(now);
    if (this.taps.length > TAP_HISTORY) this.taps.splice(0, this.taps.length - TAP_HISTORY);
    if (this.taps.length < 2) return null;

    let span = 0;
    for (let i = 1; i < this.taps.length; i++) span += this.taps[i] - this.taps[i - 1];
    const average = span / (this.taps.length - 1);
    if (average <= 0) return null;

    const bpm = clamp(Math.round(60000 / average), MIN_BPM, MAX_BPM, this.bpm);
    this.bpm = bpm;
    return bpm;
  }

  /**
   * Lookahead scheduler: hand the audio clock every step that falls inside the
   * next LOOKAHEAD_S, so playback stays sample-accurate even though the timer
   * that drives it is not.
   */
  private pump = (): void => {
    const ctx = getAudioContext();
    // A throttled tab can leave the cursor behind the audio clock. Pulling it
    // back to now keeps the loop from firing a burst of already-late clicks;
    // the loop is otherwise bounded because a step lasts at least 60/300/4 s.
    if (this.nextStepTime < ctx.currentTime) this.nextStepTime = ctx.currentTime;

    const horizon = ctx.currentTime + LOOKAHEAD_S;
    while (this.nextStepTime < horizon) {
      const time = this.nextStepTime;
      if (this.stepInBeat === 0) {
        // The accent has to key off the raw cursor: wrapping it first would turn
        // beat 8 of a bar just shortened to 4 into a false mid-bar downbeat.
        // Only the index handed to the view has to fit inside the new bar.
        const isAccent = this.beatInBar === 0;
        const beats = clamp(Math.round(this.beatsPerBar), MIN_BEATS, MAX_BEATS, 4);
        this.click(ctx, time, isAccent ? ACCENT_HZ : BEAT_HZ, isAccent ? ACCENT_GAIN : BEAT_GAIN);
        this.notify(ctx, time, this.beatInBar % beats, isAccent);
      } else {
        this.click(ctx, time, TICK_HZ, TICK_GAIN);
      }
      this.advance();
    }
  };

  /** Reads bpm/beatsPerBar/subdivision fresh so live edits apply seamlessly. */
  private advance(): void {
    const subdivision = clamp(Math.round(this.subdivision), 1, 4, 1);
    const bpm = clamp(this.bpm, MIN_BPM, MAX_BPM, 120);
    this.nextStepTime += 60 / bpm / subdivision;

    this.stepInBeat += 1;
    if (this.stepInBeat >= subdivision) {
      this.stepInBeat = 0;
      const beats = clamp(Math.round(this.beatsPerBar), MIN_BEATS, MAX_BEATS, 4);
      this.beatInBar = (this.beatInBar + 1) % beats;
    }
  }

  /** One persistent output stage, so stop() has something left to silence. */
  private bus(ctx: AudioContext): GainNode {
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    return this.master;
  }

  /** Open a fresh bar a lead-time ahead of a clock that is running right now. */
  private prime(ctx: AudioContext): void {
    this.stalled = false;
    this.beatInBar = 0;
    this.stepInBeat = 0;
    this.nextStepTime = ctx.currentTime + START_OFFSET_S;
  }

  /**
   * Backgrounding the app parks the context and freezes its clock, so the
   * cursor comes back pointing at a time the audio thread has already passed.
   * Re-prime on the way out rather than leaning on the catch-up clamp in
   * pump(), which would drop the next click in with no lead time at all.
   *
   * Only a stall that this listener actually saw counts: resume() fires its
   * statechange after the promise it returns settles, so the transition that
   * start() itself triggers would otherwise arrive once the first click was
   * already scheduled and flam a second downbeat against it.
   */
  private onStateChange = (): void => {
    const ctx = getAudioContext();
    if (!this.active) return;
    if (ctx.state !== 'running') {
      this.stalled = true;
      return;
    }
    if (this.stalled) this.prime(ctx);
  };

  private notify(ctx: AudioContext, time: number, beatInBar: number, isAccent: boolean): void {
    // `time` is when the click enters the graph; it leaves the speaker a whole
    // output latency later, which on Android over Bluetooth is a real fraction
    // of a beat. Safari exposes no outputLatency, hence the baseLatency fallback.
    const latency = (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
    const delay = Math.max(0, (time - ctx.currentTime) * 1000 + latency);
    const id = window.setTimeout(() => {
      this.beatTimers.delete(id);
      this.onBeat?.(beatInBar, isAccent);
    }, delay);
    this.beatTimers.add(id);
  }

  /** Woody click: a sine blip snapped open in 1 ms and decayed over 40 ms. */
  private click(ctx: AudioContext, time: number, freq: number, gain: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    const edge = ctx.createBiquadFilter();
    edge.type = 'highpass';
    edge.frequency.value = 600;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(SILENT, time);
    amp.gain.exponentialRampToValueAtTime(gain, time + CLICK_ATTACK_S);
    amp.gain.exponentialRampToValueAtTime(SILENT, time + CLICK_ATTACK_S + CLICK_DECAY_S);

    osc.connect(edge).connect(amp).connect(this.bus(ctx));
    osc.addEventListener(
      'ended',
      () => {
        osc.disconnect();
        edge.disconnect();
        amp.disconnect();
      },
      { once: true },
    );
    osc.start(time);
    osc.stop(time + CLICK_ATTACK_S + CLICK_DECAY_S + 0.01);
  }
}
