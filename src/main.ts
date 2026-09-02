/// <reference types="vite/client" />
import './style.css';
import type { AppState } from './state';
import { getState, setState, subscribe } from './state';
import type { Tuning, TuningGroup } from './music/tunings';
import {
  allTunings,
  capoLimit,
  deleteCustomTuning,
  noteName,
  saveCustomTuning,
  stringCents,
  tuningById,
} from './music/tunings';
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
/** The popover's fade-out, matching its own transition. `hidden` waits this
    long so the exit can play — the same deferral the sheet has always used. */
const POP_EXIT_MS = 130;

/** Section order in the tuning sheet; empty groups are skipped. */
const GROUP_ORDER: readonly TuningGroup[] = ['Guitar', 'Bass', 'Ukulele', 'Mandolin', 'Custom'];
const NAME_MAX = 24;
const NAME_FALLBACK = 'My tuning';
const STRINGS_MIN = 4;
const STRINGS_MAX = 8;
const MIDI_MIN = 23;
const MIDI_MAX = 81;
/** Per-string sweetening, in cents either side of equal temperament. */
const CENTS_MIN = -50;
const CENTS_MAX = 50;
/** Twelfth fret is where the neck runs out of usable capo positions. */
const CAPO_MAX = 12;
/** Delete asks twice; the armed button falls back to its label after this long. */
const DELETE_ARM_MS = 3500;

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
  pencil: `<svg ${SVG} stroke-width="1.8"><path d="m4.4 19.6 4.6-1.2 9.5-9.5a2.4 2.4 0 0 0-3.4-3.4l-9.5 9.5Z"/><path d="m13.4 7.1 3.5 3.5"/></svg>`,
};

const TAB_ICONS: Record<TabId, string> = {
  tuner: ICONS.gauge,
  manual: ICONS.headstock,
  metronome: ICONS.metronome,
};

/** Views that keep making sound after you leave them announce it on `window`;
    each one lights the running dot on its own tab. */
const RUNNING_SOURCES: readonly { event: string; tab: TabId; label: string }[] = [
  { event: 'truestring:metronome-running', tab: 'metronome', label: 'Metronome running' },
  { event: 'truestring:drone-running', tab: 'manual', label: 'Drone sounding' },
];

const DOT_TABS = new Set<TabId>(RUNNING_SOURCES.map((source) => source.tab));

function q<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`TrueString: missing element ${selector}`);
  return found;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Flags a scroll box whose content carries on past its bottom edge, so the CSS
 * can fade the last row instead of slicing it against whatever sits below.
 * Content that grows without moving the box — a string row added, a card
 * unfolded — never resizes the box itself, so the parts that do grow are watched
 * as well. Returns a manual re-check for changes no observer sees.
 */
function fadeOnOverflow(box: HTMLElement, grows: readonly Element[] = []): () => void {
  const update = (): void => {
    box.classList.toggle('is-clipped', box.scrollHeight - box.clientHeight - box.scrollTop > 1);
  };
  box.addEventListener('scroll', update, { passive: true });
  const observer = new ResizeObserver(update);
  observer.observe(box);
  for (const node of grows) observer.observe(node);
  return update;
}

/**
 * Fires `step` on press and then repeats while held, tightening the interval so
 * a long hold sweeps quickly. Keyboard activation holds too (Enter/Space), so
 * the button's default click is suppressed to avoid a double step. A stepper
 * that disables itself at its limit stops the repeat: a disabled button never
 * receives the pointerup that would otherwise end it.
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
    if (btn.disabled) {
      end();
      return;
    }
    step();
    reps += 1;
    timer = window.setTimeout(tick, Math.max(36, 150 - reps * 10));
  };
  const begin = (): void => {
    end();
    step();
    if (btn.disabled) return;
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

/**
 * The one content-swap enter, shared by every panel in the app (style.css owns
 * the keyframe). Re-entry restarts it rather than stacking: flipping between
 * two tabs faster than 220 ms must play one fade per swap, not a queue of them.
 * The listener is a single named function, so repeated calls on the same
 * element register it once.
 *
 * The class SCHEDULES the animation, so leaving it on a panel is leaving the
 * animation armed: the next time that panel goes from display:none back to
 * visible it plays again, on a swap nobody performed. Every ending therefore
 * has to take it off, and a run has three of them — it finishes, it is
 * cancelled, or it is torn out of the render tree in the same task it was
 * started in (a tab switched away in the frame the mode changed), which fires
 * no event at all because the animation was never once sampled. The two
 * listeners cover the first two; the timer covers the third, and nothing else
 * can.
 */
