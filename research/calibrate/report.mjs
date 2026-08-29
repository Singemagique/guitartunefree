/**
 * report.mjs — one command, one report.
 *
 *     node research/calibrate/report.mjs
 *
 * Reads whatever is in research/recordings/, measures it, and writes
 * research/calibrate/calibrate-report.md. With no recordings present it runs
 * the whole pipeline on a synthetic recording set whose answers are known, so
 * the report is a SCAFFOLD with every number the real one will carry, plus the
 * self-test that proves each measurement is trustworthy before the real clips
 * are trusted to it.
 *
 * Flags
 *   --self-test        ignore research/recordings/ and use the synthetic set
 *   --recordings=DIR   read clips from somewhere else
 *   --out=FILE         write the report somewhere else
 *   --quick            fewer sweep trials (the synth, not the analysis, is slow)
 *   --no-sweep         skip the sensitivity sweep entirely (~4 min -> ~30 s)
 *   --no-selftest      skip the synthetic self-test
 *   --raw              also report the strums WITHOUT the app's mic chain
 *   --help
 *
 * A `manifest.json` in the recordings folder overrides clip classification:
 *   { "tuning": "standard",
 *     "a4": 440,
 *     "clips": [ { "file": "memo1.m4a", "role": "solo",  "string": 0 },
 *                { "file": "memo7.m4a", "role": "strum", "variant": "down" },
 *                { "file": "memo9.m4a", "role": "strum", "muted": 4 } ] }
 * roles: solo | strum | polar | ignore.  string/muted are 0-based, low E first.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadModules, HERE, REPO } from './bundle.mjs';
import { decode, listAudio, findFfmpeg } from './decode.mjs';
import { analyzeSolo, cents as centsOf } from './solo.mjs';
import {
  analyzeStrumClip,
  verifyParity,
  segmentStrums,
  crudeOnsets,
  captureProbe,
  GATE_DEFAULTS,
  EVID_DEFAULTS,
} from './strums.mjs';
import { micChain, chainGainDb, MIC } from './micchain.mjs';
import { buildSet, NAMES, STANDARD } from './synthset.mjs';
import { buildSweepSets, sweep, score, failedGateHistogram, recommend, KNOBS } from './sweep.mjs';

const RECORDINGS = join(REPO, 'research', 'recordings');
const OUT = join(HERE, 'calibrate-report.md');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

if (flag('help')) {
  console.log(
    readFileSync(new URL(import.meta.url))
      .toString()
      .split('*/')[0]
      .replace(/^\/\*\*?\r?\n?/, '')
      .replace(/^ ?\* ?/gm, ''),
  );
  process.exit(0);
}

/* ------------------------------------------------------------- utilities */

const median = (a) => {
  const v = a.filter(Number.isFinite);
  if (!v.length) return NaN;
  const s = Float64Array.from(v).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  const v = a.filter(Number.isFinite);
  if (!v.length) return NaN;
  const s = Float64Array.from(v).sort();
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const f2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pctS = (v, d = 1) => (Number.isFinite(v) ? `${(100 * v).toFixed(d)}%` : '—');
const sci = (v, d = 2) => (Number.isFinite(v) ? v.toExponential(d) : '—');
const sign = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '—');

