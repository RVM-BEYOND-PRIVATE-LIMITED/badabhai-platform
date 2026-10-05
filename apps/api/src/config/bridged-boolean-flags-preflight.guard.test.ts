import { readFileSync } from "node:fs";
import { join } from "node:path";

import { booleanFromString, serverEnvSchema } from "@badabhai/config";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

/**
 * EVERY BRIDGED BOOLEAN IS CHECKED BEFORE ANYTHING MOVES.
 *
 * A name in the deploy job's appleboy `envs:` list reaches the box from a GitHub secret that
 * cannot be read back. When the api parses that name with `booleanFromString`, any value outside
 * true/false/1/0/empty throws at boot — and the api `up` has no automatic rollback, so a typo
 * crash-loops production after containers have already moved.
 *
 * scripts/deploy/staging-deploy.sh refuses such a value before the first prune, pull or
 * recreate. AI_RAW_PII_ENABLED, FEED_POSTINGS_UNION_ENABLED and MATCH_V1_ENABLED keep their own
 * `case` blocks (pinned by their own guard tests); every other bridged booleanFromString flag
 * must be in BRIDGED_BOOLEAN_FLAGS. This test derives the bridged set from ci.yml and the schema,
 * so a new `envs:` entry with no preflight fails here. Comments are stripped so prose cannot
 * satisfy these.
 */
const REPO_ROOT = join(__dirname, "../../../..");
const DEDICATED_GUARDS = ["AI_RAW_PII_ENABLED", "FEED_POSTINGS_UNION_ENABLED", "MATCH_V1_ENABLED"];

const SCRIPT = readFileSync(join(REPO_ROOT, "scripts/deploy/staging-deploy.sh"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** The names the deploy job's ssh step forwards to the box. */
function bridgedNames(): string[] {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const lines = workflow.split("\n").filter((line) => /^\s*envs:\s*\S/.test(line));
  expect(lines, "expected exactly one `envs:` list in ci.yml").toHaveLength(1);
  return (lines[0] ?? "")
    .replace(/^\s*envs:\s*/, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** True when the field is booleanFromString itself, or a wrapper (e.g. `.default`) around it. */
function parsesWithBooleanFromString(field: ZodTypeAny | undefined): boolean {
  let current: ZodTypeAny | undefined = field;
  while (current) {
    if (current === booleanFromString) return true;
    current = (current._def as { innerType?: ZodTypeAny }).innerType;
  }
  return false;
}

const BRIDGED_BOOLEANS = bridgedNames()
  .filter((name) =>
    parsesWithBooleanFromString(
      (serverEnvSchema.shape as Record<string, ZodTypeAny | undefined>)[name],
    ),
  )
  .sort();

const listMatch = /^BRIDGED_BOOLEAN_FLAGS=\(\n([\s\S]*?)\n\)$/m.exec(SCRIPT);
const PREFLIGHT_LIST = (listMatch?.[1] ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const LIST_START = listMatch?.index ?? -1;

describe("bridged booleanFromString flags — every one is preflighted by the deploy", () => {
  it("finds the bridged booleans (canary: guards the derivation, not the rule)", () => {
    expect(BRIDGED_BOOLEANS.length).toBeGreaterThan(DEDICATED_GUARDS.length);
    for (const name of [...DEDICATED_GUARDS, "AI_ENABLE_REAL_CALLS"]) {
      expect(BRIDGED_BOOLEANS).toContain(name);
    }
  });

  it("covers every bridged boolean: in BRIDGED_BOOLEAN_FLAGS or a dedicated case guard", () => {
    expect(listMatch, "BRIDGED_BOOLEAN_FLAGS=( ... ) is missing or reshaped").not.toBeNull();
    const missing = BRIDGED_BOOLEANS.filter(
      (name) => !PREFLIGHT_LIST.includes(name) && !DEDICATED_GUARDS.includes(name),
    );
    expect(missing, "bridged booleanFromString flags with no deploy preflight").toEqual([]);
  });

  it("lists only bridged booleanFromString flags, once each, none double-checked", () => {
    expect(new Set(PREFLIGHT_LIST).size).toBe(PREFLIGHT_LIST.length);
    for (const name of PREFLIGHT_LIST) {
      expect(BRIDGED_BOOLEANS, `${name} is not a bridged booleanFromString flag`).toContain(name);
      expect(DEDICATED_GUARDS, `${name} already has a dedicated guard`).not.toContain(name);
    }
  });

  it("keeps the dedicated guards for the three flags that have them", () => {
    for (const name of DEDICATED_GUARDS) {
      expect(SCRIPT).toContain(`case "\${${name}-}" in`);
    }
  });

  describe("the loop", () => {
    const start = SCRIPT.indexOf('for _flag in "${BRIDGED_BOOLEAN_FLAGS[@]}"; do');
    const loop = start < 0 ? "" : SCRIPT.slice(start, SCRIPT.indexOf("\ndone", start));
    const accepting = /case "\$\{!_flag-\}" in\n\s*([^\n)]*)\)\s*;;\n\s*\*\)([\s\S]*?)\n\s*;;/.exec(
      loop,
    );

    it("iterates the list with an indirect, unset-safe expansion", () => {
      expect(accepting, "the per-flag case is missing or reshaped").not.toBeNull();
    });

    it("accepts exactly what the api boots on: true, false, 1, 0 and empty", () => {
      const accepted = (accepting?.[1] ?? "")
        .split("|")
        .map((alternative) => alternative.trim().replace(/^"(.*)"$/, "$1"));
      expect([...accepted].sort()).toEqual(["", "0", "1", "false", "true"]);
      for (const value of accepted) {
        expect(booleanFromString.safeParse(value).success, `the api refuses ${value}`).toBe(true);
      }
    });

    it("never echoes the value, only the name", () => {
      const arm = accepting?.[2] ?? "";
      expect(arm).toMatch(/echo "::error::\$\{_flag\} must be exactly/);
      expect(arm).not.toMatch(/\$\{!_flag/);
    });

    it("fails the job when any flag was refused", () => {
      const after = SCRIPT.slice(SCRIPT.indexOf("\ndone", start));
      expect(after).toMatch(/^if \[ "\$_bad_flags" -ne 0 \]; then\n\s*exit 1\nfi$/m);
    });
  });

  it("runs before the first prune, pull or recreate", () => {
    expect(LIST_START).toBeGreaterThan(-1);
    for (const command of ["docker image prune", "$COMPOSE pull", "$COMPOSE up"]) {
      expect(SCRIPT.indexOf(command), `${command} runs before the preflight`).toBeGreaterThan(
        SCRIPT.indexOf("\ndone", LIST_START),
      );
    }
  });
});
