// Ref-counted screen wake lock. The screen has to stay lit while the app is
// doing something the player watches or listens to instead of touching — a mic
// session, a running click, a sustained drone — and several of those can be
// live at once, so the lock is held for a set of reasons and only freed when
// the last one lets go.
//
// Every failure is swallowed on purpose: the API is missing on http, in older
// WebViews and on iOS before 16.4, and a request is refused outright while the
// document is hidden or the battery is low. Where it is unavailable the app
// must behave exactly as it did before.

export type WakeReason = 'tuner' | 'metronome' | 'drone' | 'manual-loop';

const held = new Set<WakeReason>();
let sentinel: WakeLockSentinel | null = null;
let requesting = false;

function acquire(): void {
  const api: WakeLock | undefined = navigator.wakeLock;
  if (!api || sentinel || requesting || held.size === 0) return;
  requesting = true;
  api
    .request('screen')
    .then((lock) => {
      requesting = false;
      // The last reason may have let go while the request was in flight.
      if (held.size === 0) {
        lock.release().catch(() => undefined);
        return;
      }
      sentinel = lock;
      lock.addEventListener('release', () => {
        if (sentinel === lock) sentinel = null;
      });
    })
    .catch(() => {
      // Unsupported or refused. No retry here: the next hold, or a return to
      // visibility, asks again.
      requesting = false;
    });
}

function drop(): void {
  const lock = sentinel;
  sentinel = null;
  lock?.release().catch(() => undefined);
}

export function holdWake(reason: WakeReason): void {
  if (held.has(reason)) return;
  held.add(reason);
  acquire();
}

export function releaseWake(reason: WakeReason): void {
  if (!held.delete(reason)) return;
  if (held.size === 0) drop();
}

// The platform releases the lock whenever the page is hidden and never restores
// it, so re-request on the way back while anything is still held.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquire();
});
