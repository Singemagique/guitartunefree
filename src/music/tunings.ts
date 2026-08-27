import type { NoteInfo } from './notes';
import { midiToNote, prettyPc } from './notes';

export type TuningGroup = 'Guitar' | 'Bass' | 'Ukulele' | 'Mandolin' | 'Custom';

export interface Tuning {
  id: string;
  name: string; // "Standard E"
  detail: string; // "E A D G B E"
  // 4-8 entries in string order, lowest string first — except where the
  // instrument is reentrant: the ukulele's high G still leads.
  midis: readonly number[];
  group: TuningGroup;
}

const CUSTOM_KEY = 'truestring:custom-tunings';
/** B0 (low string of a 5-string bass) up to A5 — the whole range the tuner and
    the Karplus-Strong pluck are built for. */
const MIDI_MIN = 23;
const MIDI_MAX = 81;
const STRINGS_MIN = 4;
const STRINGS_MAX = 8;
const NAME_MAX = 24;
const DEFAULT_NAME = 'My tuning';

export const TUNINGS: readonly Tuning[] = [
  {
    id: 'standard',
    name: 'Standard E',
    detail: 'E A D G B E',
    midis: [40, 45, 50, 55, 59, 64],
    group: 'Guitar',
  },
  {
    id: 'drop-d',
    name: 'Drop D',
    detail: 'D A D G B E',
    midis: [38, 45, 50, 55, 59, 64],
    group: 'Guitar',
  },
  {
    id: 'eb-standard',
    name: 'E♭ Standard',
    detail: 'E♭ A♭ D♭ G♭ B♭ E♭',
    midis: [39, 44, 49, 54, 58, 63],
    group: 'Guitar',
  },
  {
    id: 'd-standard',
    name: 'D Standard',
    detail: 'D G C F A D',
    midis: [38, 43, 48, 53, 57, 62],
    group: 'Guitar',
  },
  {
    id: 'drop-c',
    name: 'Drop C',
    detail: 'C G C F A D',
    midis: [36, 43, 48, 53, 57, 62],
    group: 'Guitar',
  },
  {
    id: 'dadgad',
    name: 'DADGAD',
    detail: 'D A D G A D',
    midis: [38, 45, 50, 55, 57, 62],
    group: 'Guitar',
  },
  {
    id: 'open-g',
    name: 'Open G',
    detail: 'D G D G B D',
    midis: [38, 43, 50, 55, 59, 62],
    group: 'Guitar',
  },
  {
    id: 'open-d',
    name: 'Open D',
    detail: 'D A D F♯ A D',
    midis: [38, 45, 50, 54, 57, 62],
    group: 'Guitar',
  },
  {
    id: 'open-e',
    name: 'Open E',
    detail: 'E B E G♯ B E',
    midis: [40, 47, 52, 56, 59, 64],
    group: 'Guitar',
  },
  {
    id: 'open-a',
    name: 'Open A',
    detail: 'E A E A C♯ E',
    midis: [40, 45, 52, 57, 61, 64],
    group: 'Guitar',
  },
  // Octaves are spelled out from here on: a bass E1 and a guitar E2 are the same
  // letter, and the ukulele's reentrant G4 only makes sense with its octave.
  {
    id: 'bass-standard',
    name: 'Bass Standard',
    detail: 'E1 A1 D2 G2',
    midis: [28, 33, 38, 43],
    group: 'Bass',
  },
  {
    id: 'bass-5-string',
    name: 'Bass 5-string',
    detail: 'B0 E1 A1 D2 G2',
    midis: [23, 28, 33, 38, 43],
    group: 'Bass',
  },
  {
    id: 'ukulele-gcea',
    name: 'Ukulele gCEA',
    detail: 'G4 C4 E4 A4',
    midis: [67, 60, 64, 69],
    group: 'Ukulele',
  },
  {
    id: 'mandolin-gdae',
    name: 'Mandolin GDAE',
    detail: 'G3 D4 A4 E5',
    midis: [55, 62, 69, 76],
    group: 'Mandolin',
  },
];