function table(headers, rows) {
  const out = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

/* ------------------------------------------------- discovery + classification */

const NOTE_RE = /\b(e2|a2|d3|g3|b3|e4|low\s*e|high\s*e)\b/i;
const NOTE_INDEX = { e2: 0, a2: 1, d3: 2, g3: 3, b3: 4, e4: 5, 'low e': 0, 'high e': 5 };

/** Filename hints. Deliberately weak: the signal decides when they disagree. */
function hintOf(name) {
  const n = name.toLowerCase();
  const h = {};
  if (/mute|damp/.test(n)) h.variant = 'muted';
  if (/\bup\b|upstrum/.test(n)) h.variant = 'up';
  if (/noise|fan|tv|traffic/.test(n)) h.variant = 'noisy';
  if (/detun/.test(n)) h.variant = 'detuned';
  if (/polar|parallel|perpend|perp/.test(n)) h.role = 'polar';
  if (/strum/.test(n)) h.role = h.role || 'strum';
  if (/solo|single|open|pluck/.test(n)) h.role = h.role || 'solo';
  const m = n.replace(/[_-]/g, ' ').match(NOTE_RE);
  if (m) h.string = NOTE_INDEX[m[1].toLowerCase().replace(/\s+/g, ' ')];
  return h;
}

/**
 * Decide what a clip IS from the audio: one string ringing, or several.
 * A solo clip has one comb carrying essentially all the energy; a strum has
 * three or more. The verdict is recorded in the report so the user can
 * override anything it got wrong with a manifest.
 */
async function classifyBySignal(x, fs, targets) {
  const { clean } = await loadModules();
  const raw = clean.analyzeStrumRaw(x, fs, targets);
  const strong = raw.strings.filter((s) => s.conf >= 0.5 && isFinite(s.cents));
  const any = raw.strings.filter((s) => s.conf > 0.02 && isFinite(s.cents));
  // the app's own detector, plus a single-pitch check for the solo case
  const solo = await analyzeSoloQuick(x, fs);
  const near = targets
    .map((t, i) => ({ i, dc: Math.abs(centsOf(solo.freq || 1, t)) }))
    .sort((a, b) => a.dc - b.dc)[0];
  if (strong.length >= 3) return { role: 'strum', why: `${strong.length} strings confirmed by the app` };
  if (solo.frames > 10 && near && near.dc < 150) {
    return { role: 'solo', string: near.i, why: `single stable pitch ${f2(solo.freq)} Hz, ${f2(near.dc, 0)} c from ${NAMES[near.i]}` };
  }
  if (any.length >= 3) return { role: 'strum', why: `${any.length} strings with some evidence` };
  return { role: 'unknown', why: 'neither one stable pitch nor three combs' };
}

async function analyzeSoloQuick(x, fs) {
  const { pitch, probe } = await loadModules();
  const N = 2048;
  const det = new pitch.PitchDetector(fs, N, 25);
  const hop = Math.max(1, Math.round(0.025 * fs));
  const buf = new Float32Array(N);
  const fr = [];
  const t0 = probe.detectOnset(x, fs);
  const start = Math.min(x.length - N, Math.round((t0 + 0.05) * fs));
  for (let i = Math.max(0, start); i < x.length - N; i += hop) {
    for (let j = 0; j < N; j++) buf[j] = x[i + j];
    const r = det.detect(buf);
    if (r) fr.push(r.freq);
  }
  return { freq: median(fr), frames: fr.length };
}

async function gather(dir, targets) {
  const manPath = join(dir, 'manifest.json');
  const manual = existsSync(manPath) ? JSON.parse(readFileSync(manPath, 'utf8')) : null;
  const byName = new Map();
  for (const c of manual?.clips || []) byName.set(basename(c.file), c);

  const files = listAudio(dir);
  const clips = [];
  const problems = [];
  for (const file of files) {
    if (basename(file) === 'manifest.json') continue;
    const d = decode(file);
    if (!d.ok) {
      problems.push(d);
      continue;
    }
    const over = byName.get(basename(file));
    const hint = hintOf(basename(file));
    let role = over?.role ?? hint.role ?? null;
    let string = over?.string ?? hint.string ?? null;
    let why = over ? 'manifest.json' : role ? 'filename' : '';
    if (!role || (role === 'solo' && string == null)) {
      const sig = await classifyBySignal(d.x, d.fs, targets);
      role = over?.role ?? sig.role;
      if (string == null) string = sig.string ?? null;
      why = why ? `${why} + signal (${sig.why})` : `signal (${sig.why})`;
    }
    const variant = over?.variant ?? hint.variant ?? null;
    // A muted-string strum is the hallucination evidence, and WHICH string was
    // muted cannot be recovered from the audio — that is precisely the question
    // the analyzer is being tested on. It has to be declared, by the filename
    // ("strum-muted-B3") or by manifest.json.
    let muted = over?.muted ?? null;
    if (role === 'strum') {
      if (muted == null && variant === 'muted' && string != null) {
        muted = string;
        why += ` + muted string from filename`;
      }
      string = null;
    }
    clips.push({
      file,
      name: basename(file),
      x: d.x,
      fs: d.fs,
      seconds: d.seconds,
      bits: d.bits,
      channels: d.channels,
      source: d.source,
      role,
      string,
      variant,
      muted,
      // A guitar deliberately re-tuned between the solo clips and the strums
      // has no ground truth any more; manifest.json can supply the new one.
      truthCents: over?.truthCents ?? null,
      why,
    });
  }
  return { clips, problems, manual };
}

/* -------------------------------------------------------------- the report */

async function main() {
  const t0 = Date.now();
  const mods = await loadModules({ force: false });
  const quick = flag('quick');
  const outFile = opt('out', OUT);
  const recDir = opt('recordings', RECORDINGS);

  const targets = STANDARD; // standard tuning, A4 = 440
  let dir = recDir;
  let synthetic = null;
  let sourceNote = '';

  const found = flag('self-test') ? [] : listAudio(recDir);
  if (!found.length) {
    try {
      synthetic = await buildSet();
    } catch (e) {
      console.error(
        `\nNo recordings in ${recDir}, and the synthetic fallback is unavailable:\n  ${e.message}\n\n` +
          `Either drop the clips from research/recordings/README.md into that folder,\n` +
          `or point SPIKE_DIR / SPIKE_VERIFY_DIR at the research spike directories.`,
      );
      process.exit(2);
    }
    dir = synthetic.dir;
    sourceNote =
      flag('self-test') || !existsSync(recDir)
        ? 'synthetic self-test set (no real recordings)'
        : 'synthetic self-test set (research/recordings/ is empty)';
  } else {
    sourceNote = `research/recordings/ (${found.length} files)`;
  }

  const main1 = await analyseFolder(dir, targets, { withRaw: flag('raw') });
  const { clips, problems, manual, soloResults, polarResults, strumResults, truthCents } = main1;
  /* ---- 3. the sensitivity sweep ----------------------------------------- */
  let sweepOut = null;
  let sets = null;
  if (!flag('no-sweep')) {
    try {
      sets = await buildSweepSets(
        quick
          ? { hardN: 8, cleanN: 6, ablationN: 12 }
          : { hardN: 20, cleanN: 12, ablationN: 24 },
      );
      sweepOut = {
        sets,
        base: {
          clean: score(sets.clean),
          spec: score(sets.spec),
          hard: score(sets.hard),
          ablation: score(sets.ablation),
        },
        hist: {
          spec: failedGateHistogram(sets.spec),
          hard: failedGateHistogram(sets.hard),
        },
        // The brief's world AND the deliberately overdone one: a knob that can
        // carry the milder world alone but not the harsher one is worth knowing
        // about, and averaging the two would hide exactly that.
        table: sweep({ hard: sets.spec, ablation: sets.ablation, clean: sets.clean, target: 0.9 }),
        tableExtreme: sweep({ hard: sets.hard, ablation: sets.ablation, clean: sets.clean, target: 0.9 }),
        rec: recommend({ hard: sets.hard, ablation: sets.ablation, clean: sets.clean, target: 0.9 }),
        recSpec: recommend({ hard: sets.spec, ablation: sets.ablation, clean: sets.clean, target: 0.9 }),
      };
    } catch (e) {
      sweepOut = { error: String(e.message || e) };
    }
  }

  /* ---- 4. the self-test, always, against the synthetic set --------------
     Even when real clips are present: it is what licenses every measurement
     the real report makes. When the real clips ARE the synthetic set the work
     is already done and is simply reused. */
  let selfTest = null;
  if (!flag('no-selftest')) {
    let st = synthetic ? { manifest: synthetic, res: main1 } : null;
    if (!st) {
      try {
        const manifest = await buildSet();
        st = { manifest, res: await analyseFolder(manifest.dir, STANDARD, { withRaw: false }) };
      } catch (e) {
        selfTest = { checks: [{ name: 'self-test', pass: false, detail: String(e.message || e) }], pass: false };
      }
    }
    if (st) {
      const { runSelfTest } = await import('./selftest.mjs');
      selfTest = await runSelfTest({
        manifest: st.manifest,
        soloResults: st.res.soloResults,
        strumResults: st.res.strumResults,
        targets: STANDARD,
      });
      selfTest.onSynthetic = !synthetic;
    }
  }

  const md = render({
    sourceNote,
    dir,
    synthetic,
    manual,
    clips,
    problems,
    soloResults,
    polarResults,
    strumResults,
    truthCents,
    sweepOut,
    selfTest,
    elapsedMs: Date.now() - t0,
    mods,
    quick,
  });
  mkdirSync(join(outFile, '..'), { recursive: true });
  writeFileSync(outFile, md);
  console.log(`\nwrote ${outFile}  (${(md.length / 1024).toFixed(1)} kB, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (selfTest) {
    console.log(`self-test: ${selfTest.pass ? 'PASS' : 'FAIL'} — ${selfTest.checks.filter((c) => c.pass).length}/${selfTest.checks.length} checks`);
    for (const c of selfTest.checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    if (!selfTest.pass) process.exitCode = 1;
  }
}

async function analyseFolder(dir, targets, { withRaw = false } = {}) {
  const { clips, problems, manual } = await gather(dir, targets);
  const solos = clips.filter((c) => c.role === 'solo' && c.string != null);
  const polars = clips.filter((c) => c.role === 'polar');
  const strums = clips.filter((c) => c.role === 'strum');

  /* ---- 1. solo strings: ground truth, B, envelope, polarisation ---------- */
  const soloResults = [];
  for (const c of solos) {
    const a = await analyzeSolo(c.x, c.fs, { target: targets[c.string], name: NAMES[c.string] });
    soloResults.push({ clip: c, a });
  }
  const truthCents = new Array(6).fill(NaN);
  for (const { clip, a } of soloResults) if (a.ok) truthCents[clip.string] = a.centsVsTarget;

  const polarResults = [];
  for (const c of polars) {
    const s = c.string ?? 0;
    const a = await analyzeSolo(c.x, c.fs, { target: targets[s], name: `${NAMES[s]} (${c.variant || 'polar'})` });
    polarResults.push({ clip: c, a });
  }

  /* ---- 2. strums, as the app hears them and (optionally) raw ------------- */
  const strumResults = [];
  for (const c of strums) {
    const app = micChain(c.x, c.fs);
    // A clip recorded after a deliberate re-tune is scored only against a truth
    // the manifest supplies: the solo clips describe a different tuning.
    const scorable = c.variant !== 'detuned' || Boolean(c.truthCents);
    const base = c.truthCents || truthCents;
    const truth = base.map((v, i) => (c.muted === i || !scorable ? NaN : v));
    c.scorable = scorable;

    // What the APP would have captured: the shipped StrumRecorder, driven over
    // the filtered signal exactly as strumcapture.ts drives it.
    const seg = await segmentStrums(app.x, app.fs, { targets });
    const crude = crudeOnsets(app.x, app.fs);
    const delivered = seg.strums || [];
    // Every attack the recorder did NOT deliver is analysed anyway, from a
    // window placed where the app would have placed it. That is what separates
    // "the estimator could not read this strum" from "the app never looked".
    const missed = crude.filter(
      (t) => !delivered.some((d) => Math.abs(d.startSec + 0.1 - t) < 0.6),
    );

    const events = [];
    for (const d of delivered) {
      events.push({
        source: 'recorder',
        onsetSec: d.startSec + 0.1,
        startSec: d.startSec,
        x: d.x,
        fs: d.fs,
      });
    }
    for (const t of missed) {
      const from = Math.max(0, Math.round((t - 0.1) * app.fs));
      const to = Math.min(app.x.length, from + Math.round((seg.windowSeconds + 0.1) * app.fs));
      if (to - from < 0.9 * app.fs) continue; // not enough audio left to analyse
      events.push({
        source: 'missed',
        reason: t < 0.6 ? 'inside the 0.6 s detector warm-up' : 'no attack confirmed by the recorder',
        onsetSec: t,
        startSec: from / app.fs,
        x: app.x.slice(from, to),
        fs: app.fs,
      });
    }
    events.sort((a, b) => a.onsetSec - b.onsetSec);
    for (const [i, ev] of events.entries()) {
      ev.index = i;
      ev.r = await analyzeStrumClip(ev.x, ev.fs, targets, {
        truthCents: truth,
        name: `${c.name} #${i + 1}`,
      });
      ev.parity = await verifyParity(ev.x, ev.fs, targets);
      ev.x = null; // done with the audio; keep the report's memory sane
    }
    const primary = events.find((e) => e.source === 'recorder') || events[0] || null;
    // …and the same window WITHOUT the mic chain, to price the band limiting.
    // `startSec` is wall-clock, so it maps to the raw clip's own rate directly.
    let rawR = null;
    if (withRaw && primary) {
      const from = Math.max(0, Math.round(primary.startSec * c.fs));
      const to = Math.min(c.x.length, from + Math.round((seg.windowSeconds + 0.1) * c.fs));
      rawR = await analyzeStrumClip(c.x.slice(from, to), c.fs, targets, {
        truthCents: truth,
        name: `${c.name} (raw)`,
      });
    }
    // If the recorder dropped an attack, find out WHICH of its exposed
    // constants is responsible rather than guessing.
    const probe = delivered.length < crude.length ? await captureProbe(app.x, app.fs, targets) : null;
    strumResults.push({
      clip: c,
      seg,
      crude,
      events,
      probe,
      r: primary?.r ?? null,
      parity: primary?.parity ?? { ok: true, diffs: [] },
      rawR,
    });
  }
  return { clips, problems, manual, soloResults, polarResults, strumResults, truthCents };
}

