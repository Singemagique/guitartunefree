# TrueString roadmap

The near-term direction, in order. (History: v1.0 tuner+metronome, v1.1 visual beat stage — flash-free by design, v1.2 practice tools + UX audit, v1.3 noise robustness, v1.4 guided tuning, v1.5 sweetened tunings + capo, v2.0 strum check beta.)

## v2.0.x — Strum check: from beta to stable
Shipped in beta (v2.0.0): validated on synthetic strums with adversarially-verified accuracy (typical medians 0.3-0.5 cents; the promise is +-5). To drop the beta label: calibrate against real recordings (research/recordings/README.md) — fit actual per-string inharmonicity and polarisation behaviour, re-tune confidence gates, and solve the octave-pair separation that currently keeps Drop D / DADGAD-class tunings gated.
