/// <reference types="vite/client" />
import './style.css';
import type { AppState } from './state';
import { getState, setState, subscribe } from './state';
import { TUNINGS, tuningById } from './music/tunings';
import { createTunerView } from './ui/tuner-view';
import { createManualView } from './ui/manual-view';
import { createMetronomeView } from './ui/metronome-view';

interface ViewHandle {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

const TAB_IDS = ['tuner', 'manual', 'metronome'] as const;
type TabId = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<TabId, string> = {
  tuner: 'Auto',
  manual: 'Manual',
  metronome: 'Metronome',
};

const A4_MIN = 415;
const A4_MAX = 466;
const A4_DEFAULT = 440;
const SHEET_EXIT_MS = 280;

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

const ICONS = {
  fork: `<svg ${SVG} stroke-width="1.9"><path d="M8.6 3.3V10.4a3.4 3.4 0 0 0 6.8 0V3.3"/><path d="M12 13.8v6.9"/></svg>`,
  gauge: `<svg ${SVG} stroke-width="1.8"><path d="M3.6 17.2a8.4 8.4 0 0 1 16.8 0"/><path d="M12 17.2 15.6 10.9"/><circle cx="12" cy="17.2" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  headstock: `<svg ${SVG} stroke-width="1.8"><rect x="6.7" y="3.3" width="10.6" height="17.4" rx="3.2"/><circle cx="9.8" cy="8.2" r="1.05" fill="currentColor" stroke="none"/><circle cx="9.8" cy="12" r="1.05" fill="currentColor" stroke="none"/><circle cx="9.8" cy="15.8" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.2" cy="8.2" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.2" cy="12" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.2" cy="15.8" r="1.05" fill="currentColor" stroke="none"/></svg>`,
  metronome: `<svg ${SVG} stroke-width="1.8"><path d="M9.7 3.4h4.6l3.9 17.2H5.8Z"/><path d="M7.1 15.1h9.8"/><path d="m12 20.6 2.6-12.1"/></svg>`,
  gear: `<svg ${SVG}><circle cx="12" cy="12" r="8.2" stroke-width="3" stroke-dasharray="2.1 4.34"/><circle cx="12" cy="12" r="6.6" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" stroke-width="1.8"/></svg>`,
  caret: `<svg ${SVG} stroke-width="2.2"><path d="m6.5 9.7 5.5 5 5.5-5"/></svg>`,
  check: `<svg ${SVG} stroke-width="2.4"><path d="m4.8 12.7 4.9 5L19.2 6.8"/></svg>`,
  close: `<svg ${SVG} stroke-width="2"><path d="M6.6 6.6 17.4 17.4M17.4 6.6 6.6 17.4"/></svg>`,
  minus: `<svg ${SVG} stroke-width="2.2"><path d="M6.4 12h11.2"/></svg>`,
  plus: `<svg ${SVG} stroke-width="2.2"><path d="M12 6.4v11.2M6.4 12h11.2"/></svg>`,
};

const TAB_ICONS: Record<TabId, string> = {
  tuner: ICONS.gauge,
  manual: ICONS.headstock,
  metronome: ICONS.metronome,
};

function q<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`TrueString: missing element ${selector}`);
  return found;
}

function tabMarkup(id: TabId): string {
  const dot = id === 'metronome' ? '<span class="tab-dot" aria-hidden="true"></span>' : '';
  return `<button type="button" class="tab" role="tab" id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}" aria-selected="false" tabindex="-1">
      <span class="tab-icon">${TAB_ICONS[id]}</span>
      <span class="tab-label">${TAB_LABELS[id]}</span>${dot}
    </button>`;
}

const root = document.getElementById('app');
if (!root) throw new Error('TrueString: #app root missing');

root.innerHTML = `
  <div class="app-frame" id="app-frame">
    <header class="app-header">
      <div class="wordmark">
        <span class="wordmark-glyph">${ICONS.fork}</span>
        <span class="wordmark-text">TrueString</span>
      </div>
      <div class="header-actions">
        <button type="button" class="chip" id="tuning-chip" aria-haspopup="dialog" aria-expanded="false">
          <span class="sr-only">Tuning:</span>
          <span class="chip-label" id="tuning-label">Standard E</span>
          <span class="chip-caret">${ICONS.caret}</span>
        </button>
        <button type="button" class="icon-btn" id="gear-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="Reference pitch settings">${ICONS.gear}</button>
        <div class="popover" id="a4-popover" role="dialog" aria-label="Reference pitch" hidden>
          <p class="popover-title">Reference pitch</p>
          <div class="a4-stepper">
            <button type="button" class="icon-btn" id="a4-dec" aria-label="Lower reference pitch by 1 hertz">${ICONS.minus}</button>
            <p class="a4-value"><span id="a4-value" aria-live="polite">440</span><span class="a4-unit">Hz</span></p>
            <button type="button" class="icon-btn" id="a4-inc" aria-label="Raise reference pitch by 1 hertz">${ICONS.plus}</button>
          </div>
          <button type="button" class="btn btn-ghost a4-reset" id="a4-reset">Reset to 440 Hz</button>
          <p class="popover-note">A4 · ${A4_MIN}–${A4_MAX} Hz</p>
        </div>
      </div>
    </header>
    <main class="view-root" id="view-root"></main>
    <nav class="tabbar">
      <div class="tabbar-inner" role="tablist" aria-label="Sections">
        ${TAB_IDS.map(tabMarkup).join('')}
      </div>
      <span class="sr-only" id="metronome-status" role="status"></span>
    </nav>
  </div>
  <div class="scrim" id="sheet-scrim" hidden></div>
  <div class="sheet" id="tuning-sheet" role="dialog" aria-modal="true" aria-labelledby="tuning-sheet-title" hidden>
    <span class="sheet-grip" aria-hidden="true"></span>
    <div class="sheet-head">
      <h2 class="sheet-title" id="tuning-sheet-title">Tuning</h2>
      <button type="button" class="icon-btn" id="sheet-close" aria-label="Close tuning list">${ICONS.close}</button>
    </div>
    <div class="sheet-list" id="tuning-list"></div>
  </div>
`;

