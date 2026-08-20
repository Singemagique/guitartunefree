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

function tempoName(bpm: number): string {
  for (const mark of TEMPO_MARKS) {
    if (bpm < mark.max) return mark.name;
  }
  return 'Presto';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Retrigger a CSS animation that may already be mid-flight on this element. */
function replay(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
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

export function createMetronomeView(): ViewHandle {
  const metro = new Metronome();
  metro.bpm = DEFAULT_BPM;
  metro.beatsPerBar = DEFAULT_BPB;
  metro.subdivision = 1;

  let bpm = DEFAULT_BPM;
  let beatsPerBar = DEFAULT_BPB;
  let wasRunning = false;
  let starting = false;

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
      <button class="btn btn-ghost nv-tap" type="button">Tap tempo</button>
    </div>

    <div class="nv-dots" aria-hidden="true"></div>

    <div class="nv-transport-row">
      <button class="nv-transport" type="button" aria-pressed="false" aria-label="Start metronome">
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
    </div>`;

  const bpmValue = el.querySelector('.nv-bpm-value') as HTMLElement;
  const tempoLabel = el.querySelector('.nv-tempo-name') as HTMLElement;
  const slider = el.querySelector('.nv-slider') as HTMLInputElement;
  const tapBtn = el.querySelector('.nv-tap') as HTMLButtonElement;
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

  function setBpm(next: number): void {
    bpm = clamp(Math.round(next), BPM_MIN, BPM_MAX);
    metro.bpm = bpm;
    renderBpm();
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

  function syncTransport(): void {
    const running = metro.running;
    transport.classList.toggle('is-running', running);
    transport.setAttribute('aria-pressed', running ? 'true' : 'false');
    transport.setAttribute('aria-label', running ? 'Stop metronome' : 'Start metronome');
    if (!running) {
      for (const dot of dots) dot.classList.remove('is-pulse');
    }
    if (running === wasRunning) return;
    wasRunning = running;
    window.dispatchEvent(
      new CustomEvent('truestring:metronome-running', { detail: { running } }),
    );
  }

  metro.onBeat = (beatInBar: number): void => {
    const dot = dots[beatInBar];
    if (dot) replay(dot, 'is-pulse');
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
    if (tapped !== null) setBpm(tapped);
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

  // The metronome deliberately keeps running while its view is hidden, so
  // neither callback touches the engine.
  return {
    el,
    show(): void {
      syncTransport();
    },
    hide(): void {},
  };
}
