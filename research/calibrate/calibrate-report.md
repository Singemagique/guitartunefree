# Strum check — real-audio calibration report

Generated 2026-08-30T20:06:33.437Z in 134.6 s.

**Source:** research/recordings/ (17 files)
**Clips folder:** `I:\Claude\guitartunefree\research\recordings`
**Analyzer:** `src/audio/strum.ts` and `src/audio/pitch.ts`, esbuild-compiled and imported — not copied.

## 1. Clips

| file | role | string | variant | format | length | classified by |
| --- | --- | --- | --- | --- | --- | --- |
| `5strum.wav` | strum | — | — | 44100 Hz 16-bit mono | 14.8 s | filename |
| `polar-parallel.wav` | polar | — | — | 44100 Hz 16-bit mono | 7.0 s | filename |
| `polar-perp.wav` | polar | — | — | 44100 Hz 16-bit mono | 7.4 s | filename |
| `solo-a2-long.wav` | solo | A2 | — | 44100 Hz 16-bit mono | 12.3 s | filename |
| `solo-a2.wav` | solo | A2 | — | 44100 Hz 16-bit mono | 6.0 s | filename |
| `solo-b2.wav` | solo | B3 | — | 44100 Hz 16-bit mono | 6.1 s | manifest.json |
| `solo-d2.wav` | solo | D3 | — | 44100 Hz 16-bit mono | 5.9 s | manifest.json |
| `solo-e2.wav` | solo | E2 | — | 44100 Hz 16-bit mono | 5.1 s | filename |
| `solo-e4.wav` | solo | E4 | — | 44100 Hz 16-bit mono | 5.0 s | filename |
| `solo-g2.wav` | solo | G3 | — | 44100 Hz 16-bit mono | 5.8 s | manifest.json |
| `strum-detuned.wav` | strum | — | detuned | 44100 Hz 16-bit mono | 17.6 s | filename |
| `strum-muted-1.wav` | strum | muted E4 | muted | 44100 Hz 16-bit mono | 6.1 s | manifest.json |
| `strum-muted-2.wav` | strum | muted B3 | muted | 44100 Hz 16-bit mono | 6.0 s | manifest.json |
| `strum-muted-3.wav` | strum | muted G3 | muted | 44100 Hz 16-bit mono | 4.8 s | manifest.json |
| `strum-muted-4.wav` | strum | muted D3 | muted | 44100 Hz 16-bit mono | 5.0 s | manifest.json |
| `strum-muted-5.wav` | strum | muted A2 | muted | 44100 Hz 16-bit mono | 5.6 s | manifest.json |
| `strum-muted-6.wav` | strum | muted E2 | muted | 44100 Hz 16-bit mono | 5.6 s | manifest.json |

## 2. Solo strings — the ground truth

`f0` is fitted from the partial comb by phase slope (see `solo.mjs`); the MPM
column is what the app's own Single mode reads on the same audio. `B` is the
measured inharmonicity — the parameter `strum.ts` constrains with `bMax`,
`bNominal` and `bPrior`.

| string | target Hz | f0 Hz | cents vs target | MPM Hz | MPM − fit | B | comb resid | partials | SNR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A2 | 110.000 | 109.772 | -3.60 c | 110.728 | +15.02 c | 1.52e-4 | 2.97 c | 12 | 30.9 dB |
| A2 | 110.000 | 109.820 | -2.84 c | — | — c | 1.45e-4 | 4.96 c | 14 | 23.3 dB |
| B3 | 246.942 | 246.900 | -0.29 c | — | — c | 7.27e-5 | 0.35 c | 22 | 21.0 dB |
| D3 | 146.832 | 146.830 | -0.02 c | 148.549 | +20.15 c | 1.56e-4 | 3.05 c | 12 | 25.0 dB |
| E2 | 82.407 | 82.597 | +3.99 c | — | — c | 9.89e-5 | 0.36 c | 25 | 19.3 dB |
| E4 | 329.628 | 329.382 | -1.29 c | 330.322 | +4.93 c | 2.24e-5 | 0.28 c | 16 | 25.1 dB |
| G3 | 195.998 | 195.456 | -4.79 c | 197.008 | +13.69 c | 1.26e-4 | 3.30 c | 12 | 24.3 dB |