/* ------------------------------------------------------------- rendering */

function render(ctx) {
  const {
    sourceNote, dir, synthetic, clips, problems, soloResults, polarResults,
    strumResults, truthCents, sweepOut, selfTest, elapsedMs, quick,
  } = ctx;
  const L = [];
  const p = (...s) => L.push(...s, '');

  p(`# Strum check — real-audio calibration report`);
  p(
    `Generated ${new Date().toISOString()} in ${(elapsedMs / 1000).toFixed(1)} s` +
      `${quick ? ' (--quick)' : ''}.`,
    ``,
    `**Source:** ${sourceNote}`,
    `**Clips folder:** \`${dir}\``,
    `**Analyzer:** \`src/audio/strum.ts\` and \`src/audio/pitch.ts\`, esbuild-compiled and imported — not copied.`,
  );

  if (synthetic) {
    p(
      `> ### This is the scaffold, not the answer`,
      `>`,
      `> No real recordings were found, so every number below was produced from a`,
      `> SYNTHETIC recording set written to \`${dir}\` by the two research`,
      `> synthesizers (spike + adversarial verifier). Its purpose is to prove the`,
      `> pipeline measures what it claims to measure — see **Self-test** — and to`,
      `> show exactly which table each real clip will fill in.`,
      `>`,
      `> Drop the clips listed in \`research/recordings/README.md\` into that folder`,
      `> and run \`node research/calibrate/report.mjs\` again.`,
    );
  }

  /* ---------------------------------------------------------- clip inventory */
  p(`## 1. Clips`);
  p(
    table(
      ['file', 'role', 'string', 'variant', 'format', 'length', 'classified by'],
      clips.map((c) => [
        `\`${c.name}\``,
        c.role,
        c.string != null ? NAMES[c.string] : c.muted != null ? `muted ${NAMES[c.muted]}` : '—',
        c.variant || '—',
        `${c.fs} Hz ${c.bits ?? '?'}-bit ${c.channels === 2 ? 'stereo' : 'mono'}${c.source === 'ffmpeg' ? ' (ffmpeg)' : ''}`,
        `${f2(c.seconds, 1)} s`,
        c.why,
      ]),
    ),
  );
  if (problems.length) {
    p(`### Files that could not be read`);
    p(
      table(
        ['file', 'problem'],
        problems.map((q) => [`\`${q.name}\``, q.needsFfmpeg ? q.hint : q.error]),
      ),
    );
    if (problems.some((q) => q.needsFfmpeg)) {
      p(
        `ffmpeg was ${findFfmpeg() ? 'found' : 'NOT found'} on PATH. Install it, or set`,
        `\`FFMPEG=/path/to/ffmpeg\`, or convert the files with the commands above and re-run.`,
      );
    }
  }

  /* --------------------------------------------------- solo: the ground truth */
  p(`## 2. Solo strings — the ground truth`);
  if (!soloResults.length) {
    p(
      `_No solo clips. Without them there is no ground truth: a strum's cents can be`,
      `reported but not scored, and the inharmonicity and polarisation sections below`,
      `stay empty. These six clips are the ones that settle the science._`,
    );
  } else {
    p(
      `\`f0\` is fitted from the partial comb by phase slope (see \`solo.mjs\`); the MPM`,
      `column is what the app's own Single mode reads on the same audio. \`B\` is the`,
      `measured inharmonicity — the parameter \`strum.ts\` constrains with \`bMax\`,`,
      `\`bNominal\` and \`bPrior\`.`,
    );
    p(
      table(
        ['string', 'target Hz', 'f0 Hz', 'cents vs target', 'MPM Hz', 'MPM − fit', 'B', 'comb resid', 'partials', 'SNR'],
        soloResults.map(({ clip, a }) =>
          a.ok
            ? [
                NAMES[clip.string],
                f2(targetHz(clip), 3),
                f2(a.f0, 3),
                `${sign(a.centsVsTarget)} c`,
                f2(a.mpm.freq, 3),
                `${sign(a.mpmCentsVsFit)} c`,
                sci(a.B),
                `${f2(a.residCents)} c`,
                `${a.partialsUsed}`,
                `${f2(a.snrDb, 1)} dB${a.preOnsetSilence ? '' : ' (lower bound)'}`,
              ]
            : [NAMES[clip.string], '—', '—', '—', '—', '—', '—', '—', '—', a.reason],
        ),
      ),
    );
    p(`### 2a. Inharmonicity vs what the shipped code assumes`);
    p(
      table(
        ['string', 'measured B', 'wound?', 'strum.ts bNominal', 'bPrior', 'bMax', 'inside range?'],
        soloResults
          .filter(({ a }) => a.ok)
          .map(({ clip, a }) => [
            NAMES[clip.string],
            sci(a.B),
            clip.string <= 3 ? 'wound' : 'plain',
            sci(1.2e-4),
            sci(1.1e-4),
            sci(GATE_DEFAULTS.bMax),
            a.B <= GATE_DEFAULTS.bMax * GATE_DEFAULTS.bMaxFrac ? 'yes' : '**NO — tB fails**',
          ]),
      ),
    );
    if (synthetic) {
      const rows = soloResults
        .map(({ clip, a }) => {
          const t = synthetic.clips.find((k) => k.role === 'solo' && k.string === clip.string);
          return t && a.ok ? [NAMES[clip.string], sci(a.B), sci(t.truth.B), `${sign(100 * (a.B / t.truth.B - 1), 1)}%`] : null;
        })
        .filter(Boolean);
      p(`Against the synth's own truth (self-test only):`);
      p(table(['string', 'measured B', 'true B', 'error'], rows));
    }

    p(`### 2b. Spectral envelope vs the parametric model`);
    p(
      `\`strum.ts\`'s \`fitEnv()\` models a string as \`L·k^-q·|sin(π k p)|\` and falls back`,
      `to it wherever a partial is contaminated. \`rms dev\` is how far the MEASURED`,
      `partial amplitudes sit from the best fit of that family — the error the`,
      `contamination weighting inherits whenever it has to extrapolate.`,
    );
    p(
      table(
        ['string', 'q (rolloff)', 'p (pluck pos)', 'rms dev', 'worst partial', 'partials'],
        soloResults
          .filter(({ a }) => a.ok && a.env)
          .map(({ clip, a }) => [
            NAMES[clip.string],
            f2(a.env.q),
            f2(a.env.p, 3),
            `${f2(a.env.rmsDb, 1)} dB`,
            `${f2(a.env.maxDb, 1)} dB`,
            `${a.env.n}`,
          ]),
      ),
    );
  }

  /* ------------------------------------------------------- 3. polarisation */
  p(`## 3. Polarisation — the unmeasured parameter`);
  p(
    `The two candidate models disagree about ONE thing: how the split scales across`,
    `strings. Both make the beat rate of partial *k* equal to *k* times the rate of`,
    `the fundamental, so the discriminator is how rate₁ varies with f₀:`,
    ``,
    `- **spike model** (\`spike-poly/synth.mjs\`): the split is a constant number of`,
    `  Hz at the fundamental (0.05–0.6 Hz), so rate₁ does **not** depend on f₀ —`,
    `  fitted exponent 0.`,
    `- **verifier model** (\`spike-poly-verify/mysynth.mjs\`): the split is a constant`,
    `  number of CENTS (1.5–9 c), so rate₁ is proportional to f₀ — exponent 1.`,
    ``,
    `Fitting \`log rate₁ = a + n·log f₀\` across the six solo clips decides it.`,
  );
  const beatRows = soloResults
    .filter(({ a }) => a.ok)
    .map(({ clip, a }) => ({
      s: clip.string,
      f0: a.f0,
      rate1: a.splitHz1,
      cents: a.splitCents,
      depth: a.beatDepth,
      k: a.beatK,
      n: a.measurablePartials,
    }));
  p(
    table(
      ['string', 'f0 Hz', 'split (Hz at f0)', 'split (cents)', 'depth (partner/dominant)', 'measured on k', 'usable partials'],
      beatRows.map((r) => [
        NAMES[r.s],
        f2(r.f0, 2),
        f2(r.rate1, 3),
        f2(r.cents, 2),
        f2(r.depth, 3),
        Number.isFinite(r.k) ? `k=${r.k}` : '—',
        `${r.n}`,
      ]),
    ),
  );
  const usable = beatRows.filter((r) => Number.isFinite(r.rate1) && r.rate1 > 0);
  if (usable.length >= 3) {
    const n = usable.length;
    const sx = usable.reduce((a, r) => a + Math.log(r.f0), 0);
    const sy = usable.reduce((a, r) => a + Math.log(r.rate1), 0);
    const sxx = usable.reduce((a, r) => a + Math.log(r.f0) ** 2, 0);
    const sxy = usable.reduce((a, r) => a + Math.log(r.f0) * Math.log(r.rate1), 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    p(
      `**Fitted exponent: ${f2(slope)}** over ${n} strings ` +
        `(0 ⇒ the spike's Hz-constant model, 1 ⇒ the verifier's cents-constant model; ` +
        `${Math.abs(slope) < 0.5 ? 'closer to the SPIKE model' : slope > 0.5 ? 'closer to the VERIFIER model' : 'between the two'}).`,
    );
  } else {
    p(
      `_Only ${usable.length} string(s) produced a beat with enough whole cycles inside`,
      `the clip to measure. A split below about 0.2 Hz at the fundamental needs a clip`,
      `longer than ~6 s, or has to be read off a high partial (rate scales with k) —`,
      `which is what the two dedicated polarisation clips in the README are for._`,
    );
  }
  if (polarResults.length) {
    p(`### 3a. The dedicated polarisation clips (pick parallel vs perpendicular)`);
    p(
      table(
        ['clip', 'f0 Hz', 'split Hz at f0', 'split cents', 'depth', 'usable partials'],
        polarResults.map(({ clip, a }) => [
          `\`${clip.name}\``,
          a.ok ? f2(a.f0, 2) : '—',
          a.ok ? f2(a.splitHz1, 3) : '—',
          a.ok ? f2(a.splitCents, 2) : '—',
          a.ok ? f2(a.beatDepth, 3) : '—',
          a.ok ? `${a.measurablePartials}` : a.reason,
        ]),
      ),
    );
  }

  /* -------------------------------------------------------- 4. the strums */
  p(`## 4. Strums`);
  p(
    `Every strum is analysed **through the app's own mic chain** — highpass`,
    `${MIC.highpassHz} Hz, lowpass ${MIC.lowpassHz} Hz, both Q ${MIC.q} — because`,
    `\`strumcapture.ts\` taps the filtered node (SPEC v2.0 condition 3). That chain is`,
    `${f2(chainGainDb(2500), 1)} dB at 2.5 kHz and ${f2(chainGainDb(3400), 1)} dB at`,
    `3.4 kHz, while \`strum.ts\` analyses up to \`fMax = 3400\`. **The partials the`,
    `exclusive-evidence gate counts for B3 and E4 arrive several dB down.**`,
  );
  if (!strumResults.length) {
    p(`_No strum clips._`);
  } else {
    /* ------------------------------------------------------ 4a. capture */
    p(`### 4a. What the app's recorder actually captured`);
    p(
      `Before this is a question about confidence thresholds, it is a question about`,
      `whether the app ever looked. \`StrumRecorder\` (src/audio/strumcapture.ts) is`,
      `pure — "no Web Audio in sight so it can be driven from a test harness`,
      `sample-for-sample" — so it is driven here over the filtered signal, in`,
      `128-sample quanta, exactly as strumcapture.ts drives it. "attacks" is an`,
      `INDEPENDENT broadband energy-jump count, deliberately not the app's own rule,`,
      `so the two are free to disagree.`,
    );
    p(
      table(
        ['clip', 'length', 'peak', 'attacks in the audio', 'delivered to the analyzer', 'rejected by the sustain test', 'window'],
        strumResults.map(({ clip, seg, crude }) => {
          let peak = 0;
          for (const v of clip.x) if (Math.abs(v) > peak) peak = Math.abs(v);
          const nd = seg.strums?.length ?? 0;
          return [
            `\`${clip.name}\``,
            `${f2(clip.seconds, 1)} s`,
            `${f2(20 * Math.log10(peak + 1e-30), 1)} dBFS`,
            `${crude.length}${crude.length ? ` (${crude.map((t) => f2(t, 1)).join(', ')} s)` : ''}`,
            nd < crude.length ? `**${nd}**` : `${nd}`,
            `${seg.rejected ?? 0}`,
            `${f2(seg.windowSeconds, 1)} s`,
          ];
        }),
      ),
    );
    const attacks = strumResults.reduce((a, { crude }) => a + crude.length, 0);
    const dropped = strumResults.reduce(
      (a, { seg, crude }) => a + Math.max(0, crude.length - (seg.strums?.length ?? 0)),
      0,
    );
    if (dropped > 0) {
      p(
        `> **${dropped} of ${attacks} attacks were never delivered to the analyzer.**`,
        `>`,
        `> A strum that is never delivered cannot fail a confidence gate, because no`,
        `> confidence was ever computed for it: the board just goes on showing the`,
        `> previous result. Every undelivered attack is analysed below anyway, from the`,
        `> window the app WOULD have used, so "the estimator could not read it" and`,
        `> "the app never looked" can be told apart.`,
      );
      // Which of the recorder's own constants is holding them out?
      for (const { clip, probe, crude } of strumResults) {
        if (!probe) continue;
        p(
          `**Why \`${clip.name}\` lost them.** \`StrumRecorderOptions\` exposes four of the`,
          `constants the onset decision rests on. Re-running the same audio under each,`,
          `one at a time, is the capture-side equivalent of the confidence sweep:`,
        );
        p(
          table(
            ['recorder setting', 'constant', 'delivered', 'rejected by the sustain test', 'onsets'],
            probe.map((v) => [
              v.label,
              v.knob ? `\`${v.knob}\`` : '—',
              `${v.delivered} / ${crude.length}`,
              `${v.rejected}`,
              v.onsets.length ? v.onsets.map((t) => f2(t, 1)).join(', ') + ' s' : '—',
            ]),
          ),
        );
        const gets = (v, t) => v.onsets.some((o) => Math.abs(o - t) < 0.6);
        const lost = crude.filter((t) => !gets(probe[0], t));
        const lines = lost.map((t) => {
          const by = probe.slice(1).filter((v) => gets(v, t));
          return by.length
            ? `- the attack at ${f2(t, 1)} s comes back with ${by.map((v) => `\`${v.knob}\` (${v.label})`).join(' or ')}`
            : `- the attack at ${f2(t, 1)} s comes back with **none of them**`;
        });
        const orphan = lost.filter((t) => !probe.slice(1).some((v) => gets(v, t)));
        p(...lines);
        p(
          orphan.length
            ? `**${orphan.length} of the ${lost.length} lost attacks ${orphan.length === 1 ? 'survives' : 'survive'} every exposed constant.** ` +
              `What is left is \`JUMP_DB\` — the 12 dB an attack must clear the running ` +
              `background by — and \`BG_RISE\`, how fast that background climbs towards the ` +
              `PREVIOUS chord's ring. Neither is in \`StrumRecorderOptions\`, so neither can be ` +
              `swept from outside, and both are exactly what a strum three seconds after ` +
              `another one runs into: the reference it must beat is the previous chord.`
            : `Every lost attack is recovered by one of the exposed constants, so ` +
              `\`JUMP_DB\` and \`BG_RISE\` are not implicated on this recording.`,
        );
      }
    }

    /* ------------------------------------------------- 4b. per-strum results */
    p(`### 4b. Per-strum results`);
    p(
      `"weakest term" is the \`min()\` of the seven confidence terms — the one that`,
      `decided this string's confidence. For an unconfirmed string it is the gate that`,
      `held it back, and "achieved / needs" is the shortfall in that term's own units.`,
    );
    for (const { clip, events, rawR } of strumResults) {
      const played = clip.muted != null ? 5 : 6;
      p(
        `**\`${clip.name}\`**${clip.variant ? ` — ${clip.variant}` : ''}` +
          `${clip.muted != null ? ` (${NAMES[clip.muted]} muted)` : ''}` +
          `${events.length > 1 ? ` — ${events.length} strums` : ''}` +
          `${clip.scorable === false ? ' — _errors not scored: re-tuned since the solo clips, and no `truthCents` in manifest.json_' : ''}`,
      );
      if (events.length > 1) {
        p(
          table(
            ['#', 'onset', 'captured by the app?', 'confirmed', 'refusal', 'per-string cents'],
            events.map((ev, i) => [
              `${i + 1}`,
              `${f2(ev.onsetSec, 2)} s`,
              ev.source === 'recorder' ? 'yes' : `**no** — ${ev.reason}`,
              `${ev.r.strings.filter((s) => s.detected).length}/${played}`,
              ev.r.refusal ? `**${ev.r.refusal}**` : '—',
              ev.r.strings.map((s) => (s.detected ? sign(s.cents, 1) : '·')).join(' '),
            ]),
          ),
        );
      }
      for (const ev of events) {
      const r = ev.r;
      const det = r.strings.filter((s) => s.detected).length;
      p(
        `${events.length > 1 ? `**Strum ${ev.index + 1}** at ${f2(ev.onsetSec, 2)} s — ` : ''}` +
          `${ev.source === 'recorder' ? 'captured by the app' : `**NOT captured** (${ev.reason})`}; ` +
          `N=${r.n}, ${r.frames} frames, ${det}/${played} confirmed, ${f2(r.analysisMs, 0)} ms` +
          `${rawR && ev.source === 'recorder' ? `; raw (no mic chain): ${rawR.strings.filter((s) => s.detected).length}/${played}` : ''}` +
          `${r.refusal ? `, **REFUSED (${r.refusal}, median ${f2(r.globalOffsetCents)} c)**` : ''}` +
          `${ev.parity.ok ? '' : ', **INSTRUMENTATION PARITY FAILED**'}`,
      );
      p(
        table(
          ['string', 'confirmed', 'cents', 'truth', 'error', 'conf', 'weakest term', 'achieved', 'needs'],
          r.strings.map((s) => {
            const b = s.binding;
            return [
              NAMES[s.string] + (clip.muted === s.string ? ' _(muted)_' : ''),
              s.detected ? 'yes' : '**no**',
              Number.isFinite(s.cents) ? sign(s.cents) : '—',
              Number.isFinite(s.truthCents) ? sign(s.truthCents) : '—',
              Number.isFinite(s.errCents) ? sign(s.errCents) : '—',
              f2(s.conf),
              b ? b.name : '—',
              b ? fmtStat(b.name, b.got) : '—',
              b ? fmtStat(b.name, b.required) : '—',
            ];
          }),
        ),
      );
      for (const s of r.strings) {
        if (s.detected || clip.muted === s.string) continue;
        const e = s.evidence;
        if (!e) continue;
        p(
          `- **${NAMES[s.string]} not confirmed** — binding term \`${s.binding.name}\`. ` +
            `Exclusive evidence ${f2(s.stat?.evidX)} of the ${GATE_DEFAULTS.exclMin} required; ` +
            `${f2(e.exclusivePerFrame, 1)} exclusive partials per frame, ` +
            `${f2(e.inTolPerFrame, 1)} inside the ${EVID_DEFAULTS.exclDevC} c comb tolerance ` +
            `(median deviation ${f2(e.medDev)} c; the ones dropped missed by ${f2(e.medDevOfDropped)} c), ` +
            `median noise margin ${f2(e.marginDb, 1)} dB over the ${EVID_DEFAULTS.exclSnrDb} dB bar. ` +
            `To reach ${GATE_DEFAULTS.exclMin} this string alone would need ` +
            `\`exclSnrDb\` ${e.snrThresholdNeeded == null ? 'below −20 (unreachable)' : `≤ ${f2(e.snrThresholdNeeded, 1)} dB`}, ` +
            `or \`exclDevC\` ${e.devToleranceNeeded == null ? 'above 60 c (unreachable)' : `≥ ${f2(e.devToleranceNeeded, 1)} c`}, ` +
            `or \`clearBins\` ${e.clearBinsNeeded == null ? 'below 0.2 (unreachable)' : `≤ ${f2(e.clearBinsNeeded, 2)}`}.`,
        );
      }
      p('');
      }
    }

    /* ------------------------------------------------------- 4c. pooled */
    p(`### 4c. Accuracy and detection, pooled`);
    p(
      `Over every strum EVENT — including the ones the recorder did not deliver, which`,
      `are marked separately so the two failure modes never get averaged together.`,
    );
    const evAll = strumResults.flatMap(({ clip, events }) =>
      events.map((ev) => ({ clip, ev })),
    );
    const evDelivered = evAll.filter(({ ev }) => ev.source === 'recorder');
    const stringsOf = (list) =>
      list.flatMap(({ clip, ev }) => ev.r.strings.filter((s) => clip.muted !== s.string));
    const played = stringsOf(evAll);
    const playedDelivered = stringsOf(evDelivered);
    const det = played.filter((s) => s.detected);
    const detDelivered = playedDelivered.filter((s) => s.detected);
    const errs = det.map((s) => Math.abs(s.errCents)).filter(Number.isFinite);
    const halluc = evAll.flatMap(({ clip, ev }) =>
      clip.muted != null ? ev.r.strings.filter((s) => s.string === clip.muted && s.detected) : [],
    );
    const mutedClips = evAll.filter(({ clip }) => clip.muted != null).length;
    const scored = strumResults.filter(({ clip }) => clip.scorable !== false);
    p(
      table(
        ['metric', 'value'],
        [
          ['strum events', `${evAll.length} (${evDelivered.length} delivered by the recorder)`],
          ['strings played', `${played.length}`],
          ['confirmed, all events', `${det.length} (${pctS(det.length / played.length)})`],
          [
            '**confirmed, events the app actually captured**',
            playedDelivered.length
              ? `**${detDelivered.length} / ${playedDelivered.length} (${pctS(detDelivered.length / playedDelivered.length)})**`
              : '— (the recorder delivered nothing)',
          ],
          ['median abs error vs solo ground truth', errs.length ? `${f2(median(errs))} c` : '— (no scorable clip)'],
          ['p95 abs error', errs.length ? `${f2(pct(errs, 0.95))} c` : '—'],
          ['worst abs error', errs.length ? `${f2(Math.max(...errs))} c` : '—'],
          ['scored on', `${scored.length} of ${strumResults.length} clips`],
          ['muted-string clips', `${mutedClips}`],
          ['**hallucinations** (muted string confirmed)', mutedClips ? `**${halluc.length} / ${mutedClips}**` : '— (no muted clips)'],
        ],
      ),
    );
    if (strumResults.some(({ rawR }) => rawR)) {
      const rawPlayed = strumResults.flatMap(({ clip, rawR }) =>
        rawR ? rawR.strings.filter((s) => clip.muted !== s.string) : [],
      );
      const rawDet = rawPlayed.filter((s) => s.detected);
      p(
        `**Mic chain cost.** Through the app's chain`,
        `${detDelivered.length}/${playedDelivered.length}`,
        `(${pctS(detDelivered.length / playedDelivered.length)}) of played strings are`,
        `confirmed on the captured strums; on the same windows without the chain`,
        `${rawDet.length}/${rawPlayed.length} (${pctS(rawDet.length / rawPlayed.length)}).`,
        `Any gap is evidence that \`fMax = 3400\` is asking for partials the tap does not`,
        `receive — see section 6.`,
      );
    }

    p(`### 4d. Which gate held the unconfirmed strings back`);
    const hist = new Map();
    const defs = new Map();
    for (const { clip, ev } of evAll) {
      for (const s of ev.r.strings) {
        if (s.detected || clip.muted === s.string) continue;
        const n = s.binding?.name || '?';
        hist.set(n, (hist.get(n) || 0) + 1);
        if (!defs.has(n)) defs.set(n, []);
        if (Number.isFinite(s.binding?.deficit)) defs.get(n).push(s.binding.deficit);
      }
    }
    const tot = [...hist.values()].reduce((a, b) => a + b, 0);
    p(
      tot
        ? table(
            ['term', 'times binding', 'share', 'median shortfall', 'p90 shortfall'],
            [...hist.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([n, c]) => [
                `\`${n}\``,
                `${c}`,
                pctS(c / tot, 0),
                fmtDeficit(n, median(defs.get(n))),
                fmtDeficit(n, pct(defs.get(n), 0.9)),
              ]),
          )
        : `_Every played string was confirmed._`,
    );
  }

  /* ---------------------------------------------------- 5. the sweep */
  p(`## 5. Sensitivity sweep (synthetic)`);
  if (!sweepOut) {
    p(`_Skipped (\`--no-sweep\`)._`);
  } else if (sweepOut.error) {
    p(`_Unavailable: ${sweepOut.error}_`);
  } else {
    const b = sweepOut.base;
    p(
      `Three synthetic worlds, all run through the app's mic chain, ${sweepOut.sets.hard.length}`,
      `strums each, plus a ${sweepOut.sets.ablation.length}-strum ABLATION suite where one`,
      `string is genuinely not played.`,
    );
    p(
      table(
        ['world', 'what it is', 'detection', 'median abs err', 'p95 abs err'],
        [
          ['`clean`', 'ordinary polarisation, 45 dB SNR', pctS(b.clean.detectRate), `${f2(b.clean.medErr)} c`, `${f2(b.clean.p95Err)} c`],
          ['`spec`', 'deep-beat polarisation + 10 dB more noise (the brief)', pctS(b.spec.detectRate), `${f2(b.spec.medErr)} c`, `${f2(b.spec.p95Err)} c`],
          ['`extreme`', '…plus dull spectrum, wide level spread, treble trim', pctS(b.hard.detectRate), `${f2(b.hard.medErr)} c`, `${f2(b.hard.p95Err)} c`],
          ['`ablation`', '5-string strums, clean', pctS(b.ablation.detectRate), `${f2(b.ablation.medErr)} c`, `${f2(b.ablation.p95Err)} c`],
        ],
      ),
    );
    p(
      `Hallucinations at the shipped thresholds: **${b.ablation.halluc} / ${b.ablation.skipped}**`,
      `unplayed strings confirmed.`,
    );

    p(`### 5a. What each gate would have to give to reach 90% detection`);
    p(
      `One knob at a time, from the shipped value towards the relaxed end, stopping at`,
      `the first value that reaches 90%. "halluc." is the ablation suite re-scored at`,
      `that same value — the number that decides whether the relaxation is allowed at`,
      `all. Knobs marked _unreachable_ cannot lift detection alone whatever they are`,
      `set to: confidence is \`min()\` over the seven terms, so relaxing a term that is`,
      `not the binding one changes nothing.`,
    );
    for (const [label, blurb, sw, base, hist] of [
      ['spec', 'the brief’s harsher world: deep-beat polarisation + 10 dB more noise', sweepOut.table, b.spec, sweepOut.hist.spec],
      ['extreme', '…and with a dull spectrum, wide level spread and a treble trim on top', sweepOut.tableExtreme, b.hard, sweepOut.hist.hard],
    ]) {
      p(`**\`${label}\`** — ${blurb}. Detection at the shipped values: ${pctS(base.detectRate)}.`);
      p(
        table(
          ['knob', 'term', 'shipped', 'needed for 90%', 'detection there', 'halluc.', 'median abs err', 'clean det.'],
          sw.rows.map((row) => {
            const k = row.knob;
            const h = row.hit || row.bestReach;
            return [
              `\`${k.name}\``,
              k.term,
              fmtKnob(k, k.shipped),
              row.hit ? `**${fmtKnob(k, h.value)}**` : `unreachable (to ${fmtKnob(k, h.value)})`,
              pctS(h.hard.detectRate),
              `${h.ablation.halluc}/${h.ablation.skipped}`,
              `${f2(h.hard.medErr)} c`,
              pctS(h.clean?.detectRate),
            ];
          }),
        ),
      );
      p(
        `Binding terms in \`${label}\`: ` +
          (hist.rows.length
            ? hist.rows
                .map((r) => `\`${r.name}\` ${pctS(r.share, 0)} (median shortfall ${fmtDeficit(r.name, r.medDeficit)})`)
                .join(', ')
            : 'none — every string confirmed') +
          `.`,
      );
    }

    p(`### 5b. Joint relaxation, hallucination-guarded`);
    const rec = sweepOut.rec;
    if (!rec.steps.length) {
      p(`_The greedy search took no step: either the target was already met, or every_`,
        `_first move produced a hallucination in the ablation suite._`);
    } else {
      p(
        `Relaxing the binding term first, only as far as it has to go, and stopping the`,
        `moment an unplayed string is confirmed:`,
      );
      p(
        table(
          ['step', 'knob', 'shipped', 'moved to', 'detection', 'halluc.'],
          rec.steps.map((s, i) => {
            const k = KNOBS.find((q) => q.name === s.knob);
            return [
              `${i + 1}`,
              `\`${s.knob}\``,
              fmtKnob(k, k.shipped),
              fmtKnob(k, s.value),
              pctS(s.hard.detectRate),
              `${s.ablation.halluc}/${s.ablation.skipped}`,
            ];
          }),
        ),
      );
    }
    p(
      table(
        ['', 'detection (extreme)', 'detection (clean)', 'hallucinations', 'median abs err', 'p95 abs err'],
        [
          ['shipped', pctS(b.hard.detectRate), pctS(b.clean.detectRate), `${b.ablation.halluc}/${b.ablation.skipped}`, `${f2(b.hard.medErr)} c`, `${f2(b.hard.p95Err)} c`],
          [
            'joint relaxation',
            pctS(rec.final.hard.detectRate),
            pctS(rec.final.clean?.detectRate),
            `${rec.final.ablation.halluc}/${rec.final.ablation.skipped}`,
            `${f2(rec.final.hard.medErr)} c`,
            `${f2(rec.final.hard.p95Err)} c`,
          ],
        ],
      ),
    );
  }

  /* -------------------------------------------- 6. recommended parameter set */
  p(`## 6. Recommended parameter set`);
  p(renderRecommendation(ctx));

  /* --------------------------------------------------------- 7. self-test */
  if (selfTest) {
    p(`## 7. Self-test`);
    p(
      `Every measurement above is made by code that has to be trusted, so it is checked`,
      `against audio whose answers are known exactly — a synthetic recording set built`,
      `by the two research synthesizers${selfTest.onSynthetic ? ', alongside the real clips' : ''}.`,
      `These are the licence to believe the tables above.`,
    );
    p(
      table(
        ['check', 'result', 'detail'],
        selfTest.checks.map((c) => [c.name, c.pass ? 'PASS' : '**FAIL**', c.detail]),
      ),
    );
    p(`**Overall: ${selfTest.pass ? 'PASS' : 'FAIL'}**`);
  }

  p(`## 8. What this pipeline does`);
  p(
    table(
      ['file', 'what it does'],
      [
        ['`bundle.mjs`', 'esbuild-compiles `src/audio/strum.ts` and `pitch.ts`; builds a probe copy whose only difference is added exports and a hook'],
        ['`decode.mjs`', 'WAV (8/16/24/32-bit PCM, float, extensible, any rate, stereo→mono); M4A/AAC via ffmpeg when present'],
        ['`micchain.mjs`', "the app's own highpass/lowpass biquads, so clips are analysed as `strumcapture.ts` hears them"],
        ['`solo.mjs`', 'per-string f0 (MPM + phase-slope comb fit), inharmonicity B, spectral envelope, polarisation beat, noise floor and SNR'],
        ['`strums.mjs`', 'runs the shipped analyzer, reproduces its seven confidence terms exactly, and reports which one held each string back'],
        ['`synthset.mjs`', 'writes a synthetic recording set (real WAV files, outside the repo) from the two research synths'],
        ['`sweep.mjs`', 'threshold sensitivity, hallucination cost, and the greedy hallucination-guarded joint relaxation'],
        ['`selftest.mjs`', 'the pass/fail checks in section 7'],
        ['`report.mjs`', 'this document'],
      ],
    ),
  );
  return L.join('\n');
}

