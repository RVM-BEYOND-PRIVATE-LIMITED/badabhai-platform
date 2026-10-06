import { describe, expect, it } from "vitest";
import {
  TIP_SHIFT_PROPERTY,
  hideTip,
  keepTipInRow,
  showTip,
  tipOverrun,
  unwatchTip,
  type TipHost,
  type TipWindow,
} from "./chip-tip";

/**
 * A removable chip's tooltip stays inside its row. Anchored at the chip's end it never widens the
 * page, but a short chip that STARTS a row pushed it past the screen's left edge (10 of 19 at
 * 320px, measured); it now slides right by exactly the overrun. The DOM is faked structurally.
 */

function host(opts: { rowLeft: number; tipLeft: number; shown?: boolean; noRow?: boolean }) {
  const props = new Map<string, string>([[TIP_SHIFT_PROPERTY, "99"]]); // a stale shift
  const button: TipHost = {
    style: {
      setProperty: (k, v) => void props.set(k, v),
      removeProperty: (k) => {
        props.delete(k);
        return "";
      },
    },
    querySelector: (sel) =>
      sel === ".bb-icon-tip"
        ? {
            getClientRects: () => (opts.shown === false ? [] : [{}]),
            getBoundingClientRect: () => ({ left: opts.tipLeft }),
          }
        : null,
    closest: (sel) =>
      sel === ".bb-chip"
        ? { parentElement: opts.noRow ? null : { getBoundingClientRect: () => ({ left: opts.rowLeft }) } }
        : null,
  };
  return { button, props };
}

describe("keepTipInRow — the remove tooltip never crosses its row's start", () => {
  it("a tooltip already inside the row is left where it is (and a stale shift is cleared)", () => {
    const { button, props } = host({ rowLeft: 20, tipLeft: 40 });
    keepTipInRow(button);
    expect(props.has(TIP_SHIFT_PROPERTY)).toBe(false);
  });

  it("one that starts 17.4px left of the row slides right by 18px (whole pixels, rounded up)", () => {
    const { button, props } = host({ rowLeft: 20, tipLeft: 2.6 });
    keepTipInRow(button);
    expect(props.get(TIP_SHIFT_PROPERTY)).toBe("18");
  });

  it("past the SCREEN's edge too (negative left) — measured against the row, which is on screen", () => {
    const { button, props } = host({ rowLeft: 20, tipLeft: -18 });
    keepTipInRow(button);
    expect(props.get(TIP_SHIFT_PROPERTY)).toBe("38");
  });

  it("a hidden tooltip (a tap, not a hover or a keyboard focus) is not measured", () => {
    const { button, props } = host({ rowLeft: 20, tipLeft: -50, shown: false });
    keepTipInRow(button);
    expect(props.has(TIP_SHIFT_PROPERTY)).toBe(false);
  });

  it("a chip outside any row is left alone", () => {
    const { button, props } = host({ rowLeft: 20, tipLeft: -50, noRow: true });
    keepTipInRow(button);
    expect(props.has(TIP_SHIFT_PROPERTY)).toBe(false);
  });

  it("the overrun is never negative", () => {
    expect(tipOverrun(20, 40)).toBe(0);
    expect(tipOverrun(20, 19.2)).toBe(1);
  });

  it("says whether the tooltip is shown (a hidden one is not watched)", () => {
    expect(keepTipInRow(host({ rowLeft: 20, tipLeft: 40 }).button)).toBe(true);
    expect(keepTipInRow(host({ rowLeft: 20, tipLeft: 40, noRow: true }).button)).toBe(true);
    expect(keepTipInRow(host({ rowLeft: 20, tipLeft: 40, shown: false }).button)).toBe(false);
  });
});

/**
 * A tooltip measured once went stale when the window resized while it showed: 768 → 320 with
 * focus held re-flowed the row and left 4 of 12 company-form tooltips 16px past the screen's left
 * edge. While shown, it is measured again on every resize. The geometry and the shown state are
 * live (a test moves them); the window records its resize listeners.
 */
describe("showTip / hideTip — a shown tooltip is re-placed on every resize until it hides", () => {
  function live() {
    const geo = { rowLeft: 20, tipLeft: 40, shown: true };
    const props = new Map<string, string>();
    const button: TipHost = {
      style: {
        setProperty: (k, v) => void props.set(k, v),
        removeProperty: (k) => {
          props.delete(k);
          return "";
        },
      },
      querySelector: (sel) =>
        sel === ".bb-icon-tip"
          ? {
              getClientRects: () => (geo.shown ? [{}] : []),
              getBoundingClientRect: () => ({ left: geo.tipLeft }),
            }
          : null,
      closest: (sel) =>
        sel === ".bb-chip" ? { parentElement: { getBoundingClientRect: () => ({ left: geo.rowLeft }) } } : null,
    };
    const listeners = new Set<() => void>();
    const win: TipWindow = {
      addEventListener: (type, l) => {
        if (type === "resize") listeners.add(l);
      },
      removeEventListener: (type, l) => {
        if (type === "resize") listeners.delete(l);
      },
    };
    const resize = () => [...listeners].forEach((l) => l());
    return { geo, props, button, win, listeners, resize };
  }

  it("re-places the shown tooltip on a resize: a stale shift is cleared, a new overrun is applied", () => {
    const t = live();
    t.geo.tipLeft = 2; // a short chip starting the row
    showTip(t.button, t.win);
    expect(t.props.get(TIP_SHIFT_PROPERTY)).toBe("18");
    expect(t.listeners.size).toBe(1);

    t.geo.tipLeft = 120; // the window widened: the chip now sits mid-row
    t.resize();
    expect(t.props.has(TIP_SHIFT_PROPERTY)).toBe(false);

    t.geo.tipLeft = -16; // narrowed again: the row re-flowed and the chip starts it
    t.resize();
    expect(t.props.get(TIP_SHIFT_PROPERTY)).toBe("36");
  });

  it("is watched ONCE however many triggers show it (focus, then hover)", () => {
    const t = live();
    showTip(t.button, t.win);
    showTip(t.button, t.win);
    expect(t.listeners.size).toBe(1);
  });

  it("a hidden tooltip (a tap) is not watched", () => {
    const t = live();
    t.geo.shown = false;
    showTip(t.button, t.win);
    expect(t.listeners.size).toBe(0);
  });

  it("stops watching when it hides — but not while the OTHER trigger still shows it", () => {
    const t = live();
    showTip(t.button, t.win);
    hideTip(t.button); // the pointer left, but the button still has keyboard focus
    expect(t.listeners.size).toBe(1);
    t.geo.shown = false; // …and now it blurred
    hideTip(t.button);
    expect(t.listeners.size).toBe(0);
    // Shown again later: watched again.
    t.geo.shown = true;
    showTip(t.button, t.win);
    expect(t.listeners.size).toBe(1);
  });

  it("a resize that finds it hidden with no hide event (Escape) stops watching", () => {
    const t = live();
    showTip(t.button, t.win);
    t.geo.shown = false;
    t.resize();
    expect(t.listeners.size).toBe(0);
  });

  it("unwatchTip (its chip unmounts) stops watching even while it shows", () => {
    const t = live();
    showTip(t.button, t.win);
    unwatchTip(t.button);
    expect(t.listeners.size).toBe(0);
    unwatchTip(t.button); // idempotent
    expect(t.listeners.size).toBe(0);
  });
});
