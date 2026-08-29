/**
 * Strum capture: a recorder that taps the SHARED filtered mic chain, waits for
 * a strum, and hands back the couple of seconds around it. Nothing here
 * analyses anything — that is strum.ts, and it runs in a Worker (see
 * `StrumAnalyzer` at the bottom) so the view never blocks.
 *
 * The tap is an AudioWorklet whose module is an inline Blob URL: zero build
 * config, zero extra files to cache, nothing for the service worker to miss.
 * Where AudioWorklet is unavailable (or its module is refused) the tap falls
 * back to a ScriptProcessorNode, which is deprecated but universally present;
 * either way the node only reads, and the mic graph is not modified.
 */

import { MicCapture } from './mic';
import { pickN, type StrumResult } from './strum';

/* --------------------------------------------------------------- constants */

/** Audio ahead of the attack, so the analyser's own onset search has runway. */
const PRE_ROLL_S = 0.1;
/** Post-onset audio for a 16384-point analysis (0.035 + 1.21 + 0.341 + slack). */
const WINDOW_SHORT_S = 2.1;
/** ...and for 32768, which every target below ~82 Hz at 48 kHz asks for. */
const WINDOW_LONG_S = 2.4;
/** Slack in the ring on top of pre-roll + the longest window. */
const RING_SLACK_S = 0.6;

/** Hop the level detector works on — 5 ms, matching the analyser's own. */
const HOP_S = 0.005;
/**
 * The detector listens through a one-pole highpass; the ring buffer does not.
 *
 * A chord that is still ringing is nearly all fundamental — the partials that
 * carry a pluck's attack are the first to die — so measuring the jump over the
 * WHOLE band asks a new strum to be 12 dB louder than the previous one's
 * lowest, longest-lived partials, which a strum three seconds later is not.
 * Tilting the detector's band up costs two multiplies a sample and buys that
 * contrast back; it also takes the room's rumble out of the reference.
 *
 * Swept against the whole capture suite (corner x floor, 22 scenarios): below
 * 700 Hz a 2.5-3 s re-strum is missed; above it a quiet BASS strum is, because
 * a fingerstyle bass has little energy up there. 700 Hz is the only corner that
 * takes all of them.
 */
const EMPHASIS_HZ = 700;
/** Hops in the short-term RMS window (20 ms). */
const SHORT_HOPS = 4;
/** The jump over the running background that counts as an attack. */
const JUMP_DB = 12;
/**
 * Absolute floor, in the emphasised domain. Twelve dB over a silent room is
 * still a silent room, and a strum that quiet has no partials for the analyser
 * to find anyway. Measured: 0.0025 also refuses a quiet bass strum, whose
 * energy above 700 Hz is small; the jump test, not this, is what keeps the room
 * out.
 */
const ABS_FLOOR_RMS = 0.0012;
/** Background tracker: quick to follow a level down, slow to follow it up, so a
    ringing chord becomes "background" over a few hundred ms rather than at once. */
const BG_FALL = 0.15;
const BG_RISE = 0.03;
/** A strum still rings at a quarter of its attack level a quarter-second later;
    a metronome click, a door, a pick tick do not. */
const ATTACK_S = 0.06;
const SUSTAIN_FROM_S = 0.12;
const SUSTAIN_TO_S = 0.26;
const SUSTAIN_RATIO = 0.3;
const SUSTAIN_OVER_BG_DB = 8;
/**
 * ...but a MEAN over that window is not the same claim as "still ringing", and
 * the app's own metronome is the counter-example: a subdivided click train puts
 * the next click, and often two, inside 0.12-0.26 s, so a train that is ~80 %
 * silence averages above both ratios and reads as a ringing chord. Measured
 * through the real chain, eighths from 160 bpm, triplets from 90 and sixteenths
 * from 100 delivered a capture every ~3 s — wiping a correct board, inventing
 * cent figures, and twice refusing an in-tune guitar for a capo it does not
 * have. Plain quarters were always rejected; the subdivisions never were.
 *
 * So the window has to be CONTINUOUSLY above the room, not above it on average:
 * the same claim as SUSTAIN_OVER_BG_DB, made about the quietest hop instead of
 * the mean. A gap between clicks falls back to the room by construction, and a
 * ringing chord never does. Measured over bleed levels 0.02-0.30 x three room
 * floors x 26 tempo/subdivision combinations:
 *
 *   quietest confirm hop, over the background at onset
 *     click train   0.30 - 0.90   (-10.6 to -0.9 dB)
 *     real strum    3.56 - 60+    (+11.0 dB and up)
 *
 * Measuring this against the background rather than against the attack peak is
 * deliberate: a strum that begins inside a click's own confirm window is judged
 * against the CLICK's peak, and at 120 bpm that is half of all strums.
 */