const ENTER_MS = 400;
/** Panels with an enter in flight, against the backstop above. */
const enterTimers = new WeakMap<HTMLElement, number>();

function endEnter(node: HTMLElement): void {
  window.clearTimeout(enterTimers.get(node));
  enterTimers.delete(node);
  node.classList.remove('is-entering');
  node.removeEventListener('animationend', onEnterEnd);
  node.removeEventListener('animationcancel', onEnterEnd);
}

function onEnterEnd(e: AnimationEvent): void {
  const node = e.currentTarget as HTMLElement;
  // A child's own animation ending is not this one finishing.
  if (e.target !== node || e.animationName !== 'view-enter') return;
  endEnter(node);
}

function enter(el: HTMLElement): void {
  endEnter(el);
  // Commit the removal, or the two writes coalesce and a run already in flight
  // simply carries on from where it was.
  void el.offsetWidth;
  el.classList.add('is-entering');
  el.addEventListener('animationend', onEnterEnd);
  el.addEventListener('animationcancel', onEnterEnd);
  enterTimers.set(el, window.setTimeout(() => endEnter(el), ENTER_MS));
}

function tabMarkup(id: TabId): string {
  const dot = DOT_TABS.has(id) ? '<span class="tab-dot" aria-hidden="true"></span>' : '';
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
          <span class="chip-capo" id="chip-capo" hidden></span>
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
      <span class="sr-only" id="running-status" role="status"></span>
    </nav>
  </div>
  <div class="scrim" id="sheet-scrim" hidden></div>
  <div class="sheet" id="tuning-sheet" role="dialog" aria-modal="true" aria-labelledby="tuning-sheet-title" hidden>
    <span class="sheet-grip" aria-hidden="true"></span>
    <div class="sheet-head">
      <h2 class="sheet-title" id="tuning-sheet-title" tabindex="-1">Tuning</h2>
      <button type="button" class="icon-btn" id="sheet-close" aria-label="Close tuning list">${ICONS.close}</button>
    </div>
    <p class="sheet-note" id="sheet-note" role="status"></p>
    <div class="capo-row" id="capo-row">
      <span class="capo-label">Capo</span>
      <div class="capo-stepper" role="group" aria-label="Capo fret">
        <button type="button" class="icon-btn" id="capo-dec" aria-label="Move the capo down a fret">${ICONS.minus}</button>
        <span class="capo-value" id="capo-value" aria-live="polite">None</span>
        <button type="button" class="icon-btn" id="capo-inc" aria-label="Move the capo up a fret">${ICONS.plus}</button>
      </div>
    </div>
    <div class="sheet-list" id="tuning-list"></div>
    <form class="editor" id="tuning-editor" hidden>
      <div class="editor-scroll" id="editor-scroll">
        <label class="editor-label" for="editor-name">Name</label>
        <input class="editor-name" id="editor-name" type="text" maxlength="${NAME_MAX}"
          autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="${NAME_FALLBACK}">
        <div class="editor-row">
          <span class="editor-label">Strings</span>
          <div class="editor-stepper">
            <button type="button" class="icon-btn" id="editor-count-dec" aria-label="Remove the highest string">${ICONS.minus}</button>
            <span class="editor-value" id="editor-count" aria-live="polite">6</span>
            <button type="button" class="icon-btn" id="editor-count-inc" aria-label="Add a string">${ICONS.plus}</button>
          </div>
        </div>
        <div class="editor-strings" id="editor-strings"></div>
      </div>
      <div class="editor-foot">
        <p class="editor-preview" id="editor-preview"></p>
        <button type="button" class="btn btn-ghost editor-delete" id="editor-delete" hidden>Delete tuning</button>
      </div>
      <div class="editor-actions">
        <button type="button" class="btn btn-ghost" id="editor-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  </div>
`;

const appFrame = q('#app-frame');
const appHeader = q('.app-header');
const viewRoot = q('#view-root');
const tuningChip = q<HTMLButtonElement>('#tuning-chip');
const tuningLabel = q('#tuning-label');
const chipCapo = q('#chip-capo');
const gearBtn = q<HTMLButtonElement>('#gear-btn');
const popover = q('#a4-popover');
const a4Value = q('#a4-value');
const a4Dec = q<HTMLButtonElement>('#a4-dec');
const a4Inc = q<HTMLButtonElement>('#a4-inc');
const a4Reset = q<HTMLButtonElement>('#a4-reset');
const scrim = q('#sheet-scrim');
const sheet = q('#tuning-sheet');
const sheetTitle = q('#tuning-sheet-title');
const sheetClose = q<HTMLButtonElement>('#sheet-close');
const sheetNote = q('#sheet-note');
const capoRow = q('#capo-row');
const capoValue = q('#capo-value');
const capoDec = q<HTMLButtonElement>('#capo-dec');
const capoInc = q<HTMLButtonElement>('#capo-inc');
const tuningList = q('#tuning-list');
const editorForm = q<HTMLFormElement>('#tuning-editor');
const editorScroll = q('#editor-scroll');
const editorName = q<HTMLInputElement>('#editor-name');
const editorCount = q('#editor-count');
const editorCountDec = q<HTMLButtonElement>('#editor-count-dec');
const editorCountInc = q<HTMLButtonElement>('#editor-count-inc');
const editorStrings = q('#editor-strings');
const editorPreview = q('#editor-preview');
const editorDelete = q<HTMLButtonElement>('#editor-delete');
const editorCancel = q<HTMLButtonElement>('#editor-cancel');
const runningStatus = q('#running-status');

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

fadeOnOverflow(
  viewRoot,
  TAB_IDS.map((id) => views[id].el),
);

/* ---------- tabs ---------- */

let activeTab: TabId = 'tuner';

/** Where each tab was left. One scroll container serves all three, so without
    this a tab you had scrolled to the bottom hands its offset to the next one —
    which lands mid-view with its mode control clipped under the header and
    reads as a screen that failed to draw. */
const scrollPos: Partial<Record<TabId, number>> = {};

function setTab(next: TabId, moveFocus = false): void {
  if (tabs[next].getAttribute('aria-selected') === 'true') {
    if (moveFocus) tabs[next].focus();
    return;
  }
  scrollPos[activeTab] = viewRoot.scrollTop;
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
      enter(view.el);
    } else {
      view.hide();
      view.el.hidden = true;
    }
  }
  // After the swap, so the box being scrolled is the one now holding content.
  viewRoot.scrollTop = scrollPos[next] ?? 0;
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

type SheetMode = 'list' | 'editor';

let sheetMode: SheetMode = 'list';
/** The list's primary rows: one per tuning, then the "New tuning" row. */
let rowButtons: HTMLButtonElement[] = [];

/** House spelling for a signed offset — "0¢", "+3¢", "−6¢" (U+2212, matching
    the tuner's readout, which is the other place a player reads cents). */
function centsText(cents: number): string {
  if (cents === 0) return '0¢';
  return `${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

/**
 * The offsets of a sweetened tuning as one line, or "" when every string sits on
 * equal temperament. Read per string rather than off `t.cents` so a stored array
 * that is short, long or absent still lines up with the strings it describes —
 * and so customs get the same line the factory presets do.
 */
function centsLine(t: Tuning): string {
  const cents = t.midis.map((_, i) => stringCents(t, i));
  if (!cents.some((c) => c !== 0)) return '';
  const parts = cents.map((c) => (c === 0 ? '0' : c > 0 ? `+${c}` : `−${-c}`));
  // Non-breaking before the unit: a "¢" alone on the next line reads as a typo.
  return `${parts.join(' ')} ¢`;
}

function sectionHead(group: TuningGroup): HTMLElement {
  const head = document.createElement('p');
  head.className = 'sheet-section';
  head.textContent = group;
  return head;
}

function tuningRow(tuning: Tuning, currentId: string): HTMLElement {
  const name = document.createElement('span');
  name.className = 'sheet-item-name';
  name.textContent = tuning.name;

  const detail = document.createElement('span');
  detail.className = 'sheet-item-detail';
  detail.textContent = tuning.detail;

  const text = document.createElement('span');
  text.className = 'sheet-item-text';
  text.append(name, detail);

  // A sweetened tuning looks identical to its plain twin on the note names
  // alone, so the offsets get their own quiet line under them.
  const offsets = centsLine(tuning);
  if (offsets !== '') {
    const cents = document.createElement('span');
    cents.className = 'sheet-item-cents';
    cents.textContent = offsets;
    text.append(cents);
  }

  const check = document.createElement('span');
  check.className = 'sheet-item-check';
  check.innerHTML = ICONS.check;

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'sheet-item';
  item.dataset.tuningId = tuning.id;
  if (tuning.id === currentId) item.setAttribute('aria-current', 'true');
  item.append(text, check);
  item.addEventListener('click', () => {
    updateState({ tuningId: tuning.id });
    closeSheet();
  });
  rowButtons.push(item);

  if (tuning.group !== 'Custom') return item;

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'icon-btn sheet-row-edit';
  edit.setAttribute('aria-label', `Edit ${tuning.name}`);
  edit.innerHTML = ICONS.pencil;
  edit.addEventListener('click', () => openEditor(tuning));

  const row = document.createElement('div');
  row.className = 'sheet-row';
  row.append(item, edit);
  return row;
}

function addRow(): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'sheet-add-icon';
  icon.innerHTML = ICONS.plus;

  const label = document.createElement('span');
  label.className = 'sheet-item-name';
  label.textContent = 'New tuning';

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'sheet-item sheet-add';
  item.append(icon, label);
  item.addEventListener('click', () => openEditor(null));
  rowButtons.push(item);
  return item;
}

function renderList(): void {
  const currentId = getState().tuningId;
  const tunings = allTunings();
  tuningList.textContent = '';
  rowButtons = [];
  for (const group of GROUP_ORDER) {
    const entries = tunings.filter((t) => t.group === group);
    // Custom always shows: its "New tuning" row is the only way into the editor.
    if (entries.length === 0 && group !== 'Custom') continue;
    tuningList.append(sectionHead(group), ...entries.map((t) => tuningRow(t, currentId)));
    if (group === 'Custom') tuningList.append(addRow());
  }
}

/* ---------- tuning editor ---------- */

interface StringRow {
  name: HTMLElement;
  note: HTMLElement;
  dec: HTMLButtonElement;
  inc: HTMLButtonElement;
  cents: HTMLElement;
  fine: HTMLElement;
  fineDec: HTMLButtonElement;
  fineInc: HTMLButtonElement;
}

let editorId: string | null = null;
let editorMidis: number[] = [];
/** Per-string sweetening, index-aligned with editorMidis. */
let editorCents: number[] = [];
let stringRows: StringRow[] = [];
let editorReturnFocus: HTMLElement | null = null;
let deleteArmed = false;
let deleteTimer = 0;

const refreshEditorFade = fadeOnOverflow(editorScroll, [editorStrings]);

function clampMidi(midi: number): number {
  return clamp(Math.round(midi), MIDI_MIN, MIDI_MAX);
}

function clampCents(cents: number): number {
  return Number.isFinite(cents) ? clamp(Math.round(cents), CENTS_MIN, CENTS_MAX) : 0;
}

/** Disabling the focused button would drop focus to <body> and break the
    sheet's Tab trap, so hand it across the stepper before the flag flips. */
function setStepDisabled(btn: HTMLButtonElement, off: boolean, alt: HTMLButtonElement): void {
  if (off && !btn.disabled && document.activeElement === btn) {
    (alt.disabled ? sheetClose : alt).focus();
  }
  btn.disabled = off;
}

function stepButton(icon: string, step: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.innerHTML = icon;
  attachRepeat(btn, step);
  return btn;
}

/**
 * One string: its note on the first line, its sweetening on the second. Both
 * lines are built either way — four 44px targets, two readouts and two labels do
 * not fit across a phone-width sheet, and a target that has to shrink to fit is
 * the wrong thing to give up — and the stylesheet lays them side by side from
 * 400px up, where they measurably do fit.
 */
function buildStringRows(): void {
  editorStrings.textContent = '';
  stringRows = editorMidis.map((_, i) => {
    const name = document.createElement('span');
    name.className = 'editor-string-name';

    const note = document.createElement('span');
    note.className = 'editor-note';
    note.setAttribute('aria-live', 'polite');

    const dec = stepButton(ICONS.minus, () => nudgeString(i, -1));
    const inc = stepButton(ICONS.plus, () => nudgeString(i, 1));

    const stepper = document.createElement('div');
    stepper.className = 'editor-stepper';
    stepper.append(dec, note, inc);

    const head = document.createElement('div');
    head.className = 'editor-string-line';
    head.append(name, stepper);

    const fineName = document.createElement('span');
    fineName.className = 'editor-fine-name';
    fineName.textContent = 'Fine tune';

    const cents = document.createElement('span');
    cents.className = 'editor-cents';
    cents.setAttribute('aria-live', 'polite');

    const fineDec = stepButton(ICONS.minus, () => nudgeCents(i, -1));
    const fineInc = stepButton(ICONS.plus, () => nudgeCents(i, 1));

    // The pair carries the "in cents" part of the label so neither button has to
    // repeat it, and a screen reader reads the group before either one.
    const fine = document.createElement('div');
    fine.className = 'editor-stepper editor-stepper-fine';
    fine.setAttribute('role', 'group');
    fine.append(fineDec, cents, fineInc);

    const fineLine = document.createElement('div');
    fineLine.className = 'editor-string-line editor-string-fine';
    fineLine.append(fineName, fine);

    const row = document.createElement('div');
    row.className = 'editor-row editor-string';
    row.append(head, fineLine);
    editorStrings.append(row);
    return { name, note, dec, inc, cents, fine, fineDec, fineInc };
  });
}

function nudgeString(i: number, delta: number): void {
  const next = clampMidi(editorMidis[i] + delta);
  if (next === editorMidis[i]) return;
  editorMidis[i] = next;
  syncEditor();
}

function nudgeCents(i: number, delta: number): void {
  const next = clampCents(editorCents[i] + delta);
  if (next === editorCents[i]) return;
  editorCents[i] = next;
  syncEditor();
}

function setStringCount(next: number): void {
  const count = clamp(next, STRINGS_MIN, STRINGS_MAX);
  if (count === editorMidis.length) return;
  // Growing copies the last string, shrinking drops it — the highest either way.
  // A copied string brings its sweetening with it: it is the same string twice.
  while (editorMidis.length < count) {
    editorMidis.push(editorMidis[editorMidis.length - 1]);
    editorCents.push(editorCents[editorCents.length - 1] ?? 0);
  }
  while (editorMidis.length > count) {
    editorMidis.pop();
    editorCents.pop();
  }
  buildStringRows();
  syncEditor();
}

function syncEditor(): void {
  const count = editorMidis.length;
  setText(editorCount, String(count));
  setStepDisabled(editorCountDec, count <= STRINGS_MIN, editorCountInc);
  setStepDisabled(editorCountInc, count >= STRINGS_MAX, editorCountDec);

  for (let i = 0; i < stringRows.length; i++) {
    const row = stringRows[i];
    const midi = editorMidis[i];
    const cents = editorCents[i];
    // Strings are stored low → high and numbered the way a player counts them,
    // so the lowest string carries the highest number.
    const ordinal = count - i;
    setText(row.name, `String ${ordinal}`);
    setText(row.note, noteName(midi));
    setText(row.cents, centsText(cents));
    row.cents.classList.toggle('is-on', cents !== 0);
    row.dec.setAttribute('aria-label', `Lower string ${ordinal} a semitone`);
    row.inc.setAttribute('aria-label', `Raise string ${ordinal} a semitone`);
    row.fine.setAttribute('aria-label', `Fine tune string ${ordinal} in cents`);
    row.fineDec.setAttribute('aria-label', `Lower string ${ordinal} a cent`);
    row.fineInc.setAttribute('aria-label', `Raise string ${ordinal} a cent`);
    setStepDisabled(row.dec, midi <= MIDI_MIN, row.inc);
    setStepDisabled(row.inc, midi >= MIDI_MAX, row.dec);
    setStepDisabled(row.fineDec, cents <= CENTS_MIN, row.fineInc);
    setStepDisabled(row.fineInc, cents >= CENTS_MAX, row.fineDec);
  }

  setText(editorPreview, previewText());
  refreshEditorFade();
}

/**
 * The tuning as one line: note names, each with its offset when it has one.
 * A sweetened string is two words where the others are one, so the separator
 * widens to keep "B3 −6¢" reading as a single entry — and a tuning with no
 * offsets at all prints exactly the plain note list it always did.
 */
function previewText(): string {
  const sweetened = editorCents.some((c) => c !== 0);
  const parts = editorMidis.map((midi, i) => {
    const cents = editorCents[i];
    return cents === 0 ? noteName(midi) : `${noteName(midi)} ${centsText(cents)}`;
  });
  return parts.join(sweetened ? ' ' : ' ');
}

function setSheetMode(mode: SheetMode): void {
  const changed = sheetMode !== mode;
  sheetMode = mode;
  const editing = mode === 'editor';
  tuningList.hidden = editing;
  // The capo belongs to the instrument, not to the tuning being written down:
  // it has nothing to say on the editor screen and would only invite the player
  // to bake the transposition into their custom.
  capoRow.hidden = editing;
  editorForm.hidden = !editing;
  // A note belongs to the screen that raised it; every switch is a fresh one.
  setText(sheetNote, '');
  setText(sheetTitle, editing ? (editorId ? 'Edit tuning' : 'New tuning') : 'Tuning');
  sheetClose.setAttribute('aria-label', editing ? 'Close tuning editor' : 'Close tuning list');
  // The panel that arrived fades in; the one that left snaps out. Opacity and
  // transform only, so the sheet's height is the same before and after.
  if (changed) enter(editing ? editorForm : tuningList);
}

function disarmDelete(): void {
  window.clearTimeout(deleteTimer);
  deleteTimer = 0;
  if (!deleteArmed) return;
  deleteArmed = false;
  editorDelete.classList.remove('is-armed');
  setText(editorDelete, 'Delete tuning');
}

function openEditor(tuning: Tuning | null): void {
  editorReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editorId = tuning?.id ?? null;
  // A new tuning starts from the one in use: most customs are a variation on
  // whatever the player already had selected.
  const source = tuning ?? tuningById(getState().tuningId);
  editorName.value = tuning ? tuning.name : NAME_FALLBACK;
  editorMidis = source.midis.slice(0, STRINGS_MAX).map(clampMidi);
  // Read per string, so a source whose offsets are absent, short or long still
  // hands the editor one number per string it is about to show.
  editorCents = editorMidis.map((_, i) => clampCents(stringCents(source, i)));
  while (editorMidis.length < STRINGS_MIN) {
    editorMidis.push(editorMidis[editorMidis.length - 1] ?? MIDI_MIN);
    editorCents.push(editorCents[editorCents.length - 1] ?? 0);
  }
  disarmDelete();
  editorDelete.hidden = editorId === null;
  buildStringRows();
  syncEditor();
  setSheetMode('editor');
  // The title, not the name field: focusing an input here would throw a
  // software keyboard over the sheet before the player has asked for one.
  sheetTitle.focus();
}

function backToList(target: HTMLElement | null): void {
  disarmDelete();
  setSheetMode('list');
  // The row that opened the editor is gone after a delete, so fall back to the
  // "New tuning" row that took its place at the end of the list.
  const focus = target?.isConnected ? target : rowButtons[rowButtons.length - 1];
  (focus ?? sheetClose).focus();
  editorReturnFocus = null;
}

function saveEditor(): void {
  const name = editorName.value.trim().slice(0, NAME_MAX) || NAME_FALLBACK;
  // An untouched tuning stores no offsets at all, so a custom made the way every
  // custom was made before v1.5 is written exactly as it was before v1.5.
  const cents = editorCents.some((c) => c !== 0) ? [...editorCents] : undefined;
  const saved = saveCustomTuning({
    id: editorId ?? undefined,
    name,
    midis: [...editorMidis],
    cents,
  });
  // Always setState, even when the id is unchanged: an edited tuning has to
  // reach the views that are showing its note names.
  updateState({ tuningId: saved.id });
  closeSheet();
}

function removeEditing(): void {
  const id = editorId;
  if (!id) return;
  if (!deleteArmed) {
    deleteArmed = true;
    deleteTimer = window.setTimeout(disarmDelete, DELETE_ARM_MS);
    editorDelete.classList.add('is-armed');
    setText(editorDelete, 'Tap again to delete');
    return;
  }
  disarmDelete();
  const gone = tuningById(id).name;
  const wasInUse = getState().tuningId === id;
  deleteCustomTuning(id);
  if (wasInUse) updateState({ tuningId: 'standard' });
  renderList();
  const current = wasInUse
    ? (rowButtons.find((item) => item.getAttribute('aria-current') === 'true') ?? null)
    : null;
  backToList(current ?? editorReturnFocus);
  if (!current) return;
  // Deleting the tuning in use retunes the instrument. The chip says so, but it
  // is behind the scrim's blur, so the list says it too — and the row that took
  // over comes into view under the focus ring instead of 500px down the list.
  current.scrollIntoView({ block: 'center' });
  setText(sheetNote, `${gone} deleted — now using ${tuningById(getState().tuningId).name}`);
}

editorForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveEditor();
});
editorCancel.addEventListener('click', () => backToList(editorReturnFocus));
editorDelete.addEventListener('click', removeEditing);
editorName.addEventListener('input', disarmDelete);
attachRepeat(editorCountDec, () => setStringCount(editorMidis.length - 1));
attachRepeat(editorCountInc, () => setStringCount(editorMidis.length + 1));

