import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { createHookHarness } from "../../../test/hook-harness";

/**
 * #2750 — the quote layer is failure-safe and re-read on return. Driven through the repo's
 * hook harness (node env): initial quotes render at once, the post-mount read replaces them,
 * a focus (the payer back from buying a pack) re-reads, and a failed read never throws.
 */

const unlockQuotesAction = vi.fn();
vi.mock("../../lib/unlock-quotes-actions", () => ({
  unlockQuotesAction: (i: unknown) => unlockQuotesAction(i),
}));

const h = createHookHarness();
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => h.useState(initial),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => h.useEffect(effect, deps),
  };
});

type Listener = () => void;
let focus: Listener[] = [];
let visibility: Listener[] = [];

const { useUnlockQuotes } = await import("./use-unlock-quotes");

const W1 = "face2000-0000-4000-8000-000000000001";
const W2 = "face2000-0000-4000-8000-000000000002";

beforeEach(() => {
  unlockQuotesAction.mockReset();
  focus = [];
  visibility = [];
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: Listener) => {
      if (name === "focus") focus.push(fn);
    },
    removeEventListener: () => {},
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (name: string, fn: Listener) => {
      if (name === "visibilitychange") visibility.push(fn);
    },
    removeEventListener: () => {},
  });
  h.reset();
});

afterEach(() => vi.unstubAllGlobals());

describe("useUnlockQuotes", () => {
  it("starts from the seed, then reads the page's quotes after mount", async () => {
    unlockQuotesAction.mockResolvedValue({ quotes: { [W1]: 2 }, creditsAvailable: 3 });
    const frame = h.render(
      (p: { ids: string[] }) => useUnlockQuotes(p.ids, { quotes: { [W1]: 1 }, creditsAvailable: 5 }),
      { ids: [W1, W2] },
    );
    expect(frame.quotes).toEqual({ quotes: { [W1]: 1 }, creditsAvailable: 5 });
    await Promise.resolve();
    expect(unlockQuotesAction).toHaveBeenCalledWith({ workerIds: [W1, W2] });
    const next = h.render((p: { ids: string[] }) => useUnlockQuotes(p.ids), { ids: [W1, W2] });
    expect(next.quotes).toEqual({ quotes: { [W1]: 2 }, creditsAvailable: 3 });
  });

  it("re-quotes on focus (a return from a pack purchase) and folds an updated balance in", async () => {
    unlockQuotesAction
      .mockResolvedValueOnce({ quotes: { [W1]: 2 }, creditsAvailable: 1 })
      .mockResolvedValueOnce({ quotes: { [W1]: 2 }, creditsAvailable: 7 });
    h.render((p: { ids: string[] }) => useUnlockQuotes(p.ids), { ids: [W1] });
    await Promise.resolve();
    focus.forEach((fn) => fn());
    await Promise.resolve();
    expect(unlockQuotesAction).toHaveBeenCalledTimes(2);
    const frame = h.render((p: { ids: string[] }) => useUnlockQuotes(p.ids), { ids: [W1] });
    expect(frame.quotes?.creditsAvailable).toBe(7);
  });

  it("a failed read leaves the quote as it was — the list never breaks", async () => {
    unlockQuotesAction.mockRejectedValue(new Error("offline"));
    const frame = h.render(
      (p: { ids: string[] }) => useUnlockQuotes(p.ids, { quotes: { [W1]: 2 }, creditsAvailable: 4 }),
      { ids: [W1] },
    );
    await Promise.resolve();
    expect(frame.quotes).toEqual({ quotes: { [W1]: 2 }, creditsAvailable: 4 });
  });
});
