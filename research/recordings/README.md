# Real-guitar recordings for strum-check calibration

Status: `5strum.wav` received — it validated the analyzer (30/30 readings) and found + fixed the onset-detector bug. The clips below complete the calibration. WAV preferred (a voice-recorder app is perfect), 44.1 or 48 kHz, phone at your normal playing distance, quiet room unless stated. **Use these exact filename prefixes** so the pipeline classifies them automatically; drop everything in this folder.

## Essential — anchors the accuracy claim (~8 minutes)

1. `solo-e2.wav`, `solo-a2.wav`, `solo-d3.wav`, `solo-g3.wav`, `solo-b3.wav`, `solo-e4.wav` — each open string plucked ALONE, letting it ring ~5 s. Standard tuning, tuned to 0 first with Single mode (or note what Single reads and say so). These give per-string ground truth, your strings' real inharmonicity, and their polarisation behaviour.
2. `solo-a2-long.wav` — the open A string alone, ringing as long as it will (15-20 s, re-pluck once if it dies early). The A string's polarisation beat is too slow to measure in a 5 s clip; this one clip settles it.
3. `polar-parallel.wav` and `polar-perp.wav` — the low E alone, ~6 s each: once picking parallel to the soundboard, once perpendicular. Measures the polarisation depth extremes every accuracy number depends on.

## High value — validates the safety gates (~4 minutes)

4. `strum-muted-1.wav` … `strum-muted-6.wav` — six strums, each with ONE string muted by the fretting hand (file number = which string is muted, 1 = high E … 6 = low E). This measures the hallucination rate on real audio — whether the app ever claims a string you did not play.
5. `strum-detuned.wav` — detune the B string ~20¢ flat and the low E ~30¢ flat (check with Single mode first), then three strums in one clip, ~3 s apart. Tests the adjust-and-restrum regime the feature exists for.

## Nice to have (~2 minutes)

6. `strum-up.wav` — three up-strums in one clip (reverses the string-onset order; everything so far is down-strums).
7. `strum-noisy.wav` — two strums with a fan/TV/traffic clearly audible.
8. `chrome-capture-*.wav` — in Chrome on the phone, after a good strum reading, tap "Save last strum (debug)" and drop the file here. Compares Chrome's real getUserMedia path against the voice-recorder path.

If any clip is missing the pipeline runs anyway and says what it could not fit. `node research/calibrate/report.mjs` produces the full calibration report. (This set did its job: the 2026-08-30 run confirmed 114/114 played strings, 0 hallucinations, median 2.0¢, and the shipped thresholds unchanged — the beta label is retired.)