/* ---------- capo ---------- */

/** How far the capo may go on the instrument in force: twelve frets, or the
    fret where the top string would cross the pitch detector's ceiling —
    whichever comes first (see capoLimit). Past that the strip would name a
    target the tuner cannot hear, and the guide would ask for it forever. */
function capoCeiling(tuningId: string, a4: number): number {
  return Math.min(CAPO_MAX, capoLimit(tuningById(tuningId), a4));
}

/** Every write that can move a target out of the tuner's reach goes through
    here, so a fret can never outlive the instrument it was set on: picking the
    mandolin (or calibrating up to A4 466) with a high capo brings the capo down
    with it, which the sheet's own readout, the header chip and both CAPO tags
    say at once. Keeping the fret instead would leave the top string silently
    unhearable, which is the defect this replaces — and clamping only inside the
    note math would be worse still: it would name one pitch and target another. */
function updateState(partial: Partial<AppState>): void {
  const current = getState();
  const ceiling = capoCeiling(partial.tuningId ?? current.tuningId, partial.a4 ?? current.a4);
  setState({ ...partial, capo: Math.min(partial.capo ?? current.capo, ceiling) });
}

/** Changing the capo leaves the sheet open: it is a setting the player adjusts
    against the list, not a choice that ends the visit. */
function nudgeCapo(delta: number): void {
  const { capo, tuningId, a4 } = getState();
  const next = clamp(capo + delta, 0, capoCeiling(tuningId, a4));
  if (next !== capo) setState({ capo: next });
}

