/**
 * Which link's navigation is under way, for the shell's page-wide bar and its one status line
 * (`nav-pending.tsx`). A plain external store, read with `useSyncExternalStore`, so the shell holds
 * no state of its own for it. Mirrors admin-web's store, plus a DELAY.
 *
 * Each pending link ANNOUNCES its label and gets a token back; it WITHDRAWS that token when its
 * navigation ends or it unmounts. A withdrawal clears the store only if its token is still the
 * current one, so the link clicked first can never clear the label of the one clicked after it.
 *
 * THE DELAY: an announcement is SHOWN only once it has been pending for
 * {@link NAV_PENDING_DELAY_MS}. A prefetched navigation commits sooner than that, so it never
 * flashes the bar or speaks "Opening …" for a page that is already there. The link's own dot waits
 * out the same delay in CSS (`--nav-pending-delay`, globals.css).
 *
 * Written only from effects, so on the server it is always empty — which is also what the client
 * holds at hydration.
 */
export const NAV_PENDING_DELAY_MS = 180;

type Pending = { token: number; label: string; shown: boolean };

let current: Pending | null = null;
let lastToken = 0;
let reveal: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

function cancelReveal(): void {
  if (reveal !== null) clearTimeout(reveal);
  reveal = null;
}

/** Mark `label`'s navigation pending (shown after the delay); returns the token that withdraws it. */
export function announceNavigation(label: string): number {
  lastToken += 1;
  const token = lastToken;
  cancelReveal();
  const wasShown = current?.shown === true;
  current = { token, label, shown: false };
  // A label already on screen leaves it now; the new one waits out the delay like any other.
  if (wasShown) emit();
  reveal = setTimeout(() => {
    reveal = null;
    if (current?.token !== token) return;
    current = { token, label, shown: true };
    emit();
  }, NAV_PENDING_DELAY_MS);
  return token;
}

/** End the navigation `token` announced — a no-op if a later one has replaced it. */
export function withdrawNavigation(token: number): void {
  if (current?.token !== token) return;
  cancelReveal();
  const wasShown = current.shown;
  current = null;
  if (wasShown) emit();
}

/** The label of the navigation pending for at least the delay — what the bar and status show. */
export function shownNavigation(): string | null {
  return current?.shown ? current.label : null;
}

export function subscribeNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget every announcement, timer and subscriber. */
export function resetNavigationForTests(): void {
  cancelReveal();
  current = null;
  lastToken = 0;
  listeners.clear();
}
