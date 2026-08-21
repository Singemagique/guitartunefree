import './metronome-view.css';
import { ensureRunning } from '../audio/context';
import { Metronome, type Subdivision } from '../audio/metronome';

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

const PREFS_KEY = 'truestring:metronome';

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
/** Above this tempo a full-viewport flash on every beat would exceed the
    three-flashes-per-second limit (WCAG 2.3.1), so it drops to downbeats. */
const SCREEN_FLASH_MAX_BPM = 180;
/** The engine forgets a tap series after 2 s; the extra grace stops the caption
    swapping back while a slow tapper is still mid-phrase. */
const TAP_REVERT_MS = 2500;

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

const ICON_BOLT = `<svg ${SVG_ATTRS}><path d="M13.4 2.6 5.2 13.6h5.6l-.7 7.8 8.7-11.4h-5.9z"/></svg>`;
const ICON_SPEAKER = `<svg ${SVG_ATTRS}>
  <path d="M4 9.4h3.4L12 5.2v13.6L7.4 14.6H4z"/>
  <g class="nv-ico-on"><path d="M15.6 9.6a3.4 3.4 0 0 1 0 4.8"/><path d="M18.2 7.2a7 7 0 0 1 0 9.6"/></g>
  <g class="nv-ico-off"><path d="M16.4 9.8 21 14.4"/><path d="M21 9.8l-4.6 4.6"/></g>
</svg>`;
const ICON_MUTED_TAG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 9.4h3.4L12 5.2v13.6L7.4 14.6H4z"/><path d="M16.4 9.8 21 14.4"/><path d="M21 9.8l-4.6 4.6"/></svg>`;

interface Prefs {
  screenFlash: boolean;
  muted: boolean;
}

function tempoName(bpm: number): string {
  for (const mark of TEMPO_MARKS) {
    if (bpm < mark.max) return mark.name;
  }
  return 'Presto';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Storage can be absent (file://), full, or hold junk from an older build. */
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        const bag = parsed as Record<string, unknown>;
        return { screenFlash: bag.screenFlash === true, muted: bag.muted === true };
      }
    }
  } catch {
    /* unreadable or unparseable — fall through to defaults */
  }
  return { screenFlash: false, muted: false };
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
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

