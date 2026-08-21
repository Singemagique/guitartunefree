# TrueString (guitartunefree) — Build Specification

A free, lightweight, bespoke guitar tuner + metronome. Web PWA (vanilla TypeScript + Vite, zero runtime deps) wrapped for Android with Capacitor.

**Product name:** TrueString. **Tagline:** "Tune true. Keep time."

## Feature set

1. **Auto tuner** — listens on the microphone, detects pitch (MPM/NSDF), shows nearest target string of the selected tuning (or chromatic nearest note), cents offset on an analog-style needle gauge, green glow when within ±5 cents.
2. **Manual tuner** — six string buttons laid out like a headstock; tapping plucks a synthesized (Karplus–Strong) reference tone for that string in the selected tuning. Loop toggle re-plucks every 2 s.
3. **Tuning presets** — Standard E, Drop D, E♭ Standard, D Standard, Drop C, DADGAD, Open G, Open D, Open E, Open A. Selected tuning drives both tuners. Persisted to localStorage.
4. **Metronome** — 30–300 BPM, beats-per-bar 1–12 with accented downbeat, subdivisions (quarter/eighth/triplet/sixteenth), tap tempo, sample-accurate Web Audio lookahead scheduling, and a flash-free visual beat stage (pendulum, counter, moving beat marker, big view, vibrate, mute — see v1.1 below).
5. **Calibration** — A4 reference 415–466 Hz (default 440), in a small settings popover. Persisted.

## Design system (bespoke — "midnight stage")

All in `src/style.css` as CSS custom properties on `:root`:

```css
--bg: #0f1317;          /* near-black blue-charcoal page  */
--panel: #171d23;       /* card surface                    */
--panel-2: #1d242c;     /* raised surface                  */
--line: #29323c;        /* hairline borders                */
--text: #f0e9dc;        /* warm cream                      */
--muted: #8b96a0;       /* secondary text                  */
--amber: #ffb454;       /* brand accent — tube-amp glow    */
--amber-deep: #e08f2d;
--green: #63d68c;       /* in tune                         */
--red: #ff6f66;         /* far off / stop states           */
--radius: 16px;
```

