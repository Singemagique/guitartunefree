/**
 * Native strum capture — SPEC v2.1, "Native capture plugin (the real fix)".
 *
 * In the APK the strum mode does not listen through `getUserMedia`. Android's
 * WebView asks the OS for a communications input preset and the HAL puts noise
 * suppression, automatic gain and sometimes echo cancellation in front of
 * everything the page receives; web constraints cannot reach that layer (see
 * captureprobe.ts, which is what discovers it where this plugin is absent). To
 * a noise suppressor a ringing chord IS stationary noise, and the partials the
 * strum estimator measures are exactly what gets pulled down.
 *
 * So the APK opens `AudioRecord` on the least-processed source the device
 * admits to having (android/.../StrumRecorderPlugin.java) and streams raw
 * little-endian PCM16 over the bridge in ~250 ms chunks. This module turns
 * those chunks back into the signal the web path would have produced and hands
 * them to the SAME `StrumRecorder` — the same ring buffer, the same onset
 * detector, the same window, the same 5 ms hops. Nothing about the reading
 * changes except the audio it is a reading of.
 *
 * "The signal the web path would have produced" is the load-bearing phrase.
 * MicCapture puts every sample through two biquads — a 20-90 Hz highpass and a
 * 2 kHz lowpass, both Butterworth — and strum capture taps the tail of that
 * chain (v2.0 condition 3). Those filters live in the Web Audio graph, which
 * the native stream never touches, so they are reproduced here as the same two
 * RBJ biquads at the same corners and the same Q, running over the chunk
 * stream. They are not an approximation of the graph: the coefficient forms are
 * the ones the Audio EQ Cookbook specifies and Chrome's BiquadFilterNode
 * implements, and the harness checks the pair against the graph's magnitude
 * response across the band.
 */

import { StrumRecorder, WINDOW_LONG_S, WINDOW_SHORT_S, windowSecondsFor } from './strumcapture';

/* ------------------------------------------------------------ the plugin */

/** One 250 ms slice of the native stream. */
interface ChunkEvent {
  /** Base64 of raw little-endian PCM16, mono. */
  base64: string;
  sampleRate: number;
  /** Which input the device actually opened. */
  source: string;
}

interface ListenerHandle {
  remove: () => void | Promise<void>;
}

interface StrumRecorderPlugin {
  start(options?: { sampleRate?: number }): Promise<{ sampleRate?: number; source?: string }>;
  stop(): Promise<void>;
  addListener(
    eventName: 'chunk',
    callback: (event: ChunkEvent) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

/**
 * The plugin, or null wherever there isn't one: the browser, the PWA, and an
 * APK built before v2.1 — all three of which fall back to the capture-path
 * probe and the web path, exactly as they do today.
 */
export function nativeStrumPlugin(): StrumRecorderPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || cap.isNativePlatform() !== true) {
    return null;
  }
  const plugin = cap.Plugins?.StrumRecorder as Partial<StrumRecorderPlugin> | undefined;
  if (
    !plugin ||
    typeof plugin.start !== 'function' ||
    typeof plugin.stop !== 'function' ||
    typeof plugin.addListener !== 'function'
  ) {
    return null;
  }
  return plugin as StrumRecorderPlugin;
}

export function isNativeCaptureAvailable(): boolean {
  return nativeStrumPlugin() !== null;
}

/* ------------------------------------------------------------ the filters */

/** mic.ts's LOWPASS_HZ. */
const LOWPASS_HZ = 2000;
/** ...and its HIGHPASS_DEFAULT, with the same 20-90 Hz range the view moves it in. */
const HIGHPASS_DEFAULT = 20;
const HIGHPASS_MIN = 20;
const HIGHPASS_MAX = 90;
/** mic.ts's FILTER_Q — Butterworth, the flattest passband. */
const FILTER_Q = 0.707;

/** What the plugin is asked for. Every fallback it may return instead is handled. */
const PREFERRED_RATE = 48000;

