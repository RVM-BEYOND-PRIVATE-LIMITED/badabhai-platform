import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decl, resolveToken, rules, stripComments, tokensCss } from "../../test/css-rules";

/**
 * A7 (#2577) — the candidate drawer's stylesheet, pinned on the declared rules (the node env has
 * no layout engine): ONE marked block at the end of globals.css; the drawer still slides in over
 * A5's 220ms; a move fades the content in over 140ms and moves nothing; the skeleton's sheen is
 * the 1.4s token and stops under reduced motion; opacity and transform only; brand tokens only.
 */
const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, "globals.css"), "utf8");
const MARK = "══ A7 (#2577)";
const TOKENS = tokensCss();

/** A7's block: from its marker's comment to the next lane's "══" marker, or the end. */
function a7Block(css: string): string {
  const at = css.indexOf(MARK);
  const next = css.indexOf("/* ══", at + MARK.length);
  return css.slice(css.lastIndexOf("/*", at), next < 0 ? undefined : next);
}
const BLOCK = stripComments(a7Block(RAW));
const ALL = rules(BLOCK, true);
const top = (selector: string) => {
  const r = ALL.find((x) => x.selector === selector && x.atRules.length === 0);
  expect(r, selector).toBeDefined();
  return r!.body;
};
/** Every `@keyframes` of the block: its name and the properties its steps set. */
const KEYFRAMES = [...BLOCK.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)].map((m) => ({
  name: m[1]!,
  body: m[2]!,
}));
const ms = (token: string) => Number.parseFloat(resolveToken(TOKENS, token));

/** The selectors this lane owns — none may be declared outside its block. */
const A7_SELECTOR = /\.(?:cdrawer|cfield|source-tag|lock-tag|cjobs?|skeleton)(?:__[\w-]+|--[\w-]+)?(?![\w-])/;

describe("ONE marked block, after A6's", () => {
  it("is marked once and lands after the A6 block", () => {
    expect(RAW.split(MARK)).toHaveLength(2);
    expect(RAW.indexOf(MARK)).toBeGreaterThan(RAW.indexOf("══ A6 (#2576)"));
  });

  it("holds every A7 selector — none is declared before it", () => {
    const before = rules(stripComments(RAW.slice(0, RAW.lastIndexOf("/*", RAW.indexOf(MARK)))), true);
    expect(before.filter((r) => A7_SELECTOR.test(r.selector)).map((r) => r.selector)).toEqual([]);
    expect(ALL.filter((r) => A7_SELECTOR.test(r.selector)).length).toBeGreaterThan(25);
    // The detector sees an element, a modifier and a plain block name — and leaves look-alikes.
    for (const yes of [".cdrawer__tabbar", ".skeleton--title", ".cjobs", ".lock-tag > .ph-fill"])
      expect(A7_SELECTOR.test(yes), yes).toBe(true);
    for (const no of [".skeletons", ".cfields-x", ".grid__cell"]) expect(A7_SELECTOR.test(no), no).toBe(false);
  });
});

