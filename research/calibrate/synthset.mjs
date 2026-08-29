/**
 * synthset.mjs — the SELF-TEST's stand-in for the user's recordings.
 *
 * Until real clips exist, the only way to know the pipeline measures what it
 * claims to measure is to feed it audio whose answers are known exactly. This
 * writes a full "recording set" — real WAV files, in a temp directory OUTSIDE
 * the repo, in the formats a phone or a field recorder would produce — using
 * the two independent synthesizers that already exist in the research
 * scratchpad. Neither is modified; both are imported.
 *
 *   spike-poly/synth.mjs         the spike's own truth generator (polarisation
 *                                split constant in Hz at the fundamental).
 *   spike-poly-verify/mysynth.mjs the adversarial verifier's independent one
 *                                (split constant in CENTS, and a `polDeep`
 *                                worst case). Used for the harsher world in the
 *                                sensitivity sweep and for the two
 *                                polarisation clips.
 *
 * Paths default to the scratchpad they were written in and can be pointed
 * elsewhere with SPIKE_DIR / SPIKE_VERIFY_DIR. If a synth is missing the
 * pipeline says so and skips exactly the checks that needed it.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { writeWavPcm16, writeWavPcm24, writeWavFloat32 } from './decode.mjs';

const DEFAULT_SPIKE =
  'C:/Users/ADAMJA~1/AppData/Local/Temp/claude/I--Claude-guitartunefree/949ca5df-9d88-4b68-a8cd-76847f6fa80e/scratchpad/spike-poly';
const DEFAULT_VERIFY =
  'C:/Users/ADAMJA~1/AppData/Local/Temp/claude/I--Claude-guitartunefree/949ca5df-9d88-4b68-a8cd-76847f6fa80e/scratchpad/spike-poly-verify';

export const SPIKE_DIR = process.env.SPIKE_DIR || DEFAULT_SPIKE;
export const VERIFY_DIR = process.env.SPIKE_VERIFY_DIR || DEFAULT_VERIFY;

export const NAMES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
export const STANDARD_MIDI = [40, 45, 50, 55, 59, 64];
export const midiToFreq = (m, a4 = 440) => a4 * Math.pow(2, (m - 69) / 12);
export const STANDARD = STANDARD_MIDI.map((m) => midiToFreq(m));

let spikeMod = null;
let verifyMod = null;

/** The spike's synth, or null with a reason. */
export async function loadSpikeSynth() {
  if (spikeMod !== null) return spikeMod;
  const f = join(SPIKE_DIR, 'synth.mjs');
  if (!existsSync(f)) {
    spikeMod = { ok: false, reason: `spike synth not found at ${f} (set SPIKE_DIR)` };
    return spikeMod;
  }
  try {
    const m = await import(pathToFileURL(f).href);
    spikeMod = { ok: true, ...m, dir: SPIKE_DIR };
  } catch (e) {
    spikeMod = { ok: false, reason: `spike synth failed to import: ${e.message}` };
  }
  return spikeMod;
}

/** The verifier's independent synth, or null with a reason. */
export async function loadVerifySynth() {
  if (verifyMod !== null) return verifyMod;
  const f = join(VERIFY_DIR, 'mysynth.mjs');
  if (!existsSync(f)) {
    verifyMod = { ok: false, reason: `verifier synth not found at ${f} (set SPIKE_VERIFY_DIR)` };
    return verifyMod;
  }
  try {
    const m = await import(pathToFileURL(f).href);
    verifyMod = { ok: true, ...m, dir: VERIFY_DIR };
  } catch (e) {
    verifyMod = { ok: false, reason: `verifier synth failed to import: ${e.message}` };
  }
  return verifyMod;
}

export const SET_DIR = join(tmpdir(), 'truestring-calibrate-selftest');

/** Silence-plus-room-tone before the first pluck, as any real recording has.
    Longer than StrumRecorder's 0.6 s warm-up, so the capture path is real. */
export const PRE_ROLL_S = 0.9;

/* The detune the "guitar" is actually in, in cents. The solo clips and the
   strums share it, which is what makes the solo clips usable as ground truth
   exactly the way the user's will be. */
export const TRUE_DETUNE = [-11.4, 3.7, -6.2, 14.1, -2.8, 8.6];

/**
 * Build the whole synthetic recording set and write it to disk.
 * Returns a manifest: every clip, its role, and its exact truth.
 */