function renderCapo(capo: number, ceiling: number): void {
  setText(capoValue, capo === 0 ? 'None' : `Fret ${capo}`);
  capoValue.classList.toggle('is-on', capo > 0);
  setStepDisabled(capoDec, capo <= 0, capoInc);
  setStepDisabled(capoInc, capo >= ceiling, capoDec);
}

attachRepeat(capoDec, () => nudgeCapo(-1));
attachRepeat(capoInc, () => nudgeCapo(1));

// A blob written on another instrument can carry a fret this one cannot reach —
// capo 12 saved on a guitar, reopened on the mandolin. Bring it back into range
// before the first paint rather than opening deaf.
{
  const { tuningId, a4, capo } = getState();
  const ceiling = capoCeiling(tuningId, a4);
  if (capo > ceiling) setState({ capo: ceiling });
}

/* ---------- sheet open / close ---------- */

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
  // Customs can have changed since the last open, and a reopen that beat the
  // exit animation may still be sitting in edit mode.
  renderList();
  setSheetMode('list');
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
  const current = rowButtons.find((item) => item.getAttribute('aria-current') === 'true');
  (current ?? rowButtons[0] ?? sheetClose).focus();
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
    disarmDelete();
    setSheetMode('list');
  }, SHEET_EXIT_MS);
}

