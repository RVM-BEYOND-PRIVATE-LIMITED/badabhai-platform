import { afterEach, describe, expect, it, vi } from "vitest";
import { focusControlOnNextFrame } from "./form-focus";

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
