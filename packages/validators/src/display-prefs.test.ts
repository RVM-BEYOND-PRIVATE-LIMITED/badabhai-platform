/**
 * #2819 — the wire contract of every realm's `me/display-prefs` (worker, company or agency login,
 * admin). The api parses PATCH bodies with `updateDisplayPrefsSchema`; the apps may parse replies
 * with `displayPrefsResponseSchema`. Both are strict, so a smuggled id or a renamed field is loud.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  DISPLAY_THEMES,
  type DisplayPrefsResponse,
  type UpdateDisplayPrefsRequest,
} from "@badabhai/types";

import { displayPrefsResponseSchema, displayThemeSchema, updateDisplayPrefsSchema } from "./index";

const OTHER = "99999999-9999-4999-8999-999999999999";

describe("displayThemeSchema", () => {
  it("is exactly DISPLAY_THEMES", () => {
    expect(displayThemeSchema.options).toEqual([...DISPLAY_THEMES]);
    expect(displayThemeSchema.options).toEqual(["light", "dark", "system"]);
  });

  it.each(["Dark", "LIGHT", " dark", "ink", "auto", "", null, 1, true])("refuses %j", (bad) => {
    expect(displayThemeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("updateDisplayPrefsSchema — the PATCH body", () => {
  it.each(DISPLAY_THEMES)("accepts { theme: %s }", (theme) => {
    expect(updateDisplayPrefsSchema.parse({ theme })).toEqual({ theme });
  });

  it("refuses an empty body: a PATCH that says nothing is a 400, not a silent no-op", () => {
    expect(updateDisplayPrefsSchema.safeParse({}).success).toBe(false);
  });

  it.each(["worker_id", "payer_id", "admin_id", "subject_id", "subject_kind", "id", "theme_open"])(
    "refuses an unknown key (%s): the login is the token's, never the body's",
    (key) => {
      expect(updateDisplayPrefsSchema.safeParse({ theme: "dark", [key]: OTHER }).success).toBe(
        false,
      );
    },
  );

  it("infers exactly UpdateDisplayPrefsRequest", () => {
    expectTypeOf<z.infer<typeof updateDisplayPrefsSchema>>().toEqualTypeOf<{
      theme: UpdateDisplayPrefsRequest["theme"];
    }>();
  });
});

describe("displayPrefsResponseSchema — the reply", () => {
  it("accepts the closed reply and an open one", () => {
    for (const reply of [
      { theme: "light", theme_open: false },
      { theme: "dark", theme_open: true },
      { theme: "system", theme_open: true },
    ]) {
      expect(displayPrefsResponseSchema.parse(reply)).toEqual(reply);
    }
  });

  it("refuses a missing flag, a stringly flag and an extra field", () => {
    for (const bad of [
      { theme: "light" },
      { theme: "light", theme_open: "false" },
      { theme: "light", theme_open: false, subject_id: OTHER },
    ]) {
      expect(displayPrefsResponseSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("infers exactly DisplayPrefsResponse", () => {
    expectTypeOf<z.infer<typeof displayPrefsResponseSchema>>().toEqualTypeOf<{
      theme: DisplayPrefsResponse["theme"];
      theme_open: DisplayPrefsResponse["theme_open"];
    }>();
  });
});
