import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";

/**
 * Dialog — where focus lands on OPEN (review of final sweep C). MEASURED: opening
 * ConfirmSpendDialog from the keyboard landed focus on the ✕ and its "Close" tooltip covered the
 * first line of the body; Escape, its only dismissal, also cancelled the dialog (WCAG 1.4.13).
 *
 * The node env cannot mount React, so the open-time effect is run directly: `useEffect` runs its
 * effect on the spot, `useRef` hands the effect a stand-in dialog element, and the page-isolation
 * helpers are no-ops. The stand-in ✕ records the ORDER of what happened to it.
 */
const log: string[] = [];
const ownerDocument = { activeElement: null as unknown };
const closeButton = {
  offsetParent: {},
  ownerDocument,
  attrs: new Set<string>(),
  children: [
    { classList: { contains: (c: string) => c === "ph-fill" } },
    { classList: { contains: (c: string) => c === "bb-icon-tip" } },
  ],
  setAttribute(k: string) {
    this.attrs.add(k);
    log.push(`set ${k}`);
  },
  removeAttribute(k: string) {
    this.attrs.delete(k);
    log.push(`remove ${k}`);
  },
  focus() {
    log.push(`focus ✕ (tooltip dismissed: ${this.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)})`);
    ownerDocument.activeElement = this;
  },
};
const dialogEl = {
  querySelectorAll: () => [closeButton],
  addEventListener: () => {},
  removeEventListener: () => {},
  focus: () => log.push("focus dialog"),
};

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useRef: () => ({ current: dialogEl }),
    useId: () => "dlg",
    useEffect: (effect: () => void) => void effect(),
  };
});
vi.mock("./page-isolation", () => ({
  inertOutside: () => () => {},
  lockPageScroll: () => () => {},
}));

const { Dialog } = await import("./dialog");

beforeEach(() => {
  log.length = 0;
  closeButton.attrs.clear();
  ownerDocument.activeElement = null;
  vi.stubGlobal("document", {
    activeElement: null,
    body: {},
    documentElement: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("window", { innerWidth: 1280 });
});

describe("Dialog — focus on open never opens the ✕'s tooltip", () => {
  it("the ✕ is focused with its tooltip already dismissed (set BEFORE the focus)", () => {
    Dialog({ open: true, title: "Unlock routed contact?", onClose: () => {} });
    expect(log).toEqual([
      `set ${TOOLTIP_DISMISSED_ATTRIBUTE}`,
      "focus ✕ (tooltip dismissed: true)",
    ]);
  });
});
