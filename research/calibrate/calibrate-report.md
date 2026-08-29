# Strum check — real-audio calibration report

Generated 2026-08-29T20:58:27.228Z in 226.1 s.

**Source:** research/recordings/ (1 files)
**Clips folder:** `I:\Claude\guitartunefree\research\recordings`
**Analyzer:** `src/audio/strum.ts` and `src/audio/pitch.ts`, esbuild-compiled and imported — not copied.

## 1. Clips

| file | role | string | variant | format | length | classified by |
| --- | --- | --- | --- | --- | --- | --- |
| `5strum.wav` | strum | — | — | 44100 Hz 16-bit mono | 14.9 s | filename |

## 2. Solo strings — the ground truth

_No solo clips. Without them there is no ground truth: a strum's cents can be
reported but not scored, and the inharmonicity and polarisation sections below
stay empty. These six clips are the ones that settle the science._

## 3. Polarisation — the unmeasured parameter

The two candidate models disagree about ONE thing: how the split scales across
strings. Both make the beat rate of partial *k* equal to *k* times the rate of
the fundamental, so the discriminator is how rate₁ varies with f₀:

- **spike model** (`spike-poly/synth.mjs`): the split is a constant number of
  Hz at the fundamental (0.05–0.6 Hz), so rate₁ does **not** depend on f₀ —
  fitted exponent 0.
- **verifier model** (`spike-poly-verify/mysynth.mjs`): the split is a constant
  number of CENTS (1.5–9 c), so rate₁ is proportional to f₀ — exponent 1.

Fitting `log rate₁ = a + n·log f₀` across the six solo clips decides it.

| string | f0 Hz | split (Hz at f0) | split (cents) | depth (partner/dominant) | measured on k | usable partials |
| --- | --- | --- | --- | --- | --- | --- |

_Only 0 string(s) produced a beat with enough whole cycles inside
the clip to measure. A split below about 0.2 Hz at the fundamental needs a clip
longer than ~6 s, or has to be read off a high partial (rate scales with k) —
which is what the two dedicated polarisation clips in the README are for._

## 4. Strums

Every strum is analysed **through the app's own mic chain** — highpass
20 Hz, lowpass 2000 Hz, both Q 0.707 — because
`strumcapture.ts` taps the filtered node (SPEC v2.0 condition 3). That chain is
-5.4 dB at 2.5 kHz and -9.9 dB at
3.4 kHz, while `strum.ts` analyses up to `fMax = 3400`. **The partials the
exclusive-evidence gate counts for B3 and E4 arrive several dB down.**

### 4a. What the app's recorder actually captured

Before this is a question about confidence thresholds, it is a question about
whether the app ever looked. `StrumRecorder` (src/audio/strumcapture.ts) is
pure — "no Web Audio in sight so it can be driven from a test harness
sample-for-sample" — so it is driven here over the filtered signal, in
128-sample quanta, exactly as strumcapture.ts drives it. "attacks" is an
INDEPENDENT broadband energy-jump count, deliberately not the app's own rule,
so the two are free to disagree.

| clip | length | peak | attacks in the audio | delivered to the analyzer | rejected by the sustain test | window |
| --- | --- | --- | --- | --- | --- | --- |
| `5strum.wav` | 14.9 s | -28.1 dBFS | 5 (0.2, 3.2, 6.1, 9.1, 12.0 s) | **2** | 0 | 2.1 s |

> **3 of 5 attacks were never delivered to the analyzer.**
>
> A strum that is never delivered cannot fail a confidence gate, because no
> confidence was ever computed for it: the board just goes on showing the
> previous result. Every undelivered attack is analysed below anyway, from the
> window the app WOULD have used, so "the estimator could not read it" and
> "the app never looked" can be told apart.

**Why `5strum.wav` lost them.** `StrumRecorderOptions` exposes four of the
constants the onset decision rests on. Re-running the same audio under each,
one at a time, is the capture-side equivalent of the confidence sweep:

