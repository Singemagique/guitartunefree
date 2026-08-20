import { ensureRunning, getAudioContext } from './context';

const DEFAULT_GAIN = 0.5;
const DEFAULT_SECONDS = 2.5;
const PEAK = 0.9;
const ATTACK_S = 0.002;
/** -60 dB, the amplitude ratio that defines T60. */
const T60_RATIO = 0.001;

/**
 * Render one Karplus-Strong pluck into `data` and normalise it to `PEAK`.
 * `t60` is the time in seconds for the string to fall to -60 dB.
 */
function render(data: Float32Array, sampleRate: number, freq: number, t60: number): void {
  const len = data.length;
  // The 0.5 * (x[i-n] + x[i-n+1]) averager below is linear-phase with exactly
  // half a sample of delay, so a tap at lag n resonates at sampleRate/(n - 0.5).
  // Rounding the period to a whole n therefore always lands sharp, by up to a
  // full sample of period — around 13 cents in the middle of the guitar range.
  // Interpolating between the (n - 0.5) and (n + 0.5) taps buys back the
  // fraction and puts the loop delay exactly on the period.
  const period = sampleRate / freq;
  const n = Math.min(Math.max(2, Math.round(period)), len - 1);
  const alpha = Math.min(1, Math.max(0, period - (n - 0.5)));

  // Excitation: white noise averaged with its neighbour. The averaging is a
  // one-zero lowpass that takes the fizz off the attack transient, which reads
  // as a fingertip rather than a spark.
  let prev = Math.random() * 2 - 1;
  for (let i = 0; i <= n; i++) {
    const r = Math.random() * 2 - 1;
    data[i] = (prev + r) * 0.5;
    prev = r;
  }

  // A sample makes one trip round the delay line every 1/freq seconds and picks
  // up exactly one loop-gain multiply on the way, so the gain that lands on
  // -60 dB after t60 seconds is 10^(-3 / (t60 * freq)). Deriving it per note
  // instead of using a fixed constant keeps a low E and a high E ringing for
  // the same musical length.
  const decay = Math.pow(T60_RATIO, 1 / (t60 * freq));
  for (let i = n + 1; i < len; i++) {
    const lo = 0.5 * (data[i - n] + data[i - n + 1]);
    const hi = 0.5 * (data[i - n - 1] + data[i - n]);
    data[i] = decay * (lo + alpha * (hi - lo));
  }

  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const scale = PEAK / peak;
    for (let i = 0; i < len; i++) data[i] *= scale;
  }
}

/**
 * Pluck a synthesised string at `freq`. Each call builds its own short-lived
 * node graph, so overlapping plucks (a strum) simply sum at the destination.
 */
export function pluck(freq: number, opts?: { gain?: number; seconds?: number }): void {
  if (!Number.isFinite(freq) || freq <= 0) return;

  const ctx = getAudioContext();
  // Always called from a user gesture, so the resume can settle after we have
  // scheduled: while suspended, currentTime is frozen and nothing is missed.
  void ensureRunning().catch(() => undefined);

  const gain = opts?.gain ?? DEFAULT_GAIN;
  const seconds = Math.max(0.1, opts?.seconds ?? DEFAULT_SECONDS);
  const sampleRate = ctx.sampleRate;

  const buffer = ctx.createBuffer(1, Math.max(2, Math.round(seconds * sampleRate)), sampleRate);
  render(buffer.getChannelData(0), sampleRate, freq, seconds);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const body = ctx.createBiquadFilter();
  body.type = 'lowpass';
  body.frequency.value = 4000;
  body.Q.value = 0.5;

  const amp = ctx.createGain();
  const t0 = ctx.currentTime;
  amp.gain.setValueAtTime(0, t0);
  amp.gain.linearRampToValueAtTime(gain, t0 + ATTACK_S);
  // Fade the tail so the buffer never ends on a discontinuity.
  amp.gain.setTargetAtTime(0, t0 + seconds * 0.75, seconds * 0.08);

  source.connect(body).connect(amp).connect(ctx.destination);
  source.addEventListener(
    'ended',
    () => {
      source.disconnect();
      body.disconnect();
      amp.disconnect();
    },
    { once: true },
  );
  source.start(t0);
}
