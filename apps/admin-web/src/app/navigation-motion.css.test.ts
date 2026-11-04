import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decl,
  declaredProperties,
  resolveToken,
  rules,
  stripComments,
  tokensCss,
} from "../../test/css-rules";

/**
 * A6 (#2576) — THE NAVIGATION'S MOTION, as the issue specifies it, pinned on the declared rules
 * (the node env has no layout engine; each was also watched in headless Chrome):
 *   active marker glides 220ms · a group opens/closes in 180ms · the avatar menu fades and scales
 *   0.98 → 1 from the top-right in 140ms · the palette fades in with an 8px drop in 160ms, and its
 *   highlight moves instantly. Opacity and transform only; every duration a token, so all of it is
 *   zero under prefers-reduced-motion. And all of it lives in ONE block at the end of globals.css.
 */
const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, "globals.css"), "utf8");
const MARK = "══ A6 (#2576)";
const TOKENS = tokensCss();

const BLOCK = stripComments(RAW.slice(RAW.indexOf(MARK)));
const ALL = rules(BLOCK, true);
const top = (selector: string) =>
  ALL.find((r) => r.selector === selector && r.atRules.length === 0);
const keyframes = (name: string) => ALL.filter((r) => r.atRules.join() === `@keyframes ${name}`);

/** A duration token's value, plain or under prefers-reduced-motion. */
const token = (name: string) => resolveToken(TOKENS, name);
function reducedToken(name: string): string {
  const reduced = rules(TOKENS, true).filter((r) =>
    r.atRules.some((a) => a.includes("prefers-reduced-motion: reduce")),
  );
  for (const r of reduced) {
    const v = decl(r.body, name);
    if (v !== null) return v;
  }
  throw new Error(`${name} is not zeroed under reduced motion`);
}

describe("the A6 styles are ONE block, at the end of globals.css", () => {
  it("is marked once, and nothing follows it but its own rules", () => {
    expect(RAW.split(MARK)).toHaveLength(2);
    expect(RAW.indexOf(MARK)).toBeGreaterThan(RAW.length * 0.9);
    // Every A6 selector lives in the block, none before it.
    const before = stripComments(RAW.slice(0, RAW.indexOf(MARK)));
    for (const cls of [
      ".sidebar__marker",
      ".sidebar__grouptoggle",
      ".avatar-menu",
      ".jump",
      ".topbar__jump",
    ]) {
      expect(before.includes(cls), cls).toBe(false);
      expect(BLOCK.includes(cls), cls).toBe(true);
    }
  });
});

describe("the active marker glides 220ms between rows", () => {
  it("moves by transform alone, on the glide curve, over --duration-base (220ms)", () => {
    const marker = top(".sidebar__marker")!;
    expect(decl(marker.body, "transition")).toBe(
      "transform var(--duration-base) var(--ease-glide)",
    );
    expect(decl(marker.body, "transform")).toBe("translateY(var(--nav-marker-y))");
    expect(token("--duration-base")).toBe("220ms");
  });

  it("is the active row's wash and spine, drawn once — the row hands them over", () => {
    const marker = top(".sidebar__marker")!;
    expect(decl(marker.body, "background")).toBe("var(--surface-ink-active)");
    expect(decl(marker.body, "box-shadow")).toBe("inset var(--border-spine) 0 0 0 var(--brand)");
    const handedOver = top(".sidebar__nav[data-marker] .sidebar__link.is-active")!;
    expect(decl(handedOver.body, "background")).toBe("transparent");
    expect(decl(handedOver.body, "box-shadow")).toBe("none");
  });
});

describe("a group opens and closes in 180ms", () => {
  const OPEN = ".sidebar__group[data-moved] > .sidebar__list:not([hidden])";
  const CLOSED = ".sidebar__group[data-moved] > .sidebar__list[hidden]";

  it("opening: the rows rise in on the enter curve, 2 × --duration-press (180ms)", () => {
    expect(decl(top(OPEN)!.body, "animation")).toBe(
      "nav-group-in calc(var(--duration-press) * 2) var(--ease-enter)",
    );
    expect(token("--duration-press")).toBe("90ms");
    const from = keyframes("nav-group-in")[0]!;
    expect(decl(from.body, "transform")).toBe("translateY(calc(-1 * var(--motion-rise)))");
  });

  it("closing: they fade and lift on the exit curve before the list goes", () => {
    const t = decl(top(CLOSED)!.body, "transition")!;
    expect(t).toContain("opacity calc(var(--duration-press) * 2) var(--ease-exit)");
    expect(t).toContain("transform calc(var(--duration-press) * 2) var(--ease-exit)");
    expect(t).toContain("display calc(var(--duration-press) * 2) allow-discrete");
  });

  it("only a group the operator toggled animates — nothing moves on a page load", () => {
    const unconditional = ALL.filter(
      (r) =>
        r.selector.includes(".sidebar__list") &&
        !r.selector.includes("[data-moved]") &&
        (decl(r.body, "animation") ?? decl(r.body, "transition")) !== null,
    );
    expect(unconditional.map((r) => r.selector)).toEqual([]);
  });
});

