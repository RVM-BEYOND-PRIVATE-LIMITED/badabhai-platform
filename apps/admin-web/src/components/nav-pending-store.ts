/**
 * Which nav link's navigation is under way, for the shell's one status line and page-wide bar
 * (`nav-pending.tsx`, review of #2095). A plain external store, read with `useSyncExternalStore`,
 * so the shell holds no state of its own for it.
 *
 * Each pending link ANNOUNCES its label and gets a token back; it WITHDRAWS that token when its
 * navigation ends or it unmounts. A withdrawal clears the store only if its token is still the
 * current one, so the link clicked first can never clear the label of the one clicked after it.
 *
 * Written only from effects, so on the server it is always empty — which is also what the client
 * holds at hydration.
 */
type Pending = { token: number; label: string };

let current: Pending | null = null;
let lastToken = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** Mark `label`'s navigation pending; returns the token that withdraws it. */
export function announceNavigation(label: string): number {
  lastToken += 1;
  current = { token: lastToken, label };
  emit();
  return lastToken;
}

/** End the navigation `token` announced — a no-op if a later one has replaced it. */
export function withdrawNavigation(token: number): void {
  if (current?.token !== token) return;
  current = null;
  emit();
}

/** The label of the navigation under way, or null. */
export function pendingNavigation(): string | null {
  return current?.label ?? null;
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
