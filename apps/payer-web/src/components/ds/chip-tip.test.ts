import { describe, expect, it } from "vitest";
import { TIP_SHIFT_PROPERTY, keepTipInRow, tipOverrun, type TipHost } from "./chip-tip";

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
});
