/**
 * The strum analyser, off the main thread. A whole analysis is ~40-150 ms of
 * solid arithmetic — several dropped frames on the view if it ran inline — and
 * the FFT tables inside strum.ts stay warm in here across strums.
 */

import { analyzeStrum } from './strum';

interface Request {
  id: number;
  samples: ArrayBuffer;
  sampleRate: number;
  targets: number[];
}

/**
 * The worker globals, spelled out. The project compiles against the DOM lib —
 * pulling in lib.webworker for this one file would collide with it, and all
 * this module needs is a port that receives and one that sends.
 */
interface StrumWorkerScope {
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const worker = self as unknown as StrumWorkerScope;

worker.onmessage = (ev: MessageEvent<Request>): void => {
  const { id, samples, sampleRate, targets } = ev.data;
  const x = new Float32Array(samples);
  const result = analyzeStrum(x, sampleRate, targets);
  // Hand the buffer back rather than dropping it: the caller transferred it in,
  // and returning it keeps the round trip copy-free at both ends.
  worker.postMessage({ id, result, samples: x.buffer }, [x.buffer]);
};
