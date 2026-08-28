# TrueString roadmap

The near-term direction, in order. (History: v1.0 tuner+metronome, v1.1 visual beat stage — flash-free by design, v1.2 practice tools + UX audit, v1.3 noise robustness, v1.4 guided tuning, v1.5 sweetened tunings + capo.)

## v2.0 — Polyphonic tuning
Strum once, see all strings at once (PolyTune-style). This is a genuinely different algorithm from the MPM detector: spectral template matching against the selected tuning's expected partials, likely FFT-based with per-string peak tracking. Plan: a research spike first (accuracy target: +-3 cents per string on a clean strum), then a dedicated "strum check" view. Ships only if it meets the bar — the monophonic tuner stays the precision tool.
