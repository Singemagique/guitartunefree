import './metronome-view.css';
import { ensureRunning } from '../audio/context';
import { Metronome, type Subdivision } from '../audio/metronome';
import { holdWake, releaseWake } from '../wakelock';

export interface ViewHandle {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

const BPM_MIN = 30;
const BPM_MAX = 300;
const BPB_MIN = 1;
const BPB_MAX = 12;
const DEFAULT_BPM = 120;
const DEFAULT_BPB = 4;

/** Practice ranges — the engine clamps to the same numbers. */
const ADD_MIN = 1;
const ADD_MAX = 20;
const BARS_MIN = 1;
const BARS_MAX = 16;
const GAP_MIN = 1;
const GAP_MAX = 8;

const PREFS_KEY = 'truestring:metronome';

/**
 * Body class that locks page scroll while the stage fills the viewport. It is
 * deliberately NOT the shell's `is-locked`: the tuning sheet adds and removes
 * that one, and a sheet closing would otherwise unlock the page out from under
 * an open big view.
 */
const BIG_BODY_CLASS = 'nv-big-open';

/** Pendulum geometry in viewBox units: pivot at bottom centre, arm straight up. */
const PIVOT_X = 150;
const PIVOT_Y = 190;
const ARM_LEN = 150;
const BOB_R = 118;
const GUIDE_IN = 130;
const GUIDE_OUT = 156;
/** Cropped to the ink: the drawing is letterboxed by height, so trimming the
    empty band above the swing is what makes the pendulum fill the stage. */
const VIEW_TOP = 26;
const VIEW_H = 176;
/** Half-swing. The arm reaches ±SWING_DEG exactly on each main beat. */
const SWING_DEG = 26;
/** Skip an arm write below this many degrees of change. */
const ANGLE_EPSILON = 0.05;

const REST_COUNT = '–';
const TAP_HINT = 'Tap along with any song and the BPM follows.';
/** While the trainer owns the tempo the plain hint is a lie — the climb moves
    the BPM off any tapped number within a bar. What a tap does instead is set
    the tempo the next climb starts from, so that is what it says. */
const TAP_HINT_TRAINER = 'Tap to set the tempo the trainer climbs from.';
/** The engine forgets a tap series after 2 s; the extra grace stops the caption
    swapping back while a slow tapper is still mid-phrase. */
const TAP_REVERT_MS = 2500;

/** A held stepper steps every 36 ms, and a polite region written at that rate is
    a backlog rather than feedback. The announcement waits for the value to
    settle instead. */
const LIVE_SETTLE_MS = 450;

/** Haptic beat: long enough to feel through a pocket, short enough not to buzz
    into the next beat even at 300 BPM (200 ms apart). */
const VIBE_ACCENT_MS = 40;
const VIBE_BEAT_MS = 22;

/** Absent on iOS Safari; the toggle is only built where it would do something. */
const HAS_VIBRATE = typeof navigator.vibrate === 'function';

/** Big view puts the swing on the whole screen, which is exactly the kind of
    large-field oscillation a reduced-motion request is about, so the OS
    preference decides the pendulum's default. The toggle overrides it. */
const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

const TEMPO_MARKS: readonly { max: number; name: string }[] = [
  { max: 66, name: 'Largo' },
  { max: 76, name: 'Adagio' },
  { max: 108, name: 'Andante' },
  { max: 120, name: 'Moderato' },
  { max: 168, name: 'Allegro' },
];

const SUBDIVISIONS: readonly { label: string; glyph: string }[] = [
  { label: 'Quarter notes', glyph: '♩' },
  { label: 'Eighth notes', glyph: '♫' },
  { label: 'Triplets', glyph: '♫<span class="nv-trip">3</span>' },
  { label: 'Sixteenth notes', glyph: '♬' },
];

const SVG_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** Arrows out / arrows in — the second group only shows while pressed. */
const ICON_EXPAND = `<svg ${SVG_ATTRS}>
  <g class="nv-ico-on"><path d="M9.4 3.6H3.6v5.8"/><path d="M14.6 3.6h5.8v5.8"/><path d="M20.4 14.6v5.8h-5.8"/><path d="M3.6 14.6v5.8h5.8"/></g>
  <g class="nv-ico-off"><path d="M3.6 9.4h5.8V3.6"/><path d="M20.4 9.4h-5.8V3.6"/><path d="M14.6 20.4v-5.8h5.8"/><path d="M9.4 20.4v-5.8H3.6"/></g>
</svg>`;
const ICON_VIBRATE = `<svg ${SVG_ATTRS}>
  <rect x="8.2" y="2.9" width="7.6" height="18.2" rx="2.1"/>
  <path d="M4.9 9.3v5.4"/><path d="M2.3 10.9v2.2"/>
  <path d="M19.1 9.3v5.4"/><path d="M21.7 10.9v2.2"/>
</svg>`;
const ICON_SPEAKER = `<svg ${SVG_ATTRS}>
  <path d="M4 9.4h3.4L12 5.2v13.6L7.4 14.6H4z"/>
  <g class="nv-ico-on"><path d="M15.6 9.6a3.4 3.4 0 0 1 0 4.8"/><path d="M18.2 7.2a7 7 0 0 1 0 9.6"/></g>
  <g class="nv-ico-off"><path d="M16.4 9.8 21 14.4"/><path d="M21 9.8l-4.6 4.6"/></g>
</svg>`;
/** Swinging arm / arm at rest with a strike-through. */
const ICON_PENDULUM = `<svg ${SVG_ATTRS}>
  <circle cx="12" cy="19.8" r="1.4"/>
  <g class="nv-ico-on">
    <path d="M12 19.8 16.4 7.2"/>
    <ellipse cx="15.2" cy="10.7" rx="2.2" ry="1.7"/>
    <path d="M6.4 9.2a9.4 9.4 0 0 1 1.7-3.2"/>
  </g>
  <g class="nv-ico-off">
    <path d="M12 19.8V7.4"/>
    <ellipse cx="12" cy="9.6" rx="2.2" ry="1.7"/>
    <path d="M4.6 4.6 19.4 19.4"/>
  </g>
</svg>`;
const ICON_MUTED_TAG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 9.4h3.4L12 5.2v13.6L7.4 14.6H4z"/><path d="M16.4 9.8 21 14.4"/><path d="M21 9.8l-4.6 4.6"/></svg>`;
/** A dashed line: the bar the click steps out of. Deliberately nothing like the
    struck-through speaker of the user's own mute. */
const ICON_GAP_TAG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M3.2 12h3.4"/><path d="M10.3 12h3.4"/><path d="M17.4 12h3.4"/></svg>`;

interface TrainerPrefs {
  on: boolean;
  add: number;
  bars: number;
  target: number;
}

interface GapPrefs {
  on: boolean;
  play: number;
  mute: number;
}

interface Prefs {
  muted: boolean;
  vibrate: boolean;
  /** null = no choice made yet, so the OS motion preference decides. */
  pendulum: boolean | null;
  trainer: TrainerPrefs;
  gap: GapPrefs;
}

const DEFAULT_TRAINER: TrainerPrefs = { on: false, add: 2, bars: 4, target: 160 };
const DEFAULT_GAP: GapPrefs = { on: false, play: 2, mute: 2 };

function tempoName(bpm: number): string {
  for (const mark of TEMPO_MARKS) {
    if (bpm < mark.max) return mark.name;
  }
  return 'Presto';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function bagOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readNumber(value: unknown, lo: number, hi: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(Math.round(value), lo, hi)
    : fallback;
}

/** Storage can be absent (file://), full, or hold junk from an older build.
    Unknown keys — including v1.0's `screenFlash` — are simply not read, so the
    next save drops them, and every number is re-clamped on the way in. */
function loadPrefs(): Prefs {
  const prefs: Prefs = {
    muted: false,
    vibrate: false,
    pendulum: null,
    trainer: { ...DEFAULT_TRAINER },
    gap: { ...DEFAULT_GAP },
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return prefs;
    const bag = bagOf(JSON.parse(raw) as unknown);
    prefs.muted = bag.muted === true;
    prefs.vibrate = bag.vibrate === true;
    prefs.pendulum = typeof bag.pendulum === 'boolean' ? bag.pendulum : null;
    const trainer = bagOf(bag.trainer);
    prefs.trainer = {
      on: trainer.on === true,
      add: readNumber(trainer.add, ADD_MIN, ADD_MAX, DEFAULT_TRAINER.add),
      bars: readNumber(trainer.bars, BARS_MIN, BARS_MAX, DEFAULT_TRAINER.bars),
      target: readNumber(trainer.target, BPM_MIN, BPM_MAX, DEFAULT_TRAINER.target),
    };
    const gap = bagOf(bag.gap);
    prefs.gap = {
      on: gap.on === true,
      play: readNumber(gap.play, GAP_MIN, GAP_MAX, DEFAULT_GAP.play),
      mute: readNumber(gap.mute, GAP_MIN, GAP_MAX, DEFAULT_GAP.mute),
    };
  } catch {
    /* unreadable or unparseable — the defaults above stand */
  }
  return prefs;
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        muted: prefs.muted,
        vibrate: prefs.vibrate,
        pendulum: prefs.pendulum,
        trainer: prefs.trainer,
        gap: prefs.gap,
      }),
    );
  } catch {
    /* private mode or quota — the toggles still work for this session */
  }
}

