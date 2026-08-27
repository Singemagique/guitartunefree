# TrueString roadmap

The near-term direction, in order. (History: v1.0 tuner+metronome, v1.1 visual beat stage — flash-free by design, v1.2 practice tools + UX audit, v1.3 noise robustness, v1.4 guided tuning.)

## v1.5 — Sweetened tunings & capo
- Per-string **cent offsets** in the custom tuning editor (and a couple of sweetened factory presets) so targets can sit a few cents off equal temperament — the thing high-end tuners sell.
- **Capo transpose**: shift every target up N frets without creating a new tuning; shown as a small chip next to the tuning selector.

## v2.0 — Polyphonic tuning
Strum once, see all strings at once (PolyTune-style). This is a genuinely different algorithm from the MPM detector: spectral template matching against the selected tuning's expected partials, likely FFT-based with per-string peak tracking. Plan: a research spike first (accuracy target: +-3 cents per string on a clean strum), then a dedicated "strum check" view. Ships only if it meets the bar — the monophonic tuner stays the precision tool.