### 2a. Inharmonicity vs what the shipped code assumes

| string | measured B | wound? | strum.ts bNominal | bPrior | bMax | inside range? |
| --- | --- | --- | --- | --- | --- | --- |
| A2 | 1.52e-4 | wound | 1.20e-4 | 1.10e-4 | 5.50e-4 | yes |
| A2 | 1.45e-4 | wound | 1.20e-4 | 1.10e-4 | 5.50e-4 | yes |
| B3 | 7.27e-5 | plain | 1.20e-4 | 1.10e-4 | 5.50e-4 | yes |
| D3 | 1.56e-4 | wound | 1.20e-4 | 1.10e-4 | 5.50e-4 | yes |
| E2 | 9.89e-5 | wound | 1.20e-4 | 1.10e-4 | 5.50e-4 | yes |
| E4 | 2.24e-5 | plain | 1.20e-4 | 1.10e-4 | 5.50e-4 | yes |
| G3 | 1.26e-4 | wound | 1.20e-4 | 1.10e-4 | 5.50e-4 | yes |

### 2b. Spectral envelope vs the parametric model

`strum.ts`'s `fitEnv()` models a string as `L·k^-q·|sin(π k p)|` and falls back
to it wherever a partial is contaminated. `rms dev` is how far the MEASURED
partial amplitudes sit from the best fit of that family — the error the
contamination weighting inherits whenever it has to extrapolate.

| string | q (rolloff) | p (pluck pos) | rms dev | worst partial | partials |
| --- | --- | --- | --- | --- | --- |
| A2 | 1.40 | 0.045 | 6.1 dB | 16.5 dB | 13 |
| A2 | 0.88 | 0.215 | 3.9 dB | 6.8 dB | 13 |
| B3 | 0.99 | 0.040 | 6.6 dB | 13.9 dB | 23 |
| D3 | 0.72 | 0.195 | 5.8 dB | 13.0 dB | 12 |
| E2 | 0.75 | 0.235 | 7.3 dB | 20.5 dB | 30 |
| E4 | 0.87 | 0.065 | 7.0 dB | 14.3 dB | 15 |
| G3 | 0.46 | 0.185 | 6.9 dB | 16.2 dB | 13 |

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
| A2 | 109.77 | — | — | 0.021 | k=1 | 0 |
| A2 | 109.82 | — | — | 0.109 | k=1 | 0 |
| B3 | 246.90 | 0.333 | 2.33 | 0.054 | k=8 | 2 |
| D3 | 146.83 | 0.160 | 1.88 | 1.000 | k=4 | 1 |
| E2 | 82.60 | 0.155 | 3.24 | 0.211 | k=4 | 2 |
| E4 | 329.38 | 0.437 | 2.30 | 0.064 | k=3 | 2 |
| G3 | 195.46 | — | — | 0.066 | k=1 | 0 |

**Fitted exponent: 0.80** over 4 strings (0 ⇒ the spike's Hz-constant model, 1 ⇒ the verifier's cents-constant model; closer to the VERIFIER model).

### 3a. The dedicated polarisation clips (pick parallel vs perpendicular)