export async function buildSet({ dir = SET_DIR, fs = 48000, clean = true } = {}) {
  const spike = await loadSpikeSynth();
  if (!spike.ok) throw new Error(spike.reason);
  const verify = await loadVerifySynth();

  if (clean && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const clips = [];
  const targets = STANDARD;

  /* ---- 1. six solo open strings (README item 1) ------------------------
     Generated as a full six-string call with five strings SKIPPED, so each
     string keeps the inharmonicity, level tilt and wound/plain identity it
     would have in a real strum — a one-string call would draw every string
     from the wound distribution. */
  for (let s = 0; s < 6; s++) {
    const skip = [0, 1, 2, 3, 4, 5].filter((i) => i !== s);
    const sy = spike.synthStrum({
      fs,
      dur: 5.5,
      targets,
      detune: TRUE_DETUNE,
      seed: 4001 + s * 131,
      skip,
      noiseSnrDb: 45,
    });
    const p = sy.params[s];
    // format roulette: the decoder has to survive whatever the user's phone
    // or recorder produces.
    const file = join(dir, `solo-${NAMES[s]}.wav`);
    const rate = s === 5 ? 44100 : fs;
    const rolled = withPreRoll(sy.x, fs, PRE_ROLL_S, 45, 4001 + s);
    const x = rate === fs ? rolled : resampleLinear(rolled, fs, rate);
    if (s === 1) writeWavPcm24(file, x, rate);
    else if (s === 2) writeWavFloat32(file, x, rate);
    else if (s === 3) writeStereo16(file, x, rate);
    else writeWavPcm16(file, x, rate);
    clips.push({
      file,
      role: 'solo',
      string: s,
      name: NAMES[s],
      fs: rate,
      truth: {
        f0: p.f0,
        detuneCents: TRUE_DETUNE[s],
        B: p.B,
        tau1: p.tau1,
        pluckPos: p.pluckPos,
        splitHz: p.split * p.f0,
        splitRel: p.split,
        polarRatio: p.polarRatio,
        polarTau: p.polarTau,
        onset: p.onset + PRE_ROLL_S,
        model: 'spike (split constant in Hz at f0)',
      },
    });
  }

  /* ---- 2. five down-strums (README item 2) ---------------------------- */
  for (let i = 0; i < 5; i++) {
    const sy = spike.synthStrum({
      fs,
      dur: 2.9,
      targets,
      detune: TRUE_DETUNE,
      seed: 5001 + i * 977,
      noiseSnrDb: 45,
      stagger: [10, 45],
    });
    const file = join(dir, `strum-down-${i + 1}.wav`);
    writeWavPcm16(file, withPreRoll(sy.x, fs, PRE_ROLL_S, 45, 5001 + i), fs);
    clips.push({
      file,
      role: 'strum',
      variant: 'down',
      fs,
      truth: { detuneCents: TRUE_DETUNE.slice(), played: [0, 1, 2, 3, 4, 5], B: sy.params.map((p) => p.B) },
    });
  }

  /* ---- 3. two polarisation clips (README item 3) ----------------------
     From the VERIFIER's synth, whose split is specified in cents, so the two
     competing polarisation models can be told apart on audio with a known
     answer before the real clips arrive. */
  if (verify.ok) {
    for (const [tag, polCents, deep] of [
      ['parallel', 2.0, false],
      ['perpendicular', 6.0, true],
    ]) {
      const sy = verify.synthStrum({
        fs,
        dur: 6.0,
        targets,
        cents: TRUE_DETUNE,
        wound: [1, 1, 1, 1, 0, 0],
        seed: 7001 + polCents * 13,
        missing: [1, 2, 3, 4, 5],
        snrDb: 45,
        polDeep: deep,
        polCentsOverride: polCents,
      });
      const file = join(dir, `polar-E2-${tag}.wav`);
      writeWavPcm16(file, withPreRoll(sy.x, fs, PRE_ROLL_S, 45, 7001 + polCents), fs);
      clips.push({
        file,
        role: 'polar',
        string: 0,
        name: 'E2',
        fs,
        truth: {
          detuneCents: TRUE_DETUNE[0],
          polCents,
          polMix: deep ? 1.0 : null,
          splitHz: STANDARD[0] * Math.pow(2, TRUE_DETUNE[0] / 1200) * (Math.pow(2, polCents / 1200) - 1),
          model: 'verifier (split constant in cents)',
        },
      });
    }
  }

  /* ---- 4. detuned strums (README item 5) ------------------------------ */
  const detuned = TRUE_DETUNE.slice();
  detuned[4] -= 20;
  detuned[0] -= 30;
  for (let i = 0; i < 2; i++) {
    const sy = spike.synthStrum({
      fs,
      dur: 2.9,
      targets,
      detune: detuned,
      seed: 6001 + i * 733,
      noiseSnrDb: 45,
    });
    const file = join(dir, `strum-detuned-${i + 1}.wav`);
    writeWavPcm16(file, withPreRoll(sy.x, fs, PRE_ROLL_S, 45, 6001 + i), fs);
    clips.push({
      file,
      role: 'strum',
      variant: 'detuned',
      fs,
      truth: { detuneCents: detuned.slice(), played: [0, 1, 2, 3, 4, 5] },
    });
  }

  /* ---- 5. six muted-string strums (README item 6) — the hallucination
            evidence the loosening recommendation has to survive. */
  for (let s = 0; s < 6; s++) {
    const sy = spike.synthStrum({
      fs,
      dur: 2.9,
      targets,
      detune: TRUE_DETUNE,
      seed: 8001 + s * 419,
      skip: [s],
      noiseSnrDb: 45,
    });
    const file = join(dir, `strum-muted-${NAMES[s]}.wav`);
    writeWavPcm16(file, withPreRoll(sy.x, fs, PRE_ROLL_S, 45, 8001 + s), fs);
    clips.push({
      file,
      role: 'strum',
      variant: 'muted',
      muted: s,
      fs,
      truth: {
        detuneCents: TRUE_DETUNE.slice(),
        played: [0, 1, 2, 3, 4, 5].filter((i) => i !== s),
        muted: s,
      },
    });
  }

  /* ---- 6. one noisy strum (README item 7) ----------------------------- */
  {
    const sy = spike.synthStrum({
      fs,
      dur: 2.9,
      targets,
      detune: TRUE_DETUNE,
      seed: 9001,
      noiseSnrDb: 14,
    });
    const file = join(dir, 'strum-noisy.wav');
    writeWavPcm16(file, withPreRoll(sy.x, fs, PRE_ROLL_S, 14, 9001), fs);
    clips.push({
      file,
      role: 'strum',
      variant: 'noisy',
      fs,
      truth: { detuneCents: TRUE_DETUNE.slice(), played: [0, 1, 2, 3, 4, 5], snrDb: 14 },
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    dir,
    fs,
    tuning: 'standard',
    targets,
    names: NAMES,
    trueDetuneCents: TRUE_DETUNE,
    spikeDir: SPIKE_DIR,
    verifyDir: verify.ok ? VERIFY_DIR : null,
    clips,
  };
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/* ------------------------------------------------------ small utilities */

/**
 * Prepend room tone, so the synthetic clips behave like recordings.
 *
 * Two things need it. `StrumRecorder` spends its first 0.6 s deliberately deaf
 * (WARMUP_S) and a synth clip whose first onset is at 20 ms would simply never
 * be captured — an artefact of the synth, not a property of the app. And the
 * solo analysis measures the room floor from the audio BEFORE the pluck, which
 * a clip with no pre-roll does not have.
 *
 * The tone is pink at exactly the level the synth's own `noiseSnrDb` puts under
 * the note (same measurement window, same Kellett filter), so it is a
 * continuation of the noise already in the clip rather than a new invention.
 */
function withPreRoll(x, fs, seconds, snrDb, seed) {
  const a = Math.round(0.02 * fs);
  const b = Math.min(x.length, Math.round(1.6 * fs));
  let e = 0;
  for (let i = a; i < b; i++) e += x[i] * x[i];
  const nRms = Math.sqrt(e / Math.max(1, b - a)) / Math.pow(10, snrDb / 20);
  const n = Math.round(seconds * fs);
  const rng = mulberry(seed);
  const pre = new Float64Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    pre[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  let pe = 0;
  for (let i = 0; i < n; i++) pe += pre[i] * pre[i];
  const g = nRms / Math.sqrt(pe / Math.max(1, n));
  const out = new Float64Array(n + x.length);
  for (let i = 0; i < n; i++) out[i] = pre[i] * g;
  out.set(x, n);
  return out;
}

/** Linear resample — only used to prove the pipeline is rate-agnostic. */
function resampleLinear(x, fromFs, toFs) {
  const n = Math.floor((x.length * toFs) / fromFs);
  const out = new Float64Array(n);
  const step = fromFs / toFs;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    const j = Math.floor(t);
    const f = t - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f;
  }
  return out;
}

/** Stereo 16-bit: the same signal in both channels, so mixdown must be a no-op. */
function writeStereo16(file, x, fs) {
  const inter = new Float64Array(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    inter[2 * i] = x[i];
    inter[2 * i + 1] = x[i];
  }
  // writeWavPcm16 writes mono headers; build the stereo header inline.
  const body = Buffer.alloc(inter.length * 2);
  for (let i = 0; i < inter.length; i++) {
    const v = Math.max(-1, Math.min(1, inter[i]));
    body.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + body.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(fs, 24);
  head.writeUInt32LE(fs * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(body.length, 40);
  writeFileSync(file, Buffer.concat([head, body]));
  return file;
}

/* --------------------------------------------------- the harsher world */

/**
 * The worlds the sensitivity sweep runs in, from the VERIFIER's independent
 * synth. Not written to disk: the sweep needs dozens of each and none of them
 * is a "recording".
 *
 *   clean    the v2.0 baseline: ordinary polarisation, a quiet room (45 dB).
 *   spec     exactly the harsher world the calibration brief specifies —
 *            polarisation at the verifier's DEEP-BEAT setting (equal-amplitude
 *            modes 6 cents apart, the partner ringing as long as the dominant)
 *            and the noise floor 10 dB higher.
 *   extreme  everything above, plus the things a real room and a real guitar
 *            add and the synth otherwise does not: a duller spectrum
 *            (rolloff 2.6 rather than 2.0), a wide per-string level spread and
 *            a treble trim, i.e. a strum where the top strings were caught
 *            lightly. This is the worst case the modelled physics can produce.
 */
export const WORLDS = Object.freeze({
  clean: { snrDb: 45, polDeep: false },
  spec: { snrDb: 35, polDeep: true, polCentsOverride: 6.0 },
  extreme: {
    snrDb: 35,
    polDeep: true,
    polCentsOverride: 6.0,
    rolloff: 2.6,
    levelSpreadDb: 14,
    levelTrimDb: [0, 0, -3, -6, -9, -12],
  },
});

export async function harshTrials({ n = 12, fs = 48000, seed0 = 31337, world = 'spec', missing = null, dur = 2.2 } = {}) {
  const verify = await loadVerifySynth();
  if (!verify.ok) throw new Error(verify.reason);
  const cfg = WORLDS[world] || WORLDS.spec;
  const out = [];
  for (let i = 0; i < n; i++) {
    const seed = seed0 + i * 7919;
    const rng = mulberry(seed ^ 0x9e37);
    const cents = Array.from({ length: 6 }, () => (rng() * 2 - 1) * 15);
    const miss = missing ? missing(i) : [];
    const sy = verify.synthStrum({
      fs,
      dur,
      targets: STANDARD,
      cents,
      wound: [1, 1, 1, 1, 0, 0],
      seed,
      missing: miss,
      stagger: 0.03,
      ...cfg,
    });
    out.push({ x: sy.x, fs, cents, missing: miss, seed, world });
  }
  return out;
}

/** Ablation trials from the SPIKE's synth: one string genuinely not played. */
export async function ablationTrials({ n = 12, fs = 48000, seed0 = 24001, snrDb = 45, dur = 2.3 } = {}) {
  const spike = await loadSpikeSynth();
  if (!spike.ok) throw new Error(spike.reason);
  const out = [];
  for (let i = 0; i < n; i++) {
    const seed = seed0 + i * 7919;
    const rng = mulberry(seed ^ 0x5f3a);
    const detune = Array.from({ length: 6 }, () => (rng() * 2 - 1) * 15);
    const skip = [i % 6];
    const sy = spike.synthStrum({
      fs,
      dur,
      targets: STANDARD,
      detune,
      seed,
      skip,
      noiseSnrDb: snrDb,
    });
    out.push({ x: sy.x, fs, cents: detune, missing: skip, seed, world: 'ablation' });
  }
  return out;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
