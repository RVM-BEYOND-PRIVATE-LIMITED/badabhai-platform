import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseThemePreference,
  resolvePayerTheme,
  THEME_COOKIE_NAME,
  THEME_COOKIE_MAX_AGE,
} from "./config";

/**
 * THEME-1 — server-side theme resolution (the precedence the root layout renders from).
 *
 * `resolvePayerTheme(cookieValue)` is a PURE function of the already-read `bb_theme` cookie:
 *   explicit cookie (paper/ink) → env PAYER_THEME (back-compat) → system/paper.
 * For `system` (or no cookie + no env default) the server can't read the OS, so it resolves
 * to the stable `paper` baseline and the inline no-FOUC script corrects it before paint —
 * which is also why the cookie path never causes a hydration mismatch.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseThemePreference — fail-soft coercion", () => {
  it("accepts the three known values (case/space-insensitive)", () => {
    expect(parseThemePreference("paper")).toBe("paper");
    expect(parseThemePreference("  INK ")).toBe("ink");
    expect(parseThemePreference("System")).toBe("system");
  });
  it("rejects unknown / empty values", () => {
    expect(parseThemePreference("dark")).toBeUndefined();
    expect(parseThemePreference("")).toBeUndefined();
    expect(parseThemePreference(undefined)).toBeUndefined();
    expect(parseThemePreference(null)).toBeUndefined();
  });
});

describe("resolvePayerTheme — precedence", () => {
  it("an explicit ink cookie resolves to ink (the SSR layout flips to dark)", () => {
    expect(resolvePayerTheme("ink")).toBe("ink");
  });

  it("an explicit paper cookie resolves to paper (even if env default is ink)", () => {
    vi.stubEnv("PAYER_THEME", "ink");
    expect(resolvePayerTheme("paper")).toBe("paper");
  });

  it("a system cookie resolves to the stable paper baseline (OS unknown server-side)", () => {
    expect(resolvePayerTheme("system")).toBe("paper");
  });

  it("no cookie falls back to the env PAYER_THEME default (back-compat: ink still works)", () => {
    vi.stubEnv("PAYER_THEME", "ink");
    expect(resolvePayerTheme(undefined)).toBe("ink");
  });

  it("no cookie + NEXT_PUBLIC_PAYER_THEME=ink resolves to ink (public mirror seam)", () => {
    vi.stubEnv("NEXT_PUBLIC_PAYER_THEME", "ink");
    expect(resolvePayerTheme(null)).toBe("ink");
  });

  it("no cookie + no env default resolves to paper (the shipped default is unchanged)", () => {
    expect(resolvePayerTheme(undefined)).toBe("paper");
  });

  it("an unknown cookie value is ignored and falls through to env/system", () => {
    expect(resolvePayerTheme("midnight")).toBe("paper");
    vi.stubEnv("PAYER_THEME", "ink");
    expect(resolvePayerTheme("midnight")).toBe("ink");
  });
});

describe("THEME-1 cookie contract", () => {
  it("names the SSR-readable cookie bb_theme with a ~1yr max-age", () => {
    expect(THEME_COOKIE_NAME).toBe("bb_theme");
    expect(THEME_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 365);
  });
});