const SUSTAIN_MIN_OVER_BG_DB = 6;
/** Quiet after a delivered strum. */
const REARM_S = 0.35;
/**
 * ...and after a rejected transient, which is a much shorter thing: the confirm
 * test has already spent 0.26 s deciding, so the click that failed it died 0.2 s
 * ago and needs no further guarding. What DOES need the room back quickly is a
 * strum that begins near the END of a click's confirm window — a fifth of a
 * second of deafness swallowed its onset whole, and at 120 bpm that was one
 * strum in six. Measured: at 0.05 s every strum in a 42-case phase sweep over a
 * running metronome is captured, and 390 bleed-only scenarios still capture
 * nothing.
 */
const REJECT_REARM_S = 0.05;
/**
 * The graph settles for half a second after the highpass moves (see
 * MicCapture.settleMs) and the analyser's first frames are part silence. Both
 * look like an attack, so the detector spends this long only listening.
 */
const WARMUP_S = 0.6;

const dbToRatio = (db: number): number => Math.pow(10, db / 20);

/* ------------------------------------------------------------- the recorder */

export interface StrumRecorderOptions {
  /** Post-onset seconds to deliver. Defaults to the long window. */
  windowSeconds?: number;
  preRollSeconds?: number;
  warmupSeconds?: number;
  /** Detector-only highpass corner; 0 disables it. Swept by the harness. */
  emphasisHz?: number;
  /** Absolute level floor, in the emphasised domain. Swept by the harness. */
  absFloorRms?: number;
  /** How far the QUIETEST confirm hop must clear the background, in dB. */
  sustainMinOverBgDb?: number;
}

/**
 * Ring buffer + onset detector, with no Web Audio in sight so it can be driven
 * from a test harness sample-for-sample.
 */
export class StrumRecorder {
  onStrum: ((samples: Float32Array, sampleRate: number) => void) | null = null;
  /**
   * Fires the moment an attack is confirmed to be a strum — a whole capture
   * window (2.1-2.4 s) before `onStrum`, because the window has to be recorded
   * before it can be handed over. Nothing else in here knows the strum has
   * happened that early, and a view with no way to say so leaves the player
   * looking at a screen that has not moved since they hit the strings.
   */
  onOnset: (() => void) | null = null;

  readonly sampleRate: number;
  private readonly hop: number;
  private readonly preRoll: number;
  private readonly warmup: number;
  private window: number;

  private readonly ring: Float32Array;
  /** Total samples ever pushed; the ring holds the last `ring.length` of them. */
  private written = 0;

  /** Detector-only emphasis: y[n] = x[n] - x[n-1] + a*y[n-1]. */
  private readonly emphA: number;
  private readonly absFloor: number;
  private readonly sustainMinOverBg: number;
  private emphX = 0;
  private emphY = 0;

  /** Partial hop accumulator. */
  private hopSum = 0;
  private hopCount = 0;
  /** Trailing SHORT_HOPS mean-squares. */
  private readonly shortMs: Float64Array;
  private shortAt = 0;
  private shortFilled = 0;

  private bg = 0;
  private state: 'listening' | 'confirming' | 'capturing' = 'listening';
  private quietUntil = 0;
  private onsetSample = 0;
  private attackPeak = 0;
  private sustainSum = 0;
  private sustainHops = 0;
  /** Quietest hop of the confirm window — the continuity test's whole input. */
  private sustainMin = Infinity;
  private bgAtOnset = 0;
  /** The window length this capture started with, so a retarget mid-strum
      cannot change the length of a delivery already under way. */
  private captureWindow = 0;

  /** Absolute index of the first sample of the last delivered window. */
  lastWindowStart = -1;
  /** Attacks seen and rejected by the sustain test, for diagnostics. */
  rejected = 0;