| recorder setting | constant | delivered | rejected by the sustain test | onsets |
| --- | --- | --- | --- | --- |
| shipped defaults | — | 2 / 5 | 0 | 3.2, 9.1 s |
| no 0.6 s warm-up | `WARMUP_S` | 3 / 5 | 0 | 0.2, 3.2, 9.1 s |
| absolute floor /4 | `ABS_FLOOR_RMS` | 2 / 5 | 0 | 3.2, 9.1 s |
| emphasis 300 Hz | `EMPHASIS_HZ` | 2 / 5 | 0 | 3.2, 9.1 s |
| emphasis 1400 Hz | `EMPHASIS_HZ` | 3 / 5 | 0 | 3.2, 9.1, 12.0 s |
| sustain bar 6 → 2 dB | `SUSTAIN_MIN_OVER_BG_DB` | 2 / 5 | 0 | 3.2, 9.1 s |

- the attack at 0.2 s comes back with `WARMUP_S` (no 0.6 s warm-up)
- the attack at 6.1 s comes back with **none of them**
- the attack at 12.0 s comes back with `EMPHASIS_HZ` (emphasis 1400 Hz)

**1 of the 3 lost attacks survives every exposed constant.** What is left is `JUMP_DB` — the 12 dB an attack must clear the running background by — and `BG_RISE`, how fast that background climbs towards the PREVIOUS chord's ring. Neither is in `StrumRecorderOptions`, so neither can be swept from outside, and both are exactly what a strum three seconds after another one runs into: the reference it must beat is the previous chord.

### 4b. Per-strum results

"weakest term" is the `min()` of the seven confidence terms — the one that
decided this string's confidence. For an unconfirmed string it is the gate that
held it back, and "achieved / needs" is the shortfall in that term's own units.

**`5strum.wav`** — 5 strums

| # | onset | captured by the app? | confirmed | refusal | per-string cents |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.22 s | **no** — inside the 0.6 s detector warm-up | 6/6 | — | +1.7 -1.5 -0.2 +1.7 -4.5 +1.1 |
| 2 | 3.17 s | yes | 6/6 | — | +1.3 -1.5 +0.0 +2.2 -4.7 +1.5 |
| 3 | 6.06 s | **no** — no attack confirmed by the recorder | 6/6 | — | +1.1 -1.6 +0.2 +2.0 -4.0 +0.9 |
| 4 | 9.08 s | yes | 6/6 | — | +1.4 -1.3 +0.4 +2.2 -3.9 +1.1 |
| 5 | 11.99 s | **no** — no attack confirmed by the recorder | 6/6 | — | +1.3 -1.7 +0.2 +1.8 -5.1 -0.1 |

**Strum 1** at 0.22 s — **NOT captured** (inside the 0.6 s detector warm-up); N=16384, 9 frames, 6/6 confirmed, 74 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | +1.74 | — | — | 1.00 | tSnr | 24.9 dB | 5.8 dB |
| A2 | yes | -1.50 | — | — | 1.00 | tSnr | 19.1 dB | 5.8 dB |
| D3 | yes | -0.19 | — | — | 1.00 | tSnr | 24.0 dB | 5.8 dB |
| G3 | yes | +1.72 | — | — | 1.00 | tSnr | 26.7 dB | 5.8 dB |
| B3 | yes | -4.53 | — | — | 1.00 | tSnr | 22.0 dB | 5.8 dB |
| E4 | yes | +1.10 | — | — | 1.00 | tSnr | 22.4 dB | 5.8 dB |



**Strum 2** at 3.17 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 35 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | +1.29 | — | — | 1.00 | tSnr | 23.3 dB | 5.8 dB |
| A2 | yes | -1.51 | — | — | 1.00 | tSnr | 23.2 dB | 5.8 dB |
| D3 | yes | +0.01 | — | — | 1.00 | tSnr | 28.4 dB | 5.8 dB |
| G3 | yes | +2.18 | — | — | 1.00 | tSnr | 29.1 dB | 5.8 dB |
| B3 | yes | -4.65 | — | — | 1.00 | tSnr | 26.6 dB | 5.8 dB |
| E4 | yes | +1.45 | — | — | 1.00 | tSnr | 26.5 dB | 5.8 dB |



