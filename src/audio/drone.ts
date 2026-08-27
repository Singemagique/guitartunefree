import { midiToFreq } from '../music/notes';
import { ensureRunning, getAudioContext } from './context';

/** Detune of the two main voices against each other, in cents. */
const SPREAD_CENTS = 3;
/** Depth of the slow wander applied on top of the spread, in cents. */
const DRIFT_CENTS = 4;
const DRIFT_HZ = 0.3;
/** Takes the edge off the sawtooths without making them dull. */
const TONE_HZ = 1800;
const TONE_Q = 0.7;
/** Sums the three voices; keeps their peak near unity before the master. */
const MIX_GAIN = 0.5;
/** The octave below carries weight, not pitch, so it sits well under them. */
const SUB_GAIN = 0.35;
const MASTER_GAIN = 0.18;
/** Long enough that starting and stopping is a swell, not an edge. */
const FADE_S = 0.25;
/** A glide short enough to read as a retune, long enough to hide the step. */
const GLIDE_S = 0.06;
/** Margin after the fade before the oscillators are released. */
const TAIL_S = 0.02;

/** Every node of one sounding drone, kept so stop() can take it all apart. */
interface Voice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  sub: OscillatorNode;
  drift: OscillatorNode;
  master: GainNode;
  nodes: AudioNode[];
}

/**
 * Move an AudioParam to a new value over GLIDE_S. Reading the live value before
 * cancelling and pinning it at `now` means a retune during an earlier glide
 * continues from where that glide had reached, instead of snapping back to its
 * start and sliding again.
 */
function glide(param: AudioParam, value: number, now: number): void {
  const from = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.exponentialRampToValueAtTime(value, now + GLIDE_S);
}

/**
 * A sustained reference pitch to tune or practise against: two sawtooths a few
 * cents apart plus the octave below, softened by a lowpass and slowly breathing
 * so it never sits dead still in the ear.
 */
export class Drone {
  private voice: Voice | null = null;
  private pitch: number | null = null;
  private a4 = 440;

  get running(): boolean {
    return this.voice !== null;
  }

  get midi(): number | null {
    return this.voice ? this.pitch : null;
  }

  /** Starting an already sounding drone retunes it rather than stacking one. */
  start(midi: number, a4?: number): void {
    if (!Number.isFinite(midi)) return;
    if (this.voice) {
      this.setPitch(midi, a4);
      return;
    }
    this.pitch = midi;
    if (a4 !== undefined) this.a4 = a4;

    const ctx = getAudioContext();
    // Always called from a user gesture, so the resume can settle after we have
    // built the graph: while suspended, currentTime is frozen and nothing runs.
    void ensureRunning().catch(() => undefined);

    const t0 = ctx.currentTime;
    const freq = midiToFreq(midi, this.a4);

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, t0);
    master.gain.linearRampToValueAtTime(MASTER_GAIN, t0 + FADE_S);

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = TONE_HZ;
    tone.Q.value = TONE_Q;

    const mix = ctx.createGain();
    mix.gain.value = MIX_GAIN;

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.setValueAtTime(freq, t0);
    oscA.detune.value = -SPREAD_CENTS;

    const oscB = ctx.createOscillator();
    oscB.type = 'sawtooth';
    oscB.frequency.setValueAtTime(freq, t0);
    oscB.detune.value = SPREAD_CENTS;

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq / 2, t0);

    const subGain = ctx.createGain();
    subGain.gain.value = SUB_GAIN;

    // Opposed depths, so what wanders is the interval between the two voices —
    // the beating speeds up and slows down instead of the whole tone sliding.
    const drift = ctx.createOscillator();
    drift.type = 'sine';
    drift.frequency.value = DRIFT_HZ;
    const driftUp = ctx.createGain();
    driftUp.gain.value = DRIFT_CENTS;
    const driftDown = ctx.createGain();
    driftDown.gain.value = -DRIFT_CENTS;

    oscA.connect(mix);
    oscB.connect(mix);
    sub.connect(subGain).connect(mix);
    mix.connect(tone).connect(master).connect(ctx.destination);
    drift.connect(driftUp).connect(oscA.detune);
    drift.connect(driftDown).connect(oscB.detune);

    for (const osc of [oscA, oscB, sub, drift]) osc.start(t0);

    this.voice = {
      oscA,
      oscB,
      sub,
      drift,
      master,
      nodes: [oscA, oscB, sub, subGain, drift, driftUp, driftDown, mix, tone, master],
    };
  }

  /** Retune without restarting: the tone glides, it never restarts or clicks. */
  setPitch(midi: number, a4?: number): void {
    if (!Number.isFinite(midi)) return;
    this.pitch = midi;
    if (a4 !== undefined) this.a4 = a4;
    const voice = this.voice;
    if (!voice) return;

    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const freq = midiToFreq(midi, this.a4);
    glide(voice.oscA.frequency, freq, now);
    glide(voice.oscB.frequency, freq, now);
    glide(voice.sub.frequency, freq / 2, now);
  }

  stop(): void {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    this.pitch = null;

    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const gain = voice.master.gain;
    const from = gain.value;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(from, now);
    gain.linearRampToValueAtTime(0, now + FADE_S);

    const end = now + FADE_S + TAIL_S;
    for (const osc of [voice.oscA, voice.oscB, voice.sub, voice.drift]) osc.stop(end);
    // One listener for the whole voice: they all end together, and disconnecting
    // on the way out is what keeps a stopped drone off the graph entirely.
    voice.oscA.addEventListener(
      'ended',
      () => {
        for (const node of voice.nodes) node.disconnect();
      },
      { once: true },
    );
  }
}