/** Everything tabbable in the sheet, in DOM order: the close button plus the
    controls of whichever panel is showing — the capo row counts as part of the
    list, which is where it sits and where it is shown. */
function sheetFocusables(): HTMLElement[] {
  const panels = sheetMode === 'editor' ? [editorForm] : [capoRow, tuningList];
  const controls: HTMLElement[] = [];
  for (const panel of panels) {
    controls.push(
      ...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
    );
  }
  return [sheetClose, ...controls.filter((node) => !node.hidden)];
}

function handleSheetKeys(e: KeyboardEvent): void {
  const active = document.activeElement;
  if (e.key === 'Tab') {
    // The sheet is modal: keep Tab inside it.
    const focusable = sheetFocusables();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    // index < 0 covers the sheet title, which takes focus when the editor opens.
    if (index < 0) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && index === 0) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && index === focusable.length - 1) {
      e.preventDefault();
      first.focus();
    }
    return;
  }
  if (sheetMode !== 'list') return; // arrows belong to the editor's own fields
  // The capo stepper is not a list row; arrows there would fling focus into the
  // list from a control the player is in the middle of using.
  if (active instanceof Node && capoRow.contains(active)) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const index = rowButtons.findIndex((item) => item === active);
  const count = rowButtons.length;
  if (count === 0) return;
  let next = 0;
  if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % count;
  else if (e.key === 'ArrowUp') next = index < 0 ? count - 1 : (index - 1 + count) % count;
  else if (e.key === 'End') next = count - 1;
  rowButtons[next]?.focus();
}