const appFrame = q('#app-frame');
const viewRoot = q('#view-root');
const tuningChip = q<HTMLButtonElement>('#tuning-chip');
const tuningLabel = q('#tuning-label');
const gearBtn = q<HTMLButtonElement>('#gear-btn');
const popover = q('#a4-popover');
const a4Value = q('#a4-value');
const a4Dec = q<HTMLButtonElement>('#a4-dec');
const a4Inc = q<HTMLButtonElement>('#a4-inc');
const a4Reset = q<HTMLButtonElement>('#a4-reset');
const scrim = q('#sheet-scrim');
const sheet = q('#tuning-sheet');
const sheetClose = q<HTMLButtonElement>('#sheet-close');
const tuningList = q('#tuning-list');
const metronomeStatus = q('#metronome-status');

const tabs: Record<TabId, HTMLButtonElement> = {
  tuner: q<HTMLButtonElement>('#tab-tuner'),
  manual: q<HTMLButtonElement>('#tab-manual'),
  metronome: q<HTMLButtonElement>('#tab-metronome'),
};

const views: Record<TabId, ViewHandle> = {
  tuner: createTunerView(),
  manual: createManualView(),
  metronome: createMetronomeView(),
};

for (const id of TAB_IDS) {
  const view = views[id];
  view.el.id = `panel-${id}`;
  view.el.setAttribute('role', 'tabpanel');
  view.el.setAttribute('aria-labelledby', `tab-${id}`);
  view.el.hidden = true;
  viewRoot.append(view.el);
}

/* ---------- tabs ---------- */

let activeTab: TabId = 'tuner';

function setTab(next: TabId, moveFocus = false): void {
  if (tabs[next].getAttribute('aria-selected') === 'true') {
    if (moveFocus) tabs[next].focus();
    return;
  }
  activeTab = next;
  for (const id of TAB_IDS) {
    const isActive = id === next;
    const tab = tabs[id];
    const view = views[id];
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      view.el.hidden = false;
      view.show();
    } else {
      view.hide();
      view.el.hidden = true;
    }
  }
  if (moveFocus) tabs[next].focus();
}

for (const id of TAB_IDS) {
  tabs[id].addEventListener('click', () => setTab(id));
}

q('.tabbar-inner').addEventListener('keydown', (e) => {
  const index = TAB_IDS.indexOf(activeTab);
  let next = -1;
  if (e.key === 'ArrowRight') next = (index + 1) % TAB_IDS.length;
  else if (e.key === 'ArrowLeft') next = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TAB_IDS.length - 1;
  if (next < 0) return;
  e.preventDefault();
  setTab(TAB_IDS[next], true);
});

/* ---------- tuning sheet ---------- */

const tuningItems = TUNINGS.map((tuning) => {
  const name = document.createElement('span');
  name.className = 'sheet-item-name';
  name.textContent = tuning.name;

  const detail = document.createElement('span');
  detail.className = 'sheet-item-detail';
  detail.textContent = tuning.detail;

  const text = document.createElement('span');
  text.className = 'sheet-item-text';
  text.append(name, detail);

  const check = document.createElement('span');
  check.className = 'sheet-item-check';
  check.innerHTML = ICONS.check;

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'sheet-item';
  item.dataset.tuningId = tuning.id;
  item.append(text, check);
  item.addEventListener('click', () => {
    setState({ tuningId: tuning.id });
    closeSheet();
  });
  return item;
});
tuningList.append(...tuningItems);

let sheetReturnFocus: HTMLElement | null = null;
let sheetHideTimer = 0;
// `sheet.hidden` lags the close by SHEET_EXIT_MS so the slide-out can play, so
// open/closed state is tracked here instead.
let sheetOpen = false;

