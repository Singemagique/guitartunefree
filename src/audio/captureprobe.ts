/**
 * Capture-path probe — SPEC v2.1, "Capture-path probe (ships first, with
 * v2.0.2)".
 *
 * Android's WebView asks the OS for a *communications* input preset, and the
 * HAL then puts noise suppression, automatic gain and (sometimes) echo
 * cancellation in front of everything the app receives. `getUserMedia`'s
 * `noiseSuppression: false` does not reach that layer — the behaviour is
 * field-trial dependent and `getSettings()` reports the configuration that was
 * requested rather than the processing that is actually running, so there is
 * nothing to read. Chromium's own source says as much.
 *
 * The monophonic tuner survives all of it (a period detector only needs the
 * zero crossings to stay where they are). The strum analyser does not: to a
 * noise suppressor a ringing chord IS stationary noise, and the partials it
 * measures are exactly what gets pulled down.
 *
 * So the app asks the path a question it cannot lie about. Play a steady tone
 * out of the speaker, watch the envelope that comes back through the SAME
 * filtered chain the strum analyser reads, and see what the path did to it:
 *
 *     flat            the level that went out is the level that came back  -> clean
 *     one-way fade    something adapted to it and pulled it down           -> processed
 *     pumping         something is riding gain on it                       -> processed
 *     collapse        it arrived and then vanished (echo cancellation)     -> processed
 *     too quiet       the speaker is muted, or the room is louder          -> unknown
 *     too ragged      the room is not still enough to measure through      -> unknown
 *
 * The one rule that matters more than any threshold in here: **a quiet capture
 * is never 'processed'.** Volume down, a muted speaker, a phone face-down on a
 * sofa — all of those are 'unknown', and 'unknown' proceeds normally. The
 * verdict may only take the mode away from the player when the tone was
 * demonstrably heard and demonstrably mangled.
 */

import { ensureRunning } from './context';
import type { MicCapture } from './mic';

export type CapturePath = 'clean' | 'processed' | 'unknown';

/* ------------------------------------------------------------- the tone */

/**
 * Comfortably inside the analysis band: above the 70-90 Hz highpass the tuner
 * runs at, an octave and a half under the 2 kHz lowpass, and in the region
 * every phone speaker and every phone microphone actually reproduces. Low
 * enough not to be piercing, high enough that the room's own rumble is not
 * part of the measurement.
 */
const TONE_HZ = 700;
/**
 * Loud enough to clear a normal room by 20 dB or more at arm's length, quiet
 * enough that a player who did not expect a sound is not startled by one. It is
 * also the level the tone must NOT be raised past: the probe's whole claim is
 * about what the path does to an ordinary signal.
 */
const TONE_GAIN = 0.25;
/** Long enough for a noise suppressor to adapt (they settle in 0.3-1 s) and for
    two full cycles of the ~2 Hz pumping an AGC produces. */
const TONE_S = 1.2;
/** Cosine-free but click-free: 20 ms of ramp is inaudible as an edge and is
    over long before the steady window opens. */
const FADE_S = 0.02;
/** Scheduling runway, so the ramp is never truncated by a late render quantum. */
const LEAD_S = 0.06;
/** How long the room is measured for before the tone, to have something to
    compare "did the tone arrive at all" against. */
const ROOM_MS = 200;
/** Envelope resolution. The analyser hands back an ~85 ms frame, so sampling
    faster than this buys nothing but overlap; sampling slower loses the 2 Hz
    pumping the AGC test is looking for. */
const SAMPLE_MS = 20;
/** Recorded past the end of the tone, to absorb output latency plus the
    acoustic and analyser lag before the steady window is cut. */
const TAIL_S = 0.35;

/* ------------------------------------------------------- the steady window */

/**
 * The envelope from the tone's own onset is a ramp — the gain ramp, the
 * speaker's excursion settling, and the analyser's 85 ms window filling with a
 * signal it did not have a moment ago. None of that is the path's doing, so
 * none of it is measured.
 */
