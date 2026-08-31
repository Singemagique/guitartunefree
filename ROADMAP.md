# TrueString roadmap

The near-term direction, in order. (History: v1.0 tuner+metronome, v1.1 visual beat stage — flash-free by design, v1.2 practice tools + UX audit, v1.3 noise robustness, v1.4 guided tuning, v1.5 sweetened tunings + capo, v2.0 strum check beta, v2.1 native unprocessed capture on Android, v2.2 partial strum support + beta label off.)

## RESOLVED (v2.2) — Octave-pair separation, and what replaced it

The v2.0 beta shipped with two open items: calibrate against real recordings, and separate octave pairs so Drop D / DADGAD-class tunings could stop being gated. Both are now closed by measurement, and the beta label is off.

**Full separation is a NO-GO, and permanently.** A separator was built and put to adversarial verification. A string in exact octave unison with its parent has no independent spectral evidence under this app's 2 kHz analysis band — every partial it contributes is a partial the parent already contributes. On held-out draws the separator told **11 confident >10 cent lies per ~3,400 readings** where the shipped analyser tells **1**, and it still left the octave child **unconfirmed 63% of the time on a guitar that was in tune**. Nothing was gained and the mode's one promise — never show a number it does not trust — was lost. It is not shipped and it is not pending.

**Partial strum support IS shipped.** An 8,300-trial measurement found that in a tuning with EXACTLY ONE octave pair, the SHIPPED analyser reads the four non-pair strings at full spec with the pair ringing: **99.1% detection, zero errors over 10 cents**, confirmed at capo 1-3, at 44.1 and 48 kHz, and at 100% on real-audio pseudo-strums. The whole-offset refusal holds at its **98.3%** spec provided the analysis is given ALL strings. So Drop D and Drop C now show a partial board — the four other strings read from the strum, the pair's two rows labelled "octave twin, pluck it alone" — and the copy for deeper-overlap tunings says what is true of any tuner rather than promising a version that will not come.

**Drop-D bass is excluded.** One pair, but at D1 = 36.7 Hz the whole-offset refusal was measured **leaking at 81.7%** against that 98.3% spec, and a refusal that leaks is the one failure this mode may not have. The gate requires the lowest target at or above 60 Hz (Drop C's C2 at 65.4 Hz passes) and at least three non-pair strings.

**A gate hole was closed on the way.** The old integer-midi test waved through a custom tuning with two strings 11 semitones apart fine-tuned −50 and +50 cents — an exact frequency octave, measured hallucinating the upper string in **16.7%** of trials. The gate now tests composed frequencies (within 35 cents of 1200) as well as midi distance.

### If anyone returns to this
- **Strum-level, not per-frame, pair arbitration** is the only credible path left: decide once per strum which member of a pair the evidence belongs to, using onset timing and decay slope across the whole window, rather than asking each frame to split a spectrum that does not separate. Per-frame arbitration is what was measured and rejected.
- **The contamination-ceiling split** (`contamPartials` 18 → 48) is deliberately NOT shipped. It is inert on the real corpus, and it was never validated in combination with the new partial scope — an inert-looking change to the contaminant model under a scope that now deliberately analyses strings it will not display is exactly the combination nobody has measured.