| clip | f0 Hz | split Hz at f0 | split cents | depth | usable partials |
| --- | --- | --- | --- | --- | --- |
| `polar-parallel.wav` | 82.44 | 0.305 | 6.40 | 0.183 | 1 |
| `polar-perp.wav` | 82.69 | — | — | 0.084 | 0 |

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
| `5strum.wav` | 14.8 s | -20.6 dBFS | 5 (0.1, 3.1, 6.1, 9.2, 12.1 s) | 5 | 0 | 2.1 s |
| `strum-detuned.wav` | 17.6 s | -15.8 dBFS | 3 (0.2, 6.0, 11.5 s) | 3 | 0 | 2.1 s |
| `strum-muted-1.wav` | 6.1 s | -20.2 dBFS | 1 (0.2 s) | 1 | 0 | 2.1 s |
| `strum-muted-2.wav` | 6.0 s | -21.7 dBFS | 1 (0.2 s) | 1 | 0 | 2.1 s |
| `strum-muted-3.wav` | 4.8 s | -19.1 dBFS | 1 (0.1 s) | 1 | 0 | 2.1 s |
| `strum-muted-4.wav` | 5.0 s | -22.2 dBFS | 1 (0.0 s) | 1 | 0 | 2.1 s |
| `strum-muted-5.wav` | 5.6 s | -19.3 dBFS | 1 (0.2 s) | 1 | 0 | 2.1 s |
| `strum-muted-6.wav` | 5.6 s | -17.0 dBFS | 1 (0.1 s) | 1 | 0 | 2.1 s |

### 4b. Per-strum results

"weakest term" is the `min()` of the seven confidence terms — the one that
decided this string's confidence. For an unconfirmed string it is the gate that
held it back, and "achieved / needs" is the shortfall in that term's own units.

**`5strum.wav`** — 5 strums

| # | onset | captured by the app? | confirmed | refusal | per-string cents |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.13 s | yes | 6/6 | — | -2.7 -2.4 -0.2 -2.6 -4.6 -0.7 |
| 2 | 3.12 s | yes | 6/6 | — | -3.0 -2.7 -0.1 -2.4 -4.2 -0.8 |
| 3 | 6.07 s | yes | 6/6 | — | -1.0 -2.7 -0.0 -2.8 -3.9 -0.7 |
| 4 | 9.20 s | yes | 6/6 | — | -3.2 -2.1 +0.1 -2.8 -3.8 -0.6 |
| 5 | 12.07 s | yes | 6/6 | — | -3.4 -2.1 +0.3 -2.3 -3.8 -0.3 |

**Strum 1** at 0.13 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 73 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -2.71 | +3.99 | -6.70 | 1.00 | tSnr | 29.8 dB | 5.8 dB |
| A2 | yes | -2.36 | -2.84 | +0.48 | 1.00 | tSnr | 31.1 dB | 5.8 dB |
| D3 | yes | -0.17 | -0.02 | -0.15 | 1.00 | tSnr | 30.4 dB | 5.8 dB |
| G3 | yes | -2.60 | -4.79 | +2.19 | 1.00 | tSnr | 28.7 dB | 5.8 dB |
| B3 | yes | -4.58 | -0.29 | -4.29 | 1.00 | tSnr | 23.1 dB | 5.8 dB |
| E4 | yes | -0.67 | -1.29 | +0.62 | 1.00 | tSnr | 23.4 dB | 5.8 dB |



**Strum 2** at 3.12 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 35 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -3.00 | +3.99 | -6.99 | 1.00 | tSnr | 25.4 dB | 5.8 dB |
| A2 | yes | -2.74 | -2.84 | +0.10 | 1.00 | tSnr | 30.5 dB | 5.8 dB |
| D3 | yes | -0.08 | -0.02 | -0.06 | 1.00 | tSnr | 31.1 dB | 5.8 dB |
| G3 | yes | -2.43 | -4.79 | +2.36 | 1.00 | tSnr | 31.4 dB | 5.8 dB |
| B3 | yes | -4.20 | -0.29 | -3.91 | 1.00 | tSnr | 21.7 dB | 5.8 dB |
| E4 | yes | -0.77 | -1.29 | +0.52 | 1.00 | tSnr | 27.2 dB | 5.8 dB |



