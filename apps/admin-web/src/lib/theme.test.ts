import { describe, expect, it } from "vitest";
import {
  ADMIN_THEME_COOKIE_NAME,
  createThemeNoFoucScript,
  THEME_NO_FOUC_SCRIPT,
} from "@badabhai/theme-web";
import {
  adminRootTheme,
  adminThemePreference,
  THEME_COOKIE_NAME,
} from "./theme";

/**
 * #2821 — admin-web's theme decision, in isolation from Next.
 *
 * The root layout asks `adminRootTheme`; while the server-saved choice is closed it returns
 * `undefined`, so the root sets NO `data-theme` and the admin cookie is ignored. The portal keeps
 * its own cookie name so it can never read or overwrite payer-web's `bb_theme`.
 */
describe("admin root theme — closed means no data-theme", () => {
  it("returns undefined when there is no prefs read", () => {
    expect(adminRootTheme(null)).toBeUndefined();
  });

  it("returns undefined while theme_open is false, whatever the theme says", () => {
    expect(adminRootTheme({ theme_open: false, theme: "dark" })).toBeUndefined();
    expect(adminRootTheme({ theme_open: false, theme: "system" })).toBeUndefined();
  });

  it("follows the server value when open: dark → ink, light/system → paper", () => {
    expect(adminRootTheme({ theme_open: true, theme: "dark" })).toBe("ink");
    expect(adminRootTheme({ theme_open: true, theme: "light" })).toBe("paper");
    expect(adminRootTheme({ theme_open: true, theme: "system" })).toBe("paper");
  });
});

describe("admin cookie is never payer-web's bb_theme", () => {
  it("uses bb_admin_theme", () => {
    expect(ADMIN_THEME_COOKIE_NAME).toBe("bb_admin_theme");
    expect(THEME_COOKIE_NAME).toBe("bb_admin_theme");
    expect(THEME_COOKIE_NAME).not.toBe("bb_theme");
  });

  it("maps wire values onto the admin preference", () => {
    expect(adminThemePreference("dark")).toBe("ink");
    expect(adminThemePreference("light")).toBe("paper");
    expect(adminThemePreference("system")).toBe("system");
    expect(adminThemePreference("Dark")).toBeUndefined();
  });

  it("the admin no-FOUC script names its own cookie, not bb_theme", () => {
    const script = createThemeNoFoucScript(ADMIN_THEME_COOKIE_NAME);
    expect(script).toContain("bb_admin_theme");
    expect(script).not.toContain('"bb_theme"');
    expect(THEME_NO_FOUC_SCRIPT).toContain("bb_theme");
  });
});