System font stack (`-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`); big numeric readouts use `font-variant-numeric: tabular-nums`. Buttons/cards: soft 1px `--line` borders, subtle inner highlight, amber focus rings. The app is a single dark theme (it's a stage tool) — no light mode. Layout is mobile-first, max-width 480px column centered on desktop with a subtle page vignette. Bottom tab bar (3 tabs: Auto, Manual, Metronome) with inline SVG icons, active tab amber. Header: wordmark "TrueString" (cream, with amber dot over the i or an amber tuning-fork glyph), tuning selector chip on the right that opens a bottom sheet listing tuning presets, plus a small gear button for the A4 calibration popover. Respect `env(safe-area-inset-*)` paddings. `touch-action: manipulation` on controls; no 300 ms delays; controls min 44px hit targets.

## File layout

```
index.html            (already written — #app root, mounts src/main.ts)
src/
  main.ts             app shell: header, tab bar, view mounting, sheet/popover, SW registration
  style.css           design tokens + base + shell + shared primitives (imported by main.ts)
  state.ts            tiny store: { tuningId, a4 } persisted to localStorage
  music/notes.ts      note math
  music/tunings.ts    tuning preset data
  audio/context.ts    shared lazy AudioContext
  audio/pitch.ts      MPM pitch detector (pure DSP, no DOM)
  audio/mic.ts        microphone capture → time-domain frames
  audio/synth.ts      Karplus–Strong pluck
  audio/metronome.ts  lookahead scheduler engine
  ui/tuner-view.ts    auto tuner view (SVG needle gauge)   + ui/tuner-view.css
  ui/manual-view.ts   manual tuner view (headstock)        + ui/manual-view.css
  ui/metronome-view.ts metronome view                      + ui/metronome-view.css
public/
  manifest.webmanifest, sw.js, icons/
```

### CSS ownership

`src/style.css` (imported by main.ts) owns: `:root` tokens, reset/base, page layout, header, tab bar, bottom sheet, popover, and **shared primitives** that every view must reuse by these exact class names:

- `.btn` (base button), `.btn-primary` (amber filled), `.btn-ghost` (outline)
- `.icon-btn` (44px square icon-only button)
- `.chip` (small rounded label button)
- `.card` (panel surface, radius, border)
- `.seg` / `.seg-item` / `.seg-item.is-active` (segmented control)
- `.pill` / `.pill.is-active` (note pills; `.is-active` = amber highlight)
- `.sr-only` (visually hidden)

Each view module does `import './tuner-view.css'` (etc.) at the top and keeps ALL of its view-specific styles in its own CSS file, using only the `:root` tokens plus the shared primitives above. View-specific class names are prefixed: `.tv-*` (tuner), `.mv-*` (manual), `.nv-*` (metronome) to guarantee zero collisions.

## Exact module contracts (do not deviate — other agents compile against these)

### src/music/notes.ts
```ts
export interface NoteInfo { midi: number; name: string; /* "E2" */ pc: string; /* "E", "F#" */ octave: number; freq: number; }
export const NOTE_NAMES: readonly string[]; // ["C","C#","D",..., "B"] sharps only
export function midiToFreq(midi: number, a4?: number): number;      // a4 default 440
export function freqToMidi(freq: number, a4?: number): number;      // fractional midi
export function midiToNote(midi: number, a4?: number): NoteInfo;    // midi may be fractional; rounds
export function nearestNote(freq: number, a4?: number): { note: NoteInfo; cents: number };
export function centsBetween(freq: number, targetFreq: number): number; // 1200*log2(freq/target)
```

### src/music/tunings.ts
```ts
import type { NoteInfo } from './notes';
export interface Tuning { id: string; name: string; /* "Standard E" */ detail: string; /* "E A D G B E" */ midis: readonly number[]; /* low→high, 6 entries, e.g. standard = [40,45,50,55,59,64] */ }
export const TUNINGS: readonly Tuning[];        // the 10 presets listed above, standard first, id "standard"
export function tuningById(id: string): Tuning; // falls back to standard on unknown id
export function tuningNotes(t: Tuning, a4?: number): NoteInfo[]; // low→high
```

### src/state.ts
```ts
export interface AppState { tuningId: string; a4: number; }
export function getState(): AppState;
export function setState(partial: Partial<AppState>): void;    // merges, persists to localStorage key "truestring:v1", notifies
export function subscribe(fn: (s: AppState) => void): () => void;
```

### src/audio/context.ts
```ts
export function getAudioContext(): AudioContext;              // lazy singleton
export async function ensureRunning(): Promise<AudioContext>; // resume() if suspended (call from user gestures)
```

### src/audio/pitch.ts  (pure — no DOM, no imports from other app modules)
```ts
export interface PitchResult { freq: number; clarity: number; /* 0..1 */ }
export class PitchDetector {
  constructor(sampleRate: number, bufferSize?: number); // default 2048; callers pass MicCapture.bufferSize
  detect(buf: Float32Array): PitchResult | null;        // null = no confident pitch
}
```
Implementation: McLeod Pitch Method — NSDF, key-maximum picking with `k = 0.9`, parabolic interpolation for sub-bin accuracy. Reject when clarity < 0.88, RMS < 0.005, or freq outside 55–1100 Hz. Reuse internal scratch buffers (no per-call allocation).

### src/audio/mic.ts
```ts
export class MicCapture {
  readonly bufferSize: number;               // power of two sized from the context sample rate so lags down to 55 Hz fit (2048 at ≤48 kHz)
  get running(): boolean;
  get sampleRate(): number;                  // valid after start()
  async start(): Promise<void>;              // throws Error("mic-denied") on permission failure
  stop(): void;                              // stops tracks, disconnects
  read(target: Float32Array): void;          // fills target (length bufferSize) with latest time-domain data
}
```
getUserMedia constraints: `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }`. Uses an AnalyserNode (fftSize 2048) on the shared AudioContext.

### src/audio/synth.ts
```ts
export function pluck(freq: number, opts?: { gain?: number; seconds?: number }): void; // defaults gain 0.5, seconds 2.5
```
Karplus–Strong: fill a Float32Array with the KS algorithm (noise burst → averaging feedback loop, decay factor ~0.996 adjusted for freq), play via AudioBufferSourceNode → gentle lowpass (~4 kHz) → gain envelope → destination on the shared context. Deterministic, no per-note oscillator graphs left running.

### src/audio/metronome.ts
```ts
export type Subdivision = 1 | 2 | 3 | 4; // quarter, eighth, triplet, sixteenth
export class Metronome {
  bpm: number;                    // clamped 30–300
  beatsPerBar: number;            // clamped 1–12
  subdivision: Subdivision;
  get running(): boolean;
  onBeat: ((beatInBar: number, isAccent: boolean) => void) | null; // fired ~when the audible beat plays (use setTimeout aligned to ctx time); beatInBar 0-based, only for main beats not subdivisions
  start(): void;
  stop(): void;
  tap(): number | null;           // tap tempo; returns new bpm once ≥2 taps within 2s window
}
```
Lookahead scheduler: `setInterval` 25 ms, schedule 0.12 s ahead on the shared AudioContext. Click voices (all synthesized, no samples): accent = 1800 Hz, beat = 1200 Hz, subdivision tick = 900 Hz at lower gain; short sine blip with 1 ms attack / 40 ms exponential decay through a highpass ~600 Hz for a woody click. Live changes to bpm/subdivision take effect without restart.

### UI views — each exports one mount function:
```ts
import type { AppState } from '../state';
export interface ViewHandle { el: HTMLElement; show(): void; hide(): void; }
// tuner-view.ts:      export function createTunerView(): ViewHandle;
// manual-view.ts:     export function createManualView(): ViewHandle;
// metronome-view.ts:  export function createMetronomeView(): ViewHandle;
```
Views build their own DOM (document.createElement / innerHTML templates are both fine), read `getState()` and `subscribe()` for tuning/a4 changes, and use the audio modules directly. `show()`/`hide()` toggle activity: the tuner view must stop the mic when hidden; the manual view stops its loop; the metronome KEEPS running when its view is hidden (musicians tune while the click plays) but exposes a clear running indicator on its tab via a `truestring:metronome-running` CustomEvent dispatched on `window` with `detail: { running: boolean }`.

#### Auto tuner view specifics
- Big SVG gauge: 240°-ish arc spanning −50…+50 cents, minor ticks every 5, labeled −50/−25/0/+25/+50; needle pivots from bottom center; smooth needle via exponential smoothing (α≈0.25) in a rAF loop; needle/arc glow green when |cents| ≤ 5 for 3 consecutive frames, amber otherwise.
- Readout: huge note pitch-class + octave (e.g. **E**₂), detected frequency "82.4 Hz", cents "+3¢".
- String strip: the 6 target notes of the current tuning as pills; auto-highlights the nearest string to the detected pitch; flat/sharp arrows hint direction ("tune up ↑" / "tune down ↓").
- Mic starts on a big "Start listening" button (browser requires a gesture) and on `show()` if previously granted this session; stopped on `hide()`. Mic-denied state renders inline guidance.
- When no confident pitch for >600 ms, gauge relaxes to idle (needle drifts to center at low opacity, readout dims to "—").

#### Manual tuner view specifics
- Headstock-style layout: stylized 3+3 headstock (pure CSS/SVG, amber on panel) with six round string buttons labeled with the tuning's notes (low string left-bottom). Tap: `pluck()` that string; button ripples/glows amber while ringing.
- "Loop" toggle: re-plucks the selected string every 2 s until toggled off or view hidden. "Strum" button plays all six low→high at 120 ms intervals.

#### Metronome view specifics
- Giant BPM readout with ± steppers (press-and-hold repeats), a drag wheel/slider 30–300, tap-tempo button.
- Beat dots row (beatsPerBar dots, first amber-filled = accent) pulsing on onBeat; beats-per-bar stepper 1–12; subdivision segmented control (♩, ♫, triplet, ♬ — use inline SVG or text glyphs).
- Start/stop: one large round transport button (amber → red morph).

### src/main.ts
- Builds shell inside `#app`: header (wordmark, tuning chip, gear), `<main>` view container, bottom tab bar.
- Tab switching calls hide()/show() appropriately; keeps all three views mounted (display:none when hidden).
- Tuning chip opens a bottom sheet (overlay + slide-up panel, dismiss on scrim tap / Esc) listing TUNINGS with name + detail; current one checked; tap selects via setState and closes.
- Gear opens small popover: A4 stepper 415–466 (buttons ±1, default 440, "Reset 440" link).
- Listens for `truestring:metronome-running` to badge the metronome tab with a small pulsing amber dot.
- Registers `sw.js` service worker on load in production (`import.meta.env.PROD`).
- First paint must not require mic permission.

## PWA
- `public/manifest.webmanifest`: name "TrueString — Guitar Tuner & Metronome", short_name "TrueString", display standalone, background/theme `#0f1317`, icons 192/512 + maskable, start_url "./", scope "./".
- `public/sw.js`: network-first for navigations/shell (so deploys reach returning users), cache-first for hashed assets, runtime caching + old-cache cleanup, precache "./" on install, `self.skipWaiting()` + `clients.claim()`.
- `index.html` links manifest, theme-color, viewport-fit=cover, description meta, favicon.svg.

## Quality bars
- `npm run build` passes with strict TS, zero errors.
- No runtime dependencies; bundle (gz) target < 30 kB JS.
- No console errors on load; tuner view usable with mic denied (shows guidance, rest of app fine).
- All interactive elements keyboard-focusable with visible focus; aria-labels on icon-only buttons; `aria-pressed`/`aria-selected` where applicable.
- 60 fps needle (rAF, transform-only animation, no layout thrash).

## v1.1 — Visual metronome + tap tempo clarity

### Engine additions (src/audio/metronome.ts)
```ts
export interface BeatClock {
  beat: number;       // absolute main-beat count since start() (0-based, monotonic while running)
  beatInBar: number;  // 0-based, already wrapped to the live beatsPerBar
  phase: number;      // 0..1 progress through the current beat, in *audible* time
  interval: number;   // seconds per main beat at the live bpm
}
class Metronome {
  get muted(): boolean; set muted(v: boolean); // silences the click bus (5 ms ramp) without stopping the grid; onBeat/beatClock keep going
  beatClock(): BeatClock | null;               // null when not running or before the first beat is audible
}
```
`beatClock()` is computed from the scheduler's own record of scheduled main beats (keep the last few `{time, beat, beatInBar}` entries), evaluated at `ctx.currentTime - (outputLatency || baseLatency || 0)` so visuals line up with what the ear hears, not with graph-input time. `phase` uses the live `60/bpm` interval (the next beat may not be scheduled yet inside the 0.12 s lookahead at slow tempos) and is clamped to `[0, 1)`.

### Beat stage (src/ui/metronome-view.ts + .css, `.nv-stage*` classes)

**No flashing, anywhere.** Luminance flashes can trigger seizures in photosensitive people and a metronome is watched for long stretches, so the stage communicates the beat only through *continuous motion* and *moving state* — never through a wash, glow pulse, or blink. (WCAG 2.3.1/2.3.2 as a floor; the design goal is zero flash, not a capped rate.)

Placed directly under the transport button — the thing you look at while playing:
- **Pendulum**: inline SVG, pivot at bottom-center, arm swings ±26° and reaches an extreme exactly on each main beat (`angle = A · cos(π · (beat + phase))`), bob on the upper third of the arm. Driven by a `requestAnimationFrame` loop reading `metro.beatClock()` — transform-only updates on the arm group. Runs only while the metronome runs *and* the view is visible. At rest the arm hangs straight up, dimmed.
- **Beat counter**: large tabular numeral (1…beatsPerBar), amber on the downbeat, cream otherwise. On each beat the text changes and the numeral does a small scale "tick" (transform only, ≤ 1.08×, ~120 ms) — no glow, no colour blink. Shows "–" dimmed when stopped.
- **Beat marker**: the bar dots along the stage's bottom edge become a *position* indicator: the current beat's dot is filled (amber on the downbeat, cream otherwise) and the previous one empties — the fill moves from dot to dot and stays put between beats. No pulse animation.
- **Big view** (`.nv-big` toggle button in the stage's tool group, `aria-pressed`, label "Big view"; Escape also closes it): the stage expands to fill the viewport (`position: fixed; inset: 0`, same DOM so the same rAF loop drives it) with the pendulum scaled to the screen, the counter very large, the current BPM shown small, a start/stop button inside the stage (`.nv-stage-transport`, mirrors the main transport) and a close control. This is the "see the beat from across the room" mode — large motion instead of light. Body scroll locks while open; focus moves into the stage and returns on close.
- **Vibrate** (`.nv-vibe` toggle, `aria-pressed`, label "Vibrate on beat"): `navigator.vibrate(isAccent ? 30 : 15)` on each main beat, fired from `onBeat`. The button is rendered only if `navigator.vibrate` exists. A haptic channel for when the click can't be heard.
- **Mute** (`.nv-mute`, `aria-pressed`, static label "Mute click"): toggles `metro.muted`; pendulum, counter, marker and vibration keep working — a silent visual metronome. A small "Click muted" tag shows while muted.
- Prefs persisted in localStorage key `truestring:metronome` as `{ muted, vibrate }` (unknown keys such as the old `screenFlash` are ignored and dropped on next save).
- `prefers-reduced-motion`: the pendulum still moves (it is the function the user asked for) but the counter tick is disabled; nothing else animates.

### Tap tempo (same view)
- Button label becomes **"Tap the beat"**, with a caption under it (`.nv-tap-hint`, linked via `aria-describedby`): *"Tap along with any song and the BPM follows."*
- Live feedback replaces the caption while tapping: after the first tap "Keep tapping…", from the second tap "Set to 132 BPM" (updates on every tap); reverts to the explanation 2.5 s after the last tap (matches the engine's 2 s tap window plus a grace).
- The button still flashes on each tap; Space/Enter work as taps.