**Strum 3** at 6.07 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 37 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -1.00 | +3.99 | -4.98 | 0.98 | tResid | 4.3 c | 14.2 c |
| A2 | yes | -2.72 | -2.84 | +0.12 | 1.00 | tSnr | 31.7 dB | 5.8 dB |
| D3 | yes | -0.04 | -0.02 | -0.02 | 1.00 | tSnr | 30.2 dB | 5.8 dB |
| G3 | yes | -2.83 | -4.79 | +1.96 | 1.00 | tSnr | 29.9 dB | 5.8 dB |
| B3 | yes | -3.90 | -0.29 | -3.60 | 1.00 | tSnr | 20.5 dB | 5.8 dB |
| E4 | yes | -0.73 | -1.29 | +0.56 | 1.00 | tSnr | 29.1 dB | 5.8 dB |



**Strum 4** at 9.20 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 35 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -3.17 | +3.99 | -7.16 | 1.00 | tSnr | 24.2 dB | 5.8 dB |
| A2 | yes | -2.06 | -2.84 | +0.78 | 1.00 | tSnr | 29.3 dB | 5.8 dB |
| D3 | yes | +0.09 | -0.02 | +0.11 | 1.00 | tSnr | 27.9 dB | 5.8 dB |
| G3 | yes | -2.80 | -4.79 | +1.99 | 1.00 | tSnr | 29.2 dB | 5.8 dB |
| B3 | yes | -3.82 | -0.29 | -3.53 | 1.00 | tSnr | 18.8 dB | 5.8 dB |
| E4 | yes | -0.59 | -1.29 | +0.70 | 1.00 | tSnr | 25.8 dB | 5.8 dB |



**Strum 5** at 12.07 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 33 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -3.38 | +3.99 | -7.36 | 0.99 | tSnr | 15.8 dB | 5.8 dB |
| A2 | yes | -2.07 | -2.84 | +0.77 | 1.00 | tSnr | 27.4 dB | 5.8 dB |
| D3 | yes | +0.34 | -0.02 | +0.37 | 1.00 | tSnr | 29.4 dB | 5.8 dB |
| G3 | yes | -2.33 | -4.79 | +2.46 | 1.00 | tSnr | 29.4 dB | 5.8 dB |
| B3 | yes | -3.79 | -0.29 | -3.50 | 1.00 | tSnr | 21.0 dB | 5.8 dB |
| E4 | yes | -0.30 | -1.29 | +0.99 | 1.00 | tSnr | 26.8 dB | 5.8 dB |



**`strum-detuned.wav`** — detuned — 3 strums — _errors not scored: re-tuned since the solo clips, and no `truthCents` in manifest.json_

| # | onset | captured by the app? | confirmed | refusal | per-string cents |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.26 s | yes | 6/6 | — | -23.4 -0.8 +1.4 -0.8 -21.0 +0.3 |
| 2 | 5.95 s | yes | 6/6 | — | -22.9 -0.9 +1.5 -0.8 -21.2 +0.3 |
| 3 | 11.53 s | yes | 6/6 | — | -22.3 -1.1 +1.3 -0.8 -20.9 +0.4 |

**Strum 1** at 0.26 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 60 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -23.39 | — | — | 1.00 | tSnr | 35.6 dB | 5.8 dB |
| A2 | yes | -0.84 | — | — | 1.00 | tSnr | 41.6 dB | 5.8 dB |
| D3 | yes | +1.40 | — | — | 1.00 | tSnr | 38.0 dB | 5.8 dB |
| G3 | yes | -0.78 | — | — | 1.00 | tSnr | 34.7 dB | 5.8 dB |
| B3 | yes | -21.00 | — | — | 1.00 | tSnr | 24.8 dB | 5.8 dB |
| E4 | yes | +0.28 | — | — | 1.00 | tSnr | 31.0 dB | 5.8 dB |



**Strum 2** at 5.95 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 38 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -22.94 | — | — | 1.00 | tSnr | 34.5 dB | 5.8 dB |
| A2 | yes | -0.91 | — | — | 1.00 | tSnr | 41.1 dB | 5.8 dB |
| D3 | yes | +1.46 | — | — | 1.00 | tSnr | 38.2 dB | 5.8 dB |
| G3 | yes | -0.75 | — | — | 1.00 | tSnr | 37.8 dB | 5.8 dB |
| B3 | yes | -21.19 | — | — | 1.00 | tSnr | 28.5 dB | 5.8 dB |
| E4 | yes | +0.31 | — | — | 1.00 | tSnr | 31.3 dB | 5.8 dB |



