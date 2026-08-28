import type { NoteInfo } from './notes';
import { freqToMidi, midiToNote, prettyPc } from './notes';

export type TuningGroup = 'Guitar' | 'Bass' | 'Ukulele' | 'Mandolin' | 'Custom';

export interface Tuning {
  id: string;
  name: string; // "Standard E"
  detail: string; // "E A D G B E"
  // 4-8 entries in string order, lowest string first — except where the
  // instrument is reentrant: the ukulele's high G still leads.
  midis: readonly number[];
  group: TuningGroup;
  /**
   * Per-string offsets from equal temperament, in cents, same length and order
   * as `midis`. Absent means every string is dead-on. A "sweetened" tuning
   * lives here: the target frequency moves, the note NAME never does.
   */
  cents?: readonly number[];
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
/** Half a semitone each way: past that the offset is a different note, not a
    sweetening, and the tuner's ±50 cent gauge could not show it anyway. */
const CENTS_MIN = -50;
const CENTS_MAX = 50;
const CAPO_MIN = 0;
const CAPO_MAX = 12;
/** The pitch detector's ceiling (MAX_FREQ in audio/pitch.ts). A target above it
    is one the tuner can never read, so it also bounds the capo — see
    capoLimit() at the bottom of this file. */
const MAX_TARGET_HZ = 1100;

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
  // Sweetened: same notes as Standard E, targets nudged off equal temperament so
  // open chords beat less. The gauge still reads 0 when the string is right.
  {
    id: 'sweet-standard',
    name: 'Standard · sweetened',
    detail: 'E A D G B E',
    midis: [40, 45, 50, 55, 59, 64],
    cents: [0, -2, -2, -4, -6, -2],
    group: 'Guitar',
  },
  {
    id: 'james-taylor',
    name: 'James Taylor',
    detail: 'E A D G B E',
    midis: [40, 45, 50, 55, 59, 64],
    cents: [-12, -10, -8, -4, -6, -3],
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

function clampCents(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return cents < CENTS_MIN ? CENTS_MIN : cents > CENTS_MAX ? CENTS_MAX : cents;
}

/** Frets are whole numbers, and there is no fret -1. Mirrors state.ts's clamp so
    a stray caller cannot ask for a target the player could never fret. */
function capoFrets(capo: number): number {
  if (!Number.isFinite(capo)) return CAPO_MIN;
  const fret = Math.round(capo);
  return fret < CAPO_MIN ? CAPO_MIN : fret > CAPO_MAX ? CAPO_MAX : fret;
}

/**
 * Offsets for `count` strings, or undefined when there is nothing to say. Junk
 * and missing entries read as dead-on, so a v1.4 blob (no `cents` at all) and a
 * v1.5 blob of an unsweetened tuning both come back the same way: undefined.
 */
function cleanCents(value: unknown, count: number): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cents: number[] = [];
  let sweetened = false;
  for (let i = 0; i < count; i++) {
    const entry: unknown = value[i];
    const c = typeof entry === 'number' ? clampCents(entry) : 0;
    if (c !== 0) sweetened = true;
    cents.push(c);
  }
  return sweetened ? cents : undefined;
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
    const cents = cleanCents(bag.cents, midis.length);
    out.push({
      id,
      name: cleanName(bag.name),
      detail: detailOf(midis),
      midis,
      group: 'Custom',
      ...(cents ? { cents } : {}),
    });
  }
  return out;
}

function writeCustoms(list: readonly Tuning[]): void {
  // `cents` is written only when it says something: an unsweetened custom keeps
  // producing exactly the blob v1.4 wrote, so downgrading loses nothing.
  const rows = list.map((t) => ({
    id: t.id,
    name: t.name,
    midis: t.midis,
    ...(t.cents ? { cents: t.cents } : {}),
  }));
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

export function saveCustomTuning(t: {
  id?: string;
  name: string;
  midis: number[];
  cents?: number[];
}): Tuning {
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

  // Trimmed and padded to the strings that actually exist — a string the editor
  // removed must not leave its offset behind on the one that took its place.
  const cents = cleanCents(t.cents, midis.length);

  const taken = new Set([...TUNINGS.map((b) => b.id), ...list.map((c) => c.id)]);
  const id = t.id !== undefined && t.id !== '' && !isBuiltIn(t.id) ? t.id : newId(taken);

  const tuning: Tuning = {
    id,
    name: cleanName(t.name),
    detail: detailOf(midis),
    midis,
    group: 'Custom',
    ...(cents ? { cents } : {}),
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

/** Offset of string `i` in cents, 0 when the tuning has none for it. */
export function stringCents(t: Tuning, i: number): number {
  const cents = t.cents?.[i];
  return typeof cents === 'number' ? clampCents(cents) : 0;
}

/**
 * The targets a player is actually aiming at, low string first.
 *
 * Three independent adjustments compose here, in this order:
 *  - `capo` transposes the pitch UP by that many semitones — with a capo on
 *    fret 2 the open low E string sounds F♯2, so that is what we ask for, name
 *    and all.
 *  - `a4` is the calibration reference, applied by the note math itself.
 *  - the tuning's own cent offsets bend the target frequency off equal
 *    temperament without touching the name: a sweetened B string is still a B.
 */
export function tuningNotes(t: Tuning, a4 = 440, capo = 0): NoteInfo[] {
  const frets = capoFrets(capo);
  return t.midis.map((midi, i) => {
    const note = midiToNote(midi + frets, a4);
    const cents = stringCents(t, i);
    return cents === 0 ? note : { ...note, freq: note.freq * Math.pow(2, cents / 1200) };
  });
}

/**
 * The highest fret this tuning can be capoed to with every target still inside
 * the pitch detector's range (audio/pitch.ts rejects anything above MAX_FREQ,
 * so C6 at 1046.5 Hz is the last note the tuner can hear at A4 440).
 *
 * Transposing past it is not a small error: the strip names a pitch, the guide
 * asks for it, and the tuner then cannot hear that string at all, with nothing
 * on screen saying why. Mandolin GDAE reaches it at fret 9. Clamping inside
 * tuningNotes() would be worse than the bug — it would name one pitch and
 * target another — so the limit is published here and the capo control stops
 * at it instead. Calibration counts: at A4 466 the ceiling falls a semitone.
 */
export function capoLimit(t: Tuning, a4 = 440): number {
  let limit = CAPO_MAX;
  for (let i = 0; i < t.midis.length; i++) {
    // Sweetening moves the target frequency without moving the name, so it is
    // the frequency that has to clear the ceiling.
    const top = Math.floor(freqToMidi(MAX_TARGET_HZ / Math.pow(2, stringCents(t, i) / 1200), a4));
    const headroom = top - Math.round(t.midis[i]);
    if (headroom < limit) limit = headroom;
  }
  return limit < CAPO_MIN ? CAPO_MIN : limit;
}