**Strum 3** at 6.06 s — **NOT captured** (no attack confirmed by the recorder); N=16384, 9 frames, 6/6 confirmed, 35 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | +1.05 | — | — | 1.00 | tSnr | 20.8 dB | 5.8 dB |
| A2 | yes | -1.59 | — | — | 1.00 | tSnr | 18.0 dB | 5.8 dB |
| D3 | yes | +0.19 | — | — | 1.00 | tSnr | 24.0 dB | 5.8 dB |
| G3 | yes | +1.97 | — | — | 1.00 | tSnr | 26.9 dB | 5.8 dB |
| B3 | yes | -4.00 | — | — | 1.00 | tSnr | 22.3 dB | 5.8 dB |
| E4 | yes | +0.90 | — | — | 1.00 | tSnr | 26.0 dB | 5.8 dB |



**Strum 4** at 9.08 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 35 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | +1.40 | — | — | 1.00 | tSnr | 24.2 dB | 5.8 dB |
| A2 | yes | -1.29 | — | — | 1.00 | tSnr | 23.6 dB | 5.8 dB |
| D3 | yes | +0.41 | — | — | 1.00 | tSnr | 26.6 dB | 5.8 dB |
| G3 | yes | +2.16 | — | — | 1.00 | tSnr | 29.4 dB | 5.8 dB |
| B3 | yes | -3.92 | — | — | 1.00 | tSnr | 24.6 dB | 5.8 dB |
| E4 | yes | +1.05 | — | — | 1.00 | tSnr | 27.3 dB | 5.8 dB |



**Strum 5** at 11.99 s — **NOT captured** (no attack confirmed by the recorder); N=16384, 9 frames, 6/6 confirmed, 34 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | +1.34 | — | — | 1.00 | tSnr | 16.1 dB | 5.8 dB |
| A2 | yes | -1.73 | — | — | 0.94 | tSnr | 15.3 dB | 5.8 dB |
| D3 | yes | +0.21 | — | — | 1.00 | tSnr | 18.9 dB | 5.8 dB |
| G3 | yes | +1.81 | — | — | 1.00 | tSnr | 26.6 dB | 5.8 dB |
| B3 | yes | -5.11 | — | — | 1.00 | tSnr | 24.7 dB | 5.8 dB |
| E4 | yes | -0.15 | — | — | 1.00 | tSnr | 24.7 dB | 5.8 dB |



### 4c. Accuracy and detection, pooled

Over every strum EVENT — including the ones the recorder did not deliver, which
are marked separately so the two failure modes never get averaged together.

| metric | value |
| --- | --- |
| strum events | 5 (2 delivered by the recorder) |
| strings played | 30 |
| confirmed, all events | 30 (100.0%) |
| **confirmed, events the app actually captured** | **12 / 12 (100.0%)** |
| median abs error vs solo ground truth | — (no scorable clip) |
| p95 abs error | — |
| worst abs error | — |
| scored on | 1 of 1 clips |
| muted-string clips | 0 |
| **hallucinations** (muted string confirmed) | — (no muted clips) |

### 4d. Which gate held the unconfirmed strings back

_Every played string was confirmed._

## 5. Sensitivity sweep (synthetic)

Three synthetic worlds, all run through the app's mic chain, 20
strums each, plus a 24-strum ABLATION suite where one
string is genuinely not played.

| world | what it is | detection | median abs err | p95 abs err |
| --- | --- | --- | --- | --- |
| `clean` | ordinary polarisation, 45 dB SNR | 88.9% | 0.41 c | 1.19 c |
| `spec` | deep-beat polarisation + 10 dB more noise (the brief) | 78.3% | 2.89 c | 3.59 c |
| `extreme` | …plus dull spectrum, wide level spread, treble trim | 65.8% | 2.90 c | 3.32 c |
| `ablation` | 5-string strums, clean | 96.7% | 0.23 c | 0.78 c |

Hallucinations at the shipped thresholds: **0 / 24**
unplayed strings confirmed.