const STEADY_FROM_S = 0.25;
/**
 * ...and the far end stops well short of the tone's own, because the window is
 * anchored to the onset the trace SHOWS, not to the one the scheduler asked
 * for. Output latency, the speaker's delay and the analyser's own 85 ms window
 * all push the observed onset later — a fifth of a second is ordinary on a
 * phone — so a window that ran to the tone's nominal end would spend its last
 * samples on the release ramp and the room behind it. That tail is not the
 * path's doing, and it is not a small effect: one silent sample at the end of
 * an otherwise perfect envelope is enough on its own to take a 'clean' capture
 * out of 'clean' (measured: coefficient of variation 0.012 -> 0.148, against a
 * 0.15 bar). 0.9 s leaves 0.3 s of slack for the lag and still spans a whole
 * noise-suppressor adaptation and nearly two cycles of AGC pumping.
 */
const STEADY_TO_S = 0.9;
/** ...and the lag the guard above buys, stated as a rule. Past 0.3 s the steady
    window would start running off the end of the tone again, so a trace whose
    onset is later than this is not measured at all — it is either a very slow
    path or a noise sample the peak search mistook for an arrival. */
const ONSET_MAX_S = 0.3;
/** Fewer samples than this in the steady window and there is nothing to take a
    coefficient of variation of. 15 at 20 ms is 0.3 s. */
const MIN_STEADY = 15;
/** ...and a trace this short never even saw a whole tone. */
const MIN_TRACE = 30;

/* ------------------------------------------------------------- thresholds */

/**
 * Absolute floor, in RMS through the filtered chain. Below roughly -48 dBFS the
 * shape of an envelope is the shape of the capture's own noise, and no verdict
 * drawn from it would be about the path. A capture under this is 'unknown' —
 * NEVER 'processed'.
 */
const TONE_MIN_RMS = 0.004;
/**
 * ...and the tone has to clear the room it is played into by this much, or the
 * envelope is the room's shape and not the tone's. +9.5 dB is deliberately
 * modest: the point is to reject a probe that heard nothing, not to demand a
 * quiet room.
 */
const TONE_OVER_ROOM = 3;
/**
 * A collapse is only called when the tone was *unmistakably* there first — this
 * much over the "did it arrive" floor at its peak — and then fell under it. One
 * loud transient in an otherwise silent capture must not read as a tone that
 * was cancelled, so the margin is wide.
 */
const COLLAPSE_MARGIN = 4;
/**
 * Flat. A steady tone through an untouched path varies by the room's noise and
 * nothing else; 0.15 is about ±1.3 dB, which leaves room for a hand moving, a
 * fan, and the analyser's window sliding over a slightly non-integer number of
 * cycles. Set generously on purpose: the cost of missing a clean path is
 * 'unknown', which proceeds normally anyway.
 */
const CV_CLEAN = 0.15;
/** ...and flat means both ends too, not just a small variance around a slope. */
const FLAT_RATIO = 0.8;
/**
 * Pumping. An AGC riding ±6 dB puts the coefficient of variation at ~0.47 and
 * ±3 dB at ~0.24, so 0.30 sits between "a compressor is working on this" and
 * "the room is a bit lively". Everything between CV_CLEAN and this is
 * 'unknown' — an honest indeterminate band, not a coin toss.
 */
const CV_PUMP = 0.3;
/**
 * Fading. A noise suppressor that has decided the tone is noise takes it down
 * by 6 dB and more over its adaptation; 0.6 (-4.4 dB) is past anything a
 * speaker, a room mode or a hand can do to a 0.9 s window on its own.
 */
const DECAY_RATIO = 0.6;
/** The fade has to be one-way. A dip that recovers is pumping (which the CV
    test owns) or a passing noise, and neither is an adaptation. The tolerance
    keeps a couple of noisy samples from breaking an obvious slide. */
