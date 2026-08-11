import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE COOLING-OFF WINDOW IS SPELLED THREE WAYS, IN TWO UNITS, ACROSS TWO FILES (#737).
 *
 * WHY THIS FILE EXISTS. The supply-chain window — "do not resolve a version published in the
 * last 7 days" — is configured three times because two package managers read two different
 * key names and disagree about the unit:
 *
 *   pnpm-workspace.yaml  `minimumReleaseAge: 10080`   pnpm's source of truth, MINUTES
 *   .npmrc               `minimum-release-age=10080`  pnpm's kebab spelling, MINUTES
 *   .npmrc               `min-release-age=7`          npm's key (npm >= 11.10), DAYS
 *
 * pnpm does not read npm's key and npm does not read pnpm's, so a repo that sets only one is
 * unprotected the moment anyone runs the other client — which `npx`, a CI action, and a
 * contributor's muscle memory all do. That is why there are three, and it is also the hazard:
 * three hand-maintained numbers with nothing tying them together. Editing one of them is a
 * one-character change that silently makes the protection depend on WHICH TOOL RAN, and no
 * install fails, no lint fires, and no reviewer diffing a single file can see it.
 *
 * The comment in `.npmrc` already says "KEEP ALL THREE IN SYNC". A comment is not a guard.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts the three describe the SAME
 * window, converting between the units. It does NOT assert 7 days specifically — the length is
 * a policy call the owner can change, and a test pinning the number would fail on the first
 * legitimate change and be deleted rather than updated. Change the window in all three places
 * and this stays green; change it in one and it fails, which is the only failure worth having.
 */
const ROOT = join(__dirname, "../../../..");
const NPMRC = readFileSync(join(ROOT, ".npmrc"), "utf8");
const WORKSPACE = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");

const MINUTES_PER_DAY = 60 * 24;

/**
 * A key's value, read from real declarations ONLY.
 *
 * PARSED, NOT GREPPED. Both files carry long comment blocks that mention these key names in
 * prose (that is the whole point of the comments), so a substring search finds the explanation
 * before it finds the setting and would happily read a number out of an example. Anchoring to
 * line start after trimming is what separates a declaration from a sentence about one.
 */
function declared(source: string, key: string, separator: ":" | "="): string | null {
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    if (!line.startsWith(`${key}${separator}`)) continue;
    return line.slice(key.length + 1).trim();
  }
  return null;
}

describe("the release-age cooling-off window agrees across every client that reads it (#737)", () => {
  it("declares all three settings — a missing one is an unprotected client, not a tidier file", () => {
    expect(declared(WORKSPACE, "minimumReleaseAge", ":")).not.toBeNull();
    expect(declared(NPMRC, "minimum-release-age", "=")).not.toBeNull();
    // npm's own key. Without it, `npx` and any CI step that shells out to npm resolve with no
    // cooling-off window at all, while every comment in the repo says there is one.
    expect(declared(NPMRC, "min-release-age", "=")).not.toBeNull();
  });

  it("describes ONE window in all three, across the minutes/days unit change", () => {
    const workspaceMinutes = Number(declared(WORKSPACE, "minimumReleaseAge", ":"));
    const npmrcMinutes = Number(declared(NPMRC, "minimum-release-age", "="));
    const npmDays = Number(declared(NPMRC, "min-release-age", "="));

    expect(Number.isFinite(workspaceMinutes)).toBe(true);
    expect(Number.isFinite(npmDays)).toBe(true);

    // Same spelling, same unit — these two must be identical.
    expect(npmrcMinutes).toBe(workspaceMinutes);
    // Different unit. THIS is the conversion a hand edit gets wrong: setting npm's key to
    // 10080 would mean a 27-year window (npm refuses everything) and setting pnpm's to 7
    // would mean seven MINUTES (no protection at all). Both read as "in sync" at a glance.
    expect(npmDays * MINUTES_PER_DAY).toBe(workspaceMinutes);
  });
});