### 5a. What each gate would have to give to reach 90% detection

One knob at a time, from the shipped value towards the relaxed end, stopping at
the first value that reaches 90%. "halluc." is the ablation suite re-scored at
that same value — the number that decides whether the relaxation is allowed at
all. Knobs marked _unreachable_ cannot lift detection alone whatever they are
set to: confidence is `min()` over the seven terms, so relaxing a term that is
not the binding one changes nothing.

**`spec`** — the brief’s harsher world: deep-beat polarisation + 10 dB more noise. Detection at the shipped values: 78.3%.

| knob | term | shipped | needed for 90% | detection there | halluc. | median abs err | clean det. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `exclMin` | tExcl | 1.80 exclusive partials | **0.55 exclusive partials** | 90.0% | 1/24 | 2.88 c | 97.2% |
| `exclSnrDb` | tExcl (evidence) | 10.00 dB over the frame noise floor | **1.50 dB over the frame noise floor** | 90.0% | 1/24 | 2.89 c | 95.8% |
| `exclDevC` | tExcl (evidence) | 5.00 cents | unreachable (to 60.00 cents) | 80.8% | 0/24 | 2.88 c | 88.9% |
| `clearBins` | tExcl (evidence) | 1.60 bins | **0.65 bins** | 90.0% | 0/24 | 2.89 c | 95.8% |
| `ownDbLo` | tSnr | 4.00 dB | unreachable (to -30.00 dB) | 78.3% | 0/24 | 2.89 c | 88.9% |
| `evidLo` | tEvid | 1.15 partials | unreachable (to 0.02 partials) | 78.3% | 0/24 | 2.89 c | 88.9% |
| `spreadMaxCents` | tSpread | 14.00 cents | unreachable (to 90.00 cents) | 78.3% | 0/24 | 2.89 c | 88.9% |
| `residMax` | tResid | 16.00 cents | unreachable (to 90.00 cents) | 78.3% | 0/24 | 2.89 c | 88.9% |
| `bMax` | tB | 5.50e-4 | unreachable (to 4.00e-3) | 78.3% | 0/24 | 2.89 c | 88.9% |
| `confThreshold` | all (the bar itself) | 0.150 confidence | **0.000 confidence** | 100.0% | 24/24 | 2.88 c | 100.0% |

Binding terms in `spec`: `tExcl` 85% (median shortfall 0.95), `tEvid` 15% (median shortfall 0.28).

**`extreme`** — …and with a dull spectrum, wide level spread and a treble trim on top. Detection at the shipped values: 65.8%.

| knob | term | shipped | needed for 90% | detection there | halluc. | median abs err | clean det. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `exclMin` | tExcl | 1.80 exclusive partials | unreachable (to 0.00 exclusive partials) | 72.5% | 1/24 | 2.91 c | 97.2% |
| `exclSnrDb` | tExcl (evidence) | 10.00 dB over the frame noise floor | unreachable (to -12.00 dB over the frame noise floor) | 70.0% | 1/24 | 2.90 c | 95.8% |
| `exclDevC` | tExcl (evidence) | 5.00 cents | unreachable (to 60.00 cents) | 67.5% | 0/24 | 2.90 c | 88.9% |
| `clearBins` | tExcl (evidence) | 1.60 bins | unreachable (to 0.20 bins) | 72.5% | 1/24 | 2.91 c | 97.2% |
| `ownDbLo` | tSnr | 4.00 dB | unreachable (to -30.00 dB) | 65.8% | 0/24 | 2.90 c | 88.9% |
| `evidLo` | tEvid | 1.15 partials | unreachable (to 0.02 partials) | 65.8% | 0/24 | 2.90 c | 88.9% |
| `spreadMaxCents` | tSpread | 14.00 cents | unreachable (to 90.00 cents) | 65.8% | 0/24 | 2.90 c | 88.9% |
| `residMax` | tResid | 16.00 cents | unreachable (to 90.00 cents) | 65.8% | 0/24 | 2.90 c | 88.9% |
| `bMax` | tB | 5.50e-4 | unreachable (to 4.00e-3) | 65.8% | 0/24 | 2.90 c | 88.9% |
| `confThreshold` | all (the bar itself) | 0.150 confidence | **0.000 confidence** | 100.0% | 24/24 | 2.90 c | 100.0% |

