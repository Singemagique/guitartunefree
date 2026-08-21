# TrueString <img src="public/icons/favicon.svg" width="28" align="top" />

**Free, lightweight guitar tuner & metronome.** No ads, no accounts, no tracking — just tune true and keep time.

**▶ Live app:** https://singemagique.github.io/guitartunefree/

## Features

- **Auto tuner** — pitch detection from your microphone (McLeod Pitch Method / NSDF, sub-cent parabolic interpolation) with an analog-style needle gauge, cents readout, and per-string targeting that glows green when you're within ±5¢.
- **Manual tuner** — a 3+3 headstock with tappable string buttons that play Karplus–Strong synthesized reference plucks. Loop a single string or strum all six.
- **Tuning presets** — Standard E, Drop D, E♭ Standard, D Standard, Drop C, DADGAD, Open G, Open D, Open E, Open A. The selected tuning drives both tuners and is remembered.
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

**Quick install:** grab `TrueString-v1.1.1-debug.apk` from the [latest release](https://github.com/Singemagique/guitartunefree/releases/latest) (or the `truestring-debug-apk` artifact on any [Android CI run](https://github.com/Singemagique/guitartunefree/actions/workflows/android.yml)).

To build it yourself, the app ships as a Capacitor-wrapped Android project in [`android/`](android/).

```bash
npm run cap:sync                 # build web assets + sync into the Android project
npx cap open android             # open in Android Studio, then Run ▶
```

Requirements: Android Studio (or the Android SDK + Gradle). The `RECORD_AUDIO` permission is declared and requested at runtime for the auto tuner.

## License

[MIT](LICENSE)
