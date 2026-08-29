/**
 * decode.mjs — turn whatever the user dropped in research/recordings/ into
 * mono Float64 samples plus a sample rate. No npm dependencies.
 *
 *   WAV            parsed here: PCM 8/16/24/32-bit, IEEE float 32/64,
 *                  WAVE_FORMAT_EXTENSIBLE, any sample rate, any channel count
 *                  (mixed down to mono by averaging).
 *   M4A/AAC/MP3/…  handed to ffmpeg IF ffmpeg is on PATH. If it is not, the
 *                  file is reported as `needsFfmpeg` with the exact command the
 *                  user can run, and the pipeline carries on with the rest.
 *
 * Nothing is resampled: every stage downstream takes `fs` as a parameter, which
 * is how the shipped analyzer works too (it runs at the mic's own rate).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export const WAV_EXT = new Set(['.wav', '.wave']);
export const CODEC_EXT = new Set([
  '.m4a', '.mp4', '.aac', '.mp3', '.ogg', '.oga', '.opus', '.flac', '.caf', '.amr', '.3gp', '.wma',
]);
export const AUDIO_EXT = new Set([...WAV_EXT, ...CODEC_EXT]);

/* ------------------------------------------------------------------- WAV */

const FOURCC = (buf, off) => String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);

/** Signed 24-bit little-endian at `o`, normalised to [-1, 1). */
const read24 = (buf, o) =>
  (((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) >> 8) / 8388608;

/**
 * Parse a RIFF/WAVE buffer into mono Float64 + metadata.
 * Throws with a plain-English reason on anything it cannot read.
 */
export function parseWav(buf, label = 'wav') {
  if (buf.length < 12) throw new Error(`${label}: too short to be a WAV`);
  const riff = FOURCC(buf, 0);
  if (riff === 'RF64') {
    throw new Error(`${label}: RF64 (>4 GB) WAV is not supported — re-export as WAV or M4A`);
  }
  if (riff !== 'RIFF') throw new Error(`${label}: not a RIFF file (saw "${riff}")`);
  if (FOURCC(buf, 8) !== 'WAVE') throw new Error(`${label}: RIFF but not WAVE`);

  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = FOURCC(buf, p);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      const tag = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE hides the real tag in the first two bytes of the
      // SubFormat GUID, 24 bytes into the body.
      const format = tag === 0xfffe && size >= 40 ? buf.readUInt16LE(body + 24) : tag;
      fmt = { format, channels, rate, bits };
    } else if (id === 'data') {
      dataOff = body;
      // Some recorders write 0xFFFFFFFF or a stale length; clamp to what is here.
      dataLen = Math.min(size, buf.length - body);
      if (size === 0xffffffff || size === 0) dataLen = buf.length - body;
    }
    if (size === 0 && id !== 'data') break;
    p = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error(`${label}: no fmt chunk`);
  if (dataOff < 0) throw new Error(`${label}: no data chunk`);
  const { format, channels, rate, bits } = fmt;
  if (!channels || !rate) throw new Error(`${label}: fmt says ${channels} ch @ ${rate} Hz`);

  const bytes = bits >> 3;
  const rd =
    format === 3 && bits === 32
      ? (o) => buf.readFloatLE(o)
      : format === 3 && bits === 64
        ? (o) => buf.readDoubleLE(o)
        : format === 1 && bits === 8
          ? (o) => (buf[o] - 128) / 128
          : format === 1 && bits === 16
            ? (o) => buf.readInt16LE(o) / 32768
            : format === 1 && bits === 24
              ? (o) => read24(buf, o)
              : format === 1 && bits === 32
                ? (o) => buf.readInt32LE(o) / 2147483648
                : null;
  if (!rd) {
    throw new Error(
      `${label}: unsupported WAV encoding (format tag ${format}, ${bits}-bit). ` +
        'Re-export as 16/24-bit PCM or 32-bit float.',
    );
  }

  const stride = bytes * channels;
  const frames = Math.max(0, Math.floor(dataLen / stride));
  const x = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * stride;
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += rd(base + c * bytes);
    x[i] = acc / channels;
  }
  return { x, fs: rate, channels, bits, format, seconds: frames / rate };
}

/* ---------------------------------------------------------------- ffmpeg */

let ffmpegPath;
let ffmpegChecked = false;

