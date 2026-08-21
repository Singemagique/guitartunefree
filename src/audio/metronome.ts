import { ensureRunning, getAudioContext } from './context';

/** Ticks per beat: quarter, eighth, triplet, sixteenth. */
export type Subdivision = 1 | 2 | 3 | 4;

/** Where the beat grid stands *as heard*, for drawing visuals against it. */
export interface BeatClock {
  /** Main beats since start(), 0-based and monotonic while running. */
  beat: number;
  /** 0-based, already wrapped to the live beatsPerBar. */
  beatInBar: number;
  /** 0..1 progress through the current beat, in audible time. */
  phase: number;
  /** Seconds per main beat at the live bpm. */
  interval: number;
}

/** One scheduled main beat, kept so beatClock() can look backwards. */
interface BeatMark {
  time: number;
  beat: number;
  beatInBar: number;
}

const INTERVAL_MS = 25;
const LOOKAHEAD_S = 0.12;
const START_OFFSET_S = 0.06;
/** A step the grid wants in the past lands this far ahead instead. */
const OVERDUE_LEAD_S = 0.02;
/** Float slack when asking whether a grid position is already behind us. */
const STEP_EPS_S = 1e-4;

const MIN_BPM = 30;
const MAX_BPM = 300;
const MIN_BEATS = 1;
const MAX_BEATS = 12;
/** The shortest legal step (sixteenths at 300 BPM); nothing is ever scheduled
    closer than this to what the audio clock already holds. */
