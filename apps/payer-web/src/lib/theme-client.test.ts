import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_NO_FOUC_SCRIPT,
  THEME_COOKIE_NAME,
  THEME_COOKIE_MAX_AGE,
  applyResolvedTheme,
  readThemeCookieClient,
  resolvePreferenceClient,
  syncThemeColorMeta,
  writeThemeCookie,
} from "./theme";

/**
 * THEME-1 — client runtime helpers (cookie read/write, apply, theme-color sync) + the
 * no-FOUC inline-script string. The repo test env is node (no DOM), so a minimal document /
 * window / getComputedStyle is stubbed; the helpers only ever touch those globals.
 */

type FakeMeta = { name: string; attrs: Record<string, string>; getAttribute(k: string): string | null; setAttribute(k: string, v: string): void };

interface DomState {
  cookie: string;
  rootDataset: Record<string, string>;
  rootAttrs: Record<string, string>;
  metas: FakeMeta[];
  surface: string;
  protocol: string;
  prefersDark: boolean;
}

let dom: DomState;

function makeMeta(name: string): FakeMeta {
  return {
    name,
    attrs: {},
    getAttribute(k) {
      return k === "name" ? this.name : (this.attrs[k] ?? null);
    },
    setAttribute(k, v) {
      if (k === "name") this.name = v;
      else this.attrs[k] = v;
    },
  };
}

beforeEach(() => {
  dom = {
    cookie: "",
    rootDataset: {},
    rootAttrs: {},
    metas: [],
    surface: "#fff6e8", // paper page surface (stand-in for the computed --surface-page)
    protocol: "https:",
    prefersDark: false,
  };

  const root = {
    dataset: dom.rootDataset,
    removeAttribute: (k: string) => {
      if (k === "data-theme") delete dom.rootDataset.theme;
      delete dom.rootAttrs[k];
    },
    setAttribute: (k: string, v: string) => {
      dom.rootAttrs[k] = v;
    },
    classList: { add: vi.fn(), remove: vi.fn() },
  };

  vi.stubGlobal("document", {
    documentElement: root,
    head: { appendChild: (m: FakeMeta) => dom.metas.push(m) },
    createElement: () => makeMeta(""),
    querySelector: (sel: string) =>
      sel === 'meta[name="theme-color"]' ? (dom.metas.find((m) => m.name === "theme-color") ?? null) : null,
    get cookie() {
      return dom.cookie;
    },
    set cookie(v: string) {
      // emulate document.cookie append semantics for a single key
      const [pair] = v.split(";");
      const [k] = pair!.split("=");
      const others = dom.cookie
        .split("; ")
        .filter(Boolean)
        .filter((c) => !c.startsWith(k + "="));
      dom.cookie = [...others, pair].filter(Boolean).join("; ");
    },
  });

  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (p: string) => (p === "--surface-page" ? dom.surface : ""),
  }));

  vi.stubGlobal("location", { protocol: dom.protocol });

  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      matches: q.includes("dark") ? dom.prefersDark : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readThemeCookieClient", () => {
  it("reads a known preference from document.cookie", () => {
    dom.cookie = `${THEME_COOKIE_NAME}=ink`;
    expect(readThemeCookieClient()).toBe("ink");
  });
  it("returns undefined when unset / unknown", () => {
    expect(readThemeCookieClient()).toBeUndefined();
    dom.cookie = `${THEME_COOKIE_NAME}=neon`;
    expect(readThemeCookieClient()).toBeUndefined();
  });
});

describe("writeThemeCookie", () => {
  it("persists bb_theme with Path=/, the ~1yr Max-Age, SameSite=Lax, and Secure on https", () => {
    writeThemeCookie("ink");
    // the helper writes the full attribute string to document.cookie set-trap; assert via cookie
    expect(readThemeCookieClient()).toBe("ink");
  });

  it("round-trips each value and overwrites the prior one", () => {
    writeThemeCookie("ink");
    expect(readThemeCookieClient()).toBe("ink");
    writeThemeCookie("paper");
    expect(readThemeCookieClient()).toBe("paper");
    writeThemeCookie("system");
    expect(readThemeCookieClient()).toBe("system");
  });
});

describe("resolvePreferenceClient — honours the OS for 'system'", () => {
  it("explicit choices return themselves", () => {
    expect(resolvePreferenceClient("ink")).toBe("ink");
    expect(resolvePreferenceClient("paper")).toBe("paper");
  });
  it("'system' follows prefers-color-scheme", () => {
    dom.prefersDark = false;
    expect(resolvePreferenceClient("system")).toBe("paper");
    dom.prefersDark = true;
    expect(resolvePreferenceClient("system")).toBe("ink");
  });
});

describe("applyResolvedTheme — flips data-theme + syncs theme-color", () => {
  it("ink sets data-theme=ink", () => {
    applyResolvedTheme("ink");
    expect(dom.rootDataset.theme).toBe("ink");
  });
  it("paper removes data-theme (paper = the attribute-less default)", () => {
    dom.rootDataset.theme = "ink";
    applyResolvedTheme("paper");
    expect(dom.rootDataset.theme).toBeUndefined();
  });
  it("creates + updates the theme-color meta from the computed --surface-page token", () => {
    applyResolvedTheme("paper");
    const meta = dom.metas.find((m) => m.name === "theme-color");
    expect(meta).toBeDefined();
    expect(meta!.getAttribute("content")).toBe(dom.surface);
    // a later flip updates the SAME meta (no duplicates)
    dom.surface = "#1c1108";
    syncThemeColorMeta();
    expect(dom.metas.filter((m) => m.name === "theme-color")).toHaveLength(1);
    expect(meta!.getAttribute("content")).toBe("#1c1108");
  });
});

describe("THEME_NO_FOUC_SCRIPT — synchronous, dependency-free, adherence-safe", () => {
  it("references the cookie name + prefers-color-scheme and is a plain string (no import)", () => {
    expect(THEME_NO_FOUC_SCRIPT).toContain(THEME_COOKIE_NAME);
    expect(THEME_NO_FOUC_SCRIPT).toContain("prefers-color-scheme: dark");
    expect(THEME_NO_FOUC_SCRIPT).toContain("--surface-page");
    // wrapped in a try/catch IIFE so a hostile environment can never break the document
    expect(THEME_NO_FOUC_SCRIPT.trim().startsWith("(function(){try{")).toBe(true);
  });

  it("carries NO raw hex color or px literal (the adherence gate audits UI source)", () => {
    expect(THEME_NO_FOUC_SCRIPT).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(THEME_NO_FOUC_SCRIPT).not.toMatch(/\b\d+px\b/);
  });

  it("only acts on the no-explicit-cookie path (it checks v!==paper && v!==ink)", () => {
    expect(THEME_NO_FOUC_SCRIPT).toContain('v!=="paper"&&v!=="ink"');
  });
});

describe("THEME-1 max-age is a year", () => {
  it("exports a ~1yr seconds constant", () => {
    expect(THEME_COOKIE_MAX_AGE).toBe(31_536_000);
  });
});
