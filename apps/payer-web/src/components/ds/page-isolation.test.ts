import { describe, expect, it } from "vitest";
import { inertOutside, lockPageScroll, type IsolationNode, type ScrollRoot } from "./page-isolation";

/**
 * The page behind an open Dialog is INERT and STILL (L4/L5 — a wheel over the sheet's scrim moved
 * the page y=900 → 1300, and nothing outside the dialog was inert). The DOM is faked structurally
 * (the node env has none); the real dialog was measured in Chromium.
 */

interface FakeEl extends IsolationNode {
  name: string;
  inert: boolean;
  parentElement: FakeEl | null;
  children: FakeEl[];
}

function el(name: string, children: FakeEl[] = [], inert = false): FakeEl {
  const node: FakeEl = { name, inert, parentElement: null, children };
  for (const c of children) c.parentElement = node;
  return node;
}

/** body > [header, main > [form, layout > [rail, dock, scrim > dialog]], footer] */
function page() {
  const dialog = el("dialog");
  const scrim = el("scrim", [dialog]);
  const rail = el("rail");
  const dock = el("dock");
  const layout = el("layout", [rail, dock, scrim]);
  const form = el("form");
  const main = el("main", [form, layout]);
  const header = el("header");
  const footer = el("footer");
  const body = el("body", [header, main, footer]);
  const html = el("html", [el("head"), body]);
  return { html, body, header, main, form, layout, rail, dock, scrim, dialog, footer };
}

const inertNames = (p: ReturnType<typeof page>) =>
  Object.entries(p)
    .filter(([, node]) => node.inert)
    .map(([name]) => name)
    .sort();

describe("inertOutside — everything outside the dialog, up to <body>", () => {
  it("makes each sibling along the dialog's ancestor path inert — and nothing on the path", () => {
    const p = page();
    inertOutside(p.dialog, p.body);
    expect(inertNames(p)).toEqual(["dock", "footer", "form", "header", "rail"]);
    // The path itself stays live: the dialog, its scrim (click-to-close), every ancestor.
    for (const k of ["dialog", "scrim", "layout", "main", "body", "html"] as const) {
      expect(p[k].inert, k).toBe(false);
    }
  });

  it("stops at <body>: <head> (the body's sibling) is never touched", () => {
    const p = page();
    inertOutside(p.dialog, p.body);
    expect(p.html.children[0]!.inert).toBe(false);
  });

  it("the release lifts exactly what it set", () => {
    const p = page();
    const release = inertOutside(p.dialog, p.body);
    release();
    expect(inertNames(p)).toEqual([]);
  });

  it("an element ALREADY inert is left alone both ways (its owner lifts it)", () => {
    const p = page();
    p.footer.inert = true;
    const release = inertOutside(p.dialog, p.body);
    release();
    expect(p.footer.inert).toBe(true);
    expect(p.header.inert).toBe(false);
  });

  it("nests: an inner dialog isolates the outer one too, and hands back only its own", () => {
    const p = page();
    const inner = el("inner");
    const innerScrim = el("innerScrim", [inner]);
    p.layout.children.push(innerScrim);
    innerScrim.parentElement = p.layout;
    const releaseOuter = inertOutside(p.dialog, p.body);
    const releaseInner = inertOutside(inner, p.body);
    expect(p.scrim.inert).toBe(true); // the outer dialog is behind the inner one
    releaseInner();
    expect(p.scrim.inert).toBe(false);
    expect(p.header.inert).toBe(true); // still behind the outer dialog
    releaseOuter();
    expect(inertNames(p)).toEqual([]);
  });

  it("skips a node that cannot be inert (an SVG sprite, an old engine)", () => {
    const p = page();
    const sprite = { parentElement: p.body, children: [] };
    p.body.children.push(sprite as unknown as FakeEl);
    expect(() => inertOutside(p.dialog, p.body)()).not.toThrow();
    expect("inert" in sprite).toBe(false);
  });
});

function root(clientWidth: number, overflow = "", scrollbarGutter = ""): ScrollRoot & {
  style: { overflow: string; scrollbarGutter: string };
} {
  return { clientWidth, style: { overflow, scrollbarGutter } };
}

describe("lockPageScroll — the page does not scroll under a dialog", () => {
  it("holds the root still while open and restores its own inline styles on close", () => {
    const r = root(1280, "auto", "");
    const release = lockPageScroll(r, 1280);
    expect(r.style.overflow).toBe("hidden");
    release();
    expect(r.style).toEqual({ overflow: "auto", scrollbarGutter: "" });
  });

  it("keeps a CLASSIC scrollbar's gutter (innerWidth > clientWidth), so nothing shifts sideways", () => {
    const r = root(1265);
    const release = lockPageScroll(r, 1280);
    expect(r.style.scrollbarGutter).toBe("stable");
    release();
    expect(r.style.scrollbarGutter).toBe("");
  });

  it("an OVERLAY scrollbar (phones, macOS) takes no space — no gutter is reserved", () => {
    const r = root(375);
    const release = lockPageScroll(r, 375);
    expect(r.style.scrollbarGutter).toBe("");
    release();
  });

  it("nested dialogs share one hold: only the LAST close restores; a double release is a no-op", () => {
    const r = root(1280, "", "");
    const outer = lockPageScroll(r, 1280);
    const inner = lockPageScroll(r, 1280);
    inner();
    inner();
    expect(r.style.overflow).toBe("hidden");
    outer();
    expect(r.style.overflow).toBe("");
    // A fresh hold after a full release locks again.
    const again = lockPageScroll(r, 1280);
    expect(r.style.overflow).toBe("hidden");
    again();
    expect(r.style.overflow).toBe("");
  });
});