/** Same, for the accent/normal pair — either class may be the one in flight. */
function flash(el: HTMLElement, accent: boolean): void {
  el.classList.remove('is-flash', 'is-flash-accent');
  void el.offsetWidth;
  el.classList.add(accent ? 'is-flash-accent' : 'is-flash');
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
    btn.setPointerCapture(e.pointerId);
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

/** One shared overlay for the whole app, built only if the toggle is used. */
let screenFlashEl: HTMLElement | null = null;

function screenOverlay(): HTMLElement {
  if (!screenFlashEl) {
    screenFlashEl = document.createElement('div');
    screenFlashEl.className = 'nv-screen-flash';
    screenFlashEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(screenFlashEl);
  }
  return screenFlashEl;
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
  let rafId = 0;
  let writtenAngle = Number.NaN;
  let tapRevert = 0;

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
      <p class="nv-tempo-name">${tempoName(DEFAULT_BPM)}</p>
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
      ${pendulumSvg()}
      <div class="nv-stage-head">
        <div class="nv-stage-read">
          <span class="nv-count" aria-hidden="true">${REST_COUNT}</span>
          <span class="nv-muted-tag" hidden>${ICON_MUTED_TAG}Click muted</span>
        </div>
        <div class="nv-tools">
          <button class="icon-btn nv-tool nv-flash" type="button" aria-pressed="false" aria-label="Screen flash">${ICON_BOLT}</button>
          <button class="icon-btn nv-tool nv-mute" type="button" aria-pressed="false" aria-label="Mute click">${ICON_SPEAKER}</button>
        </div>
      </div>
      <div class="nv-dots" aria-hidden="true"></div>
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
  const mutedTag = el.querySelector('.nv-muted-tag') as HTMLElement;
  const flashBtn = el.querySelector('.nv-flash') as HTMLButtonElement;
  const muteBtn = el.querySelector('.nv-mute') as HTMLButtonElement;
  const dotsEl = el.querySelector('.nv-dots') as HTMLElement;
  const transport = el.querySelector('.nv-transport') as HTMLButtonElement;
  const bpbValue = el.querySelector('.nv-bpb-value') as HTMLElement;
  const subBtns = Array.from(el.querySelectorAll<HTMLButtonElement>('.nv-sub'));
  let dots: HTMLElement[] = [];

  function renderBpm(): void {
    bpmValue.textContent = String(bpm);
    tempoLabel.textContent = tempoName(bpm);
    slider.value = String(bpm);
    slider.style.setProperty('--nv-fill', `${((bpm - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100}%`);
  }

  function setBpm(next: number, fromTap = false): void {
    bpm = clamp(Math.round(next), BPM_MIN, BPM_MAX);
    metro.bpm = bpm;
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
      const glow = document.createElement('span');
      glow.className = 'nv-dot-glow';
      dot.appendChild(glow);
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

  /* ---------- beat stage ---------- */

  /** Transform-only: the arm group rotates about the pivot, nothing reflows. */
  function frame(): void {
    rafId = requestAnimationFrame(frame);
    const clock = metro.beatClock();
    // cos(π·(beat + phase)) is +1 on even beats and −1 on odd ones, so an
    // extreme lands exactly on every click and the swing takes two beats.
    const angle = clock ? SWING_DEG * Math.cos(Math.PI * (clock.beat + clock.phase)) : 0;
    if (Math.abs(angle - writtenAngle) < ANGLE_EPSILON) return;
    writtenAngle = angle;
    arm.style.transform = `rotate(${angle.toFixed(2)}deg)`;
  }

  function startLoop(): void {
    if (rafId !== 0 || !visible || !metro.running) return;
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

  function syncFlash(): void {
    flashBtn.setAttribute('aria-pressed', prefs.screenFlash ? 'true' : 'false');
    if (!prefs.screenFlash && screenFlashEl) {
      screenFlashEl.classList.remove('is-flash', 'is-flash-accent');
    }
  }

  function syncTransport(): void {
    const running = metro.running;
    transport.classList.toggle('is-running', running);
    transport.setAttribute('aria-pressed', running ? 'true' : 'false');
    transport.setAttribute('aria-label', running ? 'Stop metronome' : 'Start metronome');
    stage.classList.toggle('is-idle', !running);
    if (running) {
      startLoop();
    } else {
      stopLoop();
      settle();
      countEl.classList.remove('is-accent');
      countEl.textContent = REST_COUNT;
      if (screenFlashEl) screenFlashEl.classList.remove('is-flash', 'is-flash-accent');
    }
    if (running === wasRunning) return;
    wasRunning = running;
    window.dispatchEvent(
      new CustomEvent('truestring:metronome-running', { detail: { running } }),
    );
  }

  /** Drop every in-flight beat animation, so a view shown again after being
      hidden does not replay a whole bar's worth of pulses at once. */
  function settle(): void {
    for (const dot of dots) dot.classList.remove('is-pulse');
    stage.classList.remove('is-flash', 'is-flash-accent');
    countEl.classList.remove('is-hit');
  }

  let screenFlashParity = 0;

  /** Never more than three viewport flashes a second: above the cap only
      downbeats flash, and a one-beat bar flashes every other downbeat. */
  function screenFlashDue(isAccent: boolean): boolean {
    if (bpm <= SCREEN_FLASH_MAX_BPM) return true;
    if (!isAccent) return false;
    if (beatsPerBar > 1) return true;
    screenFlashParity ^= 1;
    return screenFlashParity === 1;
  }

  metro.onBeat = (beatInBar: number, isAccent: boolean): void => {
    countEl.textContent = String(beatInBar + 1);
    countEl.classList.toggle('is-accent', isAccent);
    // The stage is display:none while another tab is up; its animations would
    // only queue up and fire together on return.
    if (visible) {
      const dot = dots[beatInBar];
      if (dot) replay(dot, 'is-pulse');
      replay(countEl, 'is-hit');
      flash(stage, isAccent);
    }
    // The viewport frame is app-wide on purpose: it is what lets you keep
    // the beat from the tuner tab or from across the room.
    if (prefs.screenFlash && screenFlashDue(isAccent)) flash(screenOverlay(), isAccent);
  };

  attachRepeat(el.querySelector('.nv-bpm-down') as HTMLButtonElement, () => setBpm(bpm - 1));
  attachRepeat(el.querySelector('.nv-bpm-up') as HTMLButtonElement, () => setBpm(bpm + 1));
  attachRepeat(el.querySelector('.nv-bpb-down') as HTMLButtonElement, () =>
    setBeatsPerBar(beatsPerBar - 1),
  );
  attachRepeat(el.querySelector('.nv-bpb-up') as HTMLButtonElement, () =>
    setBeatsPerBar(beatsPerBar + 1),
  );

  slider.addEventListener('input', () => setBpm(Number(slider.value)));

  tapBtn.addEventListener('click', () => {
    replay(tapBtn, 'is-flash');
    const tapped = metro.tap();
    if (tapped !== null) setBpm(tapped, true);
    tapLive.textContent = tapped !== null ? `Set to ${tapped} BPM` : 'Keep tapping…';
    tapLive.hidden = false;
    tapHint.hidden = true;
    window.clearTimeout(tapRevert);
    tapRevert = window.setTimeout(revertTap, TAP_REVERT_MS);
  });

  flashBtn.addEventListener('click', () => {
    prefs.screenFlash = !prefs.screenFlash;
    syncFlash();
    savePrefs(prefs);
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

  transport.addEventListener('click', () => {
    if (metro.running) {
      metro.stop();
      syncTransport();
      return;
    }
    if (starting) return;
    starting = true;
    ensureRunning()
      .then(() => metro.start())
      .catch(() => undefined)
      .finally(() => {
        starting = false;
        syncTransport();
      });
  });

  buildDots();
  renderBpm();
  syncMute();
  syncFlash();

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
      stopLoop();
    },
  };
}
