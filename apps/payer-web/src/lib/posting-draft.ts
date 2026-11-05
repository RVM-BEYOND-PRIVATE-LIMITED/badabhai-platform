/**
 * W4 (#2584) — the posting forms' DRAFT and LEAVE GUARD, as plain functions (the hook in
 * components/use-posting-draft.ts wires them to React).
 *
 * DRAFT: a half-filled posting is kept in this browser's `localStorage` while the payer types, so a
 * click away (or a closed tab) does not lose it. It is a per-device convenience only — the server
 * copy (a posting's saved draft) stays the record. Every storage access is guarded: private mode,
 * blocked site data or a full quota read as "no draft", never as an error.
 *
 * A draft is stored with its BASE — what the form was seeded from (nothing for a new posting; the
 * saved revision for an edit). A draft whose base no longer matches the form's (the posting was
 * saved since, here or on another device) is stale and is dropped, never restored over newer data.
 *
 * A draft belongs to ONE payer: its key carries the session's opaque `payerId`, and sign-out
 * removes every draft on the device. A shared office or cyber-café browser therefore never hands
 * one company's unpublished posting to the next company that signs in.
 *
 * LEAVE GUARD: while the form holds changes nobody saved, an in-app link click and a tab close /
 * reload ask first.
 */

const PREFIX = "bb:posting-draft:";

/** The storage key of a payer's new-posting draft, or of one of their postings' edit draft. */
export function postingDraftKey(
  scope: { kind: "new"; payerId: string } | { kind: "edit"; payerId: string; postingId: string },
): string {
  const own = `${PREFIX}${scope.payerId}:`;
  return scope.kind === "new" ? `${own}new` : `${own}edit:${scope.postingId}`;
}

export interface StoredDraft<T> {
  base: string;
  payload: T;
}

/** The `Storage` the draft lives in — `undefined` outside a browser or when access throws. */
function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function saveDraft<T>(key: string, base: string, payload: T, store = storage()): boolean {
  if (store === undefined) return false;
  try {
    store.setItem(key, JSON.stringify({ base, payload } satisfies StoredDraft<T>));
    return true;
  } catch {
    return false;
  }
}

/** The stored draft for `key` when it was taken from the same `base`; a stale one is removed. */
export function loadDraft<T>(key: string, base: string, store = storage()): T | null {
  if (store === undefined) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft<T>> | null;
    if (parsed === null || typeof parsed !== "object" || parsed.base !== base) {
      store.removeItem(key);
      return null;
    }
    return (parsed.payload ?? null) as T | null;
  } catch {
    return null;
  }
}

export function clearDraft(key: string, store = storage()): void {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/** Removes every posting draft on this device, whoever's — sign-out runs it. */
export function clearAllPostingDrafts(store = storage()): void {
  if (store === undefined) return;
  try {
    // Collected first: removing while walking the keys would shift the indexes under the walk.
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/** The question a dirty form asks before an in-app link takes the payer away. */
export const LEAVE_CONFIRM =
  "Leave this posting? Your changes are not saved or published yet. A draft stays on this device.";

/** The parts of a click the guard reads (a `MouseEvent` has them all). */
export interface GuardedClick {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/**
 * The in-app page a click is about to open, or null when the click does not leave this page in
 * this tab: a modified or non-primary click, a new tab, a download, another origin, or a
 * same-page fragment.
 */
export function leavingHref(
  event: GuardedClick,
  here: { origin: string; pathname: string; search: string },
): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target as (Element & { closest?: Element["closest"] }) | null;
  const anchor = typeof target?.closest === "function" ? target.closest("a[href]") : null;
  if (anchor === null) return null;
  const targetAttr = anchor.getAttribute("target");
  if (
    (targetAttr !== null && targetAttr !== "" && targetAttr !== "_self") ||
    anchor.hasAttribute("download")
  ) {
    return null;
  }
  const href = anchor.getAttribute("href") ?? "";
  let url: URL;
  try {
    url = new URL(href, `${here.origin}${here.pathname}${here.search}`);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null;
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return url.pathname + url.search;
}

/**
 * Asks before leaving while `isDirty()` is true.
 *
 *  - CLOSING THE TAB / RELOADING: the browser's own `beforeunload` prompt (the only native prompt
 *    this app still allows — a page cannot style it, and navigation has not started yet).
 *  - AN IN-APP LINK: caught in the CAPTURE phase on the document, before the router's own link
 *    handler. `onInAppLeave(href, message)` decides: return true to let the link go, or false to
 *    stop it and show the caller's own in-app confirmation. The hook uses the latter and then
 *    navigates on the payer's confirmation.
 *
 * Returns the cleanup.
 */
export function installLeaveGuard(
  isDirty: () => boolean,
  onInAppLeave: (href: string, message: string) => boolean,
  win: Window = window,
): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!isDirty()) return;
    event.preventDefault();
    // Older browsers show the prompt only when returnValue is set.
    event.returnValue = "";
  };
  const onClick = (event: MouseEvent) => {
    if (!isDirty()) return;
    const href = leavingHref(event, win.location);
    if (href === null) return;
    if (onInAppLeave(href, LEAVE_CONFIRM)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  win.addEventListener("beforeunload", onBeforeUnload);
  win.document.addEventListener("click", onClick, true);
  return () => {
    win.removeEventListener("beforeunload", onBeforeUnload);
    win.document.removeEventListener("click", onClick, true);
  };
}
