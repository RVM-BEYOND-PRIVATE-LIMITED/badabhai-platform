import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * State that starts from the URL, is the operator's to edit, and FOLLOWS the URL when the URL's
 * value changes — without remounting anything (review of #2046).
 *
 * Next keeps a client component's state across a navigation that changes only the search params,
 * so a filter bar's fields (or a panel's open state) seeded once from the URL went stale the
 * moment a link changed the URL's filters: /events → a row's correlation-id link showed an empty
 * Correlation id, which Apply then dropped. Remounting on a key fixed that and broke focus — the
 * focused control is destroyed — so this adjusts the state DURING RENDER instead, when `key` (the
 * URL value's identity) differs from the one it last synced to: React's "adjusting some state when
 * a prop changes" (react.dev/learn/you-might-not-need-an-effect). React re-runs the component
 * before committing, so no stale frame is ever painted, and nothing is unmounted: focus, a
 * half-typed field, every other piece of state stays where it was.
 *
 *  - The same key (a page turn, any re-render) keeps the operator's edits.
 *  - A new key replaces the value with `reconcile(current, fromUrl)` — by default the URL's value.
 *
 * `key` defaults to the URL value's JSON, which suits a plain value or a flat record of strings
 * and booleans (a filter bar's fields). The second state slot is APPENDED after the value, so the
 * value keeps the position a plain `useState` had.
 */
export function useUrlState<T>(
  fromUrl: T,
  key: string = JSON.stringify(fromUrl),
  reconcile: (current: T, fromUrl: T) => T = takeUrl,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(fromUrl);
  const [syncedKey, setSyncedKey] = useState(key);
  if (syncedKey !== key) {
    setSyncedKey(key);
    setValue((current) => reconcile(current, fromUrl));
  }
  return [value, setValue];
}

function takeUrl<T>(_current: T, fromUrl: T): T {
  return fromUrl;
}
