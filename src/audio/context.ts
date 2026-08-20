let ctx: AudioContext | null = null;
/** Set once a client has asked for a running clock, so the lifecycle hooks only
 *  revive a context the app actually wants running. */
let wanted = false;

/**
 * Mobile browsers suspend WebAudio when the page goes to the background, and
 * WebKit parks it in a non-standard 'interrupted' state after a phone call.
 * Either way currentTime freezes and every scheduler goes silent while the UI
 * still believes it is playing, and nothing resumes the context on its own.
 */
function revive(): void {
  if (!wanted || !ctx || ctx.state === 'running') return;
  if (document.visibilityState !== 'visible') return;
  void ctx.resume().catch(() => undefined);
}

document.addEventListener('visibilitychange', revive);

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    ctx.addEventListener('statechange', revive);
  }
  return ctx;
}

export async function ensureRunning(): Promise<AudioContext> {
  const context = getAudioContext();
  wanted = true;
  // Not `=== 'suspended'`: WebKit's 'interrupted' state also needs the resume,
  // and skipping it there hands back a dead clock that no restart can fix.
  if (context.state !== 'running') {
    await context.resume();
  }
  return context;
}
