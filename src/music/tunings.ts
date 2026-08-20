import type { NoteInfo } from './notes';
import { midiToNote } from './notes';

export interface Tuning {
  id: string;
  name: string; // "Standard E"
  detail: string; // "E A D G B E"
  midis: readonly number[]; // low->high, 6 entries, e.g. standard = [40,45,50,55,59,64]
}

export const TUNINGS: readonly Tuning[] = [
  {
    id: 'standard',
    name: 'Standard E',
    detail: 'E A D G B E',
    midis: [40, 45, 50, 55, 59, 64],
  },
  {
    id: 'drop-d',
    name: 'Drop D',
    detail: 'D A D G B E',
    midis: [38, 45, 50, 55, 59, 64],
  },
  {
    id: 'eb-standard',
    name: 'E♭ Standard',
    detail: 'E♭ A♭ D♭ G♭ B♭ E♭',
    midis: [39, 44, 49, 54, 58, 63],
  },
  {
    id: 'd-standard',
    name: 'D Standard',
    detail: 'D G C F A D',
    midis: [38, 43, 48, 53, 57, 62],
  },
  {
    id: 'drop-c',
    name: 'Drop C',
    detail: 'C G C F A D',
    midis: [36, 43, 48, 53, 57, 62],
  },
  {
    id: 'dadgad',
    name: 'DADGAD',
    detail: 'D A D G A D',
    midis: [38, 45, 50, 55, 57, 62],
  },
  {
    id: 'open-g',
    name: 'Open G',
    detail: 'D G D G B D',
    midis: [38, 43, 50, 55, 59, 62],
  },
  {
    id: 'open-d',
    name: 'Open D',
    detail: 'D A D F♯ A D',
    midis: [38, 45, 50, 54, 57, 62],
  },
  {
    id: 'open-e',
    name: 'Open E',
    detail: 'E B E G♯ B E',
    midis: [40, 47, 52, 56, 59, 64],
  },
  {
    id: 'open-a',
    name: 'Open A',
    detail: 'E A E A C♯ E',
    midis: [40, 45, 52, 57, 61, 64],
  },
];

export function tuningById(id: string): Tuning {
  return TUNINGS.find((t) => t.id === id) ?? TUNINGS[0];
}

export function tuningNotes(t: Tuning, a4 = 440): NoteInfo[] {
  return t.midis.map((midi) => midiToNote(midi, a4));
}