Binding terms in `extreme`: `tEvid` 68% (median shortfall 0.81), `tExcl` 24% (median shortfall 0.95), `tSnr` 7% (median shortfall 11.2 dB).

### 5b. Joint relaxation, hallucination-guarded

Relaxing the binding term first, only as far as it has to go, and stopping the
moment an unplayed string is confirmed:

| step | knob | shipped | moved to | detection | halluc. |
| --- | --- | --- | --- | --- | --- |
| 1 | `exclMin` | 1.80 exclusive partials | 0.90 exclusive partials | 67.5% | 0/24 |
| 2 | `exclDevC` | 5.00 cents | 60.00 cents | 69.2% | 0/24 |
| 3 | `clearBins` | 1.60 bins | 0.40 bins | 72.5% | 0/24 |
| 4 | `evidLo` | 1.15 partials | 0.80 partials | 78.3% | 0/24 |

|  | detection (extreme) | detection (clean) | hallucinations | median abs err | p95 abs err |
| --- | --- | --- | --- | --- | --- |
| shipped | 65.8% | 88.9% | 0/24 | 2.90 c | 3.32 c |
| joint relaxation | 78.3% | 100.0% | 0/24 | 2.91 c | 3.75 c |

## 6. Recommended parameter set

Measured on 1 real strum clip(s): 5 strum events, of
which the app's own recorder delivered 2. Ground truth from
0 solo clip(s).

### The evidence points at the CAPTURE, not the confidence gates

Every one of the 30 played strings, on every one of the
5 strums, was confirmed — at confidence 1.00 in nearly all cases, with
the per-string cents agreeing to about half a cent from one strum to the next
(section 4b). The estimator read this guitar correctly every single time.

But `StrumRecorder` delivered only 2 of the 5 attacks. The other
3 were never handed to `analyzeStrum` at all, so no confidence was ever
computed for them and the board simply kept showing the previous strum's result.
**A reading that never arrives looks exactly like a reading that failed**, and
that is the far likelier explanation of "it reads everything at first, then
stops" than any threshold in `strum.ts`.

Section 4a re-runs the recorder over the same audio with each of its exposed
constants moved in turn. What that measured:

