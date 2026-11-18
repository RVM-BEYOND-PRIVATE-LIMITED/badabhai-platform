"use client";

import { useEffect, useState } from "react";
import type { UnlockQuotes } from "../../lib/contracts";
import { quoteWorkerIds } from "../../lib/unlock-quotes";
import { unlockQuotesAction } from "../../lib/unlock-quotes-actions";

/**
 * #2750 — the list's contact-cost quotes, fetched AFTER the cards render and refreshed
 * when the payer comes back to the tab (e.g. after buying a pack). A failed or absent
 * quote (`null`) is the documented fallback: the card keeps today's button.
 *
 * `updateAvailable` folds a server answer into the page's spendable figure — a grant's
 * read-back, or an `insufficient_credits` refusal — so affordability moves without a
 * second list read. It never changes a worker's price.
 */
export function useUnlockQuotes(
  workerIds: readonly string[],
  initial: UnlockQuotes | null = null,
): {
  quotes: UnlockQuotes | null;
  updateAvailable: (creditsAvailable: number) => void;
} {
  const key = workerIds.join(",");
  const [quotes, setQuotes] = useState<UnlockQuotes | null>(initial);

  useEffect(() => {
    const ids = quoteWorkerIds(key.length === 0 ? [] : key.split(","));
    if (ids.length === 0) {
      setQuotes(null);
      return;
    }
    let active = true;
    const load = () => {
      void unlockQuotesAction({ workerIds: ids })
        .then((next) => {
          if (active) setQuotes(next);
        })
        .catch(() => {
          // Failure-safe: keep whatever this list has; never break the page.
        });
    };
    load();
    const onFocus = () => load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key]);

  function updateAvailable(creditsAvailable: number): void {
    if (!Number.isSafeInteger(creditsAvailable) || creditsAvailable < 0) return;
    setQuotes((prev) => (prev === null ? prev : { ...prev, creditsAvailable }));
  }

  return { quotes, updateAvailable };
}
