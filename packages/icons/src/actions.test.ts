import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_ICON } from "./actions";
import { ICON_NAMES, LEGACY_ICON_NAMES } from "./names";

describe("ACTION_ICON — one concept, one icon", () => {
  it("covers the product's action vocabulary (adding or dropping an action is a reviewed change)", () => {
    expect(Object.keys(ACTION_ICON).sort()).toEqual(
      [
        "add",
        "applicant",
        "approve",
        "back",
        "calendar",
        "call",
        "candidate",
        "clearFilters",
        "close",
        "copy",
        "create",
        "credits",
        "delete",
        "disclosure",
        "dismiss",
        "download",
        "edit",
        "external",
        "filter",
        "location",
        "more",
        "next",
        "posting",
        "publish",
        "reinstate",
        "reject",
        "retry",
        "search",
        "send",
        "settings",
        "suspend",
        "timeline",
        "topUpQuota",
        "unlock",
        "upload",
        "users",
        "view",
        "whatsapp",
      ].sort(),
    );
  });

  it("maps only to canonical glyphs — never a retired one", () => {
    const canonical = new Set<string>(ICON_NAMES);
    const legacy = new Set<string>(LEGACY_ICON_NAMES);
    for (const [action, icon] of Object.entries(ACTION_ICON)) {
      expect(canonical.has(icon), action).toBe(true);
      expect(legacy.has(icon), action).toBe(false);
    }
  });

  it("keeps the distinctions the audit found blurred", () => {
    // `plus-circle` meant both "Post a job" and "Top up quota".
    expect(ACTION_ICON.topUpQuota).not.toBe(ACTION_ICON.create);
    // The credit balance wore three icons; Unlock is the ACTION, the wallet is the BALANCE.
    expect(ACTION_ICON.credits).not.toBe(ACTION_ICON.unlock);
    // Dismissing a panel must not look like rejecting a candidate.
    expect(ACTION_ICON.reject).not.toBe(ACTION_ICON.dismiss);
    // Synonyms share one glyph.
    expect(ACTION_ICON.add).toBe(ACTION_ICON.create);
    expect(ACTION_ICON.close).toBe(ACTION_ICON.dismiss);
    expect(ACTION_ICON.applicant).toBe(ACTION_ICON.candidate);
  });
});

describe("README.md documents the same table", () => {
  const readme = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
    "utf8",
  );
  const rows = new Map(
    [...readme.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );

  it("every ACTION_ICON entry appears as a row, with the same icon, and nothing extra", () => {
    expect(Object.fromEntries(rows)).toEqual({ ...ACTION_ICON });
  });
});
