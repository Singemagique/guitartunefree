import './tuner-view.css';
import type { AppState } from '../state';
import { getState, subscribe } from '../state';
import type { NoteInfo } from '../music/notes';
import { centsBetween, nearestNote, prettyPc } from '../music/notes';
import { tuningById, tuningNotes } from '../music/tunings';
import { MicCapture, clampAnalysisFloor } from '../audio/mic';
import { MIN_FREQ, PitchDetector } from '../audio/pitch';
import type { StrumResult, StrumStringResult } from '../audio/strum';
import { hasOctavePair } from '../audio/strum';
import { StrumCapture, analyzeStrumAsync } from '../audio/strumcapture';
import { NativeStrumCapture, isNativeCaptureAvailable } from '../audio/nativecapture';
import type { CapturePath } from '../audio/captureprobe';
import {
  capturePathVerdict,
  isProcessedCapturePlatform,
  probeCapturePath,
} from '../audio/captureprobe';
import { holdWake, releaseWake } from '../wakelock';

export interface ViewHandle {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Gauge geometry in viewBox units. The needle pivots at (CX, CY) — bottom
   centre — and sweeps ±SWEEP_DEG across the ±RANGE_CENTS window, so one cent
   is 1.44° of rotation. Angles are measured from straight up, clockwise
   positive (sharp to the right). */
const CX = 160;
const CY = 168;
const R_ARC = 132;
const R_MINOR = 122;
const R_MAJOR = 114;
const R_LABEL = 152;
const NEEDLE_LEN = 108;
const SWEEP_DEG = 72;
const RANGE_CENTS = 50;

/** Exponential smoothing weight applied to the needle angle each frame. */
const SMOOTH_ALPHA = 0.25;
/** Skip a needle write below this many degrees of change. */
const ANGLE_EPSILON = 0.05;
/** Keep the last confident reading on screen this long before relaxing. */
const HOLD_MS = 600;
/** A 2048-sample frame spans ~46 ms, so detecting faster than this is wasted
    work; the needle still animates on every rAF tick. */
const DETECT_MS = 25;
const IN_TUNE_CENTS = 5;
const IN_TUNE_FRAMES = 3;
/** Release band. A plucked string wobbles a cent or two frame to frame, so a
    symmetric ±5 gate strobes the card green whenever the player parks on the
    boundary; green only lets go once the pitch is clearly out again. */
const OUT_OF_TUNE_CENTS = 8;
/** …and never before this long, so even a hard peg turn reads as one change. */
const IN_TUNE_MIN_MS = 400;
/** One short buzz per arrival at pitch, at most this often. */
const VIBE_GAP_MS = 1000;
/** Snap to a tuning's string only when the pitch is this close to it. */
const STRING_WINDOW_CENTS = 120;
/** Frames behind the median. Five ~25 ms detections span ~125 ms — short enough
    that the needle still feels attached to the string, long enough that two
    stray frames in a row cannot move it. */
const MEDIAN_N = 5;
/** Cut the analysis band this far under the tuning's lowest string. A tone a
    semitone flat is still 6% above its target, so 0.85 leaves room to hear a
    badly slack string while dropping everything below the instrument. */
const ANALYSIS_FLOOR_RATIO = 0.85;
/** Detections this far below the analysis band are artefacts by construction:
    the highpass has already gutted any real signal down there, so a "pitch"
    below it is hum or a phantom common period, never the instrument.

    "The analysis band" means the cutoff the filter is actually running at, not
    the one this view asked for. They agree for every guitar and bass preset, but
    a ukulele asks for 222 Hz and gets the highpass's 90 Hz ceiling: fencing on
    the request threw away everything under 178 Hz — a band the filter was
    passing within a third of a dB — so a uke C string a fifth flat, or a
    baritone uke's D3, read as silence. */
const SUB_BAND_RATIO = 0.8;

/** Guided tuning: how long the median has to stay inside the latch's release
    band AFTER the in-tune latch fires before the string is called done. The
    latch alone is 3 frames at ±5 cents — enough to light the card, not enough to
    walk away from a peg that is still creeping. There is deliberately no second
    detector here: this reads the latch's own clock (`inTuneAt`), so a string
    that falls out of the band resets the latch and the dwell with it. */
const GUIDE_CONFIRM_MS = 900;
/** A done string that drifts this far while the guide is watching loses its
    check. Same number as the latch's release band, so "no longer in tune" means
    one thing in this view. */
const GUIDE_RECHECK_CENTS = OUT_OF_TUNE_CENTS;
/** A confirm hands the guide the next string within one detect interval, and a
    polite region rewritten 25 ms later announces only the last thing in it. Pin
    the sentence for long enough to be spoken before the direction hint takes the
    region back. */
const ANNOUNCE_HOLD_MS = 1400;
/** The string that was just confirmed is still ringing — a guitar's low E for
    ten seconds or more — and the guide has already moved on under it. Keep the
    readout on the string that was finished, in its in-tune state, for this long
    (or until the pitch leaves its release band, whichever comes first) so the
    player is never told to retune the string they have just tuned. The strip
    moves on immediately: the check, the counter and the next target are the
    answer to "what now", the readout is the answer to "did that work". */
const GUIDE_HOLD_MS = 1200;

/* ---------- strum check (beta) ---------- */

/** Condition 4 of the v2.0 adversarial verification: the strum board promises
    ±5 cents and no copy anywhere in it may claim better. The monophonic latch
    happens to use the same number, but they are not the same promise — this one
    is what the polyphonic estimator was measured at, so it gets its own name. */
const STRUM_IN_TUNE_CENTS = 5;
/** Half-scale of the mini bar, in cents. Past it the bar saturates and marks
    the rail; the printed figure never saturates, so a string a tone flat reads
    a pegged bar next to an honest "−203¢" rather than a plausible "−25¢". */
const STRUM_BAR_CENTS = 25;
/** How many out-of-tune strings a single spoken sentence will name before it
    starts counting them instead. Six clauses is not a sentence. */
const STRUM_SPEAK_MAX = 3;
/** A worker that never answers must not leave the board reading "Analysing…"
    for the rest of the session. */
const STRUM_TIMEOUT_MS = 8000;
/** How long the "heard it" state stays up before results may replace it. The
    onset gives it two full seconds by itself; this only matters where the
    analysis is reached without one. Below ~300 ms a state is a flash, not a
    message — the delivery-driven version showed it for 35-125 ms. */
const STRUM_ACK_MIN_MS = 400;
/** Bars in the listening ripple. Odd, so there is a middle one to put the
    newest sample in and an equal spread either side of it. */
const LEVEL_BARS = 5;
/** How far back the outermost pair reaches, in level updates (~80 ms each). */
const LEVEL_LAG = 2;
/** Bars never collapse to nothing: a silent room still shows five dots, which
    is the difference between "hearing silence" and "not running". */
const LEVEL_FLOOR = 0.16;
/** Below this a rewrite is not a visible move, and the DOM is left alone. */
const LEVEL_EPSILON = 0.02;
/** Steps the progress fills in when the player has asked for less motion. */
const PROGRESS_STEPS = 4;
/** The window a progress run assumes if the capture is somehow not there to
    be asked — the recorder's own longest, so the bar can only ever finish
    early rather than sit full while the window is still recording. */
const PROGRESS_FALLBACK_S = 2.4;
/** Where the same app runs on an untouched capture path. In the Capacitor
    WebView an https navigation outside the app's own scope is handed to the
    system browser, so this link is the one way out of the processed path that
    does not need a store listing, an install or an explanation. */
const LIVE_APP_URL = 'https://singemagique.github.io/guitartunefree/';

type Phase = 'idle' | 'starting' | 'live' | 'blocked';
type Mode = 'single' | 'strum';
/**
 * `idle` mic not open yet · `checking` the mic is open and the capture-path
 * probe is asking what the system does to it (v2.1; WebView only) · `armed`
 * open and waiting for a strum · `analysing` samples handed to the worker ·
 * `results` a board with numbers on it (still armed underneath) · `refused`
 * condition 1 tripped, numbers withheld · `unsupported` condition 2, the mode
 * never listens at all · `processed` the probe found a system-processed capture
 * path, and the mode never listens here either.
 */
type StrumState =
  | 'idle'
  | 'checking'
  | 'armed'
  | 'analysing'
  | 'results'
  | 'refused'
  | 'unsupported'
  | 'processed';

/** The two states this mode latches into: it is not listening, it is showing an
    explanation instead, and the ordinary "back to idle" transitions must not
    quietly wipe that explanation off the card. */
function strumLatched(state: StrumState): boolean {
  return state === 'unsupported' || state === 'processed';
}

interface BoardRow {
  el: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  cents: HTMLElement;
  arrow: HTMLElement;
  note: HTMLElement;
}

/** Once the user grants the mic we may re-open it on show() without a gesture. */
let micGrantedThisSession = false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  return node;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Median of the first `count` entries of `buf`, sorted into `scratch` so the
 * ring keeps its arrival order. A mean would let one frame that landed an octave
 * or a harmonic away drag the needle a visible distance; the median simply does
 * not see it, as long as its friends outnumber it. Five entries at most, so an
 * insertion sort is both the fastest and the only allocation-free option.
 */
function medianOf(buf: Float64Array, scratch: Float64Array, count: number): number {
  for (let i = 0; i < count; i++) scratch[i] = buf[i];
  for (let i = 1; i < count; i++) {
    const v = scratch[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > v) {
      scratch[j + 1] = scratch[j];
      j--;
    }
    scratch[j + 1] = v;
  }
  return scratch[(count - 1) >> 1];
}

/** 16-bit PCM WAV from a mono float capture — for the beta's debug export. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(out);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(c * 32767), true);
  }
  return out;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function centsToDeg(cents: number): number {
  return (clamp(cents, -RANGE_CENTS, RANGE_CENTS) / RANGE_CENTS) * SWEEP_DEG;
}

function polar(deg: number, r: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) };
}

function n2(v: number): string {
  return v.toFixed(2);
}

function formatFreq(freq: number): string {
  return `${freq.toFixed(1)} Hz`;
}

function formatCents(cents: number): string {
  const r = Math.round(cents);
  if (r === 0) return '0¢';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)}¢`;
}

/** Guided, one target is held however far the pitch is from it, so the offset
    can be an octave while the arc stops at ±RANGE_CENTS. Clamping the NUMBER to
    the arc prints a precise-looking lie — a string a fifth flat and a string 50
    cents flat read the same "−50¢", and the figure does not move for the whole
    wind-up from slack. Past the arc, say that it is past the arc. */
function formatGuidedCents(cents: number): string {
  if (cents > RANGE_CENTS) return `> ${formatCents(RANGE_CENTS)}`;
  if (cents < -RANGE_CENTS) return `< ${formatCents(-RANGE_CENTS)}`;
  return formatCents(cents);
}

/** Are these the same targets? Not "was the tuning id re-emitted": the state
    layer notifies on every write, and picking the row that is already current
    re-emits an unchanged id. Only a set that really differs invalidates what the
    guide has ticked off. */
function sameTargets(a: NoteInfo[], b: NoteInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pc !== b[i].pc || a[i].octave !== b[i].octave || a[i].freq !== b[i].freq) return false;
  }
  return true;
}

/** "F#3" is read as an unpronounceable token or, worse, "F hash 3"; every live
    region in the app spells the accidental out. Naturals keep their compact
    spelling, which screen readers already say correctly. */
function spokenName(note: NoteInfo): string {
  return note.pc.length > 1 ? `${note.pc.charAt(0)} sharp ${note.octave}` : note.name;
}

/** "4 cents flat" / "1 cent sharp" — the spoken half of a board row. The
    in-tune test is the caller's (it is made on the unrounded offset, so it can
    never disagree with the check mark); this only names an offset it is already
    known to have. */