/**
 * One Audio EQ Cookbook biquad, direct form I, normalised by a0 — the form
 * Chrome's BiquadFilterNode implements and research/calibrate/micchain.mjs
 * mirrors. The state is kept in doubles and only the output is written back at
 * Float32, so the recursion never accumulates single-precision error.
 */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  /** `highpass` and `lowpass` differ only in the numerator. */
  set(kind: 'highpass' | 'lowpass', sampleRate: number, freq: number, q: number): void {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    if (kind === 'lowpass') {
      this.b0 = (1 - cw) / 2 / a0;
      this.b1 = (1 - cw) / a0;
      this.b2 = this.b0;
    } else {
      this.b0 = (1 + cw) / 2 / a0;
      this.b1 = -(1 + cw) / a0;
      this.b2 = this.b0;
    }
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  /** Filter `count` samples of `buf` in place. */
  process(buf: Float32Array, count: number): void {
    const b0 = this.b0;
    const b1 = this.b1;
    const b2 = this.b2;
    const a1 = this.a1;
    const a2 = this.a2;
    let x1 = this.x1;
    let x2 = this.x2;
    let y1 = this.y1;
    let y2 = this.y2;
    for (let i = 0; i < count; i++) {
      const xn = buf[i];
      const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xn;
      y2 = y1;
      y1 = yn;
      buf[i] = yn;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
  }

  /** Magnitude at one frequency. Used by the parity harness, not by the app. */
  gainAt(freq: number, sampleRate: number): number {
    const w = (2 * Math.PI * freq) / sampleRate;
    const nr = this.b0 + this.b1 * Math.cos(w) + this.b2 * Math.cos(2 * w);
    const ni = -(this.b1 * Math.sin(w) + this.b2 * Math.sin(2 * w));
    const dr = 1 + this.a1 * Math.cos(w) + this.a2 * Math.cos(2 * w);
    const di = -(this.a1 * Math.sin(w) + this.a2 * Math.sin(2 * w));
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
}

/** mic.ts's clampAnalysisFloor, repeated so this module owes it nothing. */
function clampFloor(hz: number): number {
  return Number.isFinite(hz) ? Math.min(HIGHPASS_MAX, Math.max(HIGHPASS_MIN, hz)) : HIGHPASS_DEFAULT;
}

/* ------------------------------------------------------------- the decode */

/**
 * Base64 -> Int16LE -> Float32 in one pass, into a buffer that is reused across
 * chunks. `atob` hands back a binary string, so the bytes come out of
 * charCodeAt; two of them make one sample and the sign is folded in by hand
 * rather than by a DataView, which would cost a call per sample.
 *
 * The scale is 1/32768, matching every other PCM16 decode in this repo.
 */
class ChunkDecoder {
  private buf = new Float32Array(0);

  /** Returns a view of the scratch buffer — valid until the next decode. */
  decode(base64: string): Float32Array {
    const bin = atob(base64);
    const count = bin.length >> 1;
    if (this.buf.length < count) this.buf = new Float32Array(count);
    const out = this.buf;
    for (let i = 0; i < count; i++) {
      const lo = bin.charCodeAt(i * 2);
      const hi = bin.charCodeAt(i * 2 + 1);
      const raw = (hi << 8) | lo;
      out[i] = (raw >= 0x8000 ? raw - 0x10000 : raw) / 32768;
    }
    return out.subarray(0, count);
  }
}

/* ------------------------------------------------------------ the capture */

export interface NativeStrumCaptureOptions {
  /** Targets in Hz — only their lowest member matters, for the window length. */
  targetFreqs?: readonly number[];
  /** Force the long window instead of deriving it from `targetFreqs`. */
  needsLong?: boolean;
  /** Post-onset seconds, overriding both of the above. */
  windowSeconds?: number;
  /** The highpass corner, as MicCapture would have been told it (20-90 Hz). */
  highpassHz?: number;
}

/**
 * The same surface as `StrumCapture`, fed from the native stream instead of the
 * Web Audio graph: `start` / `stop` / `onStrum` / `onOnset` / `onLevel` /
 * `windowSeconds` / `setTargets`, so the view can hold either one.
 */
export class NativeStrumCapture {
  /** Fires once per detected strum with onset-100 ms through onset+window. */
  onStrum: ((samples: Float32Array, sampleRate: number) => void) | null = null;
  /** Fires ~0.26 s after the strings are hit, a whole window before `onStrum`. */
  onOnset: (() => void) | null = null;
  /** Smoothed input level, 0..1, ~12 times a second. */
  onLevel: ((rms: number) => void) | null = null;

  private recorder: StrumRecorder | null = null;
  private readonly decoder = new ChunkDecoder();
  private readonly highpass = new Biquad();
  private readonly lowpass = new Biquad();
  private listener: ListenerHandle | null = null;
  private running = false;
  private rate = 0;
  private windowOverride: number | null = null;
  private floorHz = HIGHPASS_DEFAULT;
  /** Which input the device opened, once it has said. Diagnostics only. */
  private sourceName = '';

  get listening(): boolean {
    return this.running && this.recorder !== null;
  }

  /** Post-onset seconds the CURRENT capture will record — what a progress bar
      started at `onOnset` has to run for. */
  get windowSeconds(): number {
    return this.recorder?.windowSeconds ?? this.windowOverride ?? WINDOW_LONG_S;
  }

  /** 'unprocessed' | 'voice_recognition' | 'camcorder' | 'mic', or '' before
      the session has started. */
  get source(): string {
    return this.sourceName;
  }

  get sampleRate(): number {
    return this.rate;
  }

  /**
   * Open the native recorder and start listening for a strum. Rejects with
   * `mic-denied` where the OS permission was refused, which is the same error
   * MicCapture throws and the same card the view already knows how to show.
   */
  async start(options: NativeStrumCaptureOptions = {}): Promise<void> {
    const plugin = nativeStrumPlugin();
    if (!plugin) throw new Error('native-capture-unavailable');
    if (options.highpassHz != null) this.setAnalysisFloor(options.highpassHz);
    this.applyWindow(options);
    if (this.running) return;
    this.running = true;

    try {
      const handle = await plugin.addListener('chunk', this.handleChunk);
      if (!this.running) {
        // Stopped while the bridge was registering us.
        void Promise.resolve(handle?.remove?.()).catch(() => undefined);
        return;
      }
      this.listener = handle ?? null;
      const started = await plugin.start({ sampleRate: PREFERRED_RATE });
      if (!this.running) {
        void plugin.stop().catch(() => undefined);
        this.dropListener();
        return;
      }
      this.sourceName = typeof started?.source === 'string' ? started.source : '';
      const rate = Number(started?.sampleRate);
      // The chunks carry the rate too, so a plugin that answered without one is
      // not a failure — the first chunk builds the recorder instead.
      if (Number.isFinite(rate) && rate > 0) this.ensureRecorder(rate);
    } catch (err) {
      this.stop();
      throw asCaptureError(err);
    }
  }

  stop(): void {
    this.running = false;
    this.dropListener();
    const plugin = nativeStrumPlugin();
    if (plugin) void plugin.stop().catch(() => undefined);
    if (this.recorder) {
      this.recorder.onStrum = null;
      this.recorder.onOnset = null;
      this.recorder.onLevel = null;
      this.recorder = null;
    }
    this.rate = 0;
    this.highpass.reset();
    this.lowpass.reset();
  }

  /** Retarget the window between strums (a capo change, a new tuning). */
  setTargets(targetFreqs: readonly number[]): void {
    this.windowOverride = windowSecondsFor(targetFreqs, this.rate || PREFERRED_RATE);
    this.recorder?.setWindowSeconds(this.windowOverride);
  }

  /**
   * Move the bottom of the analysis band, clamped to 20-90 Hz, and return what
   * was applied — MicCapture.setAnalysisFloor's contract, so the view can hold
   * either capture and reason about the band the same way.
   *
   * There is no ramp here and none is needed: the web path ramps because a
   * moving cutoff in a live graph shifts the phase of everything in the band
   * while the monophonic detector is reading it. This filter is only ever
   * retuned between strums, and the strum estimator re-derives its own phase
   * from the window it is handed.
   */
  setAnalysisFloor(hz: number): number {
    const applied = clampFloor(hz);
    if (applied === this.floorHz) return applied;
    this.floorHz = applied;
    if (this.rate > 0) this.highpass.set('highpass', this.rate, applied, FILTER_Q);
    return applied;
  }

  private applyWindow(options: NativeStrumCaptureOptions): void {
    const rate = this.rate || PREFERRED_RATE;
    if (options.windowSeconds != null) this.windowOverride = options.windowSeconds;
    else if (options.needsLong != null) {
      this.windowOverride = options.needsLong ? WINDOW_LONG_S : WINDOW_SHORT_S;
    } else if (options.targetFreqs) {
      this.windowOverride = windowSecondsFor(options.targetFreqs, rate);
    }
    if (this.windowOverride != null) this.recorder?.setWindowSeconds(this.windowOverride);
  }

  /** Build the recorder and the filters for a rate, or reuse them if it has not
      changed. Called from `start` and, defensively, from the first chunk. */
  private ensureRecorder(rate: number): StrumRecorder {
    const existing = this.recorder;
    if (existing && this.rate === rate) return existing;
    this.rate = rate;
    this.highpass.set('highpass', rate, this.floorHz, FILTER_Q);
    this.lowpass.set('lowpass', rate, LOWPASS_HZ, FILTER_Q);
    this.highpass.reset();
    this.lowpass.reset();
    const recorder = new StrumRecorder(rate, {
      windowSeconds: this.windowOverride ?? WINDOW_LONG_S,
    });
    recorder.onStrum = (samples, sampleRate) => this.onStrum?.(samples, sampleRate);
    recorder.onOnset = () => this.onOnset?.();
    recorder.onLevel = (rms) => this.onLevel?.(rms);
    this.recorder = recorder;
    return recorder;
  }

  private readonly handleChunk = (event: ChunkEvent): void => {
    if (!this.running || !event || typeof event.base64 !== 'string') return;
    const rate = Number(event.sampleRate);
    const recorder = this.ensureRecorder(Number.isFinite(rate) && rate > 0 ? rate : PREFERRED_RATE);
    if (event.source && event.source !== this.sourceName) this.sourceName = event.source;
    const block = this.decoder.decode(event.base64);
    if (!block.length) return;
    // The graph's two biquads, in the graph's order: highpass, then lowpass,
    // then the tap. In place, on the decoder's own scratch buffer — the
    // recorder copies into its ring, so nothing downstream holds a reference.
    this.highpass.process(block, block.length);
    this.lowpass.process(block, block.length);
    recorder.push(block);
  };

  private dropListener(): void {
    const handle = this.listener;
    this.listener = null;
    if (!handle) return;
    try {
      void Promise.resolve(handle.remove?.()).catch(() => undefined);
    } catch {
      /* a bridge that is already gone */
    }
  }
}

/**
 * Map the bridge's rejection onto the errors the view already handles.
 * `mic-denied` is MicCapture's own word for it, so a denial down here shows the
 * same "Microphone blocked" card a denial up there does.
 */
function asCaptureError(err: unknown): Error {
  const code = (err as { code?: unknown } | null)?.code;
  const message = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  if (code === 'denied' || /denied|permission/i.test(message)) return new Error('mic-denied');
  return err instanceof Error ? err : new Error(message || 'native-capture-failed');
}

/* ------------------------------------------------------------- for the harness */

/**
 * The chain's magnitude response, in dB, computed from the very coefficients
 * the capture runs on. The parity harness compares this against the Web Audio
 * graph's own response; nothing in the app calls it.
 */
export function nativeChainGainDb(
  freq: number,
  sampleRate = PREFERRED_RATE,
  highpassHz = HIGHPASS_DEFAULT,
  lowpassHz = LOWPASS_HZ,
): number {
  const hp = new Biquad();
  const lp = new Biquad();
  hp.set('highpass', sampleRate, highpassHz, FILTER_Q);
  lp.set('lowpass', sampleRate, lowpassHz, FILTER_Q);
  return 20 * Math.log10(hp.gainAt(freq, sampleRate) * lp.gainAt(freq, sampleRate) + 1e-30);
}