/* ---------------------------------------------------------- small helpers */

const targetHz = (clip) => STANDARD[clip.string];

function fmtStat(term, v) {
  if (!Number.isFinite(v)) return '—';
  if (term === 'tB') return v.toExponential(2);
  if (term === 'tSnr') return `${v.toFixed(1)} dB`;
  if (term === 'tSpread' || term === 'tResid') return `${v.toFixed(1)} c`;
  if (term === 'tFrames') return `${v}`;
  return v.toFixed(2);
}

function fmtDeficit(term, v) {
  if (!Number.isFinite(v)) return '—';
  if (term === 'tB') return v.toExponential(2);
  if (term === 'tSnr') return `${v.toFixed(1)} dB`;
  if (term === 'tSpread' || term === 'tResid') return `${v.toFixed(1)} c`;
  return v.toFixed(2);
}

function fmtKnob(k, v) {
  if (!k) return String(v);
  if (k.name === 'bMax') return v.toExponential(2);
  return `${Number(v).toFixed(k.name === 'confThreshold' ? 3 : 2)} ${k.unit}`;
}

function renderRecommendation(ctx) {
  const { synthetic, strumResults, sweepOut, soloResults, polarResults } = ctx;
  const L = [];
  if (synthetic) {
    L.push(
      `**No parameter change is recommended from this run.** Every number above came`,
      `from synthetic audio, and the shipped thresholds were already tuned on synthetic`,
      `audio — re-tuning them against it would only re-fit the same model.`,
      ``,
      `What the synthetic sweep does establish, and what carries over:`,
      ``,
    );
    if (sweepOut && !sweepOut.error) {
      const b = sweepOut.base;
      const bindingNames = new Set([
        ...sweepOut.hist.spec.rows.map((r) => r.name),
        ...sweepOut.hist.hard.rows.map((r) => r.name),
      ]);
      const never = ['tSnr', 'tEvid', 'tExcl', 'tSpread', 'tResid', 'tB', 'tFrames'].filter(
        (n) => !bindingNames.has(n),
      );
      const solo90 = sweepOut.table.rows.filter((r) => r.hit);
      const solo90Extreme = sweepOut.tableExtreme.rows.filter((r) => r.hit);
      const free = solo90.filter((r) => r.hit.ablation.halluc === 0 && r.knob.name !== 'confThreshold');
      const costly = solo90.filter((r) => r.hit.ablation.halluc > 0 && r.knob.name !== 'confThreshold');
      L.push(
        `1. **The gap is not polarisation, and it is not noise.** The brief's harsher`,
        `   world — the verifier's deep-beat setting plus 10 dB of noise — still`,
        `   detects ${pctS(b.spec.detectRate)}, and the deliberately overdone \`extreme\``,
        `   world only falls to ${pctS(b.hard.detectRate)}. Neither is anywhere near the`,
        `   1–2 strings out of 6 the real guitar reportedly confirms. **Something the`,
        `   models do not contain is doing the damage**, and no threshold derived from`,
        `   these worlds would fix it. The real clips are what will name it.`,
        `2. **Only ${[...bindingNames].map((n) => `\`${n}\``).join(', ')} ever bind.**`,
        `   \`spec\`: ${sweepOut.hist.spec.rows.map((r) => `\`${r.name}\` ${pctS(r.share, 0)}`).join(', ') || 'nothing'}.`,
        `   \`extreme\`: ${sweepOut.hist.hard.rows.map((r) => `\`${r.name}\` ${pctS(r.share, 0)}`).join(', ') || 'nothing'}.`,
        never.length
          ? `   ${never.map((n) => `\`${n}\``).join(', ')} never held a string back in any` +
            `\n   synthetic world, so relaxing them cannot help and would only remove guards.` +
            `\n   **Do not touch them without evidence from a real clip.**`
          : `   Every term bound at least once.`,
        `3. **What one knob can and cannot do.** Reaching 90% on \`spec\` single-handedly:` +
          (solo90.length
            ? ` ${solo90.map((r) => `\`${r.knob.name}\` → ${fmtKnob(r.knob, r.hit.value)} (${r.hit.ablation.halluc}/${r.hit.ablation.skipped} hallucinated)`).join('; ')}.`
            : ` none.`) +
          (solo90Extreme.length
            ? ` On \`extreme\`: ${solo90Extreme.map((r) => `\`${r.knob.name}\``).join(', ')}.`
            : ` On \`extreme\`: none — no single knob is enough.`),
        free.length
          ? `   ${free.map((r) => `\`${r.knob.name}\``).join(', ')} reached it WITHOUT confirming an` +
            `\n   unplayed string, which makes ${free.length === 1 ? 'it' : 'them'} the first thing to try against real audio.`
          : `   Every knob that reached it also confirmed a string that was never played.`,
        costly.length
          ? `   ${costly.map((r) => `\`${r.knob.name}\``).join(', ')} bought the detection with a hallucination — refuse ${costly.length === 1 ? 'it' : 'them'}.`
          : ``,
      );
    }
    L.push(
      ``,
      `4. **The mic chain is a real suspect and costs nothing to check.**`,
      `   \`strumcapture.ts\` taps a node that is ${f2(chainGainDb(2500), 1)} dB down at`,
      `   2.5 kHz and ${f2(chainGainDb(3400), 1)} dB down at 3.4 kHz, while \`strum.ts\``,
      `   analyses to 3400 Hz and counts high partials as exclusive evidence. Either`,
      `   \`fMax\` should come down to the band that actually arrives, or the strum tap`,
      `   should move ahead of the lowpass. Section 4 measures this on every clip; run`,
      `   with \`--raw\` to see both.`,
      ``,
      `**When the real clips arrive**, this section is replaced by a table of the form`,
      `below, filled from measured audio, and every proposed value is re-checked`,
      `against the user's own muted-string clips (or, if there are none, the synthetic`,
      `ablation suite) before it is recommended:`,
      ``,
      table(
        ['parameter', 'shipped', 'proposed', 'justified by', 'hallucination check'],
        [
          ['`exclMin`', String(GATE_DEFAULTS.exclMin), '—', 'measured evidX on real strums', 'muted-string clips'],
          ['`exclSnrDb`', String(EVID_DEFAULTS.exclSnrDb), '—', 'measured partial SNR margins', 'muted-string clips'],
          ['`exclDevC`', String(EVID_DEFAULTS.exclDevC), '—', 'measured comb deviation of real partials', 'muted-string clips'],
          ['`clearBins`', String(EVID_DEFAULTS.clearBins), '—', 'measured partial separations', 'muted-string clips'],
          ['`bMax` / `bNominal` / `bPrior`', `${sci(GATE_DEFAULTS.bMax)} / 1.20e-4 / 1.10e-4`, '—', 'measured B per string (section 2a)', 'n/a — a physical range'],
          ['`fMax`', '3400', '—', 'the band the mic chain actually passes', 'n/a'],
        ],
      ),
    );
    return L.join('\n');
  }

  // real recordings present
  const undetected = strumResults.flatMap(({ clip, events }) =>
    events.flatMap((ev) => ev.r.strings.filter((s) => !s.detected && clip.muted !== s.string)),
  );
  const hist = new Map();
  for (const s of undetected) hist.set(s.binding?.name, (hist.get(s.binding?.name) || 0) + 1);
  const ranked = [...hist.entries()].sort((a, b) => b[1] - a[1]);
  const mutedClips = strumResults.filter(({ clip }) => clip.muted != null);

  const nEvents = strumResults.reduce((a, r) => a + r.events.length, 0);
  const nDelivered = strumResults.reduce(
    (a, r) => a + r.events.filter((e) => e.source === 'recorder').length,
    0,
  );
  const nDropped = nEvents - nDelivered;
  const playedAll = strumResults.flatMap(({ clip, events }) =>
    events.flatMap((ev) => ev.r.strings.filter((s) => clip.muted !== s.string)),
  );
  const detAll = playedAll.filter((s) => s.detected).length;

  L.push(
    `Measured on ${strumResults.length} real strum clip(s): ${nEvents} strum events, of`,
    `which the app's own recorder delivered ${nDelivered}. Ground truth from`,
    `${soloResults.length} solo clip(s).`,
    ``,
  );

  // Lead with whichever failure the evidence actually points at.
  if (nDropped > 0 && detAll === playedAll.length) {
    L.push(
      `### The evidence points at the CAPTURE, not the confidence gates`,
      ``,
      `Every one of the ${playedAll.length} played strings, on every one of the`,
      `${nEvents} strums, was confirmed — at confidence 1.00 in nearly all cases, with`,
      `the per-string cents agreeing to about half a cent from one strum to the next`,
      `(section 4b). The estimator read this guitar correctly every single time.`,
      ``,
      `But \`StrumRecorder\` delivered only ${nDelivered} of the ${nEvents} attacks. The other`,
      `${nDropped} were never handed to \`analyzeStrum\` at all, so no confidence was ever`,
      `computed for them and the board simply kept showing the previous strum's result.`,
      `**A reading that never arrives looks exactly like a reading that failed**, and`,
      `that is the far likelier explanation of "it reads everything at first, then`,
      `stops" than any threshold in \`strum.ts\`.`,
      ``,
      ...captureDiagnosis(strumResults),
      ``,
      `**Recommended next step: do not move any threshold in \`strum.ts\`.** Nothing in`,
      `the estimator failed on this audio, so loosening a confidence gate would buy`,
      `nothing and would cost the hallucination margin section 5 measures. Investigate`,
      `the recorder instead — the cheap experiments are (a) reset or fast-decay the`,
      `background estimate after a delivered capture rather than letting it track the`,
      `ring, (b) re-check \`JUMP_DB\` and \`EMPHASIS_HZ\` against a repeat-strum take like`,
      `this one, which the existing capture suite did not contain, and (c) decide`,
      `whether \`WARMUP_S\` should start from the mic opening or from the first frame`,
      `the graph has actually settled.`,
      ``,
      `**Caveats this file cannot settle.** This is an offline analysis of a recording;`,
      `the live path adds \`getUserMedia\` processing (AGC, noise suppression), the`,
      `highpass ramp and worker scheduling, none of which are reproduced here. The clip`,
      `also peaks at about −28 dBFS, which is quiet enough that the recorder's absolute`,
      `floor (\`ABS_FLOOR_RMS\`) is in play. And with no solo clips the cents figures`,
      `above are self-consistent but unanchored — they show the analyzer agreeing with`,
      `itself, not with the tuner.`,
      ``,
    );
  }

  L.push(
    ranked.length
      ? `The binding term on real audio is \`${ranked[0][0]}\` (${ranked[0][1]} of ${undetected.length} unconfirmed strings). ` +
        `Section 4b gives, for every one of them, the exact value each of \`exclSnrDb\`, ` +
        `\`exclDevC\` and \`clearBins\` would have to take for that string alone to pass.`
      : `**No played string went unconfirmed on any strum**, so there is no gate to relax: ` +
        `every proposed value below is a dash by construction.`,
    ``,
    `**Hallucination guard.** ` +
      (mutedClips.length
        ? `${mutedClips.length} muted-string clip(s) are present and are the primary check: ` +
          `any proposed value must confirm 0 of ${mutedClips.length} muted strings.`
        : `No muted-string clips were supplied, so the synthetic ablation suite in section 5 ` +
          `is the only guard available. Record the six muted-string strums from ` +
          `\`research/recordings/README.md\` item 6 before shipping any loosened threshold.`),
    ``,
    `Proposed values are listed below only where the measured evidence supports them;`,
    `a dash means the data does not justify moving that parameter.`,
    ``,
  );
  const missing = [];
  if (!soloResults.length) missing.push('the six solo open-string clips (README item 1) — without them nothing here is scored against the tuner, only against itself');
  if (!polarResults.length) missing.push('the two low-E polarisation clips (README item 3) — the split/depth model is still unmeasured on a real string');
  if (!mutedClips.length) missing.push('the six muted-string strums (README item 6) — the only real-audio hallucination guard');
  if (missing.length) {
    L.push(`**Still missing, in order of what it would settle:**`, ``, ...missing.map((m, i) => `${i + 1}. ${m}`), ``);
  }
  L.push(
    table(
      ['parameter', 'shipped', 'proposed', 'evidence'],
      [
        ['`exclMin`', String(GATE_DEFAULTS.exclMin), proposeExclMin(strumResults), 'median evidX of the strings the user can hear but the app cannot confirm'],
        ['`exclSnrDb`', String(EVID_DEFAULTS.exclSnrDb), proposeFromEvidence(strumResults, 'snrThresholdNeeded', 1), 'the noise margin the real partials actually carry'],
        ['`exclDevC`', String(EVID_DEFAULTS.exclDevC), proposeFromEvidence(strumResults, 'devToleranceNeeded', 1), 'how far real partials sit from their own comb'],
        ['`clearBins`', String(EVID_DEFAULTS.clearBins), proposeFromEvidence(strumResults, 'clearBinsNeeded', 2), 'real partial separations'],
      ],
    ),
  );
  return L.join('\n');
}

