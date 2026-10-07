/**
 * What the navigation under way says, for the shell's one status line and page-wide bar
 * (`nav-pending.tsx`, review of #2095): "Opening Workers…", "Applying the filters…". A plain
 * external store, read with `useSyncExternalStore`, so the shell holds no state of its own for it.
 *
 * Each pending cue ANNOUNCES its message and gets a token back; it WITHDRAWS that token when its
 * navigation ends or it unmounts. A withdrawal clears the store only if its token is still the
 * current one, so the cue clicked first can never clear the message of the one clicked after it.
 *
 * Written only from effects, so on the server it is always empty — which is also what the client
 * holds at hydration.
 */
type Pending = { token: number; message: string };

let current: Pending | null = null;
let lastToken = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** Say `message` while a navigation is pending; returns the token that withdraws it. */
export function announceNavigation(message: string): number {
  lastToken += 1;
  current = { token: lastToken, message };
  emit();
  return lastToken;
}

/** End the navigation `token` announced — a no-op if a later one has replaced it. */
export function withdrawNavigation(token: number): void {
  if (current?.token !== token) return;
  current = null;
  emit();
}

/** What the navigation under way says, or null. */
export function pendingNavigation(): string | null {
  return current?.message ?? null;
}

export function subscribeNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget every announcement and subscriber. */
export function resetNavigationForTests(): void {
  current = null;
  lastToken = 0;
  listeners.clear();
}