function centsPhrase(cents: number): string {
  const n = Math.abs(Math.round(cents));
  return `${n} ${n === 1 ? 'cent' : 'cents'} ${cents < 0 ? 'flat' : 'sharp'}`;
}

function micIcon(): SVGSVGElement {
  const icon = s('svg', { viewBox: '0 0 24 24', class: 'tv-ico', 'aria-hidden': 'true' });
  icon.appendChild(s('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }));
  icon.appendChild(s('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }));
  icon.appendChild(s('path', { d: 'M12 18v3.5' }));
  return icon;
}

/** The one "done" mark in the view: a plain stroked tick, drawn once and shown
    or hidden by a class. Nothing about it moves or fades in. */
function checkIcon(cls: string): SVGSVGElement {
  const icon = s('svg', {
    viewBox: '0 0 24 24',
    class: cls,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  icon.appendChild(s('path', { d: 'M5 12.6 9.8 17.4 19 6.9' }));
  return icon;
}

function buildGauge(): { root: SVGSVGElement; needle: SVGGElement } {
  const root = s('svg', {
    viewBox: '0 0 320 190',
    class: 'tv-gauge',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  const left = polar(-SWEEP_DEG, R_ARC);
  const right = polar(SWEEP_DEG, R_ARC);
  root.appendChild(
    s('path', {
      class: 'tv-arc',
      d: `M ${n2(left.x)} ${n2(left.y)} A ${R_ARC} ${R_ARC} 0 0 1 ${n2(right.x)} ${n2(right.y)}`,
    }),
  );

  const zoneA = polar(-centsToDeg(IN_TUNE_CENTS), R_ARC);
  const zoneB = polar(centsToDeg(IN_TUNE_CENTS), R_ARC);
  root.appendChild(
    s('path', {
      class: 'tv-zone',
      d: `M ${n2(zoneA.x)} ${n2(zoneA.y)} A ${R_ARC} ${R_ARC} 0 0 1 ${n2(zoneB.x)} ${n2(zoneB.y)}`,
    }),
  );

  for (let c = -RANGE_CENTS; c <= RANGE_CENTS; c += 5) {
    const deg = centsToDeg(c);
    const major = c % 25 === 0;
    const outer = polar(deg, R_ARC);
    const inner = polar(deg, major ? R_MAJOR : R_MINOR);
    let cls = 'tv-tick';
    if (major) cls += ' tv-tick-major';
    if (c === 0) cls += ' tv-tick-zero';
    root.appendChild(
      s('line', {
        class: cls,
        x1: n2(outer.x),
        y1: n2(outer.y),
        x2: n2(inner.x),
        y2: n2(inner.y),
      }),
    );
    if (major) {
      const at = polar(deg, R_LABEL);
      const label = s('text', {
        class: 'tv-tick-label',
        x: n2(at.x),
        y: n2(at.y),
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      });
      label.textContent = c === 0 ? '0' : c > 0 ? `+${c}` : `−${Math.abs(c)}`;
      root.appendChild(label);
    }
  }

  const needle = s('g', { class: 'tv-needle' });
  needle.appendChild(
    s('path', {
      class: 'tv-needle-blade',
      d:
        `M ${CX - 5.5} ${CY + 6} ` +
        `L ${CX - 1.5} ${CY - NEEDLE_LEN} ` +
        `L ${CX + 1.5} ${CY - NEEDLE_LEN} ` +
        `L ${CX + 5.5} ${CY + 6} Z`,
    }),
  );
  root.appendChild(needle);

  root.appendChild(s('circle', { class: 'tv-hub', cx: CX, cy: CY, r: 11 }));
  root.appendChild(s('circle', { class: 'tv-hub-dot', cx: CX, cy: CY, r: 3.5 }));

  return { root, needle };
}

export function createTunerView(): ViewHandle {
  let state: AppState = getState();
  let targetNotes: NoteInfo[] = [];
  let pills: HTMLElement[] = [];

  let mic: MicCapture | null = null;
  let detector: PitchDetector | null = null;
  let frame: Float32Array | null = null;

  let phase: Phase = 'idle';
  let visible = false;
  let starting = false;
  let rafId = 0;

  let angle = 0;
  let targetAngle = 0;
  let writtenAngle = Number.NaN;
  /** The highpass cutoff in force, and the sub-band fence derived from it. */
  let analysisFloorHz = 0;
  let subBandHz = MIN_FREQ;
  /** The last cutoff handed to the live capture, which is not always the one
      above: a tuning change while getUserMedia is still pending updates the
      fence with no capture to tell, and the capture learns of it afterwards. */
  let micFloorHz = 0;
  let lastDetectAt = 0;
  let detectHoldUntil = 0;
  let lastConfidentAt = 0;
  let inTuneStreak = 0;
  let inTune = false;
  let inTuneAt = 0;
  let lastVibeAt = -Infinity;
  let relaxed = true;
  let activeIdx = -1;

  /* ---------- guided tuning ---------- */

  /** Off on every load — a guide that resumed itself would be answering a
      question the player did not ask this session. */
  let guideOn = false;
  /** Index into targetNotes (low string first), or -1 once every string is done
      and the guide has nothing left to point at. */
  let guideIndex = 0;
  let done: boolean[] = [];
  let complete = false;
  /** Frames a finished string has read out of tune for, so one attack transient
      cannot un-tick a check. Mirrors IN_TUNE_FRAMES on the way in. */
  let recheckStreak = 0;
  /** The string whose success readout owns the display, or -1. Set by a confirm,
      given back by endHold(). */
  let holdIdx = -1;
  let holdUntil = 0;
  /** When the current guided target started earning its dwell. The in-tune
      latch's own clock is not enough on its own: the success hold can hand the
      guide a string that is ALREADY sounding at pitch, and a latch inherited
      from the string before it would confirm that one on the spot. */
  let guideSince = 0;
  /** While a confirm sentence owns the live region, routine hint text waits. */
  let announceHoldUntil = 0;
  /** What the hint would be saying if nothing were holding the region. */
  let pendingSpoken = 'Play a string';

  /* ---------- strum check (beta) ---------- */

  /** Not persisted: Single is what this tab is. */
  let mode: Mode = 'single';
  let strumState: StrumState = 'idle';
  /**
   * Either capture, and the view cannot tell them apart: NativeStrumCapture
   * (v2.1, the APK) feeds the very same StrumRecorder from the native stream
   * and carries the same onStrum / onOnset / onLevel / windowSeconds surface,
   * so every flow state, every acknowledgement and every progress run below is
   * written once and runs on both.
   */
  let strumCap: StrumCapture | NativeStrumCapture | null = null;
  let strumStarting = false;
  /** Bumped on every analysis AND on every stop, so a result that arrives after
      the board has moved on — a tuning change, a mode switch, hide() — is
      dropped instead of drawn against targets it was never measured on. */
  let strumSeq = 0;
  let strumBusy = false;
  /** When the board last said "Heard it" — see settleAck. */
  let strumAckAt = 0;
  /** Condition 2: two strings exactly an octave apart. Latched from the CURRENT
      targets, so it follows the tuning sheet and the capo (a capo transposes
      every string by the same amount and cannot create or remove a pair). */
  let octaveBlocked = false;
  /**
   * The app's other sound sources. The capture-path probe plays a tone and
   * reads the envelope that comes back, so anything else coming out of the
   * speaker at the same time is IN that envelope: a metronome would read as
   * pumping and a drone would raise the room until the tone no longer clears
   * it. Neither would be a measurement of the capture path, so the probe simply
   * does not run — and returns 'unknown', which proceeds normally.
   *
   * Both views announce their transitions on `window` (the same events the
   * shell badges their tabs with), and every view is constructed before any of
   * them can start, so a listener attached here sees every change there is.
   */
  let metronomeSounding = false;
  let droneSounding = false;
  let boardRows: BoardRow[] = [];
  /** The stepped progress fill's pending writes; empty whenever the smooth
      transition is the one in use. Cleared before every restart, so a
      superseded strum cannot keep filling the bar the next one owns. */
  const progressTimers: number[] = [];
  /** Read at each use rather than latched: the preference can change under a
      running app, and both of the things it governs here are decided at the
      moment a strum arrives. */
  const lessMotion =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  const recent = new Float64Array(MEDIAN_N);
  const recentSorted = new Float64Array(MEDIAN_N);
  let recentCount = 0;
  let recentAt = 0;

  /** Start the median over: nothing before this moment describes the pitch the
      view is about to show (a new note, a new tuning, a new microphone). */
  function clearMedian(): void {
    recentCount = 0;
    recentAt = 0;
  }

  function pushMedian(freq: number): number {
    recent[recentAt] = freq;
    recentAt = (recentAt + 1) % MEDIAN_N;
    if (recentCount < MEDIAN_N) recentCount++;
    return medianOf(recent, recentSorted, recentCount);
  }

  const el = h('section', 'tv is-idle');
  el.setAttribute('aria-label', 'Auto tuner');
  el.dataset.phase = 'idle';
  el.dataset.mode = 'single';

  /* Mode segment. Two buttons, not a radio group: they are toggles over one
     view, and the rest of the app spells that aria-pressed. Not persisted —
     Single is the tuner this app is, and a beta mode that let itself back in on
     the next launch would be answering a question nobody asked twice. */
  const modeSeg = h('div', 'seg tv-modes');
  modeSeg.setAttribute('role', 'group');
  modeSeg.setAttribute('aria-label', 'Tuner mode');
  const singleBtn = h('button', 'seg-item tv-mode is-active', 'Single');
  singleBtn.type = 'button';
  singleBtn.setAttribute('aria-pressed', 'true');
  const strumBtn = h('button', 'seg-item tv-mode');
  strumBtn.type = 'button';
  strumBtn.setAttribute('aria-pressed', 'false');
  /* The eye gets "Strum · BETA"; the ear gets a sentence, because a screen
     reader reading a middle dot as "dot" turns the label into nonsense. */
  strumBtn.setAttribute('aria-label', 'Strum check, beta');
  const strumBtnText = h('span', undefined, 'Strum');
  strumBtnText.setAttribute('aria-hidden', 'true');
  const betaTag = h('span', 'tv-beta', 'beta');
  betaTag.setAttribute('aria-hidden', 'true');
  strumBtn.append(strumBtnText, betaTag);
  modeSeg.append(singleBtn, strumBtn);
  el.appendChild(modeSeg);

  const card = h('div', 'card tv-card');
  const gauge = buildGauge();
  const gaugeWrap = h('div', 'tv-gauge-wrap');
  gaugeWrap.appendChild(gauge.root);
  card.appendChild(gaugeWrap);

  const readout = h('div', 'tv-readout');
  const noteEl = h('div', 'tv-note');
  const pcEl = h('span', 'tv-pc', '—');
  const accEl = h('span', 'tv-acc');
  const octEl = h('span', 'tv-oct');
  noteEl.append(pcEl, accEl, octEl);
  const metrics = h('div', 'tv-metrics');
  const freqEl = h('span', 'tv-freq', '—');
  const centsEl = h('span', 'tv-cents', '—');
  metrics.append(freqEl, h('span', 'tv-sep'), centsEl);
  /* One polite region, two spellings: the eye gets a short tracked-out label
     with an arrow in it, the ear gets a sentence with the accidental spelled
     out. The visible half is aria-hidden so writing it never announces. */
  const hintEl = h('div', 'tv-hint');
  hintEl.setAttribute('aria-live', 'polite');
  const hintCheck = checkIcon('tv-hint-check');
  const hintText = h('span', 'tv-hint-text', 'Play a string');
  hintText.setAttribute('aria-hidden', 'true');
  const hintSpoken = h('span', 'sr-only tv-hint-spoken', 'Play a string');
  hintEl.append(hintCheck, hintText, hintSpoken);
  readout.append(noteEl, metrics, hintEl);
  card.appendChild(readout);

  const cta = h('div', 'tv-cta');
  const startBtn = h('button', 'btn btn-primary tv-start');
  startBtn.type = 'button';
  const startLabel = h('span', undefined, 'Start listening');
  startBtn.append(micIcon(), startLabel);
  cta.append(startBtn, h('p', 'tv-cta-note', 'Your guitar is heard on-device only — nothing is recorded or uploaded.'));
  card.appendChild(cta);
  el.appendChild(card);

  const strings = h('div', 'tv-strings');
  const stringsHead = h('div', 'tv-strings-head');
  const stringsTitle = h('p', 'tv-strings-title', 'Strings');
  /* A capo rewrites every name on the strip — the low E pill reads F♯2 with one
     at the second fret — so the strip says so, in the row that labels it. Static
     in both senses: it appears and disappears with the setting and never moves,
     and the text is only ever rewritten when the fret changes. */
  const capoTag = h('span', 'tv-capo');
  capoTag.hidden = true;
  const guideBtn = h('button', 'btn btn-ghost tv-guide', 'Tune all');
  guideBtn.type = 'button';
  guideBtn.setAttribute('aria-pressed', 'false');
  stringsHead.append(stringsTitle, capoTag, guideBtn);
  const strip = h('div', 'tv-strip');
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', 'Target strings');
  strings.append(stringsHead, strip);
  el.appendChild(strings);

  const status = h('div', 'tv-status');
  status.append(h('span', 'tv-dot'), h('span', undefined, 'Listening'));
  el.appendChild(status);

  const notice = h('div', 'card tv-notice');
  const noticeTitle = h('h2', 'tv-notice-title', 'Microphone blocked');
  const noticeBody = h('p', 'tv-notice-body');
  const steps = h('ol', 'tv-steps');
  for (const step of [
    'Tap the padlock or ⓘ next to the address bar.',
    'Open Site settings → Microphone and choose Allow.',
    'Come back here and hit Retry.',
  ]) {
    steps.appendChild(h('li', undefined, step));
  }
  const retryBtn = h('button', 'btn btn-ghost tv-retry');
  retryBtn.type = 'button';
  retryBtn.textContent = 'Retry';
  notice.append(noticeTitle, noticeBody, steps, retryBtn);
  el.appendChild(notice);

  /* ---------- strum board (beta) ---------- */

  const strumPanel = h('section', 'tv-strum');
  strumPanel.hidden = true;
  strumPanel.setAttribute('aria-label', 'Strum check');
  strumPanel.dataset.state = 'idle';

  const strumCard = h('div', 'card tv-strum-card');
  const flowEl = h('p', 'tv-flow', 'Strum all strings once');
  /* The flow line is decoration for the ear: everything it says is either in
     the board's own labels or in the one sentence the region below speaks per
     strum, and a live flow line would narrate "Listening… Analysing…" over the
     result the player is waiting for. */
  flowEl.setAttribute('aria-hidden', 'true');

  /* The mic's own pulse, beside the sentence that claims it is listening.
     Five hairlines whose heights ARE the smoothed input level — the newest
     sample in the middle, the two previous ones spreading outwards, so the
     room travels through the group instead of blinking in it. Nothing here
     has a clock: with no signal the bars sit at their floor for ever.
     Presentational, and never the only channel — the flow line says the same
     thing in words, and the region below says it out loud. */
  const levelEl = h('span', 'tv-listen-level');
  levelEl.setAttribute('aria-hidden', 'true');
  const levelBars: HTMLElement[] = [];
  for (let i = 0; i < LEVEL_BARS; i++) {
    const bar = h('span', 'tv-listen-bar');
    levelBars.push(bar);
    levelEl.appendChild(bar);
  }
  /* Newest first. Bar i shows history[|i - centre|], which is what makes the
     group a ripple rather than five copies of one number. */
  const levelHistory = new Float64Array(LEVEL_LAG + 1);
  const levelWritten = new Float64Array(LEVEL_BARS).fill(-1);

  /* The capture window, drawn. It exists because the two seconds between
     "Heard it" and a board full of numbers are otherwise two seconds of a
     screen that has not moved — the exact complaint this addendum answers.
     Determinate from end to end: one linear transition sized to the window
     the recorder is actually filling, so its position is the truth about how
     much of that window is on disk. */
  const progressEl = h('div', 'tv-strum-progress');
  progressEl.setAttribute('aria-hidden', 'true');
  const progressFill = h('span', 'tv-strum-progress-fill');
  progressEl.appendChild(progressFill);

  const board = h('ul', 'tv-board is-empty');
  /* Explicit, because the list marker is off: without it Safari drops the list
     semantics and the six rows stop being "1 of 6" to a screen reader. */
  board.setAttribute('role', 'list');
  board.setAttribute('aria-label', 'Strum results');

  const strumMsg = h('div', 'tv-strum-msg');
  strumMsg.hidden = true;
  const strumMsgTitle = h('p', 'tv-strum-msg-title');
  const strumMsgBody = h('p', 'tv-strum-msg-body');
  const strumMsgHint = h('p', 'tv-strum-msg-hint');
  /* The way out of a processed capture path, and the only one there is until
     the native recorder lands: the same app, on a path nothing is allowed to
     touch. Shown by CSS in the `processed` state alone, so the refusal and the
     octave-pair message can never grow a button that has nothing to do with
     them. `target=_blank` with `rel=noopener` because inside the WebView an
     external https navigation is what hands the URL to the system browser —
     and because a tuner that navigates ITSELF away mid-session is a tuner that
     lost your tuning. */
  const strumOpen = h('a', 'btn btn-primary tv-strum-open', 'Open in browser');
  strumOpen.href = LIVE_APP_URL;
  strumOpen.target = '_blank';
  strumOpen.rel = 'noopener';
  strumMsg.append(strumMsgTitle, strumMsgBody, strumMsgHint, strumOpen);

  /* The board prints transposed names too, so the capo has to be disclosed in
     the card the user is actually looking at — the Single-mode tag is hidden
     with the rest of that card while Strum is up. */
  const strumCapoTag = h('span', 'tv-capo tv-strum-capo');
  strumCapoTag.hidden = true;

  const strumFoot = h(
    'p',
    'tv-strum-foot',
    'Calibrated against real guitar recordings. Octave-paired tunings not yet supported.',
  );
  /* Beta diagnostics: the board can only be tuned against what the DEVICE
     heard, and a phone's capture path is not what a voice recorder hears.
     Kept in memory only until saved; one capture, overwritten per strum. */
  let lastCapture: { samples: Float32Array; sampleRate: number } | null = null;
  const strumSave = h('button', 'btn btn-ghost tv-strum-save', 'Save last strum (debug)');
  strumSave.type = 'button';
  strumSave.hidden = true;
  strumSave.addEventListener('click', () => {
    if (!lastCapture) return;
    const wav = encodeWav(lastCapture.samples, lastCapture.sampleRate);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const file = new File([blob], `strum-debug-${Date.now()}.wav`, { type: 'audio/wav' });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (nav.canShare?.({ files: [file] }) && navigator.share) {
      void navigator.share({ files: [file], title: 'TrueString strum capture' }).catch(() => saveBlob(blob, file.name));
      return;
    }
    saveBlob(blob, file.name);
  });

  /* The same overlay as Single mode, in the card that owns it. Both are inside
     containers that the mode switch hides outright, so the shared
     `.tv[data-phase="idle"] .tv-cta` rule can only ever reveal one of them. */
  const strumCta = h('div', 'tv-cta');
  const strumStartBtn = h('button', 'btn btn-primary tv-start');
  strumStartBtn.type = 'button';
  const strumStartLabel = h('span', undefined, 'Start listening');
  strumStartBtn.append(micIcon(), strumStartLabel);
  strumCta.append(
    strumStartBtn,
    h(
      'p',
      'tv-cta-note',
      'Your guitar is heard on-device only — nothing is recorded or uploaded.',
    ),
  );

  const strumHead = h('div', 'tv-strum-head');
  /* The ripple belongs to the sentence, not to the row: grouped so it sits
     against the end of "Listening —…" however wide the capo tag beside it
     turns out to be. */
  const flowGroup = h('div', 'tv-flow-group');
  flowGroup.append(flowEl, levelEl);
  strumHead.append(flowGroup, strumCapoTag);
  strumCard.append(strumHead, progressEl, board, strumMsg, strumFoot, strumSave, strumCta);
  strumPanel.appendChild(strumCard);
  el.appendChild(strumPanel);

  /* Outside the panel on purpose. A polite region only announces a MUTATION,
     and a region that was display:none when the text was written announces
     nothing at all when it is later revealed — which is exactly what the
     octave-pair state would hit, since its sentence is composed before the
     mode is on screen. Kept out of the mode switch entirely, and written only
     while strum mode is the mode. */
  const strumLive = h('span', 'sr-only tv-strum-live');
  strumLive.setAttribute('aria-live', 'polite');
  el.appendChild(strumLive);

  /** A pending start() ignores further taps, so the button must look inert. */
  function syncStartBtn(): void {
    startBtn.disabled = starting || phase === 'starting';
    strumStartBtn.disabled = strumStarting || phase === 'starting';
  }

  function setPhase(next: Phase): void {
    if (phase === next) return;
    phase = next;
    el.dataset.phase = next;
    syncStartBtn();
    const label = next === 'starting' ? 'Starting…' : 'Start listening';
    setText(startLabel, label);
    setText(strumStartLabel, label);
  }

  function setIdleVisual(on: boolean): void {
    el.classList.toggle('is-idle', on);
  }

  /** The one haptic gate in the view. Arrival at pitch and a guided confirm are
      900 ms apart, so the confirm normally lands inside the gate and the player
      feels a single buzz per string — which is the point of it. */
  function buzz(now: number, ms: number): void {
    if (now - lastVibeAt < VIBE_GAP_MS) return;
    lastVibeAt = now;
    navigator.vibrate?.(ms);
  }

  function setInTune(on: boolean, now: number): void {
    if (inTune === on) return;
    inTune = on;
    inTuneAt = now;
    el.classList.toggle('is-intune', on);
    if (on) buzz(now, 10);
  }

  function setActiveString(idx: number): void {
    if (activeIdx === idx) return;
    if (activeIdx >= 0 && activeIdx < pills.length) pills[activeIdx].classList.remove('is-active');
    if (idx >= 0 && idx < pills.length) pills[idx].classList.add('is-active');
    activeIdx = idx;
  }

  /** Players count strings from the thinnest, so the lowest string carries the
      highest number — the same numbering the tuning editor uses. The guide walks
      them in position order (lowest first), which is the reverse. */
  function stringNo(i: number): number {
    return targetNotes.length - i;
  }

  function pillLabel(i: number): string {
    const base = `String ${stringNo(i)}, ${spokenName(targetNotes[i])}`;
    return guideOn && done[i] === true ? `${base}, in tune` : base;
  }

  /** Writes the spoken half of the hint. A polite region whose text already ENDS
      with this sentence has already said it, and rewriting it is a second
      mutation, which a screen reader reads out a second time: that is how
      completion used to be announced twice — "…in tune. All strings in tune",
      then "All strings in tune" again when the hold expired. */
  function speak(text: string): void {
    const current = hintSpoken.textContent ?? '';
    if (current === text || current.endsWith(text)) return;
    setText(hintSpoken, text);
  }

  /** Writes the hint's two halves. The spoken half waits while a confirm
      sentence is still being read out. */
  function setHint(visible: string, spoken: string): void {
    setText(hintText, visible);
    pendingSpoken = spoken;
    if (performance.now() >= announceHoldUntil) speak(spoken);
  }

  /** Take the live region for one sentence, and keep it for ANNOUNCE_HOLD_MS. */
  function announce(text: string): void {
    announceHoldUntil = performance.now() + ANNOUNCE_HOLD_MS;
    setText(hintSpoken, text);
  }

  function renderStrip(): void {
    strip.textContent = '';
    activeIdx = -1;
    /* Guided, a pill is a control: tapping one moves the guide to that string.
       Unguided it is what it has always been — a read-only list item that the
       nearest-string pick highlights — so nothing here is focusable and the
       list semantics are untouched. */
    strip.setAttribute('role', guideOn ? 'group' : 'list');
    pills = targetNotes.map((note, i) => {
      let pill: HTMLElement;
      if (guideOn) {
        const button = h('button', 'pill tv-string');
        button.type = 'button';
        button.addEventListener('click', () => {
          selectGuide(i);
        });
        pill = button;
      } else {
        pill = h('span', 'pill tv-string');
        pill.setAttribute('role', 'listitem');
      }
      pill.append(
        checkIcon('tv-check'),
        h('span', 'tv-string-pc', prettyPc(note.pc)),
        h('span', 'tv-string-oct', String(note.octave)),
      );
      pill.setAttribute('aria-label', pillLabel(i));
      return pill;
    });
    for (const pill of pills) strip.appendChild(pill);
  }

  /** How many strings are ticked off. One source for the head counter and the
      spoken one, so the two can never disagree. */
  function doneCount(): number {
    let n = 0;
    for (let i = 0; i < targetNotes.length; i++) {
      if (done[i]) n++;
    }
    return n;
  }

  /** Pushes the guide's state onto the strip, the toggle and the head counter.
      Every one of these is an instant class or text swap — nothing here starts
      an animation. */
  function syncGuide(): void {
    const n = targetNotes.length;
    const count = doneCount();
    guideBtn.setAttribute('aria-pressed', guideOn ? 'true' : 'false');
    el.classList.toggle('is-guided', guideOn);
    el.classList.toggle('is-complete', guideOn && complete);
    setText(
      stringsTitle,
      !guideOn ? 'Strings' : complete ? 'All in tune' : `${count} of ${n} in tune`,
    );
    stringsTitle.classList.toggle('is-done', guideOn && complete);
    for (let i = 0; i < pills.length; i++) {
      const pill = pills[i];
      const isDone = guideOn && done[i] === true;
      const isGuided = guideOn && i === guideIndex;
      pill.classList.toggle('is-done', isDone);
      pill.classList.toggle('is-guided', isGuided);
      if (isGuided) pill.setAttribute('aria-current', 'true');
      else pill.removeAttribute('aria-current');
      pill.setAttribute('aria-label', pillLabel(i));
    }
  }

  function resetGuideProgress(): void {
    done = targetNotes.map(() => false);
    guideIndex = 0;
    complete = false;
    recheckStreak = 0;
    holdIdx = -1;
  }

  /** Drop the latch so the string the guide just moved to has to earn its own
      three frames and its own dwell, instead of inheriting the last one's. For
      the moves the PLAYER makes — the toggle, a pill, a string that drifted —
      where the card going out of its in-tune state is the honest answer. */
  function restartLatch(now: number): void {
    inTuneStreak = 0;
    recheckStreak = 0;
    holdIdx = -1;
    guideSince = now;
    setInTune(false, now);
  }

  /** Give the display back after a confirm's success readout. The in-tune latch
      is deliberately NOT forced off here: by now the player has usually moved on
      to the next string, and if that one is already at pitch, dropping green for
      a frame and taking it straight back is a flash. The ordinary path below
      turns it off on the very next frame if the new target is out of tune, which
      is the only case where it should go — while `guideSince` still makes the
      new string serve its own 900 ms before it can be confirmed. */
  function endHold(now: number): void {
    if (holdIdx < 0) return;
    holdIdx = -1;
    inTuneStreak = 0;
    recheckStreak = 0;
    guideSince = now;
  }

  function setGuideOn(on: boolean): void {
    if (guideOn === on) return;
    guideOn = on;
    resetGuideProgress();
    renderStrip();
    const now = performance.now();
    restartLatch(now);
    syncGuide();
    // Live, the next detection (25 ms away) redraws the readout against the new
    // target; idle, this is what refreshes the hint.
    if (relaxed || !mic) relax(true, now);
  }

  /** Tapping a pill moves the guide there. A finished string gives its check
      back when it is revisited: the player is asking to tune it again. */
  function selectGuide(i: number): void {
    if (!guideOn || i < 0 || i >= targetNotes.length) return;
    const now = performance.now();
    done[i] = false;
    complete = false;
    guideIndex = i;
    restartLatch(now);
    syncGuide();
    if (relaxed || !mic) relax(true, now);
  }

  function nextNotDone(from: number): number {
    const n = targetNotes.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!done[i]) return i;
    }
    return -1;
  }

  function confirmGuided(now: number): void {
    const i = guideIndex;
    if (i < 0 || i >= targetNotes.length) return;
    done[i] = true;
    buzz(now, 24);
    // Player numbering names the string; the COUNT is the progress the head
    // counter is showing at this instant. They used to be the same number read
    // two ways — "String 6 of 6" for the first string of six confirmed, next to
    // a head reading "1 of 6 in tune".
    const line =
      `String ${stringNo(i)}, ${spokenName(targetNotes[i])} — in tune. ` +
      `${doneCount()} of ${targetNotes.length} done`;
    const next = nextNotDone(i);
    // The string is still ringing: hold the readout on it, in tune and green,
    // while the strip moves on. endHold() takes it back.
    holdIdx = i;
    holdUntil = now + GUIDE_HOLD_MS;
    inTuneStreak = 0;
    recheckStreak = 0;
    guideSince = now;
    if (next < 0) {
      complete = true;
      // Nothing left to point at: the readout goes back to naming whatever it
      // hears, which is what makes re-plucking a drifted string reopen it.
      guideIndex = -1;
      // Both sentences in one write — a second write 0 ms later would replace
      // the first before it was ever spoken.
      announce(`${line}. All strings in tune`);
    } else {
      guideIndex = next;
      announce(line);
    }
    syncGuide();
  }

  /** A finished string that has drifted takes its check back and becomes the
      target again. */
  function reopenGuide(i: number, now: number): void {
    done[i] = false;
    complete = false;
    guideIndex = i;
    restartLatch(now);
    setActiveString(-1);
    syncGuide();
  }

  /* ================= strum check (beta) ================= */

  /** Everything the board is claiming, dropped in one go. Called whenever the
      targets move or the mic closes: a row's number is a measurement against a
      particular target frequency, and it stops being true the moment that
      frequency does. */
  function clearBoard(): void {
    board.classList.add('is-empty');
    for (let i = 0; i < boardRows.length; i++) {
      const row = boardRows[i];
      row.el.className = 'tv-row';
      row.el.setAttribute('aria-label', rowLabel(i, null));
      row.bar.className = 'tv-bar';
      row.fill.removeAttribute('style');
      row.fill.hidden = true;
      setText(row.cents, '—');
      setText(row.arrow, '');
      row.note.hidden = true;
    }
  }

  /** One row per target, low string first — the same order as the strip above
      it in Single mode, so "string 6" is the top row in both. */
  function renderBoard(): void {
    board.textContent = '';
    boardRows = targetNotes.map((note, i) => {
      const li = h('li', 'tv-row');
      const no = h('span', 'tv-row-no', String(stringNo(i)));
      no.setAttribute('aria-hidden', 'true');
      const name = h('span', 'tv-row-name');
      name.setAttribute('aria-hidden', 'true');
      name.append(
        h('span', 'tv-row-pc', prettyPc(note.pc)),
        h('span', 'tv-row-oct', String(note.octave)),
      );

      const bar = h('span', 'tv-bar');
      bar.setAttribute('aria-hidden', 'true');
      const fill = h('span', 'tv-bar-fill');
      fill.hidden = true;
      bar.append(h('span', 'tv-bar-zero'), fill);

      const cents = h('span', 'tv-row-cents', '—');
      cents.setAttribute('aria-hidden', 'true');

      const mark = h('span', 'tv-row-mark');
      mark.setAttribute('aria-hidden', 'true');
      const arrow = h('span', 'tv-row-arrow');
      mark.append(checkIcon('tv-row-check'), arrow);

      /* The honest per-string no-reading state (condition 5). It takes the
         width of the bar and the figure rather than sitting under them: a row
         with nothing measured has no bar to draw and no number to print, and
         leaving an empty track there reads as "0 cents". */
      const note2 = h('span', 'tv-row-note', 'Couldn’t confirm — strum again or pluck it alone');
      note2.setAttribute('aria-hidden', 'true');
      note2.hidden = true;

      li.append(no, name, bar, cents, mark, note2);
      li.setAttribute('aria-label', rowLabel(i, null));
      return { el: li, bar, fill, cents, arrow, note: note2 };
    });
    for (const row of boardRows) board.appendChild(row.el);
    clearBoard();
  }

  /** The whole meaning of a row, in one string, for the ear. `null` is the
      board before anything has been strummed — a target, with no claim about
      it. */
  function rowLabel(i: number, result: StrumStringResult | null): string {
    const base = `String ${stringNo(i)}, ${spokenName(targetNotes[i])}`;
    if (!result) return base;
    if (!result.detected || result.cents === null) return `${base}, not confirmed`;
    // The SAME rounded figure the row prints (see fillRow): a row that says
    // "+5¢" is in tune to the eye and to the ear, and one that says "+6¢" is not
    // in either. Deciding on the unrounded value put "+5¢ ↓ sharp" next to
    // "+5¢ ✓ in tune" on adjacent rows.
    const shown = Math.round(result.cents);
    if (Math.abs(shown) <= STRUM_IN_TUNE_CENTS) return `${base}, in tune`;
    return `${base}, ${centsPhrase(shown)}`;
  }

  /** Draw one measurement. The bar saturates at ±STRUM_BAR_CENTS and says so
      with a rail marker; the figure never does. */
  function fillRow(i: number, result: StrumStringResult): void {
    const row = boardRows[i];
    const cents = result.cents;
    if (!result.detected || cents === null) {
      row.el.className = 'tv-row is-unknown';
      row.bar.className = 'tv-bar';
      row.fill.hidden = true;
      row.fill.removeAttribute('style');
      setText(row.cents, '—');
      setText(row.arrow, '');
      row.note.hidden = false;
      row.el.setAttribute('aria-label', rowLabel(i, result));
      return;
    }

    // Round ONCE, then decide everything from that one number — the verdict,
    // the arrow, the bar, the rail, the figure and the sentence. Judging the
    // unrounded offset while printing the rounded one made the board contradict
    // itself: anything in [4.5, 5.5) prints "±5¢" but landed on either side of
    // the in-tune line, so one row read "+5¢ ↓" and the next "+5¢ ✓".
    const shown = Math.round(cents);
    const done = Math.abs(shown) <= STRUM_IN_TUNE_CENTS;
    row.el.className = `tv-row${done ? ' is-done' : shown < 0 ? ' is-flat' : ' is-sharp'}`;
    row.note.hidden = true;

    const span = Math.min(Math.abs(shown), STRUM_BAR_CENTS) / STRUM_BAR_CENTS;
    row.fill.hidden = false;
    row.fill.style.width = `${(span * 50).toFixed(2)}%`;
    if (shown < 0) {
      row.fill.style.right = '50%';
      row.fill.style.left = 'auto';
    } else {
      row.fill.style.left = '50%';
      row.fill.style.right = 'auto';
    }
    row.bar.className =
      Math.abs(shown) > STRUM_BAR_CENTS
        ? `tv-bar ${shown < 0 ? 'is-peg-lo' : 'is-peg-hi'}`
        : 'tv-bar';

    setText(row.cents, formatCents(shown));
    setText(row.arrow, done ? '' : shown < 0 ? '↑' : '↓');
    row.el.setAttribute('aria-label', rowLabel(i, result));
  }

  /** One sentence per strum. Named strings are capped so the region stays
      speakable; past the cap the rest are counted. */
  function boardSentence(results: readonly StrumStringResult[]): string {
    const n = results.length;
    let inTune = 0;
    let unknown = 0;
    const off: { i: number; cents: number }[] = [];
    for (let i = 0; i < n; i++) {
      const r = results[i];
      // Rounded, exactly as fillRow prints it: the count spoken here has to be
      // the count of ticks on screen.
      const shown = r.cents === null ? null : Math.round(r.cents);
      if (!r.detected || shown === null) {
        unknown++;
      } else if (Math.abs(shown) <= STRUM_IN_TUNE_CENTS) {
        inTune++;
      } else {
        off.push({ i, cents: shown });
      }
    }
    if (unknown === 0 && off.length === 0) {
      return `All ${n} strings in tune.`;
    }
    const parts = [`${inTune} of ${n} in tune.`];
    off.sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
    for (const item of off.slice(0, STRUM_SPEAK_MAX)) {
      parts.push(
        `String ${stringNo(item.i)}, ${spokenName(targetNotes[item.i])}, ${centsPhrase(item.cents)}.`,
      );
    }
    const rest = off.length - STRUM_SPEAK_MAX;
    if (rest > 0) parts.push(`And ${rest} more out of tune.`);
    if (unknown > 0) {
      parts.push(`${unknown} ${unknown === 1 ? 'string' : 'strings'} not confirmed.`);
    }
    return parts.join(' ');
  }

  /**
   * The strum panel's own polite region. The Single-mode hint region cannot
   * serve here: it lives inside the gauge card, which this mode hides, and a
   * display:none region announces nothing.
   *
   * By default a region already holding this sentence is not rewritten, because
   * a rewrite is a second mutation and a second reading — that is right for the
   * state re-compositions (a tuning change, construction) that pass through
   * here. It is exactly wrong for a RESULT: two strums that measure the same
   * produce the same sentence, and the board's numbers do not move either, so a
   * player who cannot see the screen got nothing at all for strums 2..N — no way
   * to tell heard from mis-heard from ignored. Every analysis therefore forces
   * its own announcement, by emptying the region first so the write that follows
   * is a real mutation.
   */
  function speakStrum(text: string, force = false): void {
    // Only this mode speaks here, and only while it is the mode on screen: the
    // board's states are composed on tuning changes and at construction too,
    // and none of those are things to read out to somebody using Single mode.
    if (mode !== 'strum') return;
    if ((strumLive.textContent ?? '') === text) {
      if (!force) return;
      setText(strumLive, '');
      // Next frame, not this one: clearing and rewriting inside a single task
      // nets out to no change at all by the time assistive tech looks, and
      // announces nothing. Two frames are two mutations, and the second reads.
      const seq = strumSeq;
      requestAnimationFrame(() => {
        if (mode === 'strum' && seq === strumSeq) setText(strumLive, text);
      });
      return;
    }
    setText(strumLive, text);
  }

  /* ---------- the cycle's own feedback (v2.0.2) ---------- */

  /**
   * The states in which the mic is open and the next strum would be picked up
   * on the spot.
   *
   * The spec's line is "visible only in the armed state", and `armed` alone is
   * the wrong reading of it: the board auto-rearms, so after the first strum
   * of a session the mode sits in `results` (or `refused`) for ever — both of
   * which print "Strum again any time" and both of which are listening. Gating
   * the ripple on the literal state showed it once, before the first strum,
   * and never again for the rest of the session — which is precisely the loop
   * this addendum exists to acknowledge. What "only armed" excludes is `idle`
   * (no mic), `analysing` (the level being drawn would be a chord the analyser
   * has already taken its window from) and `unsupported` (never listens).
   */
  const strumWaiting = (s: StrumState): boolean =>
    s === 'armed' || s === 'results' || s === 'refused';

  /**
   * One level update from the tap, ~12 times a second. The bars are written
   * only while the mode is waiting for a strum and only while motion is
   * wanted, so the callback costs a comparison and returns the rest of the
   * time — including through the two seconds of a capture, where the ripple is
   * off screen and whatever it would have shown is not about the room any
   * more. A room that stays put stops the writes too: a sample that moves no
   * bar by LEVEL_EPSILON touches no style at all.
   */
  function handleLevel(rms: number): void {
    if (!strumWaiting(strumState) || lessMotion?.matches) return;
    for (let i = levelHistory.length - 1; i > 0; i--) levelHistory[i] = levelHistory[i - 1];
    levelHistory[0] = rms;
    const centre = (LEVEL_BARS - 1) / 2;
    for (let i = 0; i < LEVEL_BARS; i++) {
      const v = levelHistory[Math.abs(i - centre)];
      const scale = LEVEL_FLOOR + (1 - LEVEL_FLOOR) * v;
      if (Math.abs(scale - levelWritten[i]) < LEVEL_EPSILON) continue;
      levelWritten[i] = scale;
      levelBars[i].style.transform = `scaleY(${scale.toFixed(3)})`;
    }
  }

  /** Park the ripple at its floor. A mode that has stopped waiting is not
      hearing anything, and the height it stopped at is not news about the
      room — so the next state to show the bars finds them at rest rather than
      holding the last chord's attack. */
  function restLevel(): void {
    levelHistory.fill(0);
    for (let i = 0; i < LEVEL_BARS; i++) {
      if (levelWritten[i] === LEVEL_FLOOR) continue;
      levelWritten[i] = LEVEL_FLOOR;
      levelBars[i].style.transform = `scaleY(${LEVEL_FLOOR})`;
    }
  }

  /** Back to empty, with no motion of any kind between where the bar was and
      zero — a superseded run must not be seen travelling backwards. */
  function resetProgress(): void {
    for (const id of progressTimers) window.clearTimeout(id);
    progressTimers.length = 0;
    progressFill.style.transition = 'none';
    progressFill.style.transform = 'scaleX(0)';
  }

  /**
   * Run the bar across exactly the window the recorder is filling. Smooth
   * motion is one linear transition — determinate, driven by the clock the
   * capture itself runs on, and free of any per-frame work on this thread.
   *
   * Under a reduced-motion preference the same window is spent in four steps
   * instead: style.css cuts every transition to 0.01 ms under that preference
   * (correctly — a 2.4 s slide IS motion), so a transition would arrive as an
   * instantly-full bar, which is a lie about the window and a jump besides.
   */
  function startProgress(seconds: number): void {
    resetProgress();
    // Commit the reset before the run begins, or the two writes coalesce and
    // the bar transitions from wherever the last strum left it.
    void progressFill.offsetWidth;
    if (lessMotion?.matches) {
      const step = (seconds * 1000) / PROGRESS_STEPS;
      for (let i = 1; i <= PROGRESS_STEPS; i++) {
        const at = i / PROGRESS_STEPS;
        progressTimers.push(
          window.setTimeout(() => {
            progressFill.style.transform = `scaleX(${at})`;
          }, step * i),
        );
      }
      return;
    }
    progressFill.style.transition = `transform ${seconds}s linear`;
    progressFill.style.transform = 'scaleX(1)';
  }

  /** Everything the mode puts on screen to say "this strum, right now": the
      old board dimmed out of the way, and the window drawn as it records. */
  function beginCapture(): void {
    board.classList.add('is-stale');
    startProgress(strumCap?.windowSeconds ?? PROGRESS_FALLBACK_S);
  }

  /** ...and its exit, wherever the capture ends: results, a refusal, a failed
      analysis, a tuning change, the mode closing. */
  function endCapture(): void {
    board.classList.remove('is-stale');
    resetProgress();
  }

  function setStrumState(next: StrumState): void {
    if (strumState === next) return;
    const previous = strumState;
    strumState = next;
    strumPanel.dataset.state = next;
    // The dim and the bar belong to the capture, and 'analysing' IS the
    // capture. Leaving it — with numbers, with a refusal, or with nothing —
    // ends both in the same style change that turned them on.
    if (next !== 'analysing') endCapture();
    if (!strumWaiting(next)) restLevel();
    if (next === 'armed') {
      // Only worth saying when the mode has just become usable — after the
      // unsupported state, after the capture-path check, or on the first open.
      // Re-arming after a result is silent: the result sentence is still the
      // thing being read.
      if (previous === 'unsupported' || previous === 'idle' || previous === 'checking') {
        speakStrum('Listening. Strum all strings once.');
      }
    }
    renderStrum();
  }

  /** Pushes the flow line and which of board / message is on screen. Every one
      of these is an instant text or hidden swap — nothing in this mode
      animates, and nothing in it changes luminance on its own clock. */
  function renderStrum(): void {
    const blocked = strumLatched(strumState) || strumState === 'refused';
    board.hidden = blocked;
    strumMsg.hidden = !blocked;
    let flow: string;
    switch (strumState) {
      case 'checking':
        // The one second and a half between the microphone opening and the mode
        // arming itself, on the platforms where the app has to find out what
        // the system is doing to the capture first. It plays a tone while this
        // is on screen, so the screen had better say why.
        flow = 'Checking the microphone path…';
        break;
      case 'analysing':
        // Written at the ONSET, not at the delivery — see handleOnset. "Heard
        // it" is the claim that can honestly be made 0.26 s in, and it is the
        // only thing on screen for the two seconds the window takes to record.
        flow = 'Heard it — reading…';
        break;
      case 'armed':
        // The one sentence that teaches the mode used to live in the idle state
        // only, under the start overlay's own veil (1.32:1 against it), and was
        // replaced by "Listening…" the instant the mic opened — so a sighted
        // player never got to read it. It belongs in the phase where the card is
        // uncovered and the instruction is still true.
        flow = 'Listening — strum all six strings once';
        break;
      case 'results':
      case 'refused':
        flow = 'Strum again any time';
        break;
      case 'unsupported':
      case 'processed':
        flow = 'Strum check unavailable';
        break;
      default:
        flow = 'Strum all strings once';
    }
    setText(flowEl, flow);
  }

  /** Condition 2. Shown INSTEAD of listening: the capture is never opened for
      one of these tunings, so there is no chance of a number reaching the
      board through some later path. */
  function renderUnsupported(): void {
    const name = tuningById(state.tuningId).name;
    setText(strumMsgTitle, 'Not ready for this tuning');
    setText(
      strumMsgBody,
      `Strum check can’t separate two strings an octave apart yet, and ${name} has a pair. Single mode reads this tuning exactly as it always has.`,
    );
    setText(strumMsgHint, '');
    strumMsgHint.hidden = true;
    speakStrum(
      `Strum check is not reliable for octave-paired tunings yet. ${name} has a pair. Use Single mode.`,
    );
  }

  /**
   * v2.1's capture-path verdict, shown INSTEAD of listening.
   *
   * The probe played a tone and got back an envelope the system had been at:
   * faded, pumped or cancelled. A ringing chord gets the same treatment, and
   * the strum analyser reads a flattened chord as noise — so no number this
   * mode could produce here would mean anything, and none is ever produced. The
   * monophonic tuner is untouched by any of it (a period detector only needs
   * the zero crossings to stay put), which is why the card sends the player
   * there as well as to the browser.
   */
  function renderProcessed(): void {
    setText(strumMsgTitle, 'This app’s microphone path is processed by the system');
    setText(
      strumMsgBody,
      'Android is putting noise suppression and automatic gain in front of this app’s microphone, and nothing the app can ask for turns them off. A ringing chord arrives flattened, so Strum check can’t read it here — and it will never show you a number it doesn’t trust. Single mode is unaffected and tunes exactly as it always has. Strum check works in the browser, where the capture is untouched.',
    );
    setText(strumMsgHint, '');
    strumMsgHint.hidden = true;
    speakStrum(
      'This app’s microphone path is processed by the system, so Strum check cannot read it here. Single mode still works. Open TrueString in your browser for Strum check.',
    );
  }

  /** Condition 1. The analysis said the whole instrument is off by about a
      semitone, which is almost always a capo the app does not know about (or
      one it thinks is there and is not) — and past that offset the per-string
      estimates are searching against the wrong targets, so not one of them is
      printed. */
  function renderRefusal(): void {
    const capo = state.capo;
    setText(strumMsgTitle, 'Can’t trust this reading');
    setText(
      strumMsgBody,
      'The whole guitar reads about a semitone off — check the capo setting, then use Single mode.',
    );
    setText(
      strumMsgHint,
      capo > 0
        ? `The app has a capo at fret ${capo}. Clear it in the tuning sheet if the neck is open.`
        : 'The app has no capo set. Add one in the tuning sheet if there is one on the neck.',
    );
    strumMsgHint.hidden = false;
    // Forced: a second strum that is refused for the same reason is still a
    // second strum, and the message on screen does not change to say so.
    speakStrum(
      'Reading refused. The whole guitar reads about a semitone off — check the capo setting, then use Single mode.',
      true,
    );
  }

  function applyStrumResult(res: StrumResult): void {
    if (res.refusal) {
      // Numbers from a refused analysis are never displayed, so they are never
      // written into the rows in the first place.
      clearBoard();
      renderRefusal();
      setStrumState('refused');
      renderStrum();
      return;
    }
    // A result measured against a different number of strings than the board
    // is showing was queued before a tuning change that the sequence guard
    // somehow let through. Say nothing rather than something wrong.
    if (res.strings.length !== boardRows.length) {
      setStrumState('armed');
      return;
    }
    board.classList.remove('is-empty');
    for (let i = 0; i < boardRows.length; i++) fillRow(i, res.strings[i]);
    setStrumState('results');
    renderStrum();
    // Forced, for the same reason: two identical strums must be two
    // announcements, or the board is silent about all but the first.
    speakStrum(boardSentence(res.strings), true);
  }

  /* ---------- analysis transport ---------- */

  /**
   * Condition 6's off-main-thread half, wrapped in a deadline.
   *
   * `analyzeStrumAsync` owns the worker (and the FFT tables warming inside it)
   * and falls back to this thread where a module worker cannot be built. What
   * it does not do is settle when the worker dies mid-request: the promise for
   * that strum is simply never resolved, and `strumBusy` would hold the board
   * on "Analysing…" for the rest of the session. A whole analysis is 40–150 ms,
   * so anything past STRUM_TIMEOUT_MS is a wedge, not a slow machine.
   */
  function analyse(
    samples: Float32Array,
    sampleRate: number,
    targetFreqs: number[],
  ): Promise<StrumResult> {
    let timer = 0;
    const deadline = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('strum-timeout')), STRUM_TIMEOUT_MS);
    });
    return Promise.race([analyzeStrumAsync(samples, sampleRate, targetFreqs), deadline]).finally(
      () => {
        window.clearTimeout(timer);
      },
    );
  }

  /**
   * The strings have been hit and the onset is confirmed — 0.26 s in, with the
   * whole 2.1 s capture window still to record.
   *
   * Reacting to the DELIVERY instead left the screen unchanged for 2.1 s after
   * the strum and then flashed "Analysing…" past in 35-125 ms, which is a state
   * nobody can read: the player got no feedback while it mattered and an
   * unreadable one when it did not. Same DSP, same numbers; the difference is
   * that the mode now answers when it is spoken to.
   */
  function handleOnset(): void {
    if (mode !== 'strum' || octaveBlocked || strumBusy) return;
    strumAckAt = performance.now();
    // Before the state change, so the first paint of "Heard it — reading…"
    // already carries the dimmed board and an empty bar rather than showing
    // the previous strum's numbers at full strength for a frame.
    beginCapture();
    setStrumState('analysing');
  }

  /** Hold the acknowledgement on screen long enough to be read, however fast
      the worker comes back. From the onset that is always true already; this is
      the guard for the paths that reach the analysis without one. */
  function settleAck(): Promise<void> {
    const left = STRUM_ACK_MIN_MS - (performance.now() - strumAckAt);
    if (left <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      window.setTimeout(resolve, left);
    });
  }

  async function handleStrum(samples: Float32Array, sampleRate: number): Promise<void> {
    if (mode !== 'strum' || octaveBlocked) return;
    // A second strum while the first is still in the worker is dropped rather
    // than queued: the player strummed again because they want the CURRENT
    // state of the instrument, and a stale board arriving after a fresh one
    // would overwrite it.
    if (strumBusy) return;
    strumBusy = true;
    const id = ++strumSeq;
    if (strumState !== 'analysing') {
      // A delivery that reached here without an onset of its own — the ack
      // hold's whole reason for existing. It gets the same acknowledgement,
      // and the bar runs from zero rather than picking up a stale position.
      strumAckAt = performance.now();
      beginCapture();
      setStrumState('analysing');
    }
    const targetFreqs = targetNotes.map((note) => note.freq);
    try {
      const res = await analyse(samples, sampleRate, targetFreqs);
      if (id !== strumSeq || mode !== 'strum') return;
      await settleAck();
      if (id !== strumSeq || mode !== 'strum') return;
      lastCapture = { samples, sampleRate };
      strumSave.hidden = false;
      applyStrumResult(res);
    } catch {
      if (id !== strumSeq || mode !== 'strum') return;
      // Nothing to show and nothing honest to say about why. Go back to
      // waiting, keeping whatever the last good strum put on the board.
      setStrumState(board.classList.contains('is-empty') ? 'armed' : 'results');
    } finally {
      strumBusy = false;
    }
  }

  /* ---------- capture lifecycle ---------- */

  /** Condition 2's gate, recomputed from the live targets. Returns true when
      the answer changed, because the caller has to decide whether to open or
      close the capture on the back of it. */
  function syncOctaveGate(): boolean {
    const next = hasOctavePair(targetNotes.map((note) => note.midi));
    if (next === octaveBlocked) return false;
    octaveBlocked = next;
    return true;
  }

  /**
   * v2.1's capture-path probe, and every reason not to run it.
   *
   * Returns the verdict, or 'unknown' wherever there is no honest measurement
   * to be had — which is also what every uncertainty resolves to, because
   * uncertainty must never take a working mode away from a player. Only a
   * 'processed' verdict blocks anything.
   */
  async function checkCapturePath(capture: MicCapture): Promise<CapturePath> {
    // Chrome proper is the path every measurement in this repo was taken
    // through; it is known-good and is never made to listen to a test tone.
    if (!isProcessedCapturePlatform()) return 'unknown';
    const known = capturePathVerdict();
    if (known) return known;
    // The tone would be played into the metronome, and the metronome would be
    // played into the envelope. Skip, and ask again next time.
    if (metronomeSounding || droneSounding) return 'unknown';
    setStrumState('checking');
    const verdict = await probeCapturePath(capture);
    return verdict;
  }

  /**
   * v2.1's native capture path (the APK, from this version on).
   *
   * There is no probe here and no `getUserMedia` here: the plugin opens the
   * least-processed input the device has and streams PCM straight to
   * NativeStrumCapture, which runs the identical recorder. The probe exists to
   * discover a mangled capture path — a question with an answer that no longer
   * matters once the app can simply not use that path.
   */
  async function startNativeStrum(): Promise<void> {
    // Android promises nothing about two capture clients in one process, and
    // Single mode may have left the WebView's stream open on the way in. It
    // goes before AudioRecord opens — and this also drops the wake lock, which
    // is re-held below once the native session is actually running.
    stop();
    strumStarting = true;
    setPhase('starting');
    syncStartBtn();
    const capture = new NativeStrumCapture();
    capture.onOnset = handleOnset;
    capture.onLevel = handleLevel;
    capture.onStrum = (samples: Float32Array, sampleRate: number): void => {
      void handleStrum(samples, sampleRate);
    };
    const release = (): void => {
      capture.onStrum = null;
      capture.onOnset = null;
      capture.onLevel = null;
      capture.stop();
    };
    try {
      // The band the web path would have been built at, so both hear the same
      // one: the highpass sits just under the tuning's lowest string.
      applyAnalysisFloor(null);
      await capture.start({
        targetFreqs: targetNotes.map((note) => note.freq),
        highpassHz: analysisFloorHz,
      });
      // RECORD_AUDIO is one grant: having it for AudioRecord is having it for
      // getUserMedia, which is what Single mode will ask for on the way back.
      micGrantedThisSession = true;
      if (!visible || mode !== 'strum') {
        release();
        setPhase('idle');
        return;
      }
      strumCap = capture;
      holdWake('tuner');
      setPhase('live');
      setStrumState('armed');
    } catch (err) {
      release();
      showNotice(err);
    } finally {
      strumStarting = false;
      syncStartBtn();
    }
  }

  async function startStrum(): Promise<void> {
    if (strumStarting || strumCap) return;
    if (octaveBlocked) {
      renderUnsupported();
      setStrumState('unsupported');
      renderStrum();
      return;
    }
    // The native recorder, where there is one, is preferred unconditionally: it
    // is the capture path the analyser was measured on, and the probe's whole
    // subject — what the system does to the WebView's microphone — stops being
    // a question the moment the app stops using it.
    if (isNativeCaptureAvailable()) {
      await startNativeStrum();
      return;
    }
    // Already asked, already answered. The verdict is a fact about the device,
    // so the mic is never opened again to re-learn it.
    if (capturePathVerdict() === 'processed') {
      stop();
      renderProcessed();
      setStrumState('processed');
      renderStrum();
      return;
    }
    strumStarting = true;
    setPhase('starting');
    syncStartBtn();
    // The view's OWN microphone, handed to the tap below. Given none,
    // StrumCapture opens one of its own — and then the "same filtered chain"
    // this mode is built on is a second, private chain: a second getUserMedia on
    // every mode switch, and an analysis floor only the tuner's mic ever hears
    // about. One mic, one graph, one floor (v2.0 condition 3).
    const shared = mic ?? new MicCapture();
    // Before the graph exists, for the same reason Single mode does it: a
    // highpass built at the tuning's cutoff never has to ramp there.
    applyAnalysisFloor(shared);
    try {
      // Opened here rather than inside StrumCapture.start(), because the
      // capture-path probe has to hear the room through this very graph and has
      // to answer BEFORE anything starts listening for strums. Permission flows
      // exactly as it always did — this is the same MicCapture.start().
      if (!shared.running) await shared.start();
      micGrantedThisSession = true;
      if (!visible || mode !== 'strum') {
        releaseUnadopted(shared);
        setPhase('idle');
        return;
      }
      // Adopted before the probe: the tone plays for a second and a half, and a
      // microphone nobody owns for a second and a half is a microphone nobody
      // closes. `stop()` below can only close the view's own.
      mic = shared;
      holdWake('tuner');
      setPhase('live');
      const path = await checkCapturePath(shared);
      if (!visible || mode !== 'strum') {
        // Somebody left while the tone was playing. Whoever is here now owns
        // the microphone — hide() has already closed it, Single mode has
        // already taken it over — so there is nothing to undo.
        return;
      }
      if (path === 'processed') {
        // No listening, no capture, no numbers. Close the microphone too: a
        // mode that is showing an explanation instead of running has no reader
        // on the stream, and leaving the OS indicator lit for it is a lie.
        stop();
        renderProcessed();
        setStrumState('processed');
        renderStrum();
        return;
      }
      const capture = new StrumCapture();
      capture.onOnset = handleOnset;
      capture.onLevel = handleLevel;
      capture.onStrum = (samples: Float32Array, sampleRate: number): void => {
        void handleStrum(samples, sampleRate);
      };
      // The targets choose the recorded window: a tuning whose lowest string
      // needs the 32768-point transform needs the longer one, and a capture
      // opened without them would hand the first strum a window too short for
      // the analyser's last frame.
      await capture.start({ mic: shared, targetFreqs: targetNotes.map((note) => note.freq) });
      // The mode or the tab may have changed while the tap was being built; a
      // capture nobody is watching is closed on the spot. The microphone is the
      // view's by now, so whoever took over owns it — and closing it here would
      // take it out from under Single mode.
      if (!visible || mode !== 'strum') {
        capture.onStrum = null;
        capture.onOnset = null;
        capture.onLevel = null;
        capture.stop();
        return;
      }
      strumCap = capture;
      setStrumState('armed');
    } catch (err) {
      // A stream that opened before something further down failed belongs to
      // nobody, and nobody would ever close it. One this view had already
      // adopted — the probe runs after adoption — goes out the same door every
      // other failed session goes out of.
      if (shared === mic) stop();
      else releaseUnadopted(shared);
      showNotice(err);
    } finally {
      strumStarting = false;
      syncStartBtn();
    }
  }

  /** Close a microphone this view opened but never took ownership of. */
  function releaseUnadopted(capture: MicCapture): void {
    if (capture === mic) return;
    capture.stop();
    micFloorHz = 0;
  }

  function stopStrum(): void {
    if (strumCap) {
      strumCap.onStrum = null;
      strumCap.onOnset = null;
      strumCap.onLevel = null;
      // The mic is the view's, not the capture's, so this detaches the tap and
      // leaves the stream open for Single mode.
      strumCap.stop();
      strumCap = null;
    }
    releaseWake('tuner');
    // Anything still in the worker is now about a microphone that is closed.
    strumSeq++;
    strumBusy = false;
    // The bar and the dim outlive the state machine on the paths that assign
    // `strumState` directly (an unsupported tuning), so they are dropped here
    // as well as in setStrumState.
    endCapture();
    restLevel();
    if (mode === 'strum' && (phase === 'live' || phase === 'starting')) setPhase('idle');
    if (!strumLatched(strumState)) setStrumState('idle');
  }

  /** Targets moved (tuning, capo or A4): every number on the board was measured
      against the old ones, so the board goes back to naming strings. Re-runs
      the octave gate too — the new tuning may be one this mode cannot read, or
      may be the first one it can. */
  function resetStrum(): void {
    strumSeq++;
    strumBusy = false;
    // Every number the board is holding was measured against the old targets,
    // and so was the capture the bar is drawing. Both go at once.
    endCapture();
    renderBoard();
    // A live capture keeps recording, but the window it records has to follow
    // the new targets — a drop to a bass tuning lengthens it.
    strumCap?.setTargets(targetNotes.map((note) => note.freq));
    const gateChanged = syncOctaveGate();
    // A processed capture path is a fact about the device, not about the
    // tuning: new targets do not stop the system mangling the microphone. The
    // card stays exactly where it is, and nothing re-opens behind it.
    if (strumState === 'processed') {
      renderProcessed();
      renderStrum();
      return;
    }
    if (mode !== 'strum') {
      strumState = octaveBlocked ? 'unsupported' : 'idle';
      strumPanel.dataset.state = strumState;
      if (octaveBlocked) renderUnsupported();
      renderStrum();
      return;
    }
    if (octaveBlocked) {
      // Same as entering the mode on one of these tunings: nothing is listening
      // through the shared stream any more, so it does not stay open.
      if (strumCap) stopStrum();
      stop();
      renderUnsupported();
      setStrumState('unsupported');
      renderStrum();
      return;
    }
    if (gateChanged && !strumCap && visible && micGrantedThisSession && phase !== 'blocked') {
      // The tuning that was blocking this mode has gone: open the mic the way
      // entering the mode would have.
      setStrumState('idle');
      void startStrum();
      return;
    }
    setStrumState(strumCap ? 'armed' : 'idle');
    renderStrum();
  }

  function syncMode(): void {
    const strum = mode === 'strum';
    el.dataset.mode = mode;
    singleBtn.classList.toggle('is-active', !strum);
    strumBtn.classList.toggle('is-active', strum);
    singleBtn.setAttribute('aria-pressed', strum ? 'false' : 'true');
    strumBtn.setAttribute('aria-pressed', strum ? 'true' : 'false');
    // [hidden] is display:none !important in style.css, so this beats every
    // display rule the two modes' own stylesheets set.
    card.hidden = strum;
    strings.hidden = strum;
    status.hidden = strum;
    strumPanel.hidden = !strum;
    // Leaving the mode empties its region, so re-entering on the same state
    // (an unsupported tuning, say) is a real mutation again and is spoken.
    if (!strum) setText(strumLive, '');
  }

  function setMode(next: Mode): void {
    if (mode === next) return;
    if (next === 'strum') {
      // The guide is a Single-mode flow. Turning it off through its own path
      // clears progress, restores the strip and takes the readout back to
      // "Play a string" — so coming back to Single finds the tuner in the
      // state it would have been in had the guide simply been switched off.
      if (guideOn) setGuideOn(false);
      stop(true);
      mode = 'strum';
      syncMode();
      syncOctaveGate();
      if (octaveBlocked) {
        // Condition 2 never listens, so the stream the two modes share has no
        // reader on this side. Close it rather than leave the OS microphone
        // indicator lit for a mode that is switched off.
        stop();
        renderUnsupported();
        setStrumState('unsupported');
        renderStrum();
      } else if (!isNativeCaptureAvailable() && capturePathVerdict() === 'processed') {
        // Asked and answered earlier in this session. The mode does not open a
        // microphone it already knows it cannot read a chord through, and does
        // not play the tone a second time to be told the same thing.
        stop();
        renderProcessed();
        setStrumState('processed');
        renderStrum();
      } else {
        setStrumState('idle');
        renderStrum();
        if (visible && micGrantedThisSession && phase !== 'blocked') void startStrum();
      }
    } else {
      stopStrum();
      mode = 'single';
      syncMode();
      if (visible && micGrantedThisSession && phase !== 'blocked') void start();
    }
  }

  /* ====================================================== */

  /** Tell the capture where the instrument starts, and remember what it did with
      that — the fence below has to agree with the filter, not with the request.
      Not simply the first entry: the ukulele's reentrant G leads its tuning but
      its C is the lowest note. */
  function applyAnalysisFloor(capture: MicCapture | null = mic): void {
    let lowest = Infinity;
    for (const note of targetNotes) {
      if (note.freq < lowest) lowest = note.freq;
    }
    if (lowest === Infinity) return;
    const want = lowest * ANALYSIS_FLOOR_RATIO;
    const applied = capture ? capture.setAnalysisFloor(want) : clampAnalysisFloor(want);
    if (capture) {
      // Moving the cutoff under a RUNNING capture drags the phase of everything
      // in the band with it, and a phase shift that is moving reads as a
      // frequency offset — tens of cents, at a clarity high enough to reach the
      // needle. The ramp is long enough to keep that small; this holds the
      // display off until the analyser's window is clear of it altogether. The
      // test is against what the capture was last told, not against the fence:
      // only the capture knows whether its filter actually moved.
      if (capture.running && applied !== micFloorHz) {
        detectHoldUntil = performance.now() + capture.settleMs;
      }
      micFloorHz = applied;
    }
    // The native capture runs the same two biquads in JS (v2.1), so the band
    // moves with the tuning there too. Idempotent, hence ahead of the fence
    // below: a floor that did not change is a no-op on both sides.
    if (strumCap instanceof NativeStrumCapture) strumCap.setAnalysisFloor(applied);
    if (applied === analysisFloorHz) return;
    analysisFloorHz = applied;
    subBandHz = Math.max(MIN_FREQ, applied * SUB_BAND_RATIO);
  }

  /** The capo tag. Written only when there is a fret to name, so the hidden
      element never carries a stale "Capo 3" for a screen reader to find. */
  function syncCapo(): void {
    const capo = state.capo;
    if (capo > 0) {
      setText(capoTag, `Capo ${capo}`);
      setText(strumCapoTag, `Capo ${capo}`);
    }
    capoTag.hidden = capo <= 0;
    strumCapoTag.hidden = capo <= 0;
  }

  function refreshTuning(): void {
    const previous = targetNotes;
    targetNotes = tuningNotes(tuningById(state.tuningId), state.a4, state.capo);
    // A different instrument, a different A4 or a different capo is a different
    // set of targets: whatever was ticked off was ticked off against the old
    // ones. A capo move shifts every target by at least a semitone, so it never
    // reads as the same set here and the guide always starts over — its checks
    // would otherwise be claims about pitches this tuner never heard. The SAME
    // set is not — and this runs on every state write, so it also runs when the
    // player opens the tuning sheet and picks the row that is already current,
    // or saves the editor over an unchanged tuning. Those must cost nothing.
    const changed = !sameTargets(previous, targetNotes);
    if (changed) resetGuideProgress();
    renderStrip();
    // Same rule as the guide's checks, for the same reason: a cent figure is a
    // claim about one target frequency and expires with it. This also re-runs
    // condition 2's gate, which is the only thing that can open or close the
    // strum capture without the player touching the mode segment.
    if (changed) resetStrum();
    syncCapo();
    // Readings taken through the old band, against the old targets, say nothing
    // about the new ones.
    clearMedian();
    applyAnalysisFloor();
    syncGuide();
    // The readout, the needle and the green are all claims about the targets
    // that just moved, and applyAnalysisFloor() has held detection off for the
    // filter's ramp — so nothing can correct them for another ~600 ms. A tuner
    // may not say "in tune" about a pitch that is no longer in the tuning:
    // drop the display with the progress. "—" / "Play string N" is the honest
    // state while there is nothing left to measure, and it is a state change,
    // not a flash. The SAME targets still cost nothing: a re-emission of the
    // current tuning leaves a live readout exactly where it was.
    if (changed) {
      const now = performance.now();
      restartLatch(now);
      relax(true, now);
    } else if (relaxed) {
      relax(true);
    }
  }

  /* The dwell floor is not consulted here: relaxing means HOLD_MS (600 ms) has
     passed with no confident pitch, which is already longer than IN_TUNE_MIN_MS,
     and a gauge with nothing to listen to must not claim to be in tune. */
  function relax(force: boolean, now = performance.now()): void {
    if (relaxed && !force) return;
    relaxed = true;
    // The string stopped sounding, so the success readout has nothing left to
    // hold: the guide gets the display back and the hint below names the next
    // string to play.
    endHold(now);
    targetAngle = 0;
    inTuneStreak = 0;
    recheckStreak = 0;
    clearMedian();
    setInTune(false, now);
    setIdleVisual(true);
    setActiveString(-1);
    setText(pcEl, '—');
    setText(accEl, '');
    setText(octEl, '');
    setText(freqEl, '—');
    setText(centsEl, '—');
    if (guideOn && complete) {
      setHint('All in tune', 'All strings in tune');
    } else if (guideOn && guideIndex >= 0 && guideIndex < targetNotes.length) {
      // The one thing a guided player needs while nothing is sounding: which
      // string to pluck next.
      const no = stringNo(guideIndex);
      setHint(`Play string ${no}`, `Play string ${no}, ${spokenName(targetNotes[guideIndex])}`);
    } else {
      setHint('Play a string', 'Play a string');
    }
  }

  function applyPitch(freq: number, now: number): void {
    /* A string that has just been confirmed is still ringing under the guide's
       next target, and the readout it would get there is the most alarming one
       there is: another note's name, the needle pinned, "TUNE UP". Show the
       success instead, and only for as long as it is true — the moment the pitch
       leaves the finished string's release band (the player damped it, or moved
       on) or GUIDE_HOLD_MS passes, the guide has the display back. */
    if (holdIdx >= 0 && holdIdx < targetNotes.length) {
      const held = targetNotes[holdIdx];
      const heldCents = centsBetween(freq, held.freq);
      if (now < holdUntil && Math.abs(heldCents) <= OUT_OF_TUNE_CENTS) {
        relaxed = false;
        setIdleVisual(false);
        targetAngle = centsToDeg(heldCents);
        setText(pcEl, held.pc.charAt(0));
        setText(accEl, held.pc.length > 1 ? '♯' : '');
        setText(octEl, String(held.octave));
        setText(freqEl, formatFreq(freq));
        setText(centsEl, formatCents(heldCents));
        setActiveString(-1);
        // The latch is already on and stays on: this is the in-tune state the
        // string earned, held still rather than re-entered.
        if (complete) setHint('All in tune', 'All strings in tune');
        else setHint('In tune', 'In tune');
        return;
      }
      /* Handing the display back is a change of meaning, not of pitch: the
         median still holds five frames of the string that was ringing, and
         reading those against the new target is a wild offset for two or three
         frames — long enough to blink the in-tune state off and straight back
         on when the player has already moved to a string that is at pitch.
         Start the median over and let the next detection speak for itself. */
      endHold(now);
      clearMedian();
      return;
    }

    const guided = guideOn && guideIndex >= 0 && guideIndex < targetNotes.length;
    let idx = -1;
    let cents = 0;
    let pc: string;
    let octave: number;
    /* The nearest string of the tuning and its offset, kept whatever the display
       decides to do with them: past STRING_WINDOW_CENTS the readout falls back
       to the chromatic note, and the completion re-check below must not fall
       back with it — that is exactly the drift it exists to catch. */
    let nearestIdx = -1;
    let nearestCents = 0;

    if (guided) {
      // The whole point of the guide: one target, held. A string being brought
      // up from slack passes every other string's window on the way, and a
      // display that follows it there is a display that cannot be tuned by.
      idx = guideIndex;
      cents = centsBetween(freq, targetNotes[idx].freq);
      pc = targetNotes[idx].pc;
      octave = targetNotes[idx].octave;
    } else {
      let closest = Infinity;
      for (let i = 0; i < targetNotes.length; i++) {
        const c = centsBetween(freq, targetNotes[i].freq);
        const a = Math.abs(c);
        if (a < closest) {
          closest = a;
          cents = c;
          idx = i;
        }
      }
      nearestIdx = idx;
      nearestCents = cents;

      if (idx >= 0 && closest <= STRING_WINDOW_CENTS) {
        pc = targetNotes[idx].pc;
        octave = targetNotes[idx].octave;
      } else {
        const chromatic = nearestNote(freq, state.a4);
        pc = chromatic.note.pc;
        octave = chromatic.note.octave;
        cents = chromatic.cents;
        idx = -1;
      }
    }

    relaxed = false;
    setIdleVisual(false);
    targetAngle = centsToDeg(cents);

    setText(pcEl, pc.charAt(0));
    setText(accEl, pc.length > 1 ? '♯' : '');
    setText(octEl, String(octave));
    setText(freqEl, formatFreq(freq));
    // Guided, the offset can be an octave: the needle stops at the end of the
    // arc, the number says which side of it the string is on.
    setText(centsEl, guided ? formatGuidedCents(cents) : formatCents(cents));
    // While the guide runs, the guided ring is the only pill treatment — the
    // nearest-string highlight would be pointing somewhere else.
    setActiveString(guideOn ? -1 : idx);

    const off = Math.abs(cents);
    if (off <= IN_TUNE_CENTS) {
      if (inTuneStreak < IN_TUNE_FRAMES) inTuneStreak++;
      if (inTuneStreak >= IN_TUNE_FRAMES) setInTune(true, now);
    } else {
      inTuneStreak = 0;
      if (off > OUT_OF_TUNE_CENTS && now - inTuneAt >= IN_TUNE_MIN_MS) setInTune(false, now);
    }

    /* Finished, and what is sounding is not where its string should be. Resolved
       against the guide's own target set by index — a peg that let go drops a
       string a tone or more, which is further than the display's 120-cent window
       and used to be exactly where the guide stopped looking. */
    const drifted =
      guideOn &&
      complete &&
      nearestIdx >= 0 &&
      done[nearestIdx] === true &&
      Math.abs(nearestCents) > GUIDE_RECHECK_CENTS;

    if (guided) {
      // The latch's own clock: it was reset the moment the median left the
      // release band, so surviving to here means the string held. `guideSince`
      // is the other half — a target the guide was handed a moment ago has not
      // held anything yet, however long the latch has been on.
      if (inTune && now - inTuneAt >= GUIDE_CONFIRM_MS && now - guideSince >= GUIDE_CONFIRM_MS) {
        confirmGuided(now);
      }
    } else if (drifted) {
      if (++recheckStreak >= IN_TUNE_FRAMES) reopenGuide(nearestIdx, now);
    } else {
      recheckStreak = 0;
    }

    // "All in tune" is a claim about what the tuner can hear. While it is
    // hearing a string that is out of tune, the honest line is the one that says
    // which way to turn — for the two or three frames the re-check above takes
    // to hand the guide back to that string, and for as long afterwards.
    if (guideOn && complete && !drifted) setHint('All in tune', 'All strings in tune');
    else if (inTune) setHint('In tune', 'In tune');
    else if ((drifted ? nearestCents : cents) < 0) setHint('Tune up ↑', 'Tune up');
    else setHint('Tune down ↓', 'Tune down');
  }

  function tick(now: number): void {
    rafId = requestAnimationFrame(tick);

    if (mic && detector && frame && now - lastDetectAt >= DETECT_MS && now >= detectHoldUntil) {
      lastDetectAt = now;
      mic.read(frame);
      const raw = detector.detect(frame);
      const result = raw && raw.freq >= subBandHz ? raw : null;
      if (result) {
        lastConfidentAt = now;
        // Everything downstream — readout, needle, string pick, the in-tune
        // latch — reads the median, never the raw frame: one bad detection in
        // five now costs nothing at all instead of a visible needle jump that
        // the smoothing then takes a quarter of a second to walk back.
        applyPitch(pushMedian(result.freq), now);
      } else if (lastConfidentAt === 0 || now - lastConfidentAt > HOLD_MS) {
        relax(false, now);
      }
    }

    // Hand the live region back once the confirm sentence has had its moment —
    // unless the sentence in there already ends with what the hint wants to say,
    // which is what the completion line does.
    if (now >= announceHoldUntil) speak(pendingSpoken);

    angle += (targetAngle - angle) * SMOOTH_ALPHA;
    if (!(Math.abs(angle - writtenAngle) < ANGLE_EPSILON)) {
      writtenAngle = angle;
      gauge.needle.style.transform = `rotate(${angle.toFixed(2)}deg)`;
    }
  }

  function showNotice(err: unknown): void {
    const denied = err instanceof Error && err.message === 'mic-denied';
    setText(
      noticeTitle,
      denied ? 'Microphone blocked' : 'Could not open the microphone',
    );
    setText(
      noticeBody,
      denied
        ? 'TrueString listens through the mic to hear your strings. The audio stays on your device — nothing is recorded, stored or uploaded. The Manual tuner still works without it.'
        : 'No audio input was available. Check that a microphone is connected and that no other app has taken it, then try again.',
    );
    steps.hidden = !denied;
    // Nothing was heard, so nothing that was ticked off can still be trusted.
    // (hide() is not this: the guide is meant to survive a trip to another tab.)
    resetGuideProgress();
    syncGuide();
    // Nothing was heard here either: the board stops showing measurements it
    // can no longer refresh, and stops saying it is listening.
    strumSeq++;
    strumBusy = false;
    clearBoard();
    if (!strumLatched(strumState)) setStrumState('idle');
    setPhase('blocked');
    relax(true);
  }

  async function start(): Promise<void> {
    if (starting || phase === 'live') return;
    starting = true;
    setPhase('starting');
    try {
      // The one microphone. Coming back from Strum mode it is already open and
      // already at this tuning's cutoff, and re-using it is the whole of v2.0
      // condition 3: both modes hear the same band through the same two biquads,
      // and a mode switch costs no getUserMedia at all.
      const capture = mic ?? new MicCapture();
      // Before the graph exists, so the highpass is BUILT at the tuning's cutoff
      // instead of being ramped there a moment after audio starts flowing: that
      // ramp used to fire on every single mic start, and a string already
      // ringing when it fired read tens of cents sharp for the first few frames.
      applyAnalysisFloor(capture);
      if (!capture.running) await capture.start();
      // Reaching here means getUserMedia resolved, so the grant is real even if
      // the user switched tabs while the permission prompt was up.
      micGrantedThisSession = true;
      if (!visible) {
        capture.stop();
        mic = null;
        micFloorHz = 0;
        setPhase('idle');
        return;
      }
      mic = capture;
      // The detector is built for the stream as it will be READ — decimated on
      // a 96 kHz interface — and told how often it will be called, which is the
      // only clock it has for its own memory.
      detector = new PitchDetector(capture.analysisRate, capture.analysisSize, DETECT_MS);
      frame = new Float32Array(capture.analysisSize);
      lastDetectAt = 0;
      // The analyser was created full of silence and hands that back until a
      // whole frame of real audio has arrived. The step out of it is a transient
      // with a confident, wrong pitch in it, so wait the frame out.
      detectHoldUntil = performance.now() + capture.frameMs;
      lastConfidentAt = 0;
      // A new stream is a new room as far as the gate is concerned. The band was
      // set before the graph was built; this catches a tuning change that landed
      // while the permission prompt was up.
      detector.reset();
      clearMedian();
      applyAnalysisFloor();
      // Tuning is a hands-on, screen-watching job: nothing touches the display
      // between plucks, so hold the screen awake for as long as the mic is open.
      holdWake('tuner');
      setPhase('live');
      relax(true);
      rafId = requestAnimationFrame(tick);
    } catch (err) {
      showNotice(err);
    } finally {
      starting = false;
      syncStartBtn();
    }
  }

  /**
   * Ends the Single-mode analysis loop. `keepMic` leaves the microphone itself
   * open, which is what a mode switch wants: one mic serves both modes, so
   * closing it on the way into Strum only to re-open it there would be a second
   * getUserMedia, a second filter chain, and a second analysis floor to keep in
   * step with the tuning.
   */
  function stop(keepMic = false): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (mic && !keepMic) {
      mic.stop();
      mic = null;
    }
    // Every exit from a live capture lands here — hide(), Retry after a
    // failure, a denial that never reached 'live' — and releasing a reason that
    // was never held is a no-op, so this is the one place the lock is freed.
    releaseWake('tuner');
    detector = null;
    frame = null;
    detectHoldUntil = 0;
    // The next capture is a new filter, built from scratch at whatever cutoff
    // the tuning then wants — but only if the mic actually closed. A filter that
    // is still running is still at the cutoff it was last told.
    if (!mic) micFloorHz = 0;
    if (phase === 'live' || phase === 'starting') setPhase('idle');
    relax(true);
  }

  startBtn.addEventListener('click', () => {
    void start();
  });
  strumStartBtn.addEventListener('click', () => {
    void startStrum();
  });
  retryBtn.addEventListener('click', () => {
    setPhase('idle');
    if (mode === 'strum') void startStrum();
    else void start();
  });
  guideBtn.addEventListener('click', () => {
    setGuideOn(!guideOn);
  });
  singleBtn.addEventListener('click', () => {
    setMode('single');
  });
  strumBtn.addEventListener('click', () => {
    setMode('strum');
  });

  /* The two things in this app that keep making sound after you leave their
     tab. Only the capture-path probe reads them, and only to decline to run
     while either is going: its tone would be played into theirs. */
  const running = (ev: Event): boolean =>
    (ev as CustomEvent<{ running?: boolean }>).detail?.running === true;
  window.addEventListener('truestring:metronome-running', (ev: Event) => {
    metronomeSounding = running(ev);
  });
  window.addEventListener('truestring:drone-running', (ev: Event) => {
    droneSounding = running(ev);
  });

  subscribe((next: AppState) => {
    state = next;
    refreshTuning();
  });
  refreshTuning();

  return {
    el,
    show(): void {
      visible = true;
      if (!micGrantedThisSession || phase === 'blocked') return;
      if (mode === 'strum') void startStrum();
      else void start();
    },
    hide(): void {
      visible = false;
      // The tap comes off the graph before the graph goes away — stop() owns the
      // microphone both modes share.
      stopStrum();
      stop();
    },
  };
}