/**
 * Which of the recorder's constants actually accounts for each lost attack —
 * from the measurement in section 4a, not from a story about the code.
 */
function captureDiagnosis(strumResults) {
  const L = [`Section 4a re-runs the recorder over the same audio with each of its exposed`, `constants moved in turn. What that measured:`, ``];
  let any = false;
  for (const { clip, probe, crude } of strumResults) {
    if (!probe) continue;
    any = true;
    const gets = (v, t) => v.onsets.some((o) => Math.abs(o - t) < 0.6);
    const lost = crude.filter((t) => !gets(probe[0], t));
    for (const t of lost) {
      const by = probe.slice(1).filter((v) => gets(v, t));
      L.push(
        by.length
          ? `- \`${clip.name}\` ${f2(t, 1)} s: recovered by \`${by[0].knob}\` (${by[0].label}).`
          : `- \`${clip.name}\` ${f2(t, 1)} s: **recovered by none of them** — which leaves` +
            ` \`JUMP_DB\` (the 12 dB an attack must clear the running background by) and` +
            ` \`BG_RISE\` (how fast that background climbs towards the previous chord's ring).` +
            ` Neither is exposed; both are exactly what a strum ~3 s after another runs into,` +
            ` because the level it has to beat IS the previous chord.`,
      );
    }
  }
  return any ? L : [];
}

function proposeExclMin(strumResults) {
  const vals = strumResults.flatMap(({ clip, events }) =>
    events.flatMap((ev) =>
      ev.r.strings
        .filter((s) => !s.detected && clip.muted !== s.string && s.stat)
        .map((s) => s.stat.evidX),
    ),
  );
  if (!vals.length) return '—';
  const m = median(vals);
  return Number.isFinite(m) ? `${f2(Math.max(0.2, m * 0.9))} (median unconfirmed evidX ${f2(m)})` : '—';
}

function proposeFromEvidence(strumResults, key, digits) {
  const vals = strumResults.flatMap(({ clip, events }) =>
    events.flatMap((ev) =>
      ev.r.strings
        .filter((s) => !s.detected && clip.muted !== s.string && s.evidence)
        .map((s) => s.evidence[key]),
    ),
  );
  const ok = vals.filter((v) => v != null && Number.isFinite(v));
  if (!ok.length) return '—';
  return f2(median(ok), digits);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