  constructor(sampleRate: number, opts: StrumRecorderOptions = {}) {
    this.sampleRate = sampleRate;
    this.hop = Math.max(1, Math.round(HOP_S * sampleRate));
    this.preRoll = Math.round((opts.preRollSeconds ?? PRE_ROLL_S) * sampleRate);
    this.warmup = Math.round((opts.warmupSeconds ?? WARMUP_S) * sampleRate);
    this.window = Math.round((opts.windowSeconds ?? WINDOW_LONG_S) * sampleRate);
    const emph = opts.emphasisHz ?? EMPHASIS_HZ;
    this.emphA = emph > 0 ? Math.exp((-2 * Math.PI * emph) / sampleRate) : 0;
    this.absFloor = opts.absFloorRms ?? ABS_FLOOR_RMS;
    this.sustainMinOverBg = dbToRatio(opts.sustainMinOverBgDb ?? SUSTAIN_MIN_OVER_BG_DB);
    this.shortMs = new Float64Array(SHORT_HOPS);
    const cap = this.preRoll + Math.round((WINDOW_LONG_S + RING_SLACK_S) * sampleRate);
    this.ring = new Float32Array(Math.max(cap, this.preRoll + this.window + this.hop * 8));
  }

  /** Post-onset seconds to deliver from the NEXT strum on. */
  setWindowSeconds(seconds: number): void {
    this.window = Math.round(
      Math.min(WINDOW_LONG_S, Math.max(0.5, seconds)) * this.sampleRate,
    );
  }

  get windowSeconds(): number {
    return this.window / this.sampleRate;
  }

  /** Forget the level history — after a mic restart the room may be different. */
  reset(): void {
    this.written = 0;
    this.emphX = 0;
    this.emphY = 0;
    this.hopSum = 0;
    this.hopCount = 0;
    this.shortMs.fill(0);
    this.shortAt = 0;
    this.shortFilled = 0;
    this.bg = 0;
    this.state = 'listening';
    this.quietUntil = 0;
    this.lastWindowStart = -1;
    this.rejected = 0;
  }

  /** Feed one block of the filtered mic signal, in order. */
  push(block: Float32Array): void {
    const ring = this.ring;
    const cap = ring.length;
    for (let i = 0; i < block.length; i++) {
      const v = block[i];
      ring[(this.written + i) % cap] = v;
      // The ring keeps the mic's own samples; only the level detector hears the
      // tilted version.
      const e = this.emphA > 0 ? v - this.emphX + this.emphA * this.emphY : v;
      this.emphX = v;
      this.emphY = e;
      this.hopSum += e * e;
      if (++this.hopCount === this.hop) {
        // The hop that just closed ends at this absolute sample index.
        this.step(this.written + i + 1, this.hopSum / this.hop);
        this.hopSum = 0;
        this.hopCount = 0;
      }
    }
    this.written += block.length;
  }

  /** One closed hop: `end` is its exclusive end index, `ms` its mean square. */
  private step(end: number, ms: number): void {
    this.shortMs[this.shortAt] = ms;
    this.shortAt = (this.shortAt + 1) % SHORT_HOPS;
    if (this.shortFilled < SHORT_HOPS) this.shortFilled++;
    let sum = 0;
    for (let i = 0; i < this.shortFilled; i++) sum += this.shortMs[i];
    const level = Math.sqrt(sum / this.shortFilled);

    if (end < this.warmup) {
      // Listen only: seed the background from the room as it actually is.
      this.bg = this.bg === 0 ? level : this.bg + (level - this.bg) * 0.25;
      return;
    }

    if (this.state === 'listening') {
      this.bg += (level - this.bg) * (level > this.bg ? BG_RISE : BG_FALL);
      if (
        end >= this.quietUntil &&
        this.shortFilled === SHORT_HOPS &&
        level >= this.absFloor &&
        level >= this.bg * dbToRatio(JUMP_DB)
      ) {
        // The short window is trailing, so the attack began at its start.
        this.onsetSample = Math.max(0, end - SHORT_HOPS * this.hop);
        this.state = 'confirming';
        this.attackPeak = level;
        this.sustainSum = 0;
        this.sustainHops = 0;
        this.sustainMin = Infinity;
        this.bgAtOnset = this.bg;
        this.captureWindow = this.window;
      }
      return;
    }

    // confirming / capturing: the background is frozen — a ringing chord is
    // signal, not room, and letting it climb in here would arm the next strum
    // against the wrong reference.
    const since = end - this.onsetSample;
    const fs = this.sampleRate;
    if (since <= ATTACK_S * fs) this.attackPeak = Math.max(this.attackPeak, level);
    if (since > SUSTAIN_FROM_S * fs && since <= SUSTAIN_TO_S * fs) {
      this.sustainSum += level;
      this.sustainHops++;
      if (level < this.sustainMin) this.sustainMin = level;
    }
    if (this.state === 'confirming' && since > SUSTAIN_TO_S * fs) {
      const hops = this.sustainHops;
      const sustain = hops ? this.sustainSum / hops : 0;
      // A ringing chord never goes quiet inside its own confirm window; a click
      // train spends most of that window in silence, whatever its mean says.
      const quietest = hops ? this.sustainMin : 0;
      const rings =
        sustain >= SUSTAIN_RATIO * this.attackPeak &&
        sustain >= this.bgAtOnset * dbToRatio(SUSTAIN_OVER_BG_DB) &&
        quietest >= this.bgAtOnset * this.sustainMinOverBg;
      if (!rings) {
        this.rejected++;
        // A click, a tick, a chair: loud, over in a moment, not a strum. Re-arm
        // against the transient, and go deaf for a moment so its own tail
        // cannot arm the next one.
        //
        // Unless something is STILL sounding as the window closes, which the
        // transient just rejected is not: a strum that began inside a metronome
        // click's confirm window reads exactly like this, because it is the
        // CLICK's onset that armed the test and the silence in front of the
        // strum that failed it. Then the room, not the transient, is the right
        // reference, and there is no reason to be deaf while a chord rings.
        const sounding =
          level >= this.absFloor && level >= this.bgAtOnset * dbToRatio(JUMP_DB);
        this.state = 'listening';
        this.bg = sounding ? this.bgAtOnset : Math.max(this.bgAtOnset, level * 0.5);
        this.quietUntil = sounding ? end : end + REJECT_REARM_S * fs;
        return;
      }
      this.state = 'capturing';
      this.onOnset?.();
    }
    if (this.state === 'capturing' && since >= this.captureWindow) {
      this.deliver();
      this.state = 'listening';
      // Re-arm against the chord that is still ringing, not against the quiet
      // room it started from, so the tail cannot trigger the next capture.
      this.bg = Math.max(level, this.bgAtOnset);
      this.quietUntil = end + REARM_S * fs;
    }
  }

