import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Stat } from "./stat";
import { MockMoneyTag } from "./payments-posture";

/**
 * What `Stat` RENDERS — pinned exactly, because nearly every stat tile on the console goes
 * through it (the three mono tiles in `stuck-panel.tsx` are the exception).
 *
 * The admins, credits, transactions, skill-discovery, job/worker/payer detail pages used to
 * hand-roll these three spans. Moving them onto the component was only safe if the markup
 * did not move, so these assertions are on the whole string rather than on fragments: a
 * dropped class, a reordered span or a lost space all fail here.
 *
 * `adornment` exists for the mock-rupee tiles: the `simulated` tag has to sit INSIDE the value
 * span, beside the figure, because a tile screenshotted on its own must still carry the caveat
 * — a tag rendered anywhere else would not travel with it.
 *
 * `wide` exists for the ₹ tiles: a ₹ figure must never break between digits. The class is the
 * whole mechanism (`.stat--wide .stat__value` keeps the figure on one line at the 22px step, and
 * the flex stat row widens the tile to hold it), so it must appear exactly when asked for — and
 * never on a tile that did not ask, or every count tile would take the ₹ treatment.
 */

const MOCK = { mode: "mock", blocked_reason: null } as const;
const REAL = { mode: "real", blocked_reason: null } as const;

describe("Stat", () => {
  it("renders value then label, and nothing else", () => {
    expect(renderToStaticMarkup(<Stat label="Admin accounts" value="1,234" />)).toBe(
      '<div class="stat"><span class="stat__value">1,234</span>' +
        '<span class="stat__label">Admin accounts</span></div>',
    );
  });

  it("tones the TILE, not the value", () => {
    expect(renderToStaticMarkup(<Stat label="Failed orders" value="3" tone="warn" />)).toBe(
      '<div class="stat stat--warn"><span class="stat__value">3</span>' +
        '<span class="stat__label">Failed orders</span></div>',
    );
  });

  it("an undefined tone is the untoned tile — the `cond ? 'warn' : undefined` call shape", () => {
    expect(renderToStaticMarkup(<Stat label="x" value="0" tone={undefined} />)).toContain(
      '<div class="stat">',
    );
  });

  it("marks an absent value on the value span only", () => {
    expect(
      renderToStaticMarkup(<Stat label="Average" value="No profile finished yet" absent />),
    ).toContain('<span class="stat__value stat__value--absent">No profile finished yet</span>');
  });

  it("sets the simulated tag INSIDE the value span, after one space", () => {
    const out = renderToStaticMarkup(
      <Stat label="Settled" value="₹3,000" adornment={<MockMoneyTag posture={MOCK} />} />,
    );
    expect(out).toContain(
      '<span class="stat__value">₹3,000 <span class="pill pill--warn" ' +
        'title="Real payments are disabled — this is mock money.">simulated</span></span>' +
        '<span class="stat__label">Settled</span>',
    );
  });

  it("keeps the figure intact when the tag renders nothing (live payments)", () => {
    // MockMoneyTag returns null under real payments. The slot's space stays — byte-identical
    // to the hand-rolled `{formatRupees(x)}{" "}<MockMoneyTag … />` this replaced.
    const out = renderToStaticMarkup(
      <Stat label="Settled" value="₹3,000" adornment={<MockMoneyTag posture={REAL} />} />,
    );
    expect(out).toContain('<span class="stat__value">₹3,000 </span>');
    expect(out).not.toContain("simulated");
  });

  it("adds no trailing space when there is no adornment at all", () => {
    expect(renderToStaticMarkup(<Stat label="Credits sold" value="900" />)).toContain(
      '<span class="stat__value">900</span>',
    );
  });

  it("marks a wide tile on the TILE, and changes nothing else", () => {
    expect(renderToStaticMarkup(<Stat label="Spend" value="₹2,145.382716" wide />)).toBe(
      '<div class="stat stat--wide"><span class="stat__value">₹2,145.382716</span>' +
        '<span class="stat__label">Spend</span></div>',
    );
  });

  it("composes wide with the warn tone and the simulated tag", () => {
    const out = renderToStaticMarkup(
      <Stat
        label="Pack purchases"
        value="₹1,23,45,678"
        tone="warn"
        wide
        adornment={<MockMoneyTag posture={MOCK} />}
      />,
    );
    expect(
      out.startsWith(
        '<div class="stat stat--warn stat--wide">' +
          '<span class="stat__value">₹1,23,45,678 <span class="pill pill--warn"',
      ),
    ).toBe(true);
  });

  it("is never wide unless asked — a count tile stays half-width on a phone", () => {
    for (const out of [
      renderToStaticMarkup(<Stat label="Calls" value="156" />),
      renderToStaticMarkup(<Stat label="Calls" value="156" wide={false} />),
      renderToStaticMarkup(<Stat label="Calls" value="156" tone="warn" />),
    ]) {
      expect(out).not.toContain("stat--wide");
    }
  });
});
