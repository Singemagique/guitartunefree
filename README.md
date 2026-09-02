# TrueString <img src="public/icons/favicon.svg" width="28" align="top" />

**Free, lightweight guitar tuner & metronome.** No ads, no accounts, no tracking — just tune true and keep time.

**▶ Live app:** https://singemagique.github.io/guitartunefree/

## Features

- **Auto tuner** — pitch detection from your microphone (McLeod Pitch Method / NSDF, sub-cent parabolic interpolation) with an analog-style needle gauge, cents readout, and per-string targeting that glows green when you're within ±5¢. **Tune all** mode walks you through every string low to high, checks each off as it locks in tune, and re-opens any string that drifts. Built for noisy rooms: an adaptive noise gate, tuning-aware band-pass filtering, median outlier rejection, and pitch-continuity tracking keep it locked on the string, not the background.
- **Strum check** — strum all strings once and see every string's offset at a glance: per-string cents bars, in-tune checks at ±5¢, and honest "couldn't confirm" states. Classical DSP (spectral template matching with inharmonicity fitting), analysed off the main thread, calibrated against real guitar recordings. Refuses to guess when the whole guitar reads a semitone off (capo mismatch). Tunings with one octave pair (Drop D, Drop C) get a **partial board**: every other string is read from the one strum, and the two octave twins are flagged for a solo pluck — a strum contains no evidence that separates two strings an octave apart, which is a measured physical limit, not a missing feature, so tunings with deeper octave overlap (DADGAD, the open tunings) stay Single-mode only. In the Android app, strum capture runs on a **native unprocessed-audio path** (the system WebView's mic processing, which web apps cannot disable, is bypassed entirely). The precision Single-mode tuner is untouched.
- **Manual tuner** — a headstock with tappable string buttons that play Karplus–Strong synthesized reference plucks. Loop a single string or strum them all.
- **Instruments & tunings** — ten guitar presets (Standard E, Drop D, E♭ Standard, D Standard, Drop C, DADGAD, Open G, Open D, Open E, Open A) plus bass (4- and 5-string), ukulele, mandolin, and **sweetened presets** (including James Taylor's offsets) — and a **custom tuning editor** (4–8 strings, any pitches, per-string ±50¢ fine-tuning). A **capo** setting transposes every target so you can tune with the capo clamped on. The selected tuning drives both tuners and is remembered.
- **Drone** — a warm sustained reference tone on any pitch, for intonation practice. Keeps sounding while you tune or use the metronome.
- **Speed trainer** — auto-raise the tempo (+N BPM every M bars up to a target) to build speed gradually.
- **Gap training** — the click drops out every few bars while the pendulum and counter keep going, so you can test your internal clock.
- **Screen stays awake** while the tuner listens, the metronome runs, or the drone sounds.
- **Metronome** — 30–300 BPM with sample-accurate Web Audio lookahead scheduling, accented downbeats, 1–12 beats per bar, quarter/eighth/triplet/sixteenth subdivisions, and "Tap the beat" tempo entry. Keeps ticking while you switch tabs to tune.
- **Visual beat stage** — a swinging pendulum driven off the audio clock (it reaches each extreme exactly as the click sounds, output latency included), a big beat counter, a beat marker that moves along the bar, a full-screen **Big view**, optional **vibrate on beat** (Android), and a mute toggle for a silent visual metronome. Deliberately **flash-free**: the beat is shown only through motion and position, never through blinking or luminance flashes, so it is safe for photosensitive players.
- **A4 calibration** — 415–466 Hz reference (default 440).
- **PWA** — installable, works offline after first load.

## Tech

Vanilla TypeScript + Vite. **Zero runtime dependencies** — all DSP (pitch detection, string synthesis, metronome clicks) is hand-rolled on the Web Audio API. Single dark "midnight stage" theme, system fonts, tiny bundle.

## Develop

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # type-check + production build to dist/
npm run preview  # serve the production build
```

## Android

**Quick install:** grab `TrueString-v2.3.0-debug.apk` from the [latest release](https://github.com/Singemagique/guitartunefree/releases/latest) (or the `truestring-debug-apk` artifact on any [Android CI run](https://github.com/Singemagique/guitartunefree/actions/workflows/android.yml)).

To build it yourself, the app ships as a Capacitor-wrapped Android project in [`android/`](android/).

```bash
npm run cap:sync                 # build web assets + sync into the Android project
npx cap open android             # open in Android Studio, then Run ▶
```

Requirements: Android Studio (or the Android SDK + Gradle). The `RECORD_AUDIO` permission is declared and requested at runtime for the auto tuner.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
