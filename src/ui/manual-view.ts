import './manual-view.css';
import { ensureRunning } from '../audio/context';
import { pluck } from '../audio/synth';
import { getState, subscribe } from '../state';
import { tuningById, tuningNotes } from '../music/tunings';
import type { NoteInfo } from '../music/notes';
import { prettyPc } from '../music/notes';

export interface ViewHandle {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

const RING_MS = 2000;
const LOOP_MS = 2000;
const STRUM_GAP_MS = 120;

/** Index 0 is the low (6th) string, index 5 the high (1st). */
const ORDINALS = ['6th', '5th', '4th', '3rd', '2nd', '1st'] as const;

/**
 * Stylized 3+3 headstock, nut at the bottom — i.e. seen from the front, so the
 * low E tuner sits bottom-left. Posts sit at y = 45 / 134 / 223, which is 1/6,
 * 3/6 and 5/6 of the 268-unit height: exactly the centres of the three flanking
 * button rows. Tuner groups are emitted in string order, low E first.
 */
const HEADSTOCK = `
<svg class="mv-headstock" viewBox="0 0 120 268" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
  <path class="mv-hs-body" d="M44 262 L44 244 C44 236 30 234 27 218 C22 190 21 90 24 62 C26 36 40 22 60 22 C80 22 94 36 96 62 C99 90 98 190 93 218 C90 234 76 236 76 244 L76 262 Z"/>
  <path class="mv-hs-crown" d="M28 78 C30 44 42 29 60 29 C78 29 90 44 92 78"/>
  <path class="mv-hs-mark" d="M60 44 L66 58 L60 72 L54 58 Z"/>
  <g class="mv-hs-strings">
    <line x1="47" y1="252" x2="38" y2="223" stroke-width="1.7"/>
    <line x1="52.5" y1="252" x2="36" y2="134" stroke-width="1.45"/>
    <line x1="58" y1="252" x2="36" y2="45" stroke-width="1.2"/>
    <line x1="62" y1="252" x2="84" y2="45" stroke-width="1"/>
    <line x1="67.5" y1="252" x2="84" y2="134" stroke-width="0.85"/>
    <line x1="73" y1="252" x2="82" y2="223" stroke-width="0.7"/>
  </g>
  <rect class="mv-hs-nut" x="42" y="240" width="36" height="5" rx="2"/>
  <g class="mv-hs-tuner"><line x1="38" y1="223" x2="4" y2="223"/><circle cx="38" cy="223" r="5.5"/></g>
  <g class="mv-hs-tuner"><line x1="36" y1="134" x2="4" y2="134"/><circle cx="36" cy="134" r="5.5"/></g>
  <g class="mv-hs-tuner"><line x1="36" y1="45" x2="4" y2="45"/><circle cx="36" cy="45" r="5.5"/></g>
  <g class="mv-hs-tuner"><line x1="84" y1="45" x2="116" y2="45"/><circle cx="84" cy="45" r="5.5"/></g>
  <g class="mv-hs-tuner"><line x1="84" y1="134" x2="116" y2="134"/><circle cx="84" cy="134" r="5.5"/></g>
  <g class="mv-hs-tuner"><line x1="82" y1="223" x2="116" y2="223"/><circle cx="82" cy="223" r="5.5"/></g>
</svg>`;

const LOOP_ICON = `
<svg class="mv-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M17 4H9a5 5 0 0 0-5 5v1"/><path d="M14 1l3 3-3 3"/>
  <path d="M7 20h8a5 5 0 0 0 5-5v-1"/><path d="M10 23l-3-3 3-3"/>
</svg>`;

function stringButton(i: number): string {
  return `
    <button class="mv-string mv-pos-${i}" type="button" aria-pressed="false">
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
      <div class="mv-stage" role="group" aria-label="Strings">
        ${HEADSTOCK}
        ${[0, 1, 2, 3, 4, 5].map(stringButton).join('')}
      </div>
    </div>
    <div class="mv-controls">
      <button class="btn btn-ghost mv-loop" type="button" aria-pressed="false">${LOOP_ICON}<span>Loop</span></button>
      <button class="btn btn-primary mv-strum" type="button">Strum</button>
    </div>
    <p class="mv-hint">Tap a string for its reference tone. Loop repeats the selected string every 2 seconds.</p>`;

  const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.mv-string'));
  const pcEls = buttons.map((b) => b.querySelector('.mv-pc') as HTMLElement);
  const octEls = buttons.map((b) => b.querySelector('.mv-oct') as HTMLElement);
  const stringLines = Array.from(el.querySelectorAll<SVGLineElement>('.mv-hs-strings line'));
  const tuners = Array.from(el.querySelectorAll<SVGGElement>('.mv-hs-tuner'));
  const loopBtn = el.querySelector('.mv-loop') as HTMLButtonElement;
  const strumBtn = el.querySelector('.mv-strum') as HTMLButtonElement;

  let notes: NoteInfo[] = [];
  let active = 0;
  let looping = false;
  let loopTimer = 0;
  const ringTimers = [0, 0, 0, 0, 0, 0];
  const strumTimers: number[] = [];

  function relabel(): void {
    const { tuningId, a4 } = getState();
    notes = tuningNotes(tuningById(tuningId), a4);
    for (let i = 0; i < buttons.length; i++) {
      const n = notes[i];
      pcEls[i].textContent = prettyPc(n.pc);
      octEls[i].textContent = String(n.octave);
      const spoken = n.pc.replace('#', ' sharp');
      buttons[i].setAttribute('aria-label', `${ORDINALS[i]} string, ${spoken} ${n.octave}`);
    }
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

  function armLoop(): void {
    window.clearInterval(loopTimer);
    loopTimer = window.setInterval(() => trigger(active), LOOP_MS);
  }

  function stopLoop(): void {
    looping = false;
    window.clearInterval(loopTimer);
    loopTimer = 0;
    loopBtn.classList.remove('is-active');
    loopBtn.setAttribute('aria-pressed', 'false');
  }

  function startLoop(): void {
    looping = true;
    loopBtn.classList.add('is-active');
    loopBtn.setAttribute('aria-pressed', 'true');
    trigger(active);
    armLoop();
  }

  function clearStrum(): void {
    for (const t of strumTimers) window.clearTimeout(t);
    strumTimers.length = 0;
  }

  buttons.forEach((b, i) => {
    b.addEventListener('click', () => {
      setActive(i);
      trigger(i);
      if (looping) armLoop();
    });
  });

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

  subscribe(() => {
    relabel();
    // The loop reads notes[] fresh on every fire, so it only needs a re-pluck
    // at the new pitch — tearing it down would drop the tone mid-tuning.
    if (looping) {
      trigger(active);
      armLoop();
    }
  });

  relabel();
  setActive(0);

  return {
    el,
    show(): void {
      relabel();
    },
    hide(): void {
      stopLoop();
      clearStrum();
    },
  };
}