describe("motion", () => {
  it("the drawer itself still slides in over A5's --duration-base (220ms) — A7 adds no second slide", () => {
    const drawer = rules(stripComments(RAW)).find((r) => r.selector === ".overlay--drawer .overlay__panel");
    expect(decl(drawer!.body, "animation")).toBe("drawer-in var(--duration-base) var(--ease-enter) both");
    expect(ms("--duration-base")).toBe(220);
    expect(ALL.some((r) => /overlay/.test(r.selector))).toBe(false);
  });

  it("a move fades the content in over --duration-fast (140ms), opacity only — no slide", () => {
    expect(decl(top(".cdrawer__view"), "animation")).toBe(
      "cdrawer-content-in var(--duration-fast) var(--ease-enter) both",
    );
    expect(ms("--duration-fast")).toBe(140);
    const fade = KEYFRAMES.find((k) => k.name === "cdrawer-content-in")!;
    expect([...fade.body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])).toEqual(["opacity", "opacity"]);
  });

  it("the skeleton's sheen is one 1.4s sweep (--duration-shimmer), a progress indicator that loops", () => {
    expect(decl(top(".skeleton::after"), "animation")).toBe(
      "skeleton-sheen var(--duration-shimmer) var(--ease-in-out) infinite",
    );
    expect(ms("--duration-shimmer")).toBe(1400);
  });

  it("every keyframe animates only opacity and transform", () => {
    expect(KEYFRAMES.map((k) => k.name)).toEqual(["cdrawer-content-in", "skeleton-sheen"]);
    for (const { name, body } of KEYFRAMES) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props.every((p) => p === "opacity" || p === "transform"), name).toBe(true);
    }
  });

  it("nothing else in the block loops", () => {
    const looping = ALL.filter((r) => (decl(r.body, "animation") ?? "").includes("infinite"));
    expect(looping.map((r) => r.selector)).toEqual([".skeleton::after"]);
  });

  it("under reduced motion the tokens are 0 and the sheen is taken away", () => {
    const reduced = rules(TOKENS, true).filter((r) =>
      r.atRules.some((a) => a.includes("prefers-reduced-motion: reduce")),
    );
    const all = reduced.map((r) => r.body).join(";");
    expect(decl(all, "--duration-fast")).toBe("0ms");
    expect(decl(all, "--duration-shimmer")).toBe("0ms");
    const still = ALL.find(
      (r) => r.selector === ".skeleton::after" && r.atRules.some((a) => a.includes("prefers-reduced-motion: reduce")),
    );
    expect(still && decl(still.body, "animation")).toBe("none");
  });
});

describe("layout", () => {
  it("the tab row sticks to the top of the drawer's scroller, on the card surface", () => {
    const bar = top(".cdrawer__tabbar");
    expect(decl(bar, "position")).toBe("sticky");
    expect(decl(bar, "inset-block-start")).toBe("0");
    expect(decl(bar, "background")).toBe("var(--surface-card)");
  });

  it("on a phone the seven tabs are one line that scrolls sideways, not three sticky lines", () => {
    const phone = ALL.filter((r) => r.atRules.join() === "@media (max-width: 600px)");
    const tabs = phone.find((r) => r.selector === ".cdrawer__tabs");
    expect(tabs && decl(tabs.body, "flex-wrap")).toBe("nowrap");
    expect(tabs && decl(tabs.body, "overflow-x")).toBe("auto");
    const tab = phone.find((r) => r.selector === ".cdrawer__tabs > .btn");
    expect(tab && decl(tab.body, "flex")).toBe("none");
  });

  it("a hidden tab panel takes no room", () => {
    expect(decl(top(".cdrawer__panel[hidden]"), "display")).toBe("none");
  });

  it("the lock is positioned for its tooltip, and its reason wraps inside a bound", () => {
    expect(decl(top(".lock-tag"), "position")).toBe("relative");
    const tip = top(".lock-tag > .bb-icon-tip");
    expect(decl(tip, "white-space")).toBe("normal");
    expect(decl(tip, "max-inline-size")).toBe("min(20rem, 70vw)");
  });

  it("drawer values wrap between words — not `.kv__v`'s break-all, which is for ids", () => {
    expect(decl(top(".cdrawer .kv__v"), "word-break")).toBe("normal");
  });

  it("a muted value starts where every value starts — no table-cell leading gap", () => {
    expect(decl(top(".cdrawer .table__meta"), "margin-left")).toBe("0");
  });
});

describe("brand only — no new colour", () => {
  it("every colour in the block is a token (or transparent)", () => {
    const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i;
    const offenders = ALL.flatMap((r) =>
      r.body
        .split(";")
        .filter((d) => /(^|\s)(color|background|background-color|border|border-color|box-shadow|outline)\s*:/.test(d))
        .filter((d) => literal.test(d))
        .map((d) => `${r.selector} { ${d.trim()} }`),
    );
    expect(offenders).toEqual([]);
  });
});