const MONO_TOL = 1.05;
/** Where the trace is judged to have started: the first sample at half the
    loudest one. A ramp is short, so this lands within a sample or two of the
    real arrival however much latency the output path added. */
const ONSET_FRAC = 0.5;

/* ------------------------------------------------------- the classifier */

export interface ProbeTrace {
  /** Mean RMS of the room in the moments before the tone started. */
  room: number;
  /** RMS of the capture, sampled every `intervalMs` from the moment the tone
      was scheduled — including whatever latency the output path adds, which is
      why the onset is found rather than assumed. */
  levels: readonly number[];
  /** The interval those samples were actually taken at, in ms. */
  intervalMs: number;
}

function mean(values: readonly number[], from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i];
  return to > from ? sum / (to - from) : 0;
}

/**
 * The whole verdict, as pure arithmetic over an envelope — no audio, no DOM, no
 * clock. The harness drives this directly with synthesised envelopes; the probe
 * below is only the thing that measures one.
 */
export function classifyProbeTrace(trace: ProbeTrace): CapturePath {
  const levels = trace.levels;
  const interval = trace.intervalMs;
  if (levels.length < MIN_TRACE || !(interval > 0)) return 'unknown';

  let peak = 0;
  for (const v of levels) if (v > peak) peak = v;

  // Did the tone arrive at all? Everything below this line is 'unknown', and
  // that is the point: a muted speaker is not a processed capture path.
  const heard = Math.max(TONE_MIN_RMS, trace.room * TONE_OVER_ROOM);
  if (peak < heard) return 'unknown';

  let onset = 0;
  while (onset < levels.length && levels[onset] < peak * ONSET_FRAC) onset++;
  if (onset * interval > ONSET_MAX_S * 1000) return 'unknown';

  const from = onset + Math.round((STEADY_FROM_S * 1000) / interval);
  const to = Math.min(levels.length, onset + Math.round((STEADY_TO_S * 1000) / interval));
  if (to - from < MIN_STEADY) return 'unknown';

  const avg = mean(levels, from, to);
  if (avg < heard) {
    // It was there and then it was not. Echo cancellation does exactly this,
    // and only when it was unmistakably there first is that a claim worth
    // making — otherwise the peak was a door, a cough or a table knock.
    return peak >= heard * COLLAPSE_MARGIN ? 'processed' : 'unknown';
  }

  let variance = 0;
  for (let i = from; i < to; i++) variance += (levels[i] - avg) * (levels[i] - avg);
  const cv = Math.sqrt(variance / (to - from)) / avg;

  // Thirds of the steady window: enough averaging that noise does not decide
  // the shape, enough resolution that a one-way slide is distinguishable from
  // a wobble.
  const third = (to - from) / 3;
  const a = mean(levels, from, from + Math.round(third));
  const b = mean(levels, from + Math.round(third), from + Math.round(2 * third));
  const c = mean(levels, from + Math.round(2 * third), to);

  if (cv <= CV_CLEAN && c >= a * FLAT_RATIO && a >= c * FLAT_RATIO) return 'clean';
  if (c <= a * DECAY_RATIO && b <= a * MONO_TOL && c <= b * MONO_TOL) return 'processed';
  if (cv >= CV_PUMP) return 'processed';
  // Neither flat enough to trust nor shaped enough to accuse. Say so.
  return 'unknown';
}

/* --------------------------------------------------------------- the gate */

/**
 * Chrome proper is known-good and never probes: its capture path is the one
 * every measurement in this repo was taken through, and playing a tone at
 * somebody using the web app would be a sound with no question behind it.
 *
 * The marker is Android WebView's own: every WebView user-agent carries
 * "; wv" in its Chrome token, and no Chrome, Firefox or Safari build does.
 * `window.Capacitor` covers the same platform from the other side — the bridge
 * is injected before any app code runs — and catches a WebView build whose UA
 * has been overridden.
 */
const WEBVIEW_MARKER = '; wv';

