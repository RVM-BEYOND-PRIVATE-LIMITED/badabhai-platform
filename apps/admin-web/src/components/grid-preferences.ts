import { useMemo, useSyncExternalStore } from "react";
import { parseColumnChoices, type ColumnChoices } from "./data-grid-model";

/**
 * The data grid's PER-VIEWER preferences (A4, #2574): which columns each list shows, and how dense
 * its rows are. A viewer's taste, not data — so they live in this browser's localStorage and never
 * reach the server, and nothing the grid shows depends on them being there.
 *
 *  - Density is ONE choice for every grid: an operator who wants compact rows wants them on every
 *    list. Column choices are per grid (`gridId`).
 *  - EVERY storage access is guarded. localStorage throws when it is disabled (a locked-down
 *    profile, a sandboxed frame) and refuses writes when full; the store then keeps the choice in
 *    memory for this page's life, and the grid renders exactly as it would with storage. A stored
 *    value is the viewer's to edit, so it is parsed defensively (`parseColumnChoices`).
 *  - A plain external store read with `useSyncExternalStore`, like the navigation pending store:
 *    the server and the hydrating client both render the defaults (`getServerSnapshot`), and the
 *    viewer's choices apply right after hydration — a list never fails to hydrate over a choice.
 *  - Another tab's change arrives through the `storage` event, so two open consoles agree.
 */

const PREFIX = "bb-admin:grid:";
const DENSITY_KEY = `${PREFIX}density`;
const columnsKey = (gridId: string) => `${PREFIX}columns:${gridId}`;

/** `comfortable`: 44px rows (--row-h). `compact`: 36px rows (--row-h-compact). */
export type GridDensity = "comfortable" | "compact";
export const DEFAULT_DENSITY: GridDensity = "comfortable";

/** Raw stored strings, by key: `null` is "nothing stored". Filled on first read. */
const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();
/**
 * How many times the density has CHANGED in this page's life — by the viewer here, or by another
 * tab. Not stored: it only tells a grid that a change happened (to replay its rows' fade), so the
 * density a page merely loads with, applied right after hydration, is never mistaken for one.
 */
let densityChanges = 0;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  if (cache.has(key)) return cache.get(key)!;
  let value: string | null = null;
  try {
    value = storage()?.getItem(key) ?? null;
  } catch {
    value = null;
  }
  cache.set(key, value);
  return value;
}

function write(key: string, value: string | null): void {
  cache.set(key, value);
  try {
    const s = storage();
    if (s) {
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
    }
  } catch {
    // Disabled or full: the choice holds in memory for this page's life. Nothing to tell the
    // viewer — the grid already shows what they chose.
  }
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Another tab changed (or cleared) a preference: drop what this tab cached and re-read. */
function onStorage(event: StorageEvent): void {
  if (event.key === null) cache.clear();
  else if (event.key.startsWith(PREFIX)) cache.delete(event.key);
  else return;
  if (event.key === null || event.key === DENSITY_KEY) densityChanges++;
  emit();
}

export function subscribeGridPreferences(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** The viewer's density. Anything but the one other value reads as the default. */
export function readDensity(): GridDensity {
  return read(DENSITY_KEY) === "compact" ? "compact" : DEFAULT_DENSITY;
}

/** Choosing the default removes the key, so a viewer who never deviates stores nothing. */
export function writeDensity(density: GridDensity): void {
  densityChanges++;
  write(DENSITY_KEY, density === DEFAULT_DENSITY ? null : density);
}

/** How many density changes this page has seen (see `densityChanges`). */
export function readDensityChanges(): number {
  return densityChanges;
}

/** The RAW stored column choices for `gridId` — a stable string, as a store snapshot must be. */
export function readColumnChoices(gridId: string): string | null {
  return read(columnsKey(gridId));
}

/** Store the viewer's explicit choices for `gridId`; `null` (or none left) restores the defaults. */
export function writeColumnChoices(gridId: string, choices: ColumnChoices | null): void {
  const kept = choices && Object.keys(choices).length > 0 ? JSON.stringify(choices) : null;
  write(columnsKey(gridId), kept);
}

/** The viewer's density — the default on the server and while hydrating. */
export function useGridDensity(): GridDensity {
  return useSyncExternalStore(subscribeGridPreferences, readDensity, serverDensity);
}

/** The density changes this page has seen — none on the server and while hydrating. */
export function useDensityChanges(): number {
  return useSyncExternalStore(subscribeGridPreferences, readDensityChanges, serverDensityChanges);
}

/** The viewer's column choices for `gridId` — none on the server and while hydrating. */
export function useColumnChoices(gridId: string): ColumnChoices {
  const raw = useSyncExternalStore(
    subscribeGridPreferences,
    () => readColumnChoices(gridId),
    serverChoices,
  );
  return useMemo(() => parseColumnChoices(raw), [raw]);
}

const serverDensity = (): GridDensity => DEFAULT_DENSITY;
const serverDensityChanges = (): number => 0;
const serverChoices = (): string | null => null;

/** Tests only: forget every cached preference and subscriber. */
export function resetGridPreferencesForTests(): void {
  cache.clear();
  listeners.clear();
  densityChanges = 0;
}