/** Retrigger a CSS animation that may already be mid-flight on this element. */
function replay(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function polar(deg: number, r: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: PIVOT_X + r * Math.sin(a), y: PIVOT_Y - r * Math.cos(a) };
}

/** A faint marker the arm lies flat along when it reaches that angle. */
function guide(deg: number): string {
  const inner = polar(deg, GUIDE_IN);
  const outer = polar(deg, GUIDE_OUT);
  return `<line class="nv-pend-guide" x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}"/>`;
}

function pendulumSvg(): string {
  return `<svg class="nv-pend" viewBox="0 ${VIEW_TOP} 300 ${VIEW_H}" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      ${guide(-SWING_DEG)}${guide(0)}${guide(SWING_DEG)}
      <path class="nv-pend-body" d="M${PIVOT_X - 40} ${PIVOT_Y + 9} L${PIVOT_X} ${PIVOT_Y - 34} L${PIVOT_X + 40} ${PIVOT_Y + 9} Z"/>
      <g class="nv-pend-arm">
        <line class="nv-pend-rod" x1="${PIVOT_X}" y1="${PIVOT_Y}" x2="${PIVOT_X}" y2="${PIVOT_Y - ARM_LEN}"/>
        <ellipse class="nv-pend-bob" cx="${PIVOT_X}" cy="${PIVOT_Y - BOB_R}" rx="17" ry="12"/>
      </g>
      <circle class="nv-pend-cap" cx="${PIVOT_X}" cy="${PIVOT_Y}" r="7"/>
    </svg>`;
}

