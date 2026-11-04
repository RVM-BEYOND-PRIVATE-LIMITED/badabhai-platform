"use client";

import { useSyncExternalStore } from "react";
import type { BalanceReading } from "../lib/contracts";

/**
 * The tab's NEWEST credit balance from the server (#2585), so the shell's credits chip and every
 * zero-balance check (the unlock lists' "0 credits" alert, each card's Unlock / Buy credits) show
 * the balance an unlock left, with no reload.
 *
 * ONLY A SERVER FIGURE IS EVER PUBLISHED: the balance the unlock action read back from
 * `GET /payer/credits` after a grant. Nothing here computes a balance — no client-side "−1":
 * re-unlocking a grant the payer already holds debits nothing, and what an unlock costs is the
 * server's.
 *
 * ORDERED BY WHEN THE SERVER READ IT, never by when a component mounted. Every figure carries
 * `asOf`, the portal server's clock (epoch ms) just before its `GET /payer/credits`: the layout's
 * and each page's `balance` prop (passed as `balanceAsOf`), and an unlock's read-back. That is
 * what keeps a stale prop from winning: Back / Forward restores a page from the router cache with
 * the props it was first rendered with (an unlock revalidates nothing), so a list mounted again
 * there holds a figure read BEFORE the unlock — older than the read-back published since.
 *
 * A plain external store, read with `useSyncExternalStore` (as nav-pending-store.ts). Written from
 * event handlers only, never during a render — so the server, which renders the chip and the lists
 * too, never writes it and no balance outlives one request there. A client module, so server code
 * cannot call into it at all.
 */
let latest: BalanceReading | null = null;
const listeners = new Set<() => void>();

/**
 * Publish a balance the server just read. Anything but a whole number ≥ 0 read at a real time is
 * dropped, and so is a reading older than the one held (two answers can land out of order).
 */
export function publishBalance(reading: BalanceReading): void {
  const { balance, asOf } = reading;
  if (!Number.isSafeInteger(balance) || balance < 0 || !Number.isFinite(asOf)) return;
  if (latest !== null && asOf < latest.asOf) return;
  latest = { balance, asOf };
  for (const listener of listeners) listener();
}

/** The newest publish (null before the first) — `useSyncExternalStore`'s snapshot. */
export function publishedBalance(): BalanceReading | null {
  return latest;
}

/** The server render and the hydration pass see no publish: the balance came with the page. */
export function noPublishedBalance(): null {
  return null;
}

export function subscribeBalance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The newer of the two: a publish read AFTER the screen's own figure, else that figure. */
export function newerBalance(screen: BalanceReading, published: BalanceReading | null): number {
  return published !== null && published.asOf > screen.asOf ? published.balance : screen.balance;
}

/**
 * The balance a screen shows: its own server figure (`balance`, read at `asOf`), or a newer one
 * published since — re-rendering when one is. The chip and both unlock lists read it.
 */
export function useLiveBalance(balance: number, asOf: number): number {
  const published = useSyncExternalStore(subscribeBalance, publishedBalance, noPublishedBalance);
  return newerBalance({ balance, asOf }, published);
}

/** Tests only: forget every publish and subscriber. */
export function resetPublishedBalanceForTests(): void {
  latest = null;
  listeners.clear();
}
