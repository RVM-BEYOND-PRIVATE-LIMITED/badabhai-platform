import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceNavigation,
  pendingNavigation,
  resetNavigationForTests,
  subscribeNavigation,
  withdrawNavigation,
} from "./nav-pending-store";

/**
 * Which nav link's navigation is pending, for the shell's one status line and page-wide bar
 * (review of #2095). Each pending link announces itself and withdraws when its navigation ends or
 * it unmounts; the store must never keep a label after its link has withdrawn — a pending cue that
 * sticks is the very "click did nothing" it replaces.
 */
beforeEach(() => resetNavigationForTests());

describe("the pending-navigation store", () => {
  it("is empty until a link announces itself", () => {
    expect(pendingNavigation()).toBeNull();
  });

  it("holds the announcing link's label, and tells its subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNavigation(listener);
    announceNavigation("Workers");
    expect(pendingNavigation()).toBe("Workers");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    announceNavigation("Events");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clears when that link withdraws", () => {
    const token = announceNavigation("Workers");
    withdrawNavigation(token);
    expect(pendingNavigation()).toBeNull();
  });

  it("an older link withdrawing never clears a newer one — click A, then B before A lands", () => {
    const a = announceNavigation("Workers");
    const b = announceNavigation("Events");
    withdrawNavigation(a);
    expect(pendingNavigation()).toBe("Events");
    withdrawNavigation(b);
    expect(pendingNavigation()).toBeNull();
  });

  it("a withdrawal that changes nothing tells no one", () => {
    const listener = vi.fn();
    subscribeNavigation(listener);
    const a = announceNavigation("Workers");
    announceNavigation("Events");
    listener.mockClear();
    withdrawNavigation(a);
    expect(listener).not.toHaveBeenCalled();
  });
});
