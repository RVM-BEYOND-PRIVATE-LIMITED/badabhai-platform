import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * Dialog — a just-opened dialog ignores a POINTER click on its actions (review N1).
 *
 * A fast double-click (or a phone tap that registers twice) on a purchase trigger opens the
 * confirm on the first click and lands the second where the confirm button now is — buying what
 * the payer never read. So for a short window after open, a pointer click inside the footer (the
 * actions slot) is swallowed before it reaches the button. Keyboard activation (Enter / Space on a
 * focused button, `detail === 0`) is never held back. Every DS Dialog gets this, ConfirmSpendDialog
 * included, without touching its copy.
 *
 * The node env cannot mount React, so the open effects run on the spot: `useRef` hands out one box
 * per call order (the dialog element, then the open time) and the page-isolation helpers are
 * no-ops. The guard is the footer's `onClickCapture`; it is driven with a stand-in click.
 */
const OPENED_AT = 1000;

const dialogEl = {
  children: [],
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  focus: () => {},
  setAttribute: () => {},
  removeAttribute: () => {},
  ownerDocument: { activeElement: null },
};
let refs: Array<{ current: unknown }> = [];
let refCursor = 0;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useRef: (init: unknown) => {
      const i = refCursor++;
      // Call order: (0) the dialog element, then the open time.
      refs[i] ??= { current: i === 0 ? dialogEl : init };
      return refs[i];
    },
    useId: () => "dlg",
    useEffect: (effect: () => void) => void effect(),
  };
});
vi.mock("./page-isolation", () => ({
  inertOutside: () => () => {},
  lockPageScroll: () => () => {},
}));

const { Dialog, DIALOG_ACTION_GUARD_MS } = await import("./dialog");

/** Every element carrying `cls` in its className, depth-first. */
function byClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => byClass(n, cls, acc));
    return acc;
  }
  const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
  if (typeof el.props?.className === "string" && el.props.className.split(/\s+/).includes(cls)) {
    acc.push(el);
  }
  if (el.props && "children" in el.props) byClass(el.props.children, cls, acc);
  return acc;
}

/** Open a dialog with one action and return a function that clicks its footer. */
function openWithAction() {
  refCursor = 0;
  const tree = Dialog({
    open: true,
    title: "Upgrade capacity?",
    onClose: () => {},
    footer: <button type="button">Upgrade · ₹12,000</button>,
  }) as ReactElement;
  const foot = byClass(tree, "bb-dialog__foot");
  expect(foot).toHaveLength(1);
  const guard = (foot[0]!.props as { onClickCapture?: (e: unknown) => void }).onClickCapture;
  expect(typeof guard).toBe("function");
  return (detail: number, sinceOpen: number) => {
    const e = {
      detail,
      timeStamp: OPENED_AT + sinceOpen,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    guard!(e);
    return {
      swallowed: e.stopPropagation.mock.calls.length > 0,
      prevented: e.preventDefault.mock.calls.length > 0,
    };
  };
}

beforeEach(() => {
  refs = [];
  vi.stubGlobal("document", {
    activeElement: null,
    body: {},
    documentElement: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("window", { innerWidth: 1280 });
  vi.spyOn(performance, "now").mockReturnValue(OPENED_AT);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Dialog — a pointer click on an action right after open is ignored", () => {
  it("the window is short — long enough for a double-click's second press, far too short to read", () => {
    expect(DIALOG_ACTION_GUARD_MS).toBeGreaterThanOrEqual(300);
    expect(DIALOG_ACTION_GUARD_MS).toBeLessThanOrEqual(600);
  });

  it("swallows a pointer click inside the window (the second half of a double-click / a double tap)", () => {
    const click = openWithAction();
    expect(click(1, 40)).toEqual({ swallowed: true, prevented: true });
    expect(click(2, 120)).toEqual({ swallowed: true, prevented: true }); // a dblclick's 2nd press
    expect(click(1, DIALOG_ACTION_GUARD_MS - 1)).toEqual({ swallowed: true, prevented: true });
  });

  it("lets a pointer click through once the window has passed", () => {
    const click = openWithAction();
    expect(click(1, DIALOG_ACTION_GUARD_MS)).toEqual({ swallowed: false, prevented: false });
    expect(click(1, DIALOG_ACTION_GUARD_MS + 5000)).toEqual({ swallowed: false, prevented: false });
  });

  it("never holds back the keyboard — Enter / Space on a focused action works at once", () => {
    const click = openWithAction();
    expect(click(0, 1)).toEqual({ swallowed: false, prevented: false });
    expect(click(0, DIALOG_ACTION_GUARD_MS - 1)).toEqual({ swallowed: false, prevented: false });
  });

  it("guards the actions only — the body and the head carry no guard", () => {
    refCursor = 0;
    const tree = Dialog({
      open: true,
      title: "Card preview",
      onClose: () => {},
      children: <a href="/x">A link in the body</a>,
      footer: <button type="button">Back</button>,
    }) as ReactElement;
    for (const cls of ["bb-dialog__body", "bb-dialog__head"]) {
      const el = byClass(tree, cls)[0]!;
      expect((el.props as { onClickCapture?: unknown }).onClickCapture, cls).toBeUndefined();
    }
  });
});