export function isProcessedCapturePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.userAgent === 'string' && navigator.userAgent.includes(WEBVIEW_MARKER)) {
    return true;
  }
  if (typeof window === 'undefined') return false;
  return (window as unknown as { Capacitor?: unknown }).Capacitor != null;
}

/* -------------------------------------------------------------- the probe */

/** At most once per session (SPEC), so the tone is heard once and the answer
    is a fact about the device rather than about the moment. */
let verdict: CapturePath | null = null;
let inflight: Promise<CapturePath> | null = null;

/** What the probe decided, or null if it has not run (or could not). */
export function capturePathVerdict(): CapturePath | null {
  return verdict;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

/**
 * Play the tone, watch the envelope, classify it.
 *
 * Resolves 'unknown' — without playing anything — on a platform that is not
 * gated, and on any capture that could not be completed (the microphone closed
 * under it, the timers were throttled, the graph was never built). Only a
 * completed measurement is cached: a probe that was interrupted has not
 * answered the question and must not be treated as though it had.
 */
export function probeCapturePath(mic: MicCapture): Promise<CapturePath> {
  if (verdict) return Promise.resolve(verdict);
  if (inflight) return inflight;
  if (!isProcessedCapturePlatform()) return Promise.resolve('unknown');
  const run = measure(mic)
    .then((measured) => {
      // null = the measurement did not complete. Leave the session unanswered
      // so a later entry into the mode can ask again.
      if (measured) verdict = measured;
      return measured ?? 'unknown';
    })
    .catch(() => 'unknown' as CapturePath)
    .finally(() => {
      inflight = null;
    });
  inflight = run;
  return run;
}

async function measure(mic: MicCapture): Promise<CapturePath | null> {
  if (!mic.running) return null;
  const ctx = await ensureRunning();
  if (!mic.running) return null;

  const frame = new Float32Array(mic.analysisSize);
  const level = (): number => {
    mic.read(frame);
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  };

  const room = await sample(ROOM_MS, level, mic);
  if (!room) return null;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = TONE_HZ;
  const gain = ctx.createGain();
  const t0 = ctx.currentTime + LEAD_S;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(TONE_GAIN, t0 + FADE_S);
  gain.gain.setValueAtTime(TONE_GAIN, t0 + TONE_S - FADE_S);
  gain.gain.linearRampToValueAtTime(0, t0 + TONE_S);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + TONE_S + FADE_S);

  let trace: { levels: number[]; intervalMs: number } | null = null;
  try {
    await delay(LEAD_S * 1000);
    trace = await sample((TONE_S + TAIL_S) * 1000, level, mic);
  } finally {
    // The oscillator has stopped itself; this only takes the two dead nodes off
    // the graph, and does it on every exit including an abandoned probe.
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      /* already gone */
    }
  }
  if (!trace) return null;

  return classifyProbeTrace({
    room: room.levels.reduce((sum, v) => sum + v, 0) / room.levels.length,
    levels: trace.levels,
    intervalMs: trace.intervalMs,
  });
}

/**
 * RMS samples for `ms`, at SAMPLE_MS. Returns null the moment the microphone
 * goes away under it — a graph that has been torn down reads as silence, and
 * silence read as an envelope is exactly the collapse the classifier would
 * otherwise call 'processed'.
 *
 * The interval reported back is the one the timers actually delivered, not the
 * one that was asked for, so a machine under load produces a stretched trace
 * rather than a mis-scaled verdict.
 */
async function sample(
  ms: number,
  level: () => number,
  mic: MicCapture,
): Promise<{ levels: number[]; intervalMs: number } | null> {
  const levels: number[] = [];
  const start = performance.now();
  let last = start;
  for (;;) {
    await delay(SAMPLE_MS);
    if (!mic.running) return null;
    last = performance.now();
    levels.push(level());
    if (last - start >= ms) break;
  }
  if (levels.length < 2) return null;
  return { levels, intervalMs: (last - start) / (levels.length - 1) };
}