const MIN_GAP_S = 60 / MAX_BPM / 4;

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
/** Long enough that silencing the bus mid-click fades rather than pops. */
const BUS_FADE_S = 0.005;
/** Beats kept for beatClock(); only the newest audible one is ever read. */
const BEAT_LOG = 8;

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
  /** Audio time of the most recent main beat handed to the clock; null until
      the downbeat of a fresh run has been placed. */
  private beatAnchor: number | null = null;
  /** Where the next fresh run opens, set by prime(). */
  private startTime = 0;
  /** Latest time handed to the audio clock (main beat or tick). */
  private lastScheduled = -Infinity;
  private beatInBar = 0;
  private taps: number[] = [];
  private beatTimers = new Set<number>();
  private master: GainNode | null = null;
  private stalled = false;
  private silent = false;
  private beatLog: BeatMark[] = [];
  private beatCount = 0;

  get running(): boolean {
    return this.active;
  }

  /** Silences the click bus without touching the grid: onBeat and beatClock()
      keep running, so the view stays a working silent metronome. */
  get muted(): boolean {
    return this.silent;
  }

  set muted(value: boolean) {
    const next = value === true;
    if (next === this.silent) return;
    this.silent = next;
    if (!this.active || !this.master) return;
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const gain = this.master.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(next ? 0 : 1, now + BUS_FADE_S);
  }

  /**
   * Where the beat grid stands right now *as heard*. Read from the scheduler's
   * own log of handed-off beats rather than a wall clock, and evaluated an
   * output latency behind the graph cursor so a pendulum drawn from it hits its
   * extreme when the click reaches the ear, not when it enters the graph.
   */
  beatClock(): BeatClock | null {
    if (!this.active || this.beatLog.length === 0) return null;
    const ctx = getAudioContext();
    const audible = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);

    let mark: BeatMark | null = null;
    for (let i = this.beatLog.length - 1; i >= 0; i--) {
      if (this.beatLog[i].time <= audible) {
        mark = this.beatLog[i];
        break;
      }
    }
    if (!mark) return null;

    // The live bpm, not the gap to the next logged beat: at slow tempos the
    // following beat is still outside the lookahead window and a tempo edit
    // must bend the swing immediately.
    const interval = 60 / clamp(this.bpm, MIN_BPM, MAX_BPM, 120);
    return {
      beat: mark.beat,
      beatInBar: mark.beatInBar,
      phase: clamp((audible - mark.time) / interval, 0, 0.999, 0),
      interval,
    };
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.beatCount = 0;
    void ensureRunning()
      .then((ctx) => {
        if (!this.active || this.timer !== null) return;
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
      this.master.gain.linearRampToValueAtTime(0, now + BUS_FADE_S);
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
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD_S;
    // Bounded: every pass moves lastScheduled at least MIN_GAP_S towards a
    // horizon only LOOKAHEAD_S away.
    for (;;) {
      const step = this.nextStep(now);
      // A tempo edit can pull the grid back through clicks the audio clock is
      // already holding; never land closer than one minimum step behind them.
      let time = Math.max(step.time, this.lastScheduled + MIN_GAP_S);
      // A throttled tab, or a jump to a much faster tempo, can want a step
      // that is already overdue; drop it in just ahead instead of in the past.
      if (time < now) time = Math.max(now + OVERDUE_LEAD_S, this.lastScheduled + MIN_GAP_S);
      if (time >= horizon) break;
      if (step.main) this.mainBeat(ctx, time);
      else this.click(ctx, time, TICK_HZ, TICK_GAIN);
      this.lastScheduled = time;
    }
  };

  /**
   * The next grid position after what the clock already holds, read against
   * the live bpm/subdivision so edits bend the grid on the very next pump tick
   * instead of waiting out a beat committed at the old tempo. Ticks hang off
   * the current beat's anchor, so changing the subdivision mid-beat re-slices
   * the remainder of that beat and leaves the main beats where they were.
   */
  private nextStep(now: number): { time: number; main: boolean } {
    if (this.beatAnchor === null) return { time: this.startTime, main: true };
    const interval = 60 / clamp(this.bpm, MIN_BPM, MAX_BPM, 120);
    const subdivision = clamp(Math.round(this.subdivision), 1, 4, 1);
    // A tick whose moment has already passed is dropped, not played late; only
    // an overdue main beat is worth landing promptly.
    const behind = Math.max(this.lastScheduled, now) + STEP_EPS_S;
    for (let k = 1; k < subdivision; k++) {
      const time = this.beatAnchor + (k * interval) / subdivision;
      if (time > behind) return { time, main: false };
    }
    return { time: this.beatAnchor + interval, main: true };
  }

  private mainBeat(ctx: AudioContext, time: number): void {
    const beats = clamp(Math.round(this.beatsPerBar), MIN_BEATS, MAX_BEATS, 4);
    // A bar shortened past the cursor starts over, so the counter, the accent
    // and the dot all agree that this is beat one of a new, shorter bar.
    if (this.beatInBar >= beats) this.beatInBar = 0;
    const isAccent = this.beatInBar === 0;
    this.click(ctx, time, isAccent ? ACCENT_HZ : BEAT_HZ, isAccent ? ACCENT_GAIN : BEAT_GAIN);
    this.log(time, this.beatInBar);
    this.notify(ctx, time, this.beatInBar, isAccent);
    this.beatAnchor = time;
    this.beatInBar = (this.beatInBar + 1) % beats;
  }

  /** One persistent output stage, so stop() has something left to silence. */
  private bus(ctx: AudioContext): GainNode {
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    return this.master;
  }

  /**
   * Open a fresh bar a lead-time ahead of a clock that is running right now.
   * Used by start() and again after a background stall, so it has to assume
   * the clock may still hold clicks and beat timers from before: the timers
   * are dropped, the clicks stay behind a closed bus that only opens on the new
   * downbeat. The beat count carries on so a pendulum keeps its swing direction.
   */
  private prime(ctx: AudioContext): void {
    this.stalled = false;
    const now = ctx.currentTime;
    // lastScheduled survives stop() and a stall on purpose: whatever the clock
    // still holds from before must finish before the fresh downbeat can open.
    this.startTime = Math.max(now + START_OFFSET_S, this.lastScheduled + MIN_GAP_S);
    this.beatAnchor = null;
    this.beatInBar = 0;
    for (const id of this.beatTimers) window.clearTimeout(id);
    this.beatTimers.clear();
    // Beats logged before a stall sit at times the audio clock has since jumped
    // past; keeping them would leave beatClock() pointing at a stale mark.
    this.beatLog.length = 0;

    const gain = this.bus(ctx).gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + BUS_FADE_S);
    gain.setValueAtTime(this.silent ? 0 : 1, this.startTime);
  }

  /** Remember a handed-off main beat so beatClock() can interpolate from it. */
  private log(time: number, beatInBar: number): void {
    this.beatLog.push({ time, beat: this.beatCount, beatInBar });
    this.beatCount += 1;
    if (this.beatLog.length > BEAT_LOG) this.beatLog.splice(0, this.beatLog.length - BEAT_LOG);
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