  private deliver(): void {
    const start = Math.max(0, this.onsetSample - this.preRoll);
    const length = this.onsetSample + this.captureWindow - start;
    const out = new Float32Array(length);
    const cap = this.ring.length;
    for (let i = 0; i < length; i++) out[i] = this.ring[(start + i) % cap];
    this.lastWindowStart = start;
    this.onStrum?.(out, this.sampleRate);
  }
}

/* ----------------------------------------------------------------- the tap */

/**
 * The worklet is a dumb pipe: it copies its input into ~21 ms blocks and
 * transfers them out. Onset detection stays on the main thread (in
 * StrumRecorder above) where one implementation serves both the app and the
 * test harness, and where it costs a few thousand multiply-adds a second.
 */
const TAP_PROCESSOR = 'truestring-strum-tap';
const TAP_SOURCE = `
class StrumTap extends AudioWorkletProcessor {
  constructor() { super(); this.size = 1024; this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input.length ? input[0] : null;
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(TAP_PROCESSOR)}, StrumTap);
`;

/** A processor name may only be registered once per context. */
const registered = new WeakMap<BaseAudioContext, Promise<void>>();

function registerTap(ctx: BaseAudioContext): Promise<void> {
  const existing = registered.get(ctx);
  if (existing) return existing;
  const worklet = (ctx as AudioContext).audioWorklet;
  if (!worklet) return Promise.reject(new Error('no-audioworklet'));
  const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'text/javascript' }));
  const done = worklet
    .addModule(url)
    .finally(() => URL.revokeObjectURL(url))
    .catch((err: unknown) => {
      registered.delete(ctx);
      throw err;
    });
  registered.set(ctx, done);
  return done;
}

/* -------------------------------------------------------------- the capture */

export interface StrumCaptureOptions {
  /** The mic to tap. Omitted, StrumCapture opens (and owns) its own. */
  mic?: MicCapture;
  /** Targets in Hz — only their lowest member matters, for the window length. */
  targetFreqs?: readonly number[];
  /** Force the long window instead of deriving it from `targetFreqs`. */
  needsLong?: boolean;
  /** Post-onset seconds, overriding both of the above. */
  windowSeconds?: number;
}

/**
 * Post-onset seconds needed for the analyser's nine frames: the last frame
 * starts 1.245 s after the onset and is N samples long. Keying off pickN keeps
 * this exact at every sample rate rather than guessing from a pitch threshold.
 */
