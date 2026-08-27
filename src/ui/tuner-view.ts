import './tuner-view.css';
import type { AppState } from '../state';
import { getState, subscribe } from '../state';
import type { NoteInfo } from '../music/notes';
import { centsBetween, nearestNote, prettyPc } from '../music/notes';
import { tuningById, tuningNotes } from '../music/tunings';
import { MicCapture, clampAnalysisFloor } from '../audio/mic';
import { MIN_FREQ, PitchDetector } from '../audio/pitch';
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

type Phase = 'idle' | 'starting' | 'live' | 'blocked';

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
  const guideBtn = h('button', 'btn btn-ghost tv-guide', 'Tune all');
  guideBtn.type = 'button';
  guideBtn.setAttribute('aria-pressed', 'false');
  stringsHead.append(stringsTitle, guideBtn);
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

  /** A pending start() ignores further taps, so the button must look inert. */
  function syncStartBtn(): void {
    startBtn.disabled = starting || phase === 'starting';
  }

  function setPhase(next: Phase): void {
    if (phase === next) return;
    phase = next;
    el.dataset.phase = next;
    syncStartBtn();
    setText(startLabel, next === 'starting' ? 'Starting…' : 'Start listening');
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
    if (applied === analysisFloorHz) return;
    analysisFloorHz = applied;
    subBandHz = Math.max(MIN_FREQ, applied * SUB_BAND_RATIO);
  }

  function refreshTuning(): void {
    const previous = targetNotes;
    targetNotes = tuningNotes(tuningById(state.tuningId), state.a4);
    // A different instrument, or a different A4, is a different set of targets:
    // whatever was ticked off was ticked off against the old ones. The SAME set
    // is not — and this runs on every state write, so it also runs when the
    // player opens the tuning sheet and picks the row that is already current,
    // or saves the editor over an unchanged tuning. Those must cost nothing.
    if (!sameTargets(previous, targetNotes)) resetGuideProgress();
    renderStrip();
    // Readings taken through the old band, against the old targets, say nothing
    // about the new ones.
    clearMedian();
    applyAnalysisFloor();
    syncGuide();
    if (relaxed) relax(true);
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
    setPhase('blocked');
    relax(true);
  }

  async function start(): Promise<void> {
    if (starting || phase === 'live') return;
    starting = true;
    setPhase('starting');
    try {
      const capture = new MicCapture();
      // Before the graph exists, so the highpass is BUILT at the tuning's cutoff
      // instead of being ramped there a moment after audio starts flowing: that
      // ramp used to fire on every single mic start, and a string already
      // ringing when it fired read tens of cents sharp for the first few frames.
      applyAnalysisFloor(capture);
      await capture.start();
      // Reaching here means getUserMedia resolved, so the grant is real even if
      // the user switched tabs while the permission prompt was up.
      micGrantedThisSession = true;
      if (!visible) {
        capture.stop();
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

  function stop(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (mic) {
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
    // the tuning then wants.
    micFloorHz = 0;
    if (phase === 'live' || phase === 'starting') setPhase('idle');
    relax(true);
  }

  startBtn.addEventListener('click', () => {
    void start();
  });
  retryBtn.addEventListener('click', () => {
    setPhase('idle');
    void start();
  });
  guideBtn.addEventListener('click', () => {
    setGuideOn(!guideOn);
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
      if (micGrantedThisSession && phase !== 'blocked') void start();
    },
    hide(): void {
      visible = false;
      stop();
    },
  };
}