function openSheet(): void {
  window.clearTimeout(sheetHideTimer);
  if (sheetOpen) return;
  sheetOpen = true;
  closePopover();
  sheetReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  scrim.hidden = false;
  sheet.hidden = false;
  appFrame.setAttribute('inert', '');
  document.body.classList.add('is-locked');
  tuningChip.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    scrim.classList.add('is-open');
    sheet.classList.add('is-open');
  });
  const current = tuningItems.find((item) => item.getAttribute('aria-current') === 'true');
  (current ?? tuningItems[0]).focus();
}

function closeSheet(): void {
  if (!sheetOpen) return;
  sheetOpen = false;
  scrim.classList.remove('is-open');
  sheet.classList.remove('is-open');
  appFrame.removeAttribute('inert');
  document.body.classList.remove('is-locked');
  tuningChip.setAttribute('aria-expanded', 'false');
  sheetReturnFocus?.focus();
  sheetReturnFocus = null;
  sheetHideTimer = window.setTimeout(() => {
    if (sheetOpen) return;
    sheet.hidden = true;
    scrim.hidden = true;
  }, SHEET_EXIT_MS);
}

function handleSheetKeys(e: KeyboardEvent): void {
  const focusable = [sheetClose, ...tuningItems]; // DOM order inside the sheet
  const active = document.activeElement;
  if (e.key === 'Tab') {
    // The sheet is modal: keep Tab inside it.
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const index = tuningItems.findIndex((item) => item === active);
  const count = tuningItems.length;
  let next = 0;
  if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % count;
  else if (e.key === 'ArrowUp') next = index < 0 ? count - 1 : (index - 1 + count) % count;
  else if (e.key === 'End') next = count - 1;
  tuningItems[next]?.focus();
}

tuningChip.addEventListener('click', openSheet);
sheetClose.addEventListener('click', closeSheet);
scrim.addEventListener('click', closeSheet);

/* ---------- calibration popover ---------- */

function openPopover(): void {
  if (!popover.hidden) return;
  popover.hidden = false;
  gearBtn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => popover.classList.add('is-open'));
  (a4Dec.disabled ? a4Inc : a4Dec).focus();
}

function closePopover(restoreFocus = false): void {
  if (popover.hidden) return;
  popover.classList.remove('is-open');
  popover.hidden = true;
  gearBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus) gearBtn.focus();
}

function nudgeA4(delta: number): void {
  const next = Math.min(A4_MAX, Math.max(A4_MIN, Math.round(getState().a4) + delta));
  if (next !== getState().a4) setState({ a4: next });
}

gearBtn.addEventListener('click', () => {
  if (popover.hidden) openPopover();
  else closePopover(true);
});
a4Dec.addEventListener('click', () => nudgeA4(-1));
a4Inc.addEventListener('click', () => nudgeA4(1));
a4Reset.addEventListener('click', () => {
  if (getState().a4 !== A4_DEFAULT) setState({ a4: A4_DEFAULT });
});

popover.addEventListener('focusout', (e) => {
  const next = e.relatedTarget;
  if (next instanceof Node && (popover.contains(next) || gearBtn.contains(next))) return;
  closePopover();
});

document.addEventListener('pointerdown', (e) => {
  if (popover.hidden) return;
  const target = e.target;
  if (target instanceof Node && (popover.contains(target) || gearBtn.contains(target))) return;
  closePopover();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (sheetOpen) {
      e.preventDefault();
      closeSheet();
    } else if (!popover.hidden) {
      e.preventDefault();
      closePopover(true);
    }
    return;
  }
  if (sheetOpen) handleSheetKeys(e);
});

/* ---------- state binding ---------- */

function render(state: AppState): void {
  tuningLabel.textContent = tuningById(state.tuningId).name;
  a4Value.textContent = String(state.a4);

  const decOff = state.a4 <= A4_MIN;
  const incOff = state.a4 >= A4_MAX;
  const resetOff = state.a4 === A4_DEFAULT;
  // Disabling the focused button blurs it, which would dismiss the popover mid-edit,
  // so hand focus to a live control before the flags flip.
  const focused = document.activeElement;
  if ((focused === a4Dec && decOff) || (focused === a4Inc && incOff) || (focused === a4Reset && resetOff)) {
    if (!incOff) a4Inc.focus();
    else if (!decOff) a4Dec.focus();
    else gearBtn.focus();
  }
  a4Dec.disabled = decOff;
  a4Inc.disabled = incOff;
  a4Reset.disabled = resetOff;

  for (const item of tuningItems) {
    const isCurrent = item.dataset.tuningId === state.tuningId;
    if (isCurrent) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }
}

render(getState());
subscribe(render);

/* ---------- metronome activity badge ---------- */

window.addEventListener('truestring:metronome-running', (event) => {
  const detail = (event as CustomEvent<{ running?: boolean } | null>).detail;
  const running = detail?.running === true;
  tabs.metronome.classList.toggle('is-running', running);
  metronomeStatus.textContent = running ? 'Metronome running' : '';
});

/* ---------- boot ---------- */

setTab('tuner');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // A first registration claims this page too; only a takeover from an older
  // worker means a new build is waiting, and one reload is enough to get it.
  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  const register = (): void => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then((registration) => registration.update())
      .catch(() => {
        /* offline caching is a progressive enhancement */
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
