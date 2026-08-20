// Tiny persisted app store: current tuning selection + A4 calibration.

export interface AppState {
  tuningId: string;
  a4: number;
}

const STORAGE_KEY = 'truestring:v1';
const DEFAULT_STATE: AppState = { tuningId: 'standard', a4: 440 };
const A4_MIN = 415;
const A4_MAX = 466;

function clampA4(a4: number): number {
  return Math.min(A4_MAX, Math.max(A4_MIN, a4));
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    const tuningId =
      typeof parsed?.tuningId === 'string' ? parsed.tuningId : DEFAULT_STATE.tuningId;
    const a4 =
      typeof parsed?.a4 === 'number' && Number.isFinite(parsed.a4)
        ? clampA4(parsed.a4)
        : DEFAULT_STATE.a4;
    return { tuningId, a4 };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function persist(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private mode / quota) — state stays in-memory for this session.
  }
}

let state: AppState = loadState();
const listeners = new Set<(s: AppState) => void>();

export function getState(): AppState {
  return state;
}

export function setState(partial: Partial<AppState>): void {
  const next: AppState = { ...state, ...partial };
  if (partial.a4 !== undefined) {
    next.a4 = clampA4(next.a4);
  }
  state = next;
  persist(state);
  for (const fn of listeners) fn(state);
}

export function subscribe(fn: (s: AppState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
