import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { FakeDocument, fakeControl } from "./test-doubles";
import { focusWithoutTooltip } from "./control";

/**
 * IconButtonBase behaviour, without a DOM: the node env cannot mount React, so `useRef` /
 * `useEffect` are replaced by recorders, the component is called as a function, and its
 * handlers are driven with stand-in events against a stand-in document that counts listeners.
 * The effect cleanups recorded here are exactly what React runs on unmount.
 */
const cleanups: Array<() => void> = [];
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useRef: <T,>(initial: T) => ({ current: initial }),
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
  };
});

const { IconButtonBase, useIconTipHandlers } = await import("./button");

type Handlers = {
  onKeyDown: (e: unknown) => void;
  onBlur: (e: unknown) => void;
  onPointerEnter: (e: unknown) => void;
  onPointerLeave: (e: unknown) => void;
};

function mount(props: Partial<Handlers> = {}) {
  cleanups.length = 0;
  const el = IconButtonBase({
    classBase: "bb-iconbtn",
    icon: "x",
    label: "Close",
    ...props,
  }) as ReactElement<Handlers>;
  const doc = new FakeDocument();
  const control = fakeControl(doc);
  const unmount = () => cleanups.splice(0).forEach((c) => c());
  return {
    on: el.props,
    doc,
    control,
    unmount,
    ev: (extra = {}) => ({ currentTarget: control, ...extra }),
  };
}

describe("Escape on a HOVER-opened tooltip (the button is not focused)", () => {
  beforeEach(() => void (cleanups.length = 0));

  it("pointer enter watches the document; Escape pressed on the DOCUMENT dismisses", () => {
    const { on, doc, control, ev } = mount();
    on.onPointerEnter(ev());
    expect(doc.keydownListeners).toBe(1);
    doc.pressKey("Escape");
    expect(control.dismissed).toBe(true);
  });

  it("does not swallow Escape: the admin drawer's own listener still receives it", () => {
    const { on, doc, ev } = mount();
    on.onPointerEnter(ev());
    let drawerClosed = false;
    doc.addEventListener("keydown", () => (drawerClosed = true));
    const event = doc.pressKey("Escape");
    expect(drawerClosed).toBe(true);
    // A stopPropagation() would still let the same-node listener above run, so pin the flag:
    // on a real page it would starve the drawer's `window` listener.
    expect(event.cancelBubble).toBe(false);
  });

  it("pointer leave removes the listener and re-arms the tooltip", () => {
    const { on, doc, control, ev } = mount();
    on.onPointerEnter(ev());
    doc.pressKey("Escape");
    on.onPointerLeave(ev());
    expect(doc.keydownListeners).toBe(0);
    expect(control.dismissed).toBe(false);
    doc.pressKey("Escape");
    expect(control.dismissed).toBe(false);
  });

  it("pointer enter re-arms a tooltip dismissed earlier: a new hover shows it", () => {
    const { on, doc, control, ev } = mount();
    control.setAttribute("data-tooltip-dismissed", "");
    on.onPointerEnter(ev());
    expect(control.dismissed).toBe(false);
    doc.pressKey("Escape");
    expect(control.dismissed).toBe(true);
  });

  it("re-entering never stacks listeners", () => {
    const { on, doc, ev } = mount();
    on.onPointerEnter(ev());
    on.onPointerEnter(ev());
    on.onPointerEnter(ev());
    expect(doc.keydownListeners).toBe(1);
  });

  it("unmounting while hovered removes the listener (no leak)", () => {
    const { on, doc, ev, unmount } = mount();
    on.onPointerEnter(ev());
    expect(doc.keydownListeners).toBe(1);
    unmount();
    expect(doc.keydownListeners).toBe(0);
  });

  it("the caller's own pointer handlers still run", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    const { on, ev } = mount({ onPointerEnter, onPointerLeave });
    on.onPointerEnter(ev());
    on.onPointerLeave(ev());
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });
});