/** Path of a working ffmpeg (env FFMPEG wins), or null when there is none. */
export function findFfmpeg() {
  if (ffmpegChecked) return ffmpegPath ?? null;
  ffmpegChecked = true;
  for (const c of [process.env.FFMPEG || '', 'ffmpeg']) {
    if (!c) continue;
    try {
      const r = spawnSync(c, ['-version'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) {
        ffmpegPath = c;
        return ffmpegPath;
      }
    } catch {
      /* keep looking */
    }
  }
  ffmpegPath = null;
  return null;
}

const SCRATCH = join(tmpdir(), 'truestring-calibrate-decode');

/** Decode a compressed file via ffmpeg into a 32-bit float WAV, then parse it. */
function decodeViaFfmpeg(file) {
  const exe = findFfmpeg();
  if (!exe) return null;
  mkdirSync(SCRATCH, { recursive: true });
  const out = join(SCRATCH, basename(file).replace(/[^\w.-]+/g, '_') + '.wav');
  const r = spawnSync(
    exe,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-ac', '1', '-c:a', 'pcm_f32le', out],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0 || !existsSync(out)) {
    throw new Error(`ffmpeg failed on ${basename(file)}: ${(r.stderr || '').trim().slice(0, 300)}`);
  }
  return parseWav(readFileSync(out), basename(file));
}

/* ------------------------------------------------------------------ API */

/**
 * decode(path) -> { ok:true, x, fs, … } | { ok:false, needsFfmpeg|error, hint }
 * Never throws for a file it simply cannot handle: the report has to be able to
 * say "these three clips need converting" and still analyse the rest.
 */
export function decode(file) {
  const ext = extname(file).toLowerCase();
  const name = basename(file);
  try {
    if (WAV_EXT.has(ext)) {
      return { ok: true, path: file, name, source: 'wav', ...parseWav(readFileSync(file), name) };
    }
    if (CODEC_EXT.has(ext)) {
      const got = decodeViaFfmpeg(file);
      if (got) return { ok: true, path: file, name, source: 'ffmpeg', ...got };
      const stem = name.replace(/\.[^.]+$/, '');
      return {
        ok: false,
        path: file,
        name,
        needsFfmpeg: true,
        hint: `ffmpeg not found on PATH — convert with:  ffmpeg -i "${name}" -ac 1 -c:a pcm_f32le "${stem}.wav"`,
      };
    }
    return { ok: false, path: file, name, error: `unrecognised extension "${ext}"` };
  } catch (e) {
    return { ok: false, path: file, name, error: String(e?.message || e) };
  }
}

/** Every audio-looking file in a directory, sorted, recursing one level down. */
export function listAudio(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      for (const f of readdirSync(p)) {
        if (AUDIO_EXT.has(extname(f).toLowerCase())) out.push(join(p, f));
      }
    } else if (AUDIO_EXT.has(extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out.sort();
}

/* ------------------------------------------------------------ WAV writers */
/* Used only by the synthetic self-test, which writes REAL files so that
   decode.mjs is exercised on the same path a phone recording would take. */

function riffHeader(dataLen, fs, bits, floatFmt) {
  const buf = Buffer.alloc(44);
  const bytes = bits >> 3;
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(floatFmt ? 3 : 1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(fs, 24);
  buf.writeUInt32LE(fs * bytes, 28);
  buf.writeUInt16LE(bytes, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const clip = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

/** 16-bit PCM mono — what a phone voice memo becomes. */
export function writeWavPcm16(file, x, fs) {
  const body = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) body.writeInt16LE(Math.round(clip(x[i]) * 32767), i * 2);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([riffHeader(body.length, fs, 16, false), body]));
  return file;
}

/** 24-bit PCM mono — what a field recorder produces. */
export function writeWavPcm24(file, x, fs) {
  const body = Buffer.alloc(x.length * 3);
  for (let i = 0; i < x.length; i++) {
    const s = Math.round(clip(x[i]) * 8388607);
    body.writeUInt8(s & 0xff, i * 3);
    body.writeUInt8((s >> 8) & 0xff, i * 3 + 1);
    body.writeUInt8((s >> 16) & 0xff, i * 3 + 2);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([riffHeader(body.length, fs, 24, false), body]));
  return file;
}

/** 32-bit float mono. */
export function writeWavFloat32(file, x, fs) {
  const body = Buffer.alloc(x.length * 4);
  for (let i = 0; i < x.length; i++) body.writeFloatLE(x[i], i * 4);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([riffHeader(body.length, fs, 32, true), body]));
  return file;
}
