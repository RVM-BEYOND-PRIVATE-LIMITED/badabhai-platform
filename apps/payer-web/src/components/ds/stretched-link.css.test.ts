import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CARDS-1 — the stretched-link overlay must COVER the card.
 *
 * It used to be a 1px absolute anchor whose `::after` carried `inset: 0`. An absolutely
 * positioned anchor is its own `::after`'s containing block, so the "overlay" was 1x1px: a
 * click on the card body hit the text, not the link (verified in Chromium — mouse/touch dead,
 * keyboard only). The node env has no layout engine, so this pins the declared geometry: the
 * anchor itself is the overlay, sized by `inset: 0` against the positioned card.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "..", "..", "styles", "ds-components.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} must be declared`).toBeGreaterThanOrEqual(0);
  return CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at));
}

describe("CARDS-1 · stretched-link overlay geometry", () => {
  it("the anchor is absolutely positioned and inset to the whole card", () => {
    const a = block(".bb-stretched-link");
    expect(a).toMatch(/position:\s*absolute/);
    // `inset: 0;` exactly — `inset: 0 auto auto 0` would shrink the anchor again.
    expect(a).toMatch(/inset:\s*0\s*;/);
  });

  it("the anchor sits one layer above the card's positioned descendants", () => {
    // At `--z-base` (0) a later positioned/transformed child (the posting arrow, the avatar
    // seal) paints above the anchor and eats the click. base + 1 lifts it clear.
    expect(block(".bb-stretched-link")).toMatch(/z-index:\s*calc\(var\(--z-base\)\s*\+\s*1\)/);
  });

  it("the anchor paints no focus ring of its own (the parent draws it, on :focus-visible)", () => {
    expect(block(".bb-stretched-link")).toMatch(/box-shadow:\s*none/);
  });

  it("the anchor is not a 1px box (which made the overlay 1px)", () => {
    const a = block(".bb-stretched-link");
    expect(a).not.toMatch(/width:\s*1px/);
    expect(a).not.toMatch(/height:\s*1px/);
  });

  it("no ::after overlay is sized against the anchor any more", () => {
    expect(CSS.includes(".bb-stretched-link::after")).toBe(false);
  });

  it("both link-able surfaces give the overlay a positioned parent", () => {
    expect(block(".bb-card--link")).toMatch(/position:\s*relative/);
    expect(block(".bb-stat--link")).toMatch(/position:\s*relative/);
  });
});
