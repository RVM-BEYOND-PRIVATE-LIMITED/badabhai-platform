import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinBudget } from "./within-budget";

/** A read a page can do without never holds the page (A4, #2574 — the Events name suggestions). */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("withinBudget", () => {
  it("is the work's result when it settles in time", async () => {
    await expect(withinBudget(Promise.resolve(["profile.confirmed"]), 800, [])).resolves.toEqual([
      "profile.confirmed",
    ]);
  });

  it("is the fallback when the work fails — never a thrown page", async () => {
    await expect(withinBudget(Promise.reject(new Error("metrics down")), 800, [])).resolves.toEqual([]);
  });

  it("is the fallback once the budget runs out, and does not wait for the work", async () => {
    const never = new Promise<string[]>(() => undefined);
    const result = withinBudget(never, 800, ["fallback"]);
    await vi.advanceTimersByTimeAsync(799);
    let settled = false;
    void result.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(["fallback"]);
  });

  it("leaves no timer behind when the work wins", async () => {
    await withinBudget(Promise.resolve(1), 800, 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