tuningChip.addEventListener('click', openSheet);
sheetClose.addEventListener('click', closeSheet);
scrim.addEventListener('click', closeSheet);

/* ---------- calibration popover ---------- */

let popoverHideTimer = 0;
// `popover.hidden` lags the close by POP_EXIT_MS so the fade-out can play, so
// open/closed state is tracked here instead — exactly as the sheet does it.
let popoverOpen = false;

function openPopover(): void {
  window.clearTimeout(popoverHideTimer);
  if (popoverOpen) return;
  popoverOpen = true;
  popover.hidden = false;
  gearBtn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => popover.classList.add('is-open'));
  (a4Dec.disabled ? a4Inc : a4Dec).focus();
}

function closePopover(restoreFocus = false): void {
  if (!popoverOpen) return;
  popoverOpen = false;
  popover.classList.remove('is-open');
  gearBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus) gearBtn.focus();
  // It went out the way it came in rather than being cut mid-frame; a reopen
  // inside the window clears this and fades the same panel back.
  popoverHideTimer = window.setTimeout(() => {
    if (popoverOpen) return;
    popover.hidden = true;
  }, POP_EXIT_MS);
}

function nudgeA4(delta: number): void {
  const next = Math.min(A4_MAX, Math.max(A4_MIN, Math.round(getState().a4) + delta));
  if (next !== getState().a4) updateState({ a4: next });
}

