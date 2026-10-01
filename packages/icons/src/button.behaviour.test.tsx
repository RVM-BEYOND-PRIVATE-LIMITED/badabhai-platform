import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { FakeDocument, fakeControl } from "./test-doubles";

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

const { IconButtonBase } = await import("./button");

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
