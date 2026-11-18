/**
 * #2819 — the display-preference vocabularies. `packages/db` spells both sets into CHECK
 * constraints and `packages/event-schema` into `display_prefs.changed`; their own tests pin those
 * copies to these, so this file pins the sets themselves.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISPLAY_THEME,
  DISPLAY_PREFS_SUBJECT_KINDS,
  DISPLAY_THEMES,
  isDisplayTheme,
} from "./index";

describe("display preferences", () => {
  it("offers light, dark and system, frozen", () => {
    expect(DISPLAY_THEMES).toEqual(["light", "dark", "system"]);
    expect(Object.isFrozen(DISPLAY_THEMES)).toBe(true);
  });

  it("defaults to light: what every app shows today, and what a closed switch answers", () => {
    expect(DEFAULT_DISPLAY_THEME).toBe("light");
    expect(DISPLAY_THEMES).toContain(DEFAULT_DISPLAY_THEME);
  });

  it("isDisplayTheme admits the set and nothing else", () => {
    for (const theme of DISPLAY_THEMES) expect(isDisplayTheme(theme)).toBe(true);
    for (const other of ["Dark", "ink", "auto", "", null, undefined, 0, {}]) {
      expect(isDisplayTheme(other)).toBe(false);
    }
  });

  it("names three logins: a worker, a company or agency login, an admin (never a tenant)", () => {
    expect(DISPLAY_PREFS_SUBJECT_KINDS).toEqual(["worker", "payer_user", "admin"]);
    expect(Object.isFrozen(DISPLAY_PREFS_SUBJECT_KINDS)).toBe(true);
    expect(DISPLAY_PREFS_SUBJECT_KINDS).not.toContain("payer");
    expect(DISPLAY_PREFS_SUBJECT_KINDS).not.toContain("tenant");
  });
});
