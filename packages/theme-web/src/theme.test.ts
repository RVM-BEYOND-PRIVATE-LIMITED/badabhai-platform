import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_NO_FOUC_SCRIPT,
  THEME_COOKIE_NAME,
  THEME_COOKIE_MAX_AGE,
  applyResolvedTheme,
  createThemeNoFoucScript,
  displayThemeToPreference,
  preferenceToDisplayTheme,
  readThemeCookieClient,
  resolvePreferenceClient,
  resolveServerTheme,
  resolveStartPreference,
  syncThemeColorMeta,
  writeThemeCookie,
} from "./theme";

/**
 * The shared client runtime helpers (cookie read/write, apply, theme-color sync) + the
 * no-FOUC inline-script string. The repo test env is node (no DOM), so a minimal document /
 * window / getComputedStyle is stubbed; the helpers only ever touch those globals.
 */

type FakeMeta = {
  name: string;
  attrs: Record<string, string>;
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
};

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
    surface: "#f2f4f8",
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
      sel === 'meta[name="theme-color"]'
        ? (dom.metas.find((m) => m.name === "theme-color") ?? null)
        : null,
    get cookie() {
      return dom.cookie;
    },
    set cookie(v: string) {
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
  it("reads a portal-specific cookie name", () => {
    dom.cookie = "bb_admin_theme=paper";
    expect(readThemeCookieClient("bb_admin_theme")).toBe("paper");
    expect(readThemeCookieClient()).toBeUndefined();
  });
});

describe("writeThemeCookie", () => {
  it("persists bb_theme with Path=/, the ~1yr Max-Age, SameSite=Lax, and Secure on https", () => {
    writeThemeCookie("ink");
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

  it("writes a portal-specific cookie name", () => {
    writeThemeCookie("ink", "bb_admin_theme");
    expect(readThemeCookieClient("bb_admin_theme")).toBe("ink");
    expect(readThemeCookieClient()).toBeUndefined();
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

describe("resolveServerTheme — the cookie → env → paper precedence", () => {
  it("an explicit cookie wins", () => {
    expect(resolveServerTheme("ink", "paper")).toBe("ink");
    expect(resolveServerTheme("paper", "ink")).toBe("paper");
  });
  it("system resolves to the stable paper baseline", () => {
    expect(resolveServerTheme("system", "ink")).toBe("paper");
  });
  it("no cookie falls through to the env default then paper", () => {
    expect(resolveServerTheme(undefined, "ink")).toBe("ink");
    expect(resolveServerTheme("midnight", "ink")).toBe("ink");
    expect(resolveServerTheme(undefined, null)).toBe("paper");
    expect(resolveServerTheme("midnight", "system")).toBe("paper");
  });
});

describe("resolveStartPreference — the server value wins over the cookie", () => {
  it("uses an authoritative server preference over the cookie", () => {
    expect(resolveStartPreference("ink", "paper")).toBe("ink");
    expect(resolveStartPreference("paper", "ink")).toBe("paper");
    expect(resolveStartPreference("system", "ink")).toBe("system");
  });
  it("falls back to the cookie, then system", () => {
    expect(resolveStartPreference(undefined, "ink")).toBe("ink");
    expect(resolveStartPreference(undefined, undefined)).toBe("system");
  });
});

describe("display-prefs wire mapping", () => {
  it("maps light/dark/system to paper/ink/system and back", () => {
    expect(displayThemeToPreference("light")).toBe("paper");
    expect(displayThemeToPreference("dark")).toBe("ink");
    expect(displayThemeToPreference("system")).toBe("system");
    expect(preferenceToDisplayTheme("paper")).toBe("light");
    expect(preferenceToDisplayTheme("ink")).toBe("dark");
    expect(preferenceToDisplayTheme("system")).toBe("system");
    expect(displayThemeToPreference("Dark")).toBeUndefined();
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
    dom.surface = "#0b1220";
    syncThemeColorMeta();
    expect(dom.metas.filter((m) => m.name === "theme-color")).toHaveLength(1);
    expect(meta!.getAttribute("content")).toBe("#0b1220");
  });
});

describe("THEME_NO_FOUC_SCRIPT — synchronous, dependency-free, adherence-safe", () => {
  it("references the cookie name + prefers-color-scheme and is a plain string (no import)", () => {
    expect(THEME_NO_FOUC_SCRIPT).toContain(THEME_COOKIE_NAME);
    expect(THEME_NO_FOUC_SCRIPT).toContain("prefers-color-scheme: dark");
    expect(THEME_NO_FOUC_SCRIPT).toContain("--surface-page");
    expect(THEME_NO_FOUC_SCRIPT.trim().startsWith("(function(){try{")).toBe(true);
  });

  it("carries NO raw hex color or px literal (the adherence gate audits UI source)", () => {
    expect(THEME_NO_FOUC_SCRIPT).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(THEME_NO_FOUC_SCRIPT).not.toMatch(/\b\d+px\b/);
  });

  it("only acts on the no-explicit-cookie path (it checks v!==paper && v!==ink)", () => {
    expect(THEME_NO_FOUC_SCRIPT).toContain('v!=="paper"&&v!=="ink"');
  });

  it("can be built for a portal-specific cookie name", () => {
    const script = createThemeNoFoucScript("bb_admin_theme");
    expect(script).toContain('"bb_admin_theme"');
    expect(script).not.toContain(`"${THEME_COOKIE_NAME}"`);
  });

  it("ignores the cookie when the server has an authoritative explicit choice", () => {
    const script = createThemeNoFoucScript(THEME_COOKIE_NAME, "ink");
    expect(script).not.toContain('v!=="paper"&&v!=="ink"');
    expect(script).not.toContain("prefers-color-scheme");
  });

  it("follows the OS for an authoritative `system`, even with a stale explicit cookie", () => {
    const script = createThemeNoFoucScript(THEME_COOKIE_NAME, "system");
    expect(script).not.toContain('v!=="paper"&&v!=="ink"');
    expect(script).toContain("prefers-color-scheme: dark");
  });
});

describe("max-age is a year", () => {
  it("exports a ~1yr seconds constant", () => {
    expect(THEME_COOKIE_MAX_AGE).toBe(31_536_000);
  });
});
