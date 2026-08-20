import { ensureRunning, getAudioContext } from './context';

const DENIED = ['NotAllowedError', 'NotFoundError', 'SecurityError'];

/** Lowest pitch the detector accepts, mirroring MIN_FREQ in pitch.ts. */
const FLOOR_HZ = 55;
/** The frame size every mainstream rate lands on, and the spec's baseline. */
const MIN_FRAME = 2048;
/** AnalyserNode refuses an fftSize above this. */
const MAX_FRAME = 32768;

/**
 * The detector needs a lag of one FLOOR_HZ period and never looks past half the
 * frame, so the frame has to span two of them. A fixed 2048 covers that at
 * 44.1/48 kHz but bottoms out at 93.75 Hz on a 96 kHz interface, which silently
 * hides the lowest string of every tuning; deriving the size from the live rate
 * keeps the floor at ~55 Hz and the window at ~45 ms whatever the hardware runs.
 */
function frameSize(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return MIN_FRAME;
  const needed = 2 * (Math.ceil(sampleRate / FLOOR_HZ) + 2);
  if (needed >= MAX_FRAME) return MAX_FRAME;
  return Math.max(MIN_FRAME, 1 << Math.ceil(Math.log2(needed)));
}

export class MicCapture {
  readonly bufferSize: number = frameSize(getAudioContext().sampleRate);

  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private readonly frame = new Float32Array(this.bufferSize);

  get running(): boolean {
    return this.analyser !== null;
  }

  get sampleRate(): number {
    return getAudioContext().sampleRate;
  }

  async start(): Promise<void> {
    if (this.analyser) return;
    if (!this.pending) {
      const attempt = this.open(++this.generation).finally(() => {
        if (this.pending === attempt) this.pending = null;
      });
      this.pending = attempt;
    }
    await this.pending;
  }

  stop(): void {
    // Invalidate any start() still waiting on getUserMedia so it tears down
    // instead of wiring up a stream nobody asked for any more.
    this.generation++;
    this.pending = null;
    this.source?.disconnect();
    this.source = null;
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }

  read(target: Float32Array): void {
    if (!this.analyser) {
      target.fill(0);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.frame);
    const n = Math.min(target.length, this.frame.length);
    target.set(this.frame.subarray(0, n));
  }

  private async open(generation: number): Promise<void> {
    const media: MediaDevices | undefined = navigator.mediaDevices;
    if (!media) throw new Error('mic-denied');

    const ctx = await ensureRunning();

    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (err) {
      const name = (err as DOMException | null)?.name ?? '';
      if (DENIED.includes(name)) throw new Error('mic-denied');
      throw err;
    }

    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.bufferSize;
    analyser.smoothingTimeConstant = 0;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    this.stream = stream;
    this.source = source;
    this.analyser = analyser;
  }
}