**Strum 3** at 11.53 s — captured by the app; N=16384, 9 frames, 6/6 confirmed, 33 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -22.25 | — | — | 1.00 | tSnr | 33.1 dB | 5.8 dB |
| A2 | yes | -1.10 | — | — | 1.00 | tSnr | 36.8 dB | 5.8 dB |
| D3 | yes | +1.32 | — | — | 1.00 | tSnr | 35.1 dB | 5.8 dB |
| G3 | yes | -0.79 | — | — | 1.00 | tSnr | 34.4 dB | 5.8 dB |
| B3 | yes | -20.91 | — | — | 1.00 | tSnr | 25.5 dB | 5.8 dB |
| E4 | yes | +0.45 | — | — | 1.00 | tSnr | 28.4 dB | 5.8 dB |



**`strum-muted-1.wav`** — muted (E4 muted)

captured by the app; N=16384, 9 frames, 5/5 confirmed, 58 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -2.87 | +3.99 | -6.85 | 1.00 | tSnr | 31.9 dB | 5.8 dB |
| A2 | yes | -0.98 | -2.84 | +1.86 | 1.00 | tSnr | 38.1 dB | 5.8 dB |
| D3 | yes | +0.90 | -0.02 | +0.92 | 1.00 | tSnr | 36.9 dB | 5.8 dB |
| G3 | yes | -1.55 | -4.79 | +3.24 | 1.00 | tSnr | 34.1 dB | 5.8 dB |
| B3 | yes | -3.22 | -0.29 | -2.93 | 1.00 | tSnr | 26.9 dB | 5.8 dB |
| E4 _(muted)_ | **no** | +3.62 | — | — | 0.00 | tExcl | 1.08 | 1.95 |



**`strum-muted-2.wav`** — muted (B3 muted)

captured by the app; N=16384, 9 frames, 5/5 confirmed, 35 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -1.46 | +3.99 | -5.45 | 1.00 | tSnr | 33.8 dB | 5.8 dB |
| A2 | yes | -0.96 | -2.84 | +1.88 | 1.00 | tSnr | 38.1 dB | 5.8 dB |
| D3 | yes | +1.13 | -0.02 | +1.15 | 1.00 | tSnr | 36.9 dB | 5.8 dB |
| G3 | yes | -1.16 | -4.79 | +3.63 | 1.00 | tSnr | 33.8 dB | 5.8 dB |
| B3 _(muted)_ | **no** | +95.24 | — | — | 0.00 | tEvid | 0.24 | 1.31 |
| E4 | yes | -0.33 | -1.29 | +0.96 | 1.00 | tSnr | 31.9 dB | 5.8 dB |



**`strum-muted-3.wav`** — muted (G3 muted)

captured by the app; N=16384, 9 frames, 5/5 confirmed, 33 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -2.38 | +3.99 | -6.36 | 1.00 | tSnr | 33.5 dB | 5.8 dB |
| A2 | yes | -0.41 | -2.84 | +2.43 | 1.00 | tSnr | 38.4 dB | 5.8 dB |
| D3 | yes | +1.25 | -0.02 | +1.27 | 1.00 | tSnr | 35.1 dB | 5.8 dB |
| G3 _(muted)_ | **no** | -69.92 | — | — | 0.00 | tExcl | 1.49 | 1.95 |
| B3 | yes | -2.67 | -0.29 | -2.38 | 1.00 | tSnr | 27.4 dB | 5.8 dB |
| E4 | yes | -0.25 | -1.29 | +1.04 | 1.00 | tSnr | 34.9 dB | 5.8 dB |



**`strum-muted-4.wav`** — muted (D3 muted)