/** One practice stepper: −, value, +. `name` prefixes the three class hooks. */
function miniStepper(name: string, group: string, down: string, up: string): string {
  return `<span class="nv-mini" role="group" aria-label="${group}">
        <button class="icon-btn nv-mini-btn nv-${name}-down" type="button" aria-label="${down}"><span aria-hidden="true">&minus;</span></button>
        <span class="nv-mini-value nv-${name}-value"></span>
        <button class="icon-btn nv-mini-btn nv-${name}-up" type="button" aria-label="${up}"><span aria-hidden="true">+</span></button>
      </span>`;
}

/**
 * A debounced writer for one polite live region: the sentence lands once, after
 * the value has stopped moving. The equality guard matters as much as the
 * timer — assigning the identical string still replaces the text node, and a
 * screen reader announces that, so a stepper held past its clamp would keep
 * talking about a number that has stopped changing.
 */
function liveWriter(node: HTMLElement): (text: string) => void {
  let timer = 0;
  return (text: string): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (node.textContent !== text) node.textContent = text;
    }, LIVE_SETTLE_MS);
  };
}

/**
 * Fires `step` on press and then repeats while held, tightening the interval so
 * a long hold sweeps quickly. Keyboard activation holds too (Enter/Space), so
 * the button's default click is suppressed to avoid a double step.
 */
function attachRepeat(btn: HTMLButtonElement, step: () => void): void {
  let timer = 0;
  let reps = 0;

  const end = (): void => {
    window.clearTimeout(timer);
    timer = 0;
    reps = 0;
  };
  const tick = (): void => {
    step();
    reps += 1;
    timer = window.setTimeout(tick, Math.max(36, 150 - reps * 10));
  };
  const begin = (): void => {
    end();
    step();
    timer = window.setTimeout(tick, 420);
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic event has no active pointer to capture */
    }
    begin();
  });
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('blur', end);
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) begin();
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') end();
  });
}

