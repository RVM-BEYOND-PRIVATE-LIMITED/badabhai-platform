import { afterEach, describe, expect, it, vi } from "vitest";
import { focusControlOnNextFrame, focusIsLost } from "./form-focus";

/**
 * #2645 — a refusal on a control the same click is about to SHOW (the trade picker on step 1,
 * refused from step 3) focuses it on the NEXT frame, once React has drawn the step. Node env:
 * `window`, `document` and the frame callback are stubbed.
 */

afterEach(() => vi.unstubAllGlobals());

describe("focusControlOnNextFrame", () => {
  it("focuses the control only on the next frame, not during the click", () => {
    const focus = vi.fn();
    const frames: Array<() => void> = [];
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "roleKind" ? { focus } : null) });
    vi.stubGlobal("window", { requestAnimationFrame: (cb: () => void) => frames.push(cb) });

    focusControlOnNextFrame("roleKind");
    expect(focus).not.toHaveBeenCalled();
    frames.forEach((run) => run());
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("is a no-op outside a browser", () => {
    expect(() => focusControlOnNextFrame("roleKind")).not.toThrow();
  });
});

describe("focusIsLost — a form takes focus back only when no control holds it", () => {
  it("is lost when focus sits on the page itself (its control was removed) or nowhere", () => {
    const body = { tagName: "BODY" };
    vi.stubGlobal("document", { body, activeElement: body });
    expect(focusIsLost()).toBe(true);
    vi.stubGlobal("document", { body, activeElement: null });
    expect(focusIsLost()).toBe(true);
  });

  it("is not lost while a control holds it, and never outside a browser", () => {
    vi.stubGlobal("document", { body: { tagName: "BODY" }, activeElement: { id: "description" } });
    expect(focusIsLost()).toBe(false);
    vi.unstubAllGlobals();
    expect(focusIsLost()).toBe(false);
  });
});
