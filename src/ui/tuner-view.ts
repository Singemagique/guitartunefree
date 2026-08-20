import './tuner-view.css';
import type { AppState } from '../state';
import { getState, subscribe } from '../state';
import type { NoteInfo } from '../music/notes';
import { centsBetween, nearestNote, prettyPc } from '../music/notes';
import { tuningById, tuningNotes } from '../music/tunings';
import { MicCapture } from '../audio/mic';
import { PitchDetector } from '../audio/pitch';

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
/** Snap to a tuning's string only when the pitch is this close to it. */
const STRING_WINDOW_CENTS = 120;

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

function micIcon(): SVGSVGElement {
  const icon = s('svg', { viewBox: '0 0 24 24', class: 'tv-ico', 'aria-hidden': 'true' });
  icon.appendChild(s('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }));
  icon.appendChild(s('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }));
  icon.appendChild(s('path', { d: 'M12 18v3.5' }));
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
  let lastDetectAt = 0;
  let lastConfidentAt = 0;
  let inTuneStreak = 0;
  let inTune = false;
  let relaxed = true;
  let activeIdx = -1;

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
  const hintEl = h('div', 'tv-hint', 'Play a string');
  hintEl.setAttribute('aria-live', 'polite');
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

  const strip = h('div', 'tv-strip');
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', 'Target strings');
  el.appendChild(strip);

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

  function setInTune(on: boolean): void {
    if (inTune === on) return;
    inTune = on;
    el.classList.toggle('is-intune', on);
    if (on) navigator.vibrate?.(10);
  }

  function setActiveString(idx: number): void {
    if (activeIdx === idx) return;
    if (activeIdx >= 0 && activeIdx < pills.length) pills[activeIdx].classList.remove('is-active');
    if (idx >= 0 && idx < pills.length) pills[idx].classList.add('is-active');
    activeIdx = idx;
  }

  function renderStrip(): void {
    strip.textContent = '';
    activeIdx = -1;
    pills = targetNotes.map((note, i) => {
      const pill = h('span', 'pill tv-string');
      pill.setAttribute('role', 'listitem');
      pill.setAttribute('aria-label', `String ${targetNotes.length - i}, ${note.name}`);
      pill.append(
        h('span', 'tv-string-pc', prettyPc(note.pc)),
        h('span', 'tv-string-oct', String(note.octave)),
      );
      return pill;
    });
    for (const pill of pills) strip.appendChild(pill);
  }

  function refreshTuning(): void {
    targetNotes = tuningNotes(tuningById(state.tuningId), state.a4);
    renderStrip();
  }

  function relax(force: boolean): void {
    if (relaxed && !force) return;
    relaxed = true;
    targetAngle = 0;
    inTuneStreak = 0;
    setInTune(false);
    setIdleVisual(true);
    setActiveString(-1);
    setText(pcEl, '—');
    setText(accEl, '');
    setText(octEl, '');
    setText(freqEl, '—');
    setText(centsEl, '—');
    setText(hintEl, 'Play a string');
  }

  function applyPitch(freq: number): void {
    let idx = -1;
    let cents = 0;
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

    let pc: string;
    let octave: number;
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

    relaxed = false;
    setIdleVisual(false);
    targetAngle = centsToDeg(cents);

    setText(pcEl, pc.charAt(0));
    setText(accEl, pc.length > 1 ? '♯' : '');
    setText(octEl, String(octave));
    setText(freqEl, formatFreq(freq));
    setText(centsEl, formatCents(cents));
    setActiveString(idx);

    if (Math.abs(cents) <= IN_TUNE_CENTS) {
      if (inTuneStreak < IN_TUNE_FRAMES) inTuneStreak++;
      if (inTuneStreak >= IN_TUNE_FRAMES) {
        setInTune(true);
        setText(hintEl, 'In tune');
      }
    } else {
      inTuneStreak = 0;
      setInTune(false);
      setText(hintEl, cents < 0 ? 'Tune up ↑' : 'Tune down ↓');
    }
  }

  function tick(now: number): void {
    rafId = requestAnimationFrame(tick);

    if (mic && detector && frame && now - lastDetectAt >= DETECT_MS) {
      lastDetectAt = now;
      mic.read(frame);
      const result = detector.detect(frame);
      if (result) {
        lastConfidentAt = now;
        applyPitch(result.freq);
      } else if (lastConfidentAt === 0 || now - lastConfidentAt > HOLD_MS) {
        relax(false);
      }
    }

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
    setPhase('blocked');
  }

  async function start(): Promise<void> {
    if (starting || phase === 'live') return;
    starting = true;
    setPhase('starting');
    try {
      const capture = new MicCapture();
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
      detector = new PitchDetector(capture.sampleRate, capture.bufferSize);
      frame = new Float32Array(capture.bufferSize);
      lastDetectAt = 0;
      lastConfidentAt = 0;
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
    detector = null;
    frame = null;
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