export function createMetronomeView(): ViewHandle {
  const metro = new Metronome();
  metro.bpm = DEFAULT_BPM;
  metro.beatsPerBar = DEFAULT_BPB;
  metro.subdivision = 1;

  const prefs = loadPrefs();
  metro.muted = prefs.muted;

  let bpm = DEFAULT_BPM;
  let beatsPerBar = DEFAULT_BPB;
  let wasRunning = false;
  let starting = false;
  let visible = false;
  let big = false;
  let rafId = 0;
  let writtenAngle = Number.NaN;
  let tapRevert = 0;
  let saveTimer = 0;
  let scroller: HTMLElement | null = null;
  let scrollTop = 0;
  /** The tempo a trainer run climbs from: taken when the trainer is switched on
      and re-taken on every hand edit while it is on. Without it a run that ends
      on the target leaves the tempo parked there, and every later start is a
      switch that looks armed and does nothing. */
  let trainerBase = DEFAULT_BPM;
  /** Arrival is announced once per climb, not once per repaint. */
  let saidAtTarget = false;

  const el = document.createElement('section');
  el.className = 'nv';
  el.setAttribute('aria-label', 'Metronome');
  el.innerHTML = `
    <div class="card nv-panel">
      <div class="nv-bpm-row">
        <button class="icon-btn nv-step nv-bpm-down" type="button" aria-label="Decrease tempo"><span aria-hidden="true">&minus;</span></button>
        <div class="nv-bpm">
          <span class="nv-bpm-value">${DEFAULT_BPM}</span>
          <span class="nv-bpm-unit">BPM</span>
        </div>
        <button class="icon-btn nv-step nv-bpm-up" type="button" aria-label="Increase tempo"><span aria-hidden="true">+</span></button>
      </div>
      <div class="nv-tempo-line">
        <p class="nv-tempo-name">${tempoName(DEFAULT_BPM)}</p>
        <span class="nv-target" hidden></span>
      </div>
      <input class="nv-slider" type="range" min="${BPM_MIN}" max="${BPM_MAX}" step="1" value="${DEFAULT_BPM}" aria-label="Tempo in beats per minute">
      <button class="btn btn-ghost nv-tap" type="button" aria-describedby="nv-tap-hint">Tap the beat</button>
      <p class="nv-tap-hint" id="nv-tap-hint">${TAP_HINT}</p>
      <p class="nv-tap-live" aria-live="polite" hidden></p>
    </div>

    <div class="nv-transport-row">
      <button class="nv-transport" type="button" aria-pressed="false" aria-label="Start metronome">
        <span class="nv-shape" aria-hidden="true"></span>
      </button>
    </div>

    <div class="card nv-stage is-idle">
      <div class="nv-stage-head">
        <div class="nv-stage-read">
          <span class="nv-count" aria-hidden="true">${REST_COUNT}</span>
          <span class="nv-stage-bpm" aria-hidden="true">${DEFAULT_BPM} BPM</span>
          <span class="nv-muted-tag" hidden>${ICON_MUTED_TAG}Click muted</span>
          <span class="nv-gap-tag">${ICON_GAP_TAG}Count it</span>
        </div>
        <div class="nv-tools">
          <button class="icon-btn nv-tool nv-big" type="button" aria-pressed="false" aria-label="Big view">${ICON_EXPAND}</button>
          <button class="icon-btn nv-tool nv-pend-toggle" type="button" aria-pressed="true" aria-label="Show pendulum">${ICON_PENDULUM}</button>
          ${
            HAS_VIBRATE
              ? `<button class="icon-btn nv-tool nv-vibe" type="button" aria-pressed="false" aria-label="Vibrate on beat">${ICON_VIBRATE}</button>`
              : ''
          }
          <button class="icon-btn nv-tool nv-mute" type="button" aria-pressed="false" aria-label="Mute click">${ICON_SPEAKER}</button>
        </div>
      </div>
      <div class="nv-pend-box" aria-hidden="true">${pendulumSvg()}</div>
      <div class="nv-dots" aria-hidden="true"></div>
      <button class="nv-transport nv-stage-transport" type="button" aria-pressed="false" aria-label="Start metronome">
        <span class="nv-shape" aria-hidden="true"></span>
      </button>
    </div>

    <div class="card nv-panel nv-settings">
      <div class="nv-row">
        <span class="nv-row-label">Beats per bar</span>
        <div class="nv-stepper" role="group" aria-label="Beats per bar">
          <button class="icon-btn nv-step nv-bpb-down" type="button" aria-label="Fewer beats per bar"><span aria-hidden="true">&minus;</span></button>
          <span class="nv-bpb-value">${DEFAULT_BPB}</span>
          <button class="icon-btn nv-step nv-bpb-up" type="button" aria-label="More beats per bar"><span aria-hidden="true">+</span></button>
        </div>
      </div>
      <div class="nv-row">
        <span class="nv-row-label">Subdivision</span>
        <div class="seg nv-seg" role="group" aria-label="Subdivision">
          ${SUBDIVISIONS.map(
            (s, i) =>
              `<button class="seg-item nv-sub${i === 0 ? ' is-active' : ''}" type="button" aria-pressed="${i === 0}" aria-label="${s.label}"><span class="nv-glyph" aria-hidden="true">${s.glyph}</span></button>`,
          ).join('')}
        </div>
      </div>
    </div>

    <div class="card nv-panel nv-practice">
      <div class="nv-prac">
        <button class="nv-prac-head nv-trainer-btn" type="button" aria-pressed="false">
          <span class="nv-row-label">Speed trainer</span>
          <span class="nv-prac-sum nv-trainer-sum" aria-hidden="true"></span>
          <span class="nv-switch" aria-hidden="true"></span>
        </button>
        <p class="sr-only nv-trainer-live" aria-live="polite"></p>
        <div class="nv-prac-cfg nv-trainer-cfg" hidden>
          ${miniStepper('add', 'Tempo added each step', 'Smaller tempo step', 'Bigger tempo step')}
          <span class="nv-prac-word">BPM every</span>
          ${miniStepper('bars', 'Bars between steps', 'Fewer bars between steps', 'More bars between steps')}
          <span class="nv-prac-word">bars, up to</span>
          ${miniStepper('target', 'Target tempo', 'Lower target tempo', 'Higher target tempo')}
        </div>
      </div>
      <div class="nv-prac">
        <button class="nv-prac-head nv-gap-btn" type="button" aria-pressed="false">
          <span class="nv-row-label">Gap training</span>
          <span class="nv-prac-sum nv-gap-sum" aria-hidden="true"></span>
          <span class="nv-switch" aria-hidden="true"></span>
        </button>
        <p class="sr-only nv-gap-live" aria-live="polite"></p>
        <div class="nv-prac-cfg nv-gap-cfg" hidden>
          ${miniStepper('play', 'Bars with the click', 'Fewer sounding bars', 'More sounding bars')}
          <span class="nv-prac-word">bars on /</span>
          ${miniStepper('rest', 'Bars of silence', 'Fewer silent bars', 'More silent bars')}
          <span class="nv-prac-word">off</span>
        </div>
      </div>
    </div>`;

  const bpmValue = el.querySelector('.nv-bpm-value') as HTMLElement;
  const tempoLabel = el.querySelector('.nv-tempo-name') as HTMLElement;
  const slider = el.querySelector('.nv-slider') as HTMLInputElement;
  const tapBtn = el.querySelector('.nv-tap') as HTMLButtonElement;
  const tapHint = el.querySelector('.nv-tap-hint') as HTMLElement;
  const tapLive = el.querySelector('.nv-tap-live') as HTMLElement;
  const stage = el.querySelector('.nv-stage') as HTMLElement;
  const arm = el.querySelector('.nv-pend-arm') as SVGGElement;
  const countEl = el.querySelector('.nv-count') as HTMLElement;
  const stageBpm = el.querySelector('.nv-stage-bpm') as HTMLElement;
  const mutedTag = el.querySelector('.nv-muted-tag') as HTMLElement;
  const bigBtn = el.querySelector('.nv-big') as HTMLButtonElement;
  const pendBtn = el.querySelector('.nv-pend-toggle') as HTMLButtonElement;
  const vibeBtn = el.querySelector('.nv-vibe') as HTMLButtonElement | null;
  const muteBtn = el.querySelector('.nv-mute') as HTMLButtonElement;
  const dotsEl = el.querySelector('.nv-dots') as HTMLElement;
  const transport = el.querySelector('.nv-transport-row .nv-transport') as HTMLButtonElement;
  const stageTransport = el.querySelector('.nv-stage-transport') as HTMLButtonElement;
  const bpbValue = el.querySelector('.nv-bpb-value') as HTMLElement;
  const subBtns = Array.from(el.querySelectorAll<HTMLButtonElement>('.nv-sub'));
  const targetChip = el.querySelector('.nv-target') as HTMLElement;
  const trainerBtn = el.querySelector('.nv-trainer-btn') as HTMLButtonElement;
  const trainerSum = el.querySelector('.nv-trainer-sum') as HTMLElement;
  const trainerLive = el.querySelector('.nv-trainer-live') as HTMLElement;
  const trainerCfg = el.querySelector('.nv-trainer-cfg') as HTMLElement;
  const addValue = el.querySelector('.nv-add-value') as HTMLElement;
  const barsValue = el.querySelector('.nv-bars-value') as HTMLElement;
  const targetValue = el.querySelector('.nv-target-value') as HTMLElement;
  const gapBtn = el.querySelector('.nv-gap-btn') as HTMLButtonElement;
  const gapSum = el.querySelector('.nv-gap-sum') as HTMLElement;
  const gapLive = el.querySelector('.nv-gap-live') as HTMLElement;
  const gapCfg = el.querySelector('.nv-gap-cfg') as HTMLElement;
  const playValue = el.querySelector('.nv-play-value') as HTMLElement;
  const restValue = el.querySelector('.nv-rest-value') as HTMLElement;
  const sayTrainer = liveWriter(trainerLive);
  const sayGap = liveWriter(gapLive);
  let dots: HTMLElement[] = [];

  function renderBpm(): void {
    bpmValue.textContent = String(bpm);
    tempoLabel.textContent = tempoName(bpm);
    stageBpm.textContent = `${bpm} BPM`;
    slider.value = String(bpm);
    slider.style.setProperty('--nv-fill', `${((bpm - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100}%`);
    renderTarget();
  }

  /** Where the climb ends, and whether it still has anywhere to go. Derived from
      the tempo rather than latched, so raising the target while the ramp is
      parked on it puts the chip straight back into its climbing state. The swap
      happens on the bar the target is reached — never on a beat. */
  function renderTarget(): void {
    const t = prefs.trainer;
    const arrived = t.on && bpm >= t.target;
    const text = arrived ? `at ${t.target}` : `up to ${t.target}`;
    if (targetChip.textContent !== text) targetChip.textContent = text;
    targetChip.classList.toggle('is-at', arrived);
    targetChip.hidden = !t.on;
    if (!arrived) {
      saidAtTarget = false;
      return;
    }
    if (saidAtTarget) return;
    saidAtTarget = true;
    // A chip is silent to a screen reader; the end of the climb is the one
    // moment of the exercise that has to be spoken.
    if (metro.running) sayTrainer(`Speed trainer at ${t.target} BPM, climb finished`);
  }

  function setBpm(next: number, fromTap = false): void {
    bpm = clamp(Math.round(next), BPM_MIN, BPM_MAX);
    metro.bpm = bpm;
    // A hand-set tempo is where the next climb starts from, dragged or tapped:
    // the trainer follows the musician instead of overwriting them.
    if (prefs.trainer.on) trainerBase = bpm;
    renderBpm();
    // A slider or stepper edit makes any "Set to N BPM" caption a lie.
    if (!fromTap) revertTap();
  }

  function revertTap(): void {
    window.clearTimeout(tapRevert);
    tapRevert = 0;
    tapLive.hidden = true;
    tapLive.textContent = '';
    tapHint.hidden = false;
  }

  function buildDots(): void {
    dotsEl.replaceChildren();
    for (let i = 0; i < beatsPerBar; i++) {
      const dot = document.createElement('span');
      dot.className = i === 0 ? 'nv-dot nv-dot-accent' : 'nv-dot';
      dotsEl.appendChild(dot);
    }
    dots = Array.from(dotsEl.querySelectorAll<HTMLElement>('.nv-dot'));
  }

  function setBeatsPerBar(next: number): void {
    const n = clamp(Math.round(next), BPB_MIN, BPB_MAX);
    if (n === beatsPerBar) return;
    beatsPerBar = n;
    metro.beatsPerBar = n;
    bpbValue.textContent = String(n);
    buildDots();
  }

  function setSubdivision(next: Subdivision): void {
    metro.subdivision = next;
    subBtns.forEach((b, i) => {
      const on = i + 1 === next;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /* ---------- practice ---------- */

  /** A held stepper steps every 36 ms at full tilt and localStorage is
      synchronous on the thread the scheduler and the rAF loop share, so the
      write waits for the hold to end. The engine already has the new config. */
  function queueSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => savePrefs(prefs), 350);
  }

  /** Pushes the whole config at the engine, which reads it fresh on each
      downbeat — so an edit mid-run lands on the next bar without a restart. */
  function renderTrainer(): void {
    const t = prefs.trainer;
    addValue.textContent = `+${t.add}`;
    barsValue.textContent = String(t.bars);
    targetValue.textContent = String(t.target);
    trainerSum.textContent = `+${t.add} BPM / ${t.bars} bars → ${t.target}`;
    trainerSum.hidden = t.on;
    trainerBtn.setAttribute('aria-pressed', t.on ? 'true' : 'false');
    trainerCfg.hidden = !t.on;
    // "the BPM follows" stops being true the moment something else is driving
    // the tempo, so the button under it says what a tap does instead.
    tapHint.textContent = t.on ? TAP_HINT_TRAINER : TAP_HINT;
    renderTarget();
    metro.trainer = t.on ? { add: t.add, bars: t.bars, target: t.target } : null;
  }

  function renderGap(): void {
    const g = prefs.gap;
    playValue.textContent = String(g.play);
    restValue.textContent = String(g.mute);
    gapSum.textContent = `${g.play} bars on / ${g.mute} off`;
    gapSum.hidden = g.on;
    gapBtn.setAttribute('aria-pressed', g.on ? 'true' : 'false');
    gapCfg.hidden = !g.on;
    metro.gap = g.on ? { play: g.play, mute: g.mute } : null;
    // Switched off inside a silent bar, the stage would otherwise hold the
    // muted-bar treatment until the next beat repainted it.
    if (!g.on) stage.classList.remove('is-gap');
  }

  function editTrainer(patch: Partial<TrainerPrefs>): void {
    const t = prefs.trainer;
    const wasOn = t.on;
    const next = { ...t, ...patch };
    t.on = next.on;
    t.add = clamp(next.add, ADD_MIN, ADD_MAX);
    t.bars = clamp(next.bars, BARS_MIN, BARS_MAX);
    t.target = clamp(next.target, BPM_MIN, BPM_MAX);
    // Switching it on marks where the first climb starts.
    if (t.on && !wasOn) trainerBase = bpm;
    renderTrainer();
    // The values live in a sentence of small steppers with no big readout
    // mirroring them, so the change is spoken as one — once it has settled.
    sayTrainer(
      t.on
        ? `Speed trainer on, ${t.add} BPM every ${t.bars} bars, up to ${t.target} BPM`
        : 'Speed trainer off',
    );
    queueSave();
  }

  function editGap(patch: Partial<GapPrefs>): void {
    const g = prefs.gap;
    const next = { ...g, ...patch };
    g.on = next.on;
    g.play = clamp(next.play, GAP_MIN, GAP_MAX);
    g.mute = clamp(next.mute, GAP_MIN, GAP_MAX);
    renderGap();
    sayGap(
      g.on
        ? `Gap training on, ${g.play} bars with the click, ${g.mute} silent`
        : 'Gap training off',
    );
    queueSave();
  }

  /** Unfolding a row's steppers can drop them under the tab bar, and a switch
      that appears to do nothing reads as a broken switch. `nearest` moves the
      view the least it can — nothing at all when the row is already clear — and
      the row's scroll-margin keeps it off the shell's bottom fade. */
  function reveal(row: Element | null): void {
    row?.scrollIntoView({
      block: 'nearest',
      behavior: REDUCE_MOTION.matches ? 'auto' : 'smooth',
    });
  }

  /* ---------- beat stage ---------- */

  /** The toggle wins once it has been used; until then the OS decides. */
  function pendulumShown(): boolean {
    return prefs.pendulum ?? !REDUCE_MOTION.matches;
  }

  /** Transform-only: the arm group rotates about the pivot, nothing reflows. */
  function frame(): void {
    rafId = requestAnimationFrame(frame);
    // Switched off, the arm holds at rest and the counter, the marker dot, the
    // click and the vibration carry the beat on their own.
    if (!pendulumShown()) return;
    const clock = metro.beatClock();
    // cos(π·(beat + phase)) is +1 on even beats and −1 on odd ones, so an
    // extreme lands exactly on every click and the swing takes two beats.
    const angle = clock ? SWING_DEG * Math.cos(Math.PI * (clock.beat + clock.phase)) : 0;
    if (Math.abs(angle - writtenAngle) < ANGLE_EPSILON) return;
    writtenAngle = angle;
    arm.style.transform = `rotate(${angle.toFixed(2)}deg)`;
  }

  function startLoop(): void {
    if (rafId !== 0 || !visible || !metro.running || !pendulumShown()) return;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop(): void {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    writtenAngle = 0;
    arm.style.transform = 'rotate(0deg)';
  }

  /** Static name + aria-pressed: a toggle that renames itself reads as two
      different controls to a screen reader. */
  function syncMute(): void {
    muteBtn.setAttribute('aria-pressed', prefs.muted ? 'true' : 'false');
    mutedTag.hidden = !prefs.muted;
  }

  function syncVibe(): void {
    vibeBtn?.setAttribute('aria-pressed', prefs.vibrate ? 'true' : 'false');
  }

  /** Off parks the arm and costs nothing: the loop is not started at all. */
  function syncPendulum(): void {
    const on = pendulumShown();
    pendBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    stage.classList.toggle('is-pend-off', !on);
    if (on) startLoop();
    else stopLoop();
  }

  /** Both transports are the same control in two places; they never disagree. */
  function syncTransport(): void {
    const running = metro.running;
    const label = running ? 'Stop metronome' : 'Start metronome';
    // Held while the engine runs, hidden view included — the click keeps time
    // for a musician who is looking at their hands, not at the screen. Every
    // stop path lands here, including a start that never got its audio.
    if (running) holdWake('metronome');
    else releaseWake('metronome');
    for (const btn of [transport, stageTransport]) {
      btn.classList.toggle('is-running', running);
      btn.setAttribute('aria-pressed', running ? 'true' : 'false');
      btn.setAttribute('aria-label', label);
    }
    stage.classList.toggle('is-idle', !running);
    if (running) {
      startLoop();
    } else {
      stopLoop();
      settle();
      countEl.classList.remove('is-accent');
      countEl.textContent = REST_COUNT;
      stage.classList.remove('is-gap');
    }
    if (running === wasRunning) return;
    wasRunning = running;
    window.dispatchEvent(
      new CustomEvent('truestring:metronome-running', { detail: { running } }),
    );
  }

  function toggleTransport(): void {
    if (metro.running) {
      metro.stop();
      syncTransport();
      return;
    }
    if (starting) return;
    starting = true;
    // Every run climbs. Without this the tempo is left wherever the last run
    // parked it — on the target, where the trainer has nothing left to do — and
    // pressing start again is a silent no-op under a switch that reads as on.
    if (prefs.trainer.on) setBpm(trainerBase);
    ensureRunning()
      .then(() => metro.start())
      .catch(() => undefined)
      .finally(() => {
        starting = false;
        syncTransport();
      });
  }

  /** Clear the moving beat marker and any in-flight counter tick, so a stage
      shown again after being hidden starts from a clean position rather than
      replaying the last beat it saw. */
  function settle(): void {
    for (const dot of dots) dot.classList.remove('is-current');
    countEl.classList.remove('is-tick');
  }

  /* ---------- big view ---------- */

  /** Exactly what this view made inert, so closing never clears an `inert` the
      shell set for a sheet of its own. */
  const inerted: Element[] = [];

  /**
   * A full-screen overlay has to be a real modal. Everything outside the stage
   * — the other cards in this view, the other views, the header and the tab bar
   * — goes inert, so Tab cycles the stage's own controls and the covered tuning
   * chip can no longer open a sheet underneath the overlay.
   */
  function setOutsideInert(on: boolean): void {
    if (!on) {
      for (const node of inerted) node.removeAttribute('inert');
      inerted.length = 0;
      return;
    }
    const stop = el.closest('.app-frame') ?? document.body;
    let node: Element = stage;
    while (node !== stop && node.parentElement) {
      const parent: Element = node.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node || sibling.hasAttribute('inert')) continue;
        sibling.setAttribute('inert', '');
        inerted.push(sibling);
      }
      node = parent;
    }
  }

  function setBig(on: boolean, restoreFocus = true): void {
    if (big === on) return;
    big = on;
    if (on) {
      // Going fixed pulls the stage out of the flow, which collapses the scroll
      // container under it and makes the browser clamp scrollTop; the offset is
      // only recoverable if it is read before the class lands.
      scroller = el.closest<HTMLElement>('.view-root');
      scrollTop = scroller?.scrollTop ?? 0;
      stage.setAttribute('role', 'dialog');
      stage.setAttribute('aria-modal', 'true');
      stage.setAttribute('aria-label', 'Metronome big view');
    }
    stage.classList.toggle('is-big', on);
    bigBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    document.body.classList.toggle(BIG_BODY_CLASS, on);
    setOutsideInert(on);
    if (on) {
      document.addEventListener('keydown', onBigKey);
      stageTransport.focus();
    } else {
      document.removeEventListener('keydown', onBigKey);
      stage.removeAttribute('role');
      stage.removeAttribute('aria-modal');
      stage.removeAttribute('aria-label');
      // .view-root is shared with the other views, so the offset only goes back
      // if this view is still the one on screen.
      if (visible && scroller) scroller.scrollTop = scrollTop;
      scroller = null;
      // Unconditional: closing the overlay by hand always hands focus back to
      // the button that opened it, wherever it had wandered. Only the tab-switch
      // teardown passes restoreFocus false, and it is the one path that must not
      // pull focus into a view being taken off screen.
      if (restoreFocus) bigBtn.focus();
    }
  }

  /** The stage's own controls in DOM order — the rail, then the transport. The
      vibrate toggle is not built everywhere and the stage transport only shows
      in big view, so the list is read live rather than cached. */
  function stageFocusables(): HTMLElement[] {
    return Array.from(stage.querySelectorAll<HTMLElement>('button')).filter(
      (b) => !(b as HTMLButtonElement).disabled && b.getClientRects().length > 0,
    );
  }

  /**
   * Big view declares itself a modal, so it has to hold Tab. Everything outside
   * is inert, but without a wrap the cycle still steps off the last control onto
   * <body> — no focus ring, nothing to read, and an Escape from there with
   * nowhere to put focus back.
   */
  function onBigKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      setBig(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = stageFocusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    // Focus outside the stage is the recovery case — a Tab from anywhere else
    // comes straight back in rather than walking an inert document.
    const leaving = e.shiftKey ? first : last;
    if (document.activeElement === leaving || !stage.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  metro.onBeat = (beatInBar: number, isAccent: boolean, muted: boolean): void => {
    countEl.textContent = String(beatInBar + 1);
    countEl.classList.toggle('is-accent', isAccent);
    // A gap bar is a state, not an event: the counter switches to its outline
    // and holds there for the whole bar. Distinct from the user's own mute,
    // which keeps its own tag and its solid numeral.
    stage.classList.toggle('is-gap', muted);
    // Position, not pulse: exactly one dot is filled and the fill steps along.
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('is-current', i === beatInBar);
    }
    // The stage is display:none while another tab is up; the tick would only
    // queue and fire on return.
    if (visible) replay(countEl, 'is-tick');
    // The haptic stands in for the click, so a gap bar drops it too — a buzz
    // through the bar you are supposed to keep on your own is no gap at all.
    if (HAS_VIBRATE && prefs.vibrate && !muted) {
      navigator.vibrate(isAccent ? VIBE_ACCENT_MS : VIBE_BEAT_MS);
    }
  };

  // The trainer moves the tempo itself: follow it in the readout, on the slider
  // and in the target chip. The tap caption goes with it — "Set to 100 BPM"
  // standing under a readout that now says 130 is one of the two numbers being
  // a lie. Note the base is untouched: a bump is the climb, not a new start.
  metro.onTempoChange = (next: number): void => {
    bpm = clamp(Math.round(next), BPM_MIN, BPM_MAX);
    renderBpm();
    revertTap();
  };

  attachRepeat(el.querySelector('.nv-bpm-down') as HTMLButtonElement, () => setBpm(bpm - 1));
  attachRepeat(el.querySelector('.nv-bpm-up') as HTMLButtonElement, () => setBpm(bpm + 1));
  attachRepeat(el.querySelector('.nv-bpb-down') as HTMLButtonElement, () =>
    setBeatsPerBar(beatsPerBar - 1),
  );
  attachRepeat(el.querySelector('.nv-bpb-up') as HTMLButtonElement, () =>
    setBeatsPerBar(beatsPerBar + 1),
  );

  const repeat = (sel: string, step: () => void): void =>
    attachRepeat(el.querySelector(sel) as HTMLButtonElement, step);

  repeat('.nv-add-down', () => editTrainer({ add: prefs.trainer.add - 1 }));
  repeat('.nv-add-up', () => editTrainer({ add: prefs.trainer.add + 1 }));
  repeat('.nv-bars-down', () => editTrainer({ bars: prefs.trainer.bars - 1 }));
  repeat('.nv-bars-up', () => editTrainer({ bars: prefs.trainer.bars + 1 }));
  repeat('.nv-target-down', () => editTrainer({ target: prefs.trainer.target - 1 }));
  repeat('.nv-target-up', () => editTrainer({ target: prefs.trainer.target + 1 }));
  repeat('.nv-play-down', () => editGap({ play: prefs.gap.play - 1 }));
  repeat('.nv-play-up', () => editGap({ play: prefs.gap.play + 1 }));
  repeat('.nv-rest-down', () => editGap({ mute: prefs.gap.mute - 1 }));
  repeat('.nv-rest-up', () => editGap({ mute: prefs.gap.mute + 1 }));

  trainerBtn.addEventListener('click', () => {
    editTrainer({ on: !prefs.trainer.on });
    if (prefs.trainer.on) reveal(trainerBtn.closest('.nv-prac'));
  });

  gapBtn.addEventListener('click', () => {
    editGap({ on: !prefs.gap.on });
    if (prefs.gap.on) reveal(gapBtn.closest('.nv-prac'));
  });

  slider.addEventListener('input', () => setBpm(Number(slider.value)));

  tapBtn.addEventListener('click', () => {
    replay(tapBtn, 'is-tapped');
    const tapped = metro.tap();
    if (tapped !== null) setBpm(tapped, true);
    tapLive.textContent = tapped !== null ? `Set to ${tapped} BPM` : 'Keep tapping…';
    tapLive.hidden = false;
    tapHint.hidden = true;
    window.clearTimeout(tapRevert);
    tapRevert = window.setTimeout(revertTap, TAP_REVERT_MS);
  });

  bigBtn.addEventListener('click', () => setBig(!big));

  pendBtn.addEventListener('click', () => {
    prefs.pendulum = !pendulumShown();
    syncPendulum();
    savePrefs(prefs);
  });

  // While no choice has been made, the stage follows the OS preference live —
  // turning reduced motion on should not need a reload to be obeyed.
  REDUCE_MOTION.addEventListener('change', () => {
    if (prefs.pendulum === null) syncPendulum();
  });

  vibeBtn?.addEventListener('click', () => {
    prefs.vibrate = !prefs.vibrate;
    syncVibe();
    savePrefs(prefs);
    // A confirming buzz on the tap that turned it on, so the effect is felt
    // before the next beat arrives (or at all, with the metronome stopped).
    if (prefs.vibrate) navigator.vibrate(VIBE_ACCENT_MS);
  });

  muteBtn.addEventListener('click', () => {
    prefs.muted = !prefs.muted;
    metro.muted = prefs.muted;
    syncMute();
    savePrefs(prefs);
  });

  subBtns.forEach((b, i) => {
    b.addEventListener('click', () => setSubdivision((i + 1) as Subdivision));
  });

  transport.addEventListener('click', toggleTransport);
  stageTransport.addEventListener('click', toggleTransport);

  buildDots();
  renderBpm();
  syncMute();
  syncVibe();
  syncPendulum();
  renderTrainer();
  renderGap();

  // The metronome deliberately keeps running while its view is hidden; only the
  // rAF loop that draws it stops, since nothing it writes to would be visible.
  return {
    el,
    show(): void {
      visible = true;
      settle();
      syncTransport();
    },
    hide(): void {
      visible = false;
      // A fixed stage inside a display:none section would vanish while leaving
      // the page scroll-locked, so leaving the tab leaves big view too.
      setBig(false, false);
      stopLoop();
    },
  };
}