- `5strum.wav` 0.2 s: recovered by `WARMUP_S` (no 0.6 s warm-up).
- `5strum.wav` 6.1 s: **recovered by none of them** — which leaves `JUMP_DB` (the 12 dB an attack must clear the running background by) and `BG_RISE` (how fast that background climbs towards the previous chord's ring). Neither is exposed; both are exactly what a strum ~3 s after another runs into, because the level it has to beat IS the previous chord.
- `5strum.wav` 12.0 s: recovered by `EMPHASIS_HZ` (emphasis 1400 Hz).

**Recommended next step: do not move any threshold in `strum.ts`.** Nothing in
the estimator failed on this audio, so loosening a confidence gate would buy
nothing and would cost the hallucination margin section 5 measures. Investigate
the recorder instead — the cheap experiments are (a) reset or fast-decay the
background estimate after a delivered capture rather than letting it track the
ring, (b) re-check `JUMP_DB` and `EMPHASIS_HZ` against a repeat-strum take like
this one, which the existing capture suite did not contain, and (c) decide
whether `WARMUP_S` should start from the mic opening or from the first frame
the graph has actually settled.

**Caveats this file cannot settle.** This is an offline analysis of a recording;
the live path adds `getUserMedia` processing (AGC, noise suppression), the
highpass ramp and worker scheduling, none of which are reproduced here. The clip
also peaks at about −28 dBFS, which is quiet enough that the recorder's absolute
floor (`ABS_FLOOR_RMS`) is in play. And with no solo clips the cents figures
above are self-consistent but unanchored — they show the analyzer agreeing with
itself, not with the tuner.

**No played string went unconfirmed on any strum**, so there is no gate to relax: every proposed value below is a dash by construction.

**Hallucination guard.** No muted-string clips were supplied, so the synthetic ablation suite in section 5 is the only guard available. Record the six muted-string strums from `research/recordings/README.md` item 6 before shipping any loosened threshold.

Proposed values are listed below only where the measured evidence supports them;
a dash means the data does not justify moving that parameter.

**Still missing, in order of what it would settle:**

1. the six solo open-string clips (README item 1) — without them nothing here is scored against the tuner, only against itself
2. the two low-E polarisation clips (README item 3) — the split/depth model is still unmeasured on a real string
3. the six muted-string strums (README item 6) — the only real-audio hallucination guard

| parameter | shipped | proposed | evidence |
| --- | --- | --- | --- |
| `exclMin` | 1.8 | — | median evidX of the strings the user can hear but the app cannot confirm |
| `exclSnrDb` | 10 | — | the noise margin the real partials actually carry |
| `exclDevC` | 5 | — | how far real partials sit from their own comb |
| `clearBins` | 1.6 | — | real partial separations |

## 7. Self-test

Every measurement above is made by code that has to be trusted, so it is checked
against audio whose answers are known exactly — a synthetic recording set built
by the two research synthesizers, alongside the real clips.
These are the licence to believe the tables above.

| check | result | detail |
| --- | --- | --- |
| decode every written format | PASS | 22 clips: 16-bit, 24-bit, 32-bit float, stereo, 44.1 kHz and 48 kHz all read |
| instrumented bundle is behaviourally identical to the shipped one | PASS | 84 string-results identical to 1e-12 |
| failed-gate instrumentation reproduces the shipped detect/no-detect decision | PASS | 0 disagreements over 84 string-results (14 clips) |
| per-partial evidence table reconstructs the module’s own evidX | PASS | worst abs difference 0.0e+0 over 755 frame-strings |
| solo ground-truth f0 within 0.5 cents | PASS | worst 0.069 c over 6 strings (A2 +0.004, B3 -0.069, D3 +0.058, E2 -0.043, E4 +0.032, G3 -0.008) |
| fitted inharmonicity B within 15% per string | PASS | worst 1.2% over 6 strings (A2 +0.5%, B3 +0.4%, D3 +0.2%, E2 +0.8%, E4 +0.3%, G3 +1.2%) |
| polarisation beat RATE within 25% | PASS | worst 2.6% over 5 strings; not measurable: A2 (split 0.113 Hz at f0 — needs a clip ~18 s long) |
| polarisation beat DEPTH within 25% | PASS | worst 6.1% over 5 strings (B3 -5%/7k, D3 +6%/8k, E2 +1%/7k, E4 -4%/9k, G3 -1%/4k) |
| muted strings are not hallucinated at the shipped thresholds | PASS | 0 of 6 muted-string strum events confirmed the muted string |

**Overall: PASS**

## 8. What this pipeline does

| file | what it does |
| --- | --- |
| `bundle.mjs` | esbuild-compiles `src/audio/strum.ts` and `pitch.ts`; builds a probe copy whose only difference is added exports and a hook |
| `decode.mjs` | WAV (8/16/24/32-bit PCM, float, extensible, any rate, stereo→mono); M4A/AAC via ffmpeg when present |
| `micchain.mjs` | the app's own highpass/lowpass biquads, so clips are analysed as `strumcapture.ts` hears them |
| `solo.mjs` | per-string f0 (MPM + phase-slope comb fit), inharmonicity B, spectral envelope, polarisation beat, noise floor and SNR |
| `strums.mjs` | runs the shipped analyzer, reproduces its seven confidence terms exactly, and reports which one held each string back |
| `synthset.mjs` | writes a synthetic recording set (real WAV files, outside the repo) from the two research synths |
| `sweep.mjs` | threshold sensitivity, hallucination cost, and the greedy hallucination-guarded joint relaxation |
| `selftest.mjs` | the pass/fail checks in section 7 |
| `report.mjs` | this document |