captured by the app; N=16384, 9 frames, 5/5 confirmed, 32 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -2.27 | +3.99 | -6.25 | 1.00 | tSnr | 33.4 dB | 5.8 dB |
| A2 | yes | -1.16 | -2.84 | +1.68 | 1.00 | tSnr | 36.5 dB | 5.8 dB |
| D3 _(muted)_ | **no** | -17.25 | — | — | 0.00 | tExcl | 1.13 | 1.95 |
| G3 | yes | -1.50 | -4.79 | +3.29 | 1.00 | tSnr | 34.5 dB | 5.8 dB |
| B3 | yes | -2.62 | -0.29 | -2.33 | 1.00 | tSnr | 25.7 dB | 5.8 dB |
| E4 | yes | -0.30 | -1.29 | +0.99 | 1.00 | tSnr | 33.7 dB | 5.8 dB |



**`strum-muted-5.wav`** — muted (A2 muted)

captured by the app; N=16384, 9 frames, 5/5 confirmed, 33 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 | yes | -2.27 | +3.99 | -6.26 | 1.00 | tSnr | 36.1 dB | 5.8 dB |
| A2 _(muted)_ | **no** | -11.32 | — | — | 0.00 | tExcl | 1.05 | 1.95 |
| D3 | yes | +1.53 | -0.02 | +1.56 | 1.00 | tSnr | 38.8 dB | 5.8 dB |
| G3 | yes | -1.15 | -4.79 | +3.64 | 1.00 | tSnr | 36.3 dB | 5.8 dB |
| B3 | yes | -2.30 | -0.29 | -2.01 | 1.00 | tSnr | 27.3 dB | 5.8 dB |
| E4 | yes | -0.18 | -1.29 | +1.10 | 1.00 | tSnr | 34.6 dB | 5.8 dB |



**`strum-muted-6.wav`** — muted (E2 muted)

captured by the app; N=16384, 9 frames, 5/5 confirmed, 48 ms

| string | confirmed | cents | truth | error | conf | weakest term | achieved | needs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2 _(muted)_ | **no** | +0.72 | — | — | 0.00 | tEvid | 0.37 | 1.31 |
| A2 | yes | +0.13 | -2.84 | +2.97 | 1.00 | tSnr | 41.6 dB | 5.8 dB |
| D3 | yes | +1.39 | -0.02 | +1.42 | 1.00 | tSnr | 38.6 dB | 5.8 dB |
| G3 | yes | -1.40 | -4.79 | +3.39 | 1.00 | tSnr | 35.9 dB | 5.8 dB |
| B3 | yes | -2.42 | -0.29 | -2.13 | 1.00 | tSnr | 31.8 dB | 5.8 dB |
| E4 | yes | -0.23 | -1.29 | +1.06 | 1.00 | tSnr | 33.3 dB | 5.8 dB |



### 4c. Accuracy and detection, pooled

Over every strum EVENT — including the ones the recorder did not deliver, which
are marked separately so the two failure modes never get averaged together.

| metric | value |
| --- | --- |
| strum events | 14 (14 delivered by the recorder) |
| strings played | 78 |
| confirmed, all events | 78 (100.0%) |
| **confirmed, events the app actually captured** | **78 / 78 (100.0%)** |
| median abs error vs solo ground truth | 2.00 c |
| p95 abs error | 6.86 c |
| worst abs error | 7.36 c |
| scored on | 7 of 8 clips |
| muted-string clips | 6 |
| **hallucinations** (muted string confirmed) | **0 / 6** |

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

Measured on 8 real strum clip(s): 14 strum events, of
which the app's own recorder delivered 14. Ground truth from
7 solo clip(s).

**No played string went unconfirmed on any strum**, so there is no gate to relax: every proposed value below is a dash by construction.

**Hallucination guard.** 6 muted-string clip(s) are present and are the primary check: any proposed value must confirm 0 of 6 muted strings.

Proposed values are listed below only where the measured evidence supports them;
a dash means the data does not justify moving that parameter.

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
