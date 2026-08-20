// Note math: MIDI <-> frequency <-> note name conversions.
// A4 (MIDI 69) defaults to 440 Hz but every function accepts a calibrated a4.

export interface NoteInfo {
  midi: number;
  name: string; // "E2"
  pc: string; // "E", "F#"
  octave: number;
  freq: number;
}

export const NOTE_NAMES: readonly string[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

const A4_MIDI = 69;

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - A4_MIDI) / 12);
}

export function freqToMidi(freq: number, a4 = 440): number {
  return A4_MIDI + 12 * Math.log2(freq / a4);
}

export function midiToNote(midi: number, a4 = 440): NoteInfo {
  const rounded = Math.round(midi);
  const pcIndex = ((rounded % 12) + 12) % 12;
  const pc = NOTE_NAMES[pcIndex];
  const octave = Math.floor(rounded / 12) - 1;
  const freq = midiToFreq(rounded, a4);
  return { midi: rounded, name: `${pc}${octave}`, pc, octave, freq };
}

/** Display form of a pitch class: "G#" -> "G♯". Logic and aria keep the raw pc. */
export function prettyPc(pc: string): string {
  return pc.length > 1 ? `${pc.charAt(0)}♯` : pc;
}

export function nearestNote(freq: number, a4 = 440): { note: NoteInfo; cents: number } {
  const fractionalMidi = freqToMidi(freq, a4);
  const note = midiToNote(fractionalMidi, a4);
  const cents = centsBetween(freq, note.freq);
  return { note, cents };
}

export function centsBetween(freq: number, targetFreq: number): number {
  return 1200 * Math.log2(freq / targetFreq);
}