describe("Escape on a FOCUS-opened tooltip", () => {
  it("keydown on the control dismisses; blur re-arms; the caller's handlers still run", () => {
    const onKeyDown = vi.fn();
    const onBlur = vi.fn();
    const { on, control, ev } = mount({ onKeyDown, onBlur });
    on.onKeyDown(ev({ key: "Enter" }));
    expect(control.dismissed).toBe(false);
    on.onKeyDown(ev({ key: "Escape" }));
    expect(control.dismissed).toBe(true);
    on.onBlur(ev());
    expect(control.dismissed).toBe(false);
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

/**
 * The same wiring as a hook, for a control that keeps its own markup around the shared tooltip
 * (payer-web's theme switch). IconButtonBase is built on it, so the tests above cover it through
 * the button; these drive the hook's handlers directly.
 */
describe("useIconTipHandlers — the wiring on its own", () => {
  function hook() {
    cleanups.length = 0;
    const on = useIconTipHandlers() as unknown as Handlers;
    const doc = new FakeDocument();
    const control = fakeControl(doc);
    const unmount = () => cleanups.splice(0).forEach((c) => c());
    return {
      on,
      doc,
      control,
      unmount,
      ev: (extra = {}) => ({ currentTarget: control, ...extra }),
    };
  }

  it("focus: Escape dismisses, any other key does not, blur re-arms", () => {
    const { on, control, ev } = hook();
    on.onKeyDown(ev({ key: "Tab" }));
    expect(control.dismissed).toBe(false);
    on.onKeyDown(ev({ key: "Escape" }));
    expect(control.dismissed).toBe(true);
    on.onBlur(ev());
    expect(control.dismissed).toBe(false);
  });

  it("hover: ONE document listener (re-entering never stacks); leave removes it and re-arms", () => {
    const { on, doc, control, ev } = hook();
    on.onPointerEnter(ev());
    on.onPointerEnter(ev());
    expect(doc.keydownListeners).toBe(1);
    doc.pressKey("Escape");
    expect(control.dismissed).toBe(true);
    on.onPointerLeave(ev());
    expect(doc.keydownListeners).toBe(0);
    expect(control.dismissed).toBe(false);
  });

  it("unmounting mid-hover removes the document listener (no leak)", () => {
    const { on, doc, ev, unmount } = hook();
    on.onPointerEnter(ev());
    expect(doc.keydownListeners).toBe(1);
    unmount();
    expect(doc.keydownListeners).toBe(0);
  });

  /** A control the app can move focus to: it takes focus, and carries the shared tooltip. */
  function focusTarget(doc: FakeDocument) {
    const control = Object.assign(fakeControl(doc), {
      children: [{ classList: { contains: (c: string) => c === "bb-icon-tip" } }],
      focus: () => void (doc.activeElement = control),
    });
    return control;
  }

  it("app-moved focus keeps the tip quiet for the KEYBOARD until focus moves (blur re-arms)", () => {
    const { on } = hook();
    const doc = new FakeDocument();
    const control = focusTarget(doc);
    focusWithoutTooltip(control); // a dialog opened from the keyboard lands on its ✕
    on.onKeyDown({ currentTarget: control, key: "Tab" });
    expect(control.dismissed).toBe(true);
    on.onBlur({ currentTarget: control });
    expect(control.dismissed).toBe(false);
  });

  it("…but not for the MOUSE: hovering shows it; Escape while hovering dismisses it again", () => {
    const { on } = hook();
    const doc = new FakeDocument();
    const control = focusTarget(doc);
    focusWithoutTooltip(control);
    expect(control.dismissed).toBe(true);
    on.onPointerEnter({ currentTarget: control });
    expect(control.dismissed).toBe(false);
    doc.pressKey("Escape");
    expect(control.dismissed).toBe(true);
    on.onPointerLeave({ currentTarget: control });
    expect(doc.keydownListeners).toBe(0);
  });
});