gearBtn.addEventListener('click', () => {
  if (popoverOpen) closePopover(true);
  else openPopover();
});
a4Dec.addEventListener('click', () => nudgeA4(-1));
a4Inc.addEventListener('click', () => nudgeA4(1));
a4Reset.addEventListener('click', () => {
  if (getState().a4 !== A4_DEFAULT) updateState({ a4: A4_DEFAULT });
});

popover.addEventListener('focusout', (e) => {
  const next = e.relatedTarget;
  if (next instanceof Node && (popover.contains(next) || gearBtn.contains(next))) return;
  closePopover();
});

document.addEventListener('pointerdown', (e) => {
  if (!popoverOpen) return;
  const target = e.target;
  if (target instanceof Node && (popover.contains(target) || gearBtn.contains(target))) return;
  closePopover();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (sheetOpen) {
      e.preventDefault();
      closeSheet();
    } else if (popoverOpen) {
      e.preventDefault();
      closePopover(true);
    }
    return;
  }
  if (sheetOpen) handleSheetKeys(e);
});

/* ---------- state binding ---------- */

function render(state: AppState): void {
  setText(tuningLabel, tuningById(state.tuningId).name);
  // A capo silently retunes every target in the app, so the chip that names the
  // tuning names the capo too — the one label that is on screen at all times.
  const capo = clamp(state.capo, 0, CAPO_MAX);
  setText(chipCapo, capo > 0 ? `capo ${capo}` : '');
  chipCapo.hidden = capo === 0;
  appHeader.classList.toggle('has-capo', capo > 0);
  renderCapo(capo, capoCeiling(state.tuningId, state.a4));

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

  for (const item of rowButtons) {
    const id = item.dataset.tuningId;
    if (id === undefined) continue; // the "New tuning" row
    if (id === state.tuningId) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }
}

render(getState());
subscribe(render);

/* ---------- activity badges ---------- */

const runningNow = new Map<TabId, string>();

for (const source of RUNNING_SOURCES) {
  window.addEventListener(source.event, (event) => {
    const detail = (event as CustomEvent<{ running?: boolean; note?: string } | null>).detail;
    const running = detail?.running === true;
    tabs[source.tab].classList.toggle('is-running', running);
    // A view may name what it is playing, already spelled for speech ("A sharp
    // 3"); a badge that says which tone is sounding beats one that says a tone is.
    const note = typeof detail?.note === 'string' ? detail.note : '';
    if (running) runningNow.set(source.tab, note ? `${source.label}, ${note}` : source.label);
    else runningNow.delete(source.tab);
    setText(runningStatus, [...runningNow.values()].join(', '));
  });
}

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