export function windowSecondsFor(targets: readonly number[], sampleRate: number): number {
  if (!targets.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return WINDOW_LONG_S;
  return pickN(targets, sampleRate) > 16384 ? WINDOW_LONG_S : WINDOW_SHORT_S;
}

export class StrumCapture {
  /**
   * Fires once per detected strum with onset-100 ms through onset+window. The
   * buffer is freshly allocated and yours to transfer.
   */
  onStrum: ((samples: Float32Array, sampleRate: number) => void) | null = null;
  /**
   * Fires ~0.26 s after the strings are hit — the instant the onset is
   * confirmed, and a whole capture window before `onStrum`. The view uses it to
   * acknowledge the strum while the window is still being recorded.
   */
  onOnset: (() => void) | null = null;

  private mic: MicCapture | null = null;
  private ownsMic = false;
  private prevGraphHook: (() => void) | null = null;
  private hooked = false;
  private recorder: StrumRecorder | null = null;
  private node: AudioNode | null = null;
  private sink: GainNode | null = null;
  private tapped: AudioNode | null = null;
  private running = false;
  private windowOverride: number | null = null;

  constructor(mic?: MicCapture) {
    if (mic) this.mic = mic;
  }

  get listening(): boolean {
    return this.running && this.node !== null;
  }

  /**
   * Open (or join) the mic and start listening for a strum. Permission flows
   * exactly as the monophonic tuner's does — this is MicCapture's own start().
   */
  async start(options: StrumCaptureOptions = {}): Promise<void> {
    if (options.mic && options.mic !== this.mic) {
      this.releaseMic();
      this.mic = options.mic;
      this.ownsMic = false;
    }
    if (!this.mic) {
      this.mic = new MicCapture();
      this.ownsMic = true;
    }
    const mic = this.mic;
    this.running = true;
    this.applyWindow(options);

    if (!mic.running) await mic.start();
    if (!this.running) return; // stopped while the permission dialog was up

    if (!this.hooked) {
      // Chain rather than replace, and never wrap our own handler — a second
      // start() would otherwise call it from itself, for ever.
      this.prevGraphHook = mic.onGraphChange;
      mic.onGraphChange = this.handleGraphChange;
      this.hooked = true;
    }
    await this.attach();
  }

  stop(): void {
    this.running = false;
    this.detach();
    this.releaseMic();
    this.recorder = null;
  }

  /** Retarget the window between strums (a capo change, a new tuning). */
  setTargets(targetFreqs: readonly number[]): void {
    const rate = this.recorder?.sampleRate ?? this.mic?.sampleRate ?? 48000;
    this.windowOverride = windowSecondsFor(targetFreqs, rate);
    this.recorder?.setWindowSeconds(this.windowOverride);
  }

  private applyWindow(options: StrumCaptureOptions): void {
    const rate = this.recorder?.sampleRate ?? this.mic?.sampleRate ?? 48000;
    if (options.windowSeconds != null) this.windowOverride = options.windowSeconds;
    else if (options.needsLong != null) {
      this.windowOverride = options.needsLong ? WINDOW_LONG_S : WINDOW_SHORT_S;
    } else if (options.targetFreqs) {
      this.windowOverride = windowSecondsFor(options.targetFreqs, rate);
    }
    if (this.windowOverride != null) this.recorder?.setWindowSeconds(this.windowOverride);
  }

  private readonly handleGraphChange = (): void => {
    this.prevGraphHook?.();
    if (!this.running) return;
    this.detachNodes();
    void this.attach();
  };

  private async attach(): Promise<void> {
    const mic = this.mic;
    const source = mic?.filteredOutput ?? null;
    if (!mic || !source || this.node) return;

    const ctx = source.context;
    const rate = ctx.sampleRate;
    if (!this.recorder || this.recorder.sampleRate !== rate) {
      this.recorder = new StrumRecorder(rate, {
        windowSeconds: this.windowOverride ?? WINDOW_LONG_S,
      });
    } else this.recorder.reset();
    this.recorder.onStrum = (samples, sampleRate) => this.onStrum?.(samples, sampleRate);
    this.recorder.onOnset = () => this.onOnset?.();

    // A node with nothing downstream is not guaranteed to be pulled, so the tap
    // ends in a muted gain. Nothing reaches the speakers: the gain is zero and
    // the worklet writes no output at all.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    let node: AudioNode;
    try {
      await registerTap(ctx);
      if (!this.running || this.node) {
        sink.disconnect();
        return;
      }
      const worklet = new AudioWorkletNode(ctx, TAP_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      worklet.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        this.recorder?.push(new Float32Array(ev.data));
      };
      node = worklet;
    } catch {
      // No AudioWorklet, or a policy that refuses blob modules: fall back to the
      // deprecated-but-everywhere ScriptProcessor. It only reads.
      if (!this.running || this.node) {
        sink.disconnect();
        return;
      }
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (ev: AudioProcessingEvent): void => {
        this.recorder?.push(ev.inputBuffer.getChannelData(0));
      };
      node = sp;
    }

    source.connect(node);
    node.connect(sink);
    this.tapped = source;
    this.node = node;
    this.sink = sink;
  }

  private detachNodes(): void {
    const node = this.node;
    if (node) {
      try {
        this.tapped?.disconnect(node);
      } catch {
        /* the chain may already be gone */
      }
      node.disconnect();
      if (typeof AudioWorkletNode !== 'undefined' && node instanceof AudioWorkletNode) {
        node.port.onmessage = null;
      } else (node as ScriptProcessorNode).onaudioprocess = null;
    }
    this.sink?.disconnect();
    this.node = null;
    this.sink = null;
    this.tapped = null;
  }

  private detach(): void {
    this.detachNodes();
    if (this.recorder) {
      this.recorder.onStrum = null;
      this.recorder.onOnset = null;
    }
  }

  private releaseMic(): void {
    const mic = this.mic;
    if (!mic) return;
    if (mic.onGraphChange === this.handleGraphChange) mic.onGraphChange = this.prevGraphHook;
    this.prevGraphHook = null;
    this.hooked = false;
    if (this.ownsMic) mic.stop();
    this.ownsMic = false;
    this.mic = null;
  }
}

/* ------------------------------------------------------- analysis, off-thread */

interface WorkerReply {
  id: number;
  result: StrumResult;
  samples: ArrayBuffer;
}

/**
 * Runs analyzeStrum in a module Worker. The samples are transferred in and the
 * (now detached) buffer is transferred back with the result, so a 460 kB window
 * crosses the boundary twice without a single copy.
 *
 * If the Worker cannot be constructed the analysis falls back to a dynamic
 * import on this thread: slower and it does block, but a working reading beats
 * a broken mode.
 */
export class StrumAnalyzer {
  private worker: Worker | null = null;
  private broken = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: StrumResult) => void; strings: number }>();

  analyze(
    samples: Float32Array,
    sampleRate: number,
    targetFreqs: readonly number[],
  ): Promise<StrumResult> {
    const worker = this.ensure();
    if (!worker) {
      return import('./strum').then((m) => m.analyzeStrum(samples, sampleRate, targetFreqs));
    }
    const id = this.nextId++;
    return new Promise<StrumResult>((resolve) => {
      this.pending.set(id, { resolve, strings: targetFreqs.length });
      // Transferring a view's whole buffer would hand over more than the view;
      // the recorder always allocates exactly, but a caller might not.
      const exact =
        samples.byteOffset === 0 && samples.buffer.byteLength === samples.byteLength
          ? samples
          : new Float32Array(samples);
      const buffer = exact.buffer as ArrayBuffer;
      worker.postMessage(
        { id, samples: buffer, sampleRate, targets: Array.from(targetFreqs) },
        [buffer],
      );
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.failAll();
  }

  private ensure(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const worker = new Worker(new URL('./strum-worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (ev: MessageEvent<WorkerReply>): void => {
        const done = this.pending.get(ev.data.id);
        if (!done) return;
        this.pending.delete(ev.data.id);
        done.resolve(ev.data.result);
      };
      worker.onerror = (): void => {
        // The samples were transferred away, so there is nothing left to retry
        // with: settle the waiters as "nothing confirmed" — the board's own
        // no-reading state — and send the next analysis down the inline path.
        this.broken = true;
        this.worker = null;
        worker.terminate();
        this.failAll();
      };
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }

  private failAll(): void {
    for (const { resolve, strings } of this.pending.values()) {
      resolve({
        strings: Array.from({ length: strings }, () => ({
          cents: null,
          confidence: 0,
          detected: false,
        })),
        refusal: null,
        globalOffsetCents: null,
        analysisMs: 0,
      });
    }
    this.pending.clear();
  }
}

let shared: StrumAnalyzer | null = null;

/** The one analyser the view needs; the Worker starts on first use. */
export function analyzeStrumAsync(
  samples: Float32Array,
  sampleRate: number,
  targetFreqs: readonly number[],
): Promise<StrumResult> {
  shared ??= new StrumAnalyzer();
  return shared.analyze(samples, sampleRate, targetFreqs);
}
