import './manual-view.css';
import { ensureRunning } from '../audio/context';
import { Drone } from '../audio/drone';
import { pluck } from '../audio/synth';
import { getState, subscribe } from '../state';
import { tuningById, tuningNotes } from '../music/tunings';
import type { NoteInfo } from '../music/notes';
import { NOTE_NAMES, prettyPc } from '../music/notes';
import { holdWake, releaseWake } from '../wakelock';

export interface ViewHandle {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

const RING_MS = 2000;
const LOOP_MS = 2000;
const STRUM_GAP_MS = 120;
/** How long a retune has to stop moving before the loop plays it. The capo
    stepper repeats down to a 36 ms tick while it is held, and every tick writes
    app state: without this, a thumb dragged from None to fret 12 fires a dozen
    2.5 s plucks that all sound at once. One pluck, at the pitch the player
    settled on. */
const RETUNE_PLUCK_MS = 250;

/** Spoken position of a string, counted the way players do: 1st is the highest. */
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'] as const;

const OCTAVE_MIN = 2;
const OCTAVE_MAX = 5;
/** A3 — the drone's default, and the note most players sing a reference from. */
const DRONE_PC = 9;
const DRONE_OCTAVE = 3;

/*
 * Headstock geometry, in viewBox units. The drawing is one column 120 units
 * wide and ROW_UNITS tall per tuner row, so a post drawn at the centre of a row
 * lands on the button in that row at every stage size — the stage's grid rows
 * are equal and the SVG box carries the same aspect ratio (see --mv-hs-ratio in
 * manual-view.css). ROW_UNITS is a third of the original 268-unit drawing, so a
 * six-string headstock renders exactly as it did before it became parametric.
 */
const ROW_UNITS = 268 / 3;
const HS_W = 120;
const HS_CX = 60;
/** The crown keeps its shape at every string count; only the long flanks stretch. */
const HS_TOP = 22;
const HS_CROWN = 62;

const LOOP_ICON = `
<svg class="mv-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M17 4H9a5 5 0 0 0-5 5v1"/><path d="M14 1l3 3-3 3"/>
  <path d="M7 20h8a5 5 0 0 0 5-5v-1"/><path d="M10 23l-3-3 3-3"/>
</svg>`;

/** Play triangle / stop square, swapped by aria-pressed — a state, not a blink. */
const DRONE_ICON = `
<svg class="mv-ico mv-ico-solid" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="mv-ico-on" d="M8.8 5.9 18.4 12l-9.6 6.1Z"/>
  <rect class="mv-ico-off" x="7.4" y="7.4" width="9.2" height="9.2" rx="1.8"/>
</svg>`;

const PC_CHIPS = NOTE_NAMES.map(
  (pc, i) =>
    `<button class="pill mv-pc-chip" type="button" data-pc="${i}" aria-pressed="false" aria-label="${pc.replace('#', ' sharp')}">${prettyPc(pc)}</button>`,
).join('');

function n1(v: number): string {
  return v.toFixed(1);
}

/** Number of tuner rows for a string count: the left column takes the surplus. */
function rowCount(strings: number): number {
  return Math.ceil(strings / 2);
}

/**
 * Outline of a headstock `h` units tall. The neck stub, the shoulder and the
 * flanks follow `h`; the crown above HS_CROWN does not, so the silhouette grows
 * downward from a constant head rather than scaling into a different shape.
 */
function headstockPath(h: number): string {
  const nut = h - 24;
  const shoulder = h - 50;
  const bend = (shoulder - HS_CROWN) * 0.18;
  return (
    `M44 ${n1(h - 6)} L44 ${n1(nut)}` +
    ` C44 ${n1(nut - 8)} 30 ${n1(nut - 10)} 27 ${n1(shoulder)}` +
    ` C22 ${n1(shoulder - bend)} 21 ${n1(HS_CROWN + bend)} 24 ${HS_CROWN}` +
    ` C26 36 40 ${HS_TOP} 60 ${HS_TOP}` +
    ` C80 ${HS_TOP} 94 36 96 ${HS_CROWN}` +
    ` C99 ${n1(HS_CROWN + bend)} 98 ${n1(shoulder - bend)} 93 ${n1(shoulder)}` +
    ` C90 ${n1(nut - 10)} 76 ${n1(nut - 8)} 76 ${n1(nut)}` +
    ` L76 ${n1(h - 6)} Z`
  );
}

/**
 * The decorative headstock for `count` strings, seen from the front: the first
 * ceil(count/2) posts run up the left flank from the bottom, the rest run back
 * down the right one. Strings and tuner groups are emitted in string order, so
 * their indices match the buttons'.
 */
function headstockSvg(count: number): string {
  const rows = rowCount(count);
  const h = ROW_UNITS * rows;
  const nutY = h - 24;
  const span = h - 50 - HS_CROWN;

  const posts = [];
  for (let i = 0; i < count; i++) {
    const left = i < rows;
    const y = ROW_UNITS * ((left ? rows - 1 - i : i - rows) + 0.5);
    // The body narrows towards the nut, so a post down by the shoulder sits a
    // little closer to the centre line than one up by the crown.
    const taper = Math.min(1, Math.max(0, (y - HS_CROWN) / span));
    posts.push({ x: HS_CX + (left ? -1 : 1) * (24 - 2 * taper), y, left });
  }

  const strings = posts
    .map((p, i) => {
      const x = 47 + (26 * i) / (count - 1);
      const width = 1.7 - i / (count - 1);
      return `<line x1="${n1(x)}" y1="${n1(h - 16)}" x2="${n1(p.x)}" y2="${n1(p.y)}" stroke-width="${width.toFixed(2)}"/>`;
    })
    .join('');

  const tuners = posts
    .map(
      (p) =>
        `<g class="mv-hs-tuner"><line x1="${n1(p.x)}" y1="${n1(p.y)}" x2="${p.left ? 4 : HS_W - 4}" y2="${n1(p.y)}"/><circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="5.5"/></g>`,
    )
    .join('');

  return `
<svg class="mv-headstock" viewBox="0 0 ${HS_W} ${n1(h)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
  <path class="mv-hs-body" d="${headstockPath(h)}"/>
  <path class="mv-hs-crown" d="M28 78 C30 44 42 29 60 29 C78 29 90 44 92 78"/>
  <path class="mv-hs-mark" d="M60 44 L66 58 L60 72 L54 58 Z"/>
  <g class="mv-hs-strings">${strings}</g>
  <rect class="mv-hs-nut" x="42" y="${n1(nutY - 4)}" width="36" height="5" rx="2"/>
  ${tuners}
</svg>`;
}

function stringButton(i: number, count: number): string {
  const rows = rowCount(count);
  const left = i < rows;
  const row = left ? rows - i : i - rows + 1;
  return `
    <button class="mv-string mv-col-${left ? 'l' : 'r'} mv-row-${row}" type="button" aria-pressed="false">
      <span class="mv-ripple" aria-hidden="true"></span>
      <span class="mv-label"><span class="mv-pc"></span><span class="mv-oct"></span></span>
    </button>`;
}

export function createManualView(): ViewHandle {
  const el = document.createElement('section');
  el.className = 'mv';
  el.setAttribute('aria-label', 'Manual tuner');
  el.innerHTML = `
    <div class="card mv-card">
      <div class="mv-capo-row" hidden><span class="mv-capo"></span></div>
      <div class="mv-stage" role="group" aria-label="Strings" data-rows="3"></div>
    </div>
    <div class="mv-controls">
      <button class="btn btn-ghost mv-loop" type="button" aria-pressed="false">${LOOP_ICON}<span>Loop</span></button>
      <button class="btn btn-primary mv-strum" type="button">Strum</button>
    </div>
    <p class="mv-hint">Tap a string for its reference tone. Loop repeats the selected string every 2 seconds.</p>

    <div class="card mv-drone">
      <div class="mv-drone-head">
        <h2 class="mv-drone-title">Drone</h2>
        <p class="mv-drone-note" aria-live="polite"><span class="mv-drone-glyph" aria-hidden="true">A3</span><span class="sr-only mv-drone-spoken">A 3</span></p>
      </div>
      <div class="mv-pcs" role="group" aria-label="Drone pitch">${PC_CHIPS}</div>
      <div class="mv-drone-row">
        <div class="mv-octave" role="group" aria-label="Drone octave">
          <button class="icon-btn mv-step mv-oct-down" type="button" aria-label="Lower octave"><span aria-hidden="true">&minus;</span></button>
          <span class="mv-oct-value">${DRONE_OCTAVE}</span>
          <button class="icon-btn mv-step mv-oct-up" type="button" aria-label="Raise octave"><span aria-hidden="true">+</span></button>
        </div>
        <button class="btn btn-ghost mv-drone-toggle" type="button" aria-pressed="false">${DRONE_ICON}<span>Drone</span></button>
      </div>
      <p class="mv-hint mv-drone-hint">A steady tone to tune or play against. It keeps sounding on the other tabs.</p>
    </div>`;

  const stage = el.querySelector('.mv-stage') as HTMLElement;
  const capoRow = el.querySelector('.mv-capo-row') as HTMLElement;
  const capoTag = el.querySelector('.mv-capo') as HTMLElement;
  const loopBtn = el.querySelector('.mv-loop') as HTMLButtonElement;
  const strumBtn = el.querySelector('.mv-strum') as HTMLButtonElement;
  const pcChips = Array.from(el.querySelectorAll<HTMLButtonElement>('.mv-pc-chip'));
  const octValue = el.querySelector('.mv-oct-value') as HTMLElement;
  const droneGlyph = el.querySelector('.mv-drone-glyph') as HTMLElement;
  const droneSpoken = el.querySelector('.mv-drone-spoken') as HTMLElement;
  const droneBtn = el.querySelector('.mv-drone-toggle') as HTMLButtonElement;

  let buttons: HTMLButtonElement[] = [];
  let pcEls: HTMLElement[] = [];
  let octEls: HTMLElement[] = [];
  let stringLines: SVGLineElement[] = [];
  let tuners: SVGGElement[] = [];
  let ringTimers: number[] = [];

  let notes: NoteInfo[] = [];
  let active = 0;
  let looping = false;
  let loopTimer = 0;
  let retuneTimer = 0;
  const strumTimers: number[] = [];

  const drone = new Drone();
  let dronePc = DRONE_PC;
  let droneOctave = DRONE_OCTAVE;

  function clearStrum(): void {
    for (const t of strumTimers) window.clearTimeout(t);
    strumTimers.length = 0;
  }

  function ring(i: number): void {
    const b = buttons[i];
    // Restart the amber ring/ripple even if the string is already sounding.
    b.classList.remove('is-ringing');
    void b.offsetWidth;
    b.classList.add('is-ringing');
    window.clearTimeout(ringTimers[i]);
    ringTimers[i] = window.setTimeout(() => b.classList.remove('is-ringing'), RING_MS);
  }

  function trigger(i: number): void {
    const n = notes[i];
    if (!n) return;
    ring(i);
    ensureRunning()
      .then(() => pluck(n.freq))
      .catch(() => undefined);
  }

  function setActive(i: number): void {
    active = i;
    for (let j = 0; j < buttons.length; j++) {
      const on = j === i;
      buttons[j].classList.toggle('is-active', on);
      buttons[j].setAttribute('aria-pressed', on ? 'true' : 'false');
      stringLines[j].classList.toggle('is-active', on);
      tuners[j].classList.toggle('is-active', on);
    }
  }

  /** A tuning with a different string count needs a different headstock, so the
      stage is rebuilt from scratch — buttons included. */
  function build(count: number): void {
    clearStrum();
    for (const t of ringTimers) window.clearTimeout(t);

    stage.dataset.rows = String(rowCount(count));
    const strings: string[] = [];
    for (let i = 0; i < count; i++) strings.push(stringButton(i, count));
    stage.innerHTML = headstockSvg(count) + strings.join('');

    buttons = Array.from(stage.querySelectorAll<HTMLButtonElement>('.mv-string'));
    pcEls = buttons.map((b) => b.querySelector('.mv-pc') as HTMLElement);
    octEls = buttons.map((b) => b.querySelector('.mv-oct') as HTMLElement);
    stringLines = Array.from(stage.querySelectorAll<SVGLineElement>('.mv-hs-strings line'));
    tuners = Array.from(stage.querySelectorAll<SVGGElement>('.mv-hs-tuner'));
    ringTimers = buttons.map(() => 0);

    buttons.forEach((b, i) => {
      b.addEventListener('click', () => {
        setActive(i);
        trigger(i);
        if (looping) armLoop();
      });
    });

    if (active >= count) active = count - 1;
  }

  function relabel(): void {
    const { tuningId, a4, capo } = getState();
    // Capo on, the buttons pluck what the strings actually sound: the reference
    // tone for the low string of Standard E at the 2nd fret is F♯2, and it is
    // labelled F♯2. The drone below is untouched — that picker is absolute
    // pitch, and a capo is a property of the fretboard, not of the note A.
    notes = tuningNotes(tuningById(tuningId), a4, capo);
    // The whole header row is hidden, not just the tag inside it: an empty row
    // would keep its padding and push the headstock down for nothing. The text
    // is written only when there is a fret to name, so the hidden row never
    // holds a stale "Capo 3" for a screen reader to find.
    if (capo > 0) capoTag.textContent = `Capo ${capo}`;
    capoRow.hidden = capo <= 0;
    if (notes.length !== buttons.length) build(notes.length);
    for (let i = 0; i < buttons.length; i++) {
      const n = notes[i];
      pcEls[i].textContent = prettyPc(n.pc);
      octEls[i].textContent = String(n.octave);
      const spoken = n.pc.replace('#', ' sharp');
      const ordinal = ORDINALS[notes.length - 1 - i];
      buttons[i].setAttribute('aria-label', `${ordinal} string, ${spoken} ${n.octave}`);
    }
    setActive(active);
  }

  function armLoop(): void {
    window.clearInterval(loopTimer);
    loopTimer = window.setInterval(() => trigger(active), LOOP_MS);
  }

  /** A retune the player is still making is not a pitch worth playing yet: the
      pluck waits for the value to settle, then sounds once. Trailing, so the
      tone that arrives is always the one the player stopped on. */
  function queueRetunePluck(): void {
    window.clearTimeout(retuneTimer);
    retuneTimer = window.setTimeout(() => {
      retuneTimer = 0;
      if (!looping) return;
      trigger(active);
      armLoop();
    }, RETUNE_PLUCK_MS);
  }

  function stopLoop(): void {
    if (!looping) return;
    looping = false;
    window.clearTimeout(retuneTimer);
    retuneTimer = 0;
    window.clearInterval(loopTimer);
    loopTimer = 0;
    loopBtn.classList.remove('is-active');
    loopBtn.setAttribute('aria-pressed', 'false');
    releaseWake('manual-loop');
  }

  function startLoop(): void {
    looping = true;
    loopBtn.classList.add('is-active');
    loopBtn.setAttribute('aria-pressed', 'true');
    holdWake('manual-loop');
    trigger(active);
    armLoop();
  }

  /* ---------- drone ---------- */

  function droneMidi(): number {
    return (droneOctave + 1) * 12 + dronePc;
  }

  /** The pitch as a screen reader has to hear it. Readers drop U+266F at default
      verbosity, which leaves A♯3 sounding exactly like A3 — and the octave
      stepper has no other feedback. */
  function spokenPitch(): string {
    return `${NOTE_NAMES[dronePc].replace('#', ' sharp')} ${droneOctave}`;
  }

  /** The drone outlives this view, so the shell badges the Manual tab for it —
      naming the pitch, so the badge says what is still sounding. */
  function announceDrone(): void {
    window.dispatchEvent(
      new CustomEvent('truestring:drone-running', {
        detail: { running: drone.running, note: spokenPitch() },
      }),
    );
  }

  function renderDrone(): void {
    const running = drone.running;
    for (let i = 0; i < pcChips.length; i++) {
      const on = i === dronePc;
      pcChips[i].classList.toggle('is-active', on);
      pcChips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    octValue.textContent = String(droneOctave);
    // ♯ for the eye, "sharp" for the ear — one live region, two spellings.
    droneGlyph.textContent = `${prettyPc(NOTE_NAMES[dronePc])}${droneOctave}`;
    droneSpoken.textContent = spokenPitch();
    // Sounding is an amber-filled button that stays amber — the pitch chips and
    // the octave keep their own state, so nothing here moves on its own.
    droneBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
    droneBtn.classList.toggle('btn-primary', running);
    droneBtn.classList.toggle('btn-ghost', !running);
  }

  function setDronePitch(pc: number, octave: number): void {
    dronePc = pc;
    droneOctave = Math.min(OCTAVE_MAX, Math.max(OCTAVE_MIN, octave));
    renderDrone();
    if (!drone.running) return;
    drone.setPitch(droneMidi(), getState().a4);
    // Retuning a sounding drone changes what the tab badge is reporting.
    announceDrone();
  }

  function toggleDrone(): void {
    if (drone.running) {
      drone.stop();
      releaseWake('drone');
    } else {
      drone.start(droneMidi(), getState().a4);
      holdWake('drone');
    }
    renderDrone();
    announceDrone();
  }

  /* ---------- wiring ---------- */

  loopBtn.addEventListener('click', () => {
    if (looping) stopLoop();
    else startLoop();
  });

  strumBtn.addEventListener('click', () => {
    clearStrum();
    for (let i = 0; i < buttons.length; i++) {
      strumTimers.push(window.setTimeout(() => trigger(i), i * STRUM_GAP_MS));
    }
  });

  pcChips.forEach((chip, i) => {
    chip.addEventListener('click', () => setDronePitch(i, droneOctave));
  });

  (el.querySelector('.mv-oct-down') as HTMLButtonElement).addEventListener('click', () =>
    setDronePitch(dronePc, droneOctave - 1),
  );
  (el.querySelector('.mv-oct-up') as HTMLButtonElement).addEventListener('click', () =>
    setDronePitch(dronePc, droneOctave + 1),
  );

  droneBtn.addEventListener('click', toggleDrone);

  subscribe((next) => {
    const wasFreq = notes[active]?.freq ?? 0;
    relabel();
    // The loop reads notes[] fresh on every fire, so it only needs a re-pluck
    // at the new pitch — tearing it down would drop the tone mid-tuning. Two
    // gates on that re-pluck: the pitch has to have actually moved (the state
    // layer notifies on every write, including the tuning row that is already
    // current), and it has to have stopped moving (the capo stepper repeats
    // while it is held). Relabelling and re-arming stay eager, so the loop's
    // own 2 s tick never lands in the middle of a sweep.
    if (looping) {
      if ((notes[active]?.freq ?? 0) !== wasFreq) queueRetunePluck();
      armLoop();
    }
    // Recalibrating A4 moves the drone with everything else, without a gap.
    if (drone.running) drone.setPitch(droneMidi(), next.a4);
  });

  relabel();
  renderDrone();

  return {
    el,
    show(): void {
      relabel();
    },
    // The drone deliberately keeps sounding: it is a reference to play against
    // while the metronome or the auto tuner is on screen. Only its own toggle
    // stops it.
    hide(): void {
      stopLoop();
      clearStrum();
    },
  };
}