describe("the avatar menu fades and scales 0.98 → 1 from the top-right in 140ms", () => {
  it("animates on opening over --duration-fast (140ms), on the enter curve", () => {
    expect(decl(top(".avatar-menu__panel:not([hidden])")!.body, "animation")).toBe(
      "avatar-menu-in var(--duration-fast) var(--ease-enter)",
    );
    expect(token("--duration-fast")).toBe("140ms");
    expect(decl(top(".avatar-menu__panel")!.body, "transform-origin")).toBe("top right");
  });

  it("from transparent at the enter scale (0.98)", () => {
    const from = keyframes("avatar-menu-in")[0]!;
    expect(decl(from.body, "opacity")).toBe("0");
    expect(decl(from.body, "transform")).toBe("scale(var(--motion-enter-scale))");
    expect(token("--motion-enter-scale")).toBe("0.98");
  });
});

describe("the palette fades in with an 8px drop in 160ms; its highlight never animates", () => {
  it("opens over 2 × --duration-instant (160ms) on the enter curve, backdrop with it", () => {
    expect(decl(top(".jump[open]")!.body, "animation")).toBe(
      "jump-in calc(var(--duration-instant) * 2) var(--ease-enter)",
    );
    expect(decl(top(".jump[open]::backdrop")!.body, "animation")).toBe(
      "jump-fade calc(var(--duration-instant) * 2) var(--ease-enter)",
    );
    expect(token("--duration-instant")).toBe("80ms");
  });

  it("drops 8px (--space-2) — the issue's one stated exception to the 6px travel", () => {
    const from = keyframes("jump-in")[0]!;
    expect(decl(from.body, "opacity")).toBe("0");
    expect(decl(from.body, "transform")).toBe("translateY(calc(-1 * var(--space-2)))");
    expect(token("--space-2")).toBe("8px");
  });

  it("the highlight moves instantly: no option carries a transition or an animation", () => {
    const options = ALL.filter((r) => r.selector.includes(".jump__option"));
    expect(options.length).toBeGreaterThan(0);
    for (const r of options) {
      expect(decl(r.body, "transition"), r.selector).toBeNull();
      expect(decl(r.body, "animation"), r.selector).toBeNull();
    }
  });
});

describe("opacity and transform only — and zero under reduced motion", () => {
  it("every keyframe in the block animates opacity or transform, nothing else", () => {
    const frames = ALL.filter((r) => r.atRules.some((a) => a.startsWith("@keyframes")));
    expect(frames.length).toBe(4);
    for (const f of frames) {
      for (const prop of declaredProperties(f.body)) {
        expect(["opacity", "transform"], `${f.atRules.join()} ${prop}`).toContain(prop);
      }
    }
  });

  it("every transition in the block moves opacity, transform or a discrete display — or is the shared control token", () => {
    for (const r of ALL) {
      const t = decl(r.body, "transition");
      if (t === null || t === "var(--transition-control)") continue;
      for (const item of t.split(/,(?![^(]*\))/)) {
        const prop = item.trim().split(/\s+/)[0]!;
        expect(["opacity", "transform", "display"], `${r.selector}: ${item}`).toContain(prop);
      }
    }
  });

  it("every duration the block uses is zeroed by the token layer under reduced motion", () => {
    for (const name of [
      "--duration-base",
      "--duration-press",
      "--duration-fast",
      "--duration-instant",
    ]) {
      expect(reducedToken(name), name).toBe("0ms");
    }
    expect(reducedToken("--motion-rise")).toBe("0px");
    expect(reducedToken("--motion-enter-scale")).toBe("1");
  });
});
