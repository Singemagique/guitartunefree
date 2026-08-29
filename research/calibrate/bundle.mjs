/**
 * bundle.mjs — make the SHIPPED TypeScript modules runnable from Node.
 *
 * Nothing here re-implements the app. `src/audio/strum.ts` and
 * `src/audio/pitch.ts` are compiled with esbuild (already present as a vite
 * dependency — no npm install) and imported. Two artefacts come out:
 *
 *   strum.clean.mjs  the module exactly as it ships. Every number this pipeline
 *                    publishes about detection comes from here.
 *   strum.probe.mjs  the same bundle with SURGICAL, VERIFIED insertions that
 *                    only ADD exports and ADD fields to an internal record:
 *                      - export the internal `analyzeFrame`, `cachedFFT`,
 *                        `cachedHann`, `mad` (so the calibration can drive the
 *                        real per-frame estimator itself and know the frame
 *                        index),
 *                      - carry `sepBins` / `contamCents` on each partial record,
 *                      - call a probe hook at the end of `refine()` with the
 *                        per-partial evidence table.
 *                    Behaviour is unchanged with the hook unset, and
 *                    `selftest.mjs` PROVES it: clean vs probe must agree
 *                    bit-for-bit on every clip.
 *
 * Every insertion is anchored on a pattern that must match EXACTLY ONCE. If
 * strum.ts moves, this throws loudly rather than silently mis-instrumenting.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const OUT = join(HERE, '.build');
export const SRC_STRUM = join(REPO, 'src', 'audio', 'strum.ts');
export const SRC_PITCH = join(REPO, 'src', 'audio', 'pitch.ts');

function newest(...files) {
  let t = 0;
  for (const f of files) t = Math.max(t, statSync(f).mtimeMs);
  return t;
}

async function esbuildTransform(file) {
  const esbuild = await import('esbuild');
  const src = readFileSync(file, 'utf8');
  const r = await esbuild.transform(src, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
    sourcemap: false,
    // no minify, no name mangling: the probe patches read this text
  });
  if (/^\s*import\s/m.test(src)) {
    throw new Error(
      `${file} has grown imports; bundle.mjs assumes the audio modules are ` +
        'self-contained. Switch to esbuild.build({bundle:true}) and re-check the probe anchors.',
    );
  }
  return r.code;
}

/** Replace exactly once, or throw. */
function once(text, find, replace, what) {
  const parts = text.split(find);
  if (parts.length !== 2) {
    throw new Error(
      `probe anchor "${what}" matched ${parts.length - 1} times (want 1). ` +
        'src/audio/strum.ts changed shape — re-derive the patch in bundle.mjs.',
    );
  }
  return parts[0] + replace + parts[1];
}

const PROBE_PREAMBLE = `
/* ---- calibration probe (research/calibrate/bundle.mjs) — additive only ---- */
let __probeHook = null;
export function __setProbe(fn) { __probeHook = fn; }
`;

function makeProbe(clean) {
  let t = clean;

  // (1) carry the geometry that decides p.exclusive, and the contaminant
  //     distance, on the partial record. Additive field, no behaviour change.
  t = once(
    t,
    'exclusive: ca.sepBins >= o.clearBins\n      });',
    'exclusive: ca.sepBins >= o.clearBins,\n        sepBins: ca.sepBins,\n        contamCents: ca.dc\n      });',
    'Pt.exclusive',
  );

  // (2) hand the finished per-string evidence table to the hook. Placed AFTER
  //     the evidX loop and BEFORE the meanR bookkeeping, i.e. at the point the
  //     shipped code has finished deciding this string's evidence for this pass.
  t = once(
    t,
    '    cur.meanR = pts.reduce(',
    `    if (__probeHook) __probeHook({
    s, target: cur.target, f0: cur.f0, B: cur.B, resid: cur.resid,
    nGood: cur.nGood, evidX: cur.evidX, wsum: cur.wsum, noiseAmp, flr,
    partials: pts.map((p) => ({
      k: p.k, f: p.f, amp: p.amp, snr: p.snr, r: p.r, fused: p.fused,
      exclusive: p.exclusive, sepBins: p.sepBins, contamCents: p.contamCents,
      dev: Math.abs(toCents(Math.log(p.f / (p.k * fit.f0 * Math.sqrt(1 + fit.B * p.k * p.k))))),
    })),
  });
    cur.meanR = pts.reduce(`,
    'refine() tail',
  );

  // (3) expose the internals the calibration drives directly.
  t += `\nexport { analyzeFrame, cachedFFT, cachedHann, mad, noiseFloor, findPeaks, hannPeakOffset, defaultStarts, partialFreq, toCents, clamp01 };\n`;
  return PROBE_PREAMBLE + t;
}

/**
 * Build (or reuse) the three artefacts. Returns their file: URLs.
 * Rebuilds whenever a source file or this script is newer than the output.
 */
export async function buildAll({ force = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const clean = join(OUT, 'strum.clean.mjs');
  const probe = join(OUT, 'strum.probe.mjs');
  const pitch = join(OUT, 'pitch.mjs');
  const stale =
    force ||
    !existsSync(clean) ||
    !existsSync(probe) ||
    !existsSync(pitch) ||
    newest(SRC_STRUM, SRC_PITCH, join(HERE, 'bundle.mjs')) > newest(clean, probe, pitch);

  if (stale) {
    const strumJs = await esbuildTransform(SRC_STRUM);
    writeFileSync(clean, strumJs);
    writeFileSync(probe, makeProbe(strumJs));
    writeFileSync(pitch, await esbuildTransform(SRC_PITCH));
  }
  return {
    clean: pathToFileURL(clean).href,
    probe: pathToFileURL(probe).href,
    pitch: pathToFileURL(pitch).href,
    rebuilt: stale,
  };
}

let cached = null;
/** Import all three modules once per process. */
export async function loadModules(opts) {
  if (cached) return cached;
  const urls = await buildAll(opts);
  const [clean, probe, pitch] = await Promise.all([
    import(urls.clean),
    import(urls.probe),
    import(urls.pitch),
  ]);
  cached = { clean, probe, pitch, urls };
  return cached;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const u = await buildAll({ force: true });
  console.log('built:\n  ' + [u.clean, u.probe, u.pitch].join('\n  '));
  const m = await import(u.probe);
  console.log(
    'probe exports:',
    ['analyzeFrame', 'cachedFFT', 'cachedHann', 'mad', '__setProbe', 'analyzeStrumRaw', 'DEFAULTS']
      .map((k) => `${k}=${typeof m[k]}`)
      .join(' '),
  );
}
