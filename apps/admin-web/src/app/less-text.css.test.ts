import { describe, expect, it } from "vitest";
import { decl, globalsCss, rule } from "../../test/css-rules";

/**
 * A3 (#2573) — the motion and shape of the InfoPopover, "About this data" and the tier
 * segmented control. Durations are motion tokens (tokens.css zeroes them under reduced motion,
 * and the duration-token fence checks every value); this pins WHICH token and what moves.
 */
const CSS = globalsCss();
const own = (selector: string) => {
  const body = rule(CSS, selector);
  expect(body, `${selector} must be declared at top level`).not.toBeNull();
  return body!;
};
const keyframes = (name: string) => {
  const at = CSS.indexOf(`@keyframes ${name}`);
  expect(at, name).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf("}\n}", at) + 3).replace(/\s+/g, " ");
};

describe("InfoPopover motion", () => {
  it("fades and scales 0.98 → 1 over --duration-fast (140ms), from the ⓘ", () => {
    expect(decl(own(".infopop[open] > .infopop__body"), "animation")).toBe(
      "infopop-in var(--duration-fast) var(--ease-enter) both",
    );
    expect(decl(own(".infopop__body"), "transform-origin")).toBe("top left");
    const kf = keyframes("infopop-in");
    expect(kf).toContain("opacity: 0; transform: scale(0.98);");
    expect(kf).toContain("opacity: 1; transform: scale(1);");
  });
});

describe("InfoPopover placement", () => {
  it("anchors the note to its row, not to the ⓘ, so it never runs off a 375px screen", () => {
    expect(decl(own(".page__subrow"), "position")).toBe("relative");
    expect(decl(own(".notice--row"), "position")).toBe("relative");
    expect(decl(own(".infopop"), "position")).toBe("static");
    const body = own(".infopop__body");
    expect(decl(body, "inset-inline")).toBe("0");
    expect(decl(body, "inline-size")).toBe("auto");
    expect(decl(body, "max-inline-size")).toBe("22rem");
    expect(decl(body, "inset-inline-start")).toBeNull();
    expect(decl(own(".page__subrow > .infopop > .infopop__body"), "margin-inline-start")).toBe(
      "auto",
    );
  });
});

describe("About this data motion", () => {
  it("expands height + opacity over --duration-base (220ms)", () => {
    expect(decl(own(".about::details-content"), "transition")).toContain(
      "block-size var(--duration-base) var(--ease-out)",
    );
    expect(decl(own(".about[open] > .about__body"), "animation")).toBe(
      "about-in var(--duration-base) var(--ease-enter) both",
    );
    expect(keyframes("about-in")).toContain("opacity: 0;");
  });

  it("turns its chevron 180° in the same time", () => {
    expect(decl(own(".about .about__chevron"), "transition")).toBe(
      "transform var(--duration-base) var(--ease-out)",
    );
    expect(decl(own(".about[open] > .about__toggle > .about__chevron"), "transform")).toBe(
      "rotate(180deg)",
    );
  });
});

describe("the tier segmented control", () => {
  it("is one track; its segments drop their own borders and the selected one lifts", () => {
    expect(decl(own(".segmented"), "display")).toBe("inline-flex");
    expect(decl(own(".segmented > .btn"), "border-color")).toBe("transparent");
    expect(decl(own(".segmented > .btn--selected"), "background")).toBe("var(--surface-card)");
  });
});