/** Display spelling of a pitch, sharps only: 46 -> "A♯2". */
export function noteName(midi: number): string {
  const note = midiToNote(midi);
  return `${prettyPc(note.pc)}${note.octave}`;
}

function detailOf(midis: readonly number[]): string {
  return midis.map(noteName).join(' ');
}

function clampMidi(midi: number): number {
  const m = Math.round(midi);
  return m < MIDI_MIN ? MIDI_MIN : m > MIDI_MAX ? MIDI_MAX : m;
}

function cleanName(name: unknown): string {
  const text = typeof name === 'string' ? name.slice(0, NAME_MAX).trim() : '';
  return text === '' ? DEFAULT_NAME : text;
}

/** Stored midis, trusted no further than their shape: anything non-numeric is
    dropped and the rest is clamped into range. Null when too few survive. */
function cleanMidis(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const midis: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
    midis.push(clampMidi(entry));
    if (midis.length === STRINGS_MAX) break;
  }
  return midis.length < STRINGS_MIN ? null : midis;
}

function isBuiltIn(id: string): boolean {
  return TUNINGS.some((t) => t.id === id);
}

/**
 * Customs are read back from storage on every call rather than cached: the app
 * is the only writer, but a second tab is not, and a tuning list that quietly
 * disagrees with what was saved is worse than one extra JSON.parse of a few
 * hundred bytes.
 */
function readCustoms(): Tuning[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CUSTOM_KEY);
  } catch {
    return []; // storage blocked (private mode / file://)
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Tuning[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const bag = entry as Record<string, unknown>;
    const id = typeof bag.id === 'string' ? bag.id : '';
    const midis = cleanMidis(bag.midis);
    // A custom that shadows a preset id would render twice and resolve wrong.
    if (id === '' || midis === null || seen.has(id) || isBuiltIn(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: cleanName(bag.name),
      detail: detailOf(midis),
      midis,
      group: 'Custom',
    });
  }
  return out;
}

function writeCustoms(list: readonly Tuning[]): void {
  const rows = list.map((t) => ({ id: t.id, name: t.name, midis: t.midis }));
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(rows));
  } catch {
    // Private mode or quota: the edit is lost on reload, which is the honest
    // outcome — nothing else in the app keeps a shadow copy of it.
  }
}

function newId(taken: ReadonlySet<string>): string {
  let id = '';
  do {
    id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  } while (taken.has(id));
  return id;
}

export function customTunings(): Tuning[] {
  return readCustoms();
}

export function allTunings(): Tuning[] {
  return [...TUNINGS, ...readCustoms()];
}

export function tuningById(id: string): Tuning {
  return TUNINGS.find((t) => t.id === id) ?? readCustoms().find((t) => t.id === id) ?? TUNINGS[0];
}

export function saveCustomTuning(t: { id?: string; name: string; midis: number[] }): Tuning {
  const list = readCustoms();

  const midis: number[] = [];
  for (const entry of t.midis) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
    midis.push(clampMidi(entry));
    if (midis.length === STRINGS_MAX) break;
  }
  // Short of four strings the editor has handed over something impossible; the
  // last string repeats rather than the save failing under a returning caller.
  while (midis.length < STRINGS_MIN) midis.push(midis[midis.length - 1] ?? 40);

  const taken = new Set([...TUNINGS.map((b) => b.id), ...list.map((c) => c.id)]);
  const id = t.id !== undefined && t.id !== '' && !isBuiltIn(t.id) ? t.id : newId(taken);

  const tuning: Tuning = {
    id,
    name: cleanName(t.name),
    detail: detailOf(midis),
    midis,
    group: 'Custom',
  };

  const at = list.findIndex((c) => c.id === id);
  if (at >= 0) list[at] = tuning;
  else list.push(tuning);
  writeCustoms(list);
  return tuning;
}

export function deleteCustomTuning(id: string): void {
  const list = readCustoms();
  const next = list.filter((t) => t.id !== id);
  if (next.length !== list.length) writeCustoms(next);
}

export function tuningNotes(t: Tuning, a4 = 440): NoteInfo[] {
  return t.midis.map((midi) => midiToNote(midi, a4));
}
