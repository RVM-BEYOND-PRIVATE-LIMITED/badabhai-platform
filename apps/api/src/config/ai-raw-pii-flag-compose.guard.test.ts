import { readFileSync } from "node:fs";
import { join } from "node:path";

import { booleanFromString } from "@badabhai/config";
import { describe, expect, it } from "vitest";

import {
  BASE_COMPOSE_PATH,
  STAGING_COMPOSE_PATH,
  environmentOfFile,
} from "../common/testing/compose-env";

/**
 * RAW TEXT TO THE MODEL (owner decision 2026-09-30, ADR-0047) — ONE NAME, BOTH SERVICES, OFF.
 *
 * `AI_RAW_PII_ENABLED` is the one switch that lifts prompt-side PII masking, and unlike every
 * other flag in this directory it is read by BOTH containers: the ai-service (its input maskers,
 * the Langfuse and ai_call_traces copies) and the api (companion v2's gateway hop; extraction's
 * known-name redaction deliberately does not read it, ADR-0047 G2). A declaration on only one of
 * them is a HALF-FLIP — the api sending a model raw text while the ai-service still masks it, or
 * the reverse — and nothing else in the repo would notice, because each half is correct on its own.
 *
 * So both declarations are pinned to the one form a privacy flag may take here: `${NAME:-false}`.
 * A literal beats the box in both directions (#798 defect 1); `:-true` would arm every box by
 * commit; a bare or empty substitution hands pydantic "" and stops the ai-service booting.
 *
 * The other half of the path — the deploy job's `env:` line and its ssh `envs:` entry — is
 * asserted in deploy-workflow-taxonomy.guard.test.ts, which slices the deploy job and strips
 * comments; a whole-file grep here could be satisfied by a comment.
 */
const NAME = "AI_RAW_PII_ENABLED";
const DECLARATION = `${NAME}: \${${NAME}:-false}`;

describe(`${NAME} — declared on the api AND the ai-service, overridable, off by default`, () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const aiService = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");

  it("parses both services' environments (canaries: guards the parser, not the rule)", () => {
    expect(api.get("NODE_ENV")).toBe("production");
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
    expect(aiService.has("AI_ENABLE_REAL_CALLS")).toBe(true);
  });

  it.each([
    ["api", api],
    ["ai-service", aiService],
  ])("is declared on the %s service as a :-false substitution", (service, env) => {
    expect(env.get(NAME), `${NAME} missing or armed on the ${service} service`).toBe(
      `\${${NAME}:-false}`,
    );
  });

  it.each([
    ["api", api],
    ["ai-service", aiService],
  ])("no case-variant spelling sits beside the exact-case key on the %s service", (_s, env) => {
    // pydantic-settings reads env vars case-insensitively, so a lowercase twin on the ai-service
    // would arm the same field while the exact-case lookup above stays green. The same wall the
    // résumé raw-text flag carries (security review, 2026-09-16), on the new name.
    const variants = [...env.keys()].filter((key) => key !== NAME && key.toUpperCase() === NAME);
    expect(variants).toEqual([]);
  });

  it("is declared EXACTLY twice in the file — once per service, never a second copy", () => {
    // `environmentOf` returns a Map, so a second byte-identical line in one block would collapse
    // into the first and pass every assertion above — while YAML's last-key-wins made the later
    // copy the real one. Counting the raw text is what sees it.
    const occurrences = readFileSync(STAGING_COMPOSE_PATH, "utf8").split(DECLARATION).length - 1;
    expect(occurrences).toBe(2);
  });

  it("is NOT declared in the DEV-LAPTOP file — the staging overlay is the one place it is read", () => {
    expect(environmentOfFile(BASE_COMPOSE_PATH, "api").has(NAME)).toBe(false);
    expect(environmentOfFile(BASE_COMPOSE_PATH, "ai-service").has(NAME)).toBe(false);
  });
});

/**
 * THE DEPLOY REFUSES A VALUE THE API CANNOT BOOT ON — BEFORE ANY CONTAINER MOVES (ADR-0047 §5).
 *
 * The secret's value cannot be read back, and the deploy recreates the ai-service first and then
 * replaces the api with no automatic rollback. A value the api's `booleanFromString` throws on
 * ("True", "yes") would crash-loop the api behind a service that booted armed. So
 * scripts/deploy/staging-deploy.sh checks the value against exactly that grammar and exits before
 * the first prune, pull or `up`. Comments are stripped so prose cannot satisfy these.
 */
describe(`${NAME} — the deploy refuses a value outside the api's grammar, before anything moves`, () => {
  const SCRIPT = readFileSync(
    join(__dirname, "../../../../scripts/deploy/staging-deploy.sh"),
    "utf8",
  )
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const GUARD_HEAD = `case "\${${NAME}-}" in`;
  // The case statement alone, up to its OWN `esac`: a pattern allowed to run past it would find
  // some later `exit 1` in the script and pass with the catch-all arm gutted.
  const start = SCRIPT.indexOf(GUARD_HEAD);
  const block = start < 0 ? "" : SCRIPT.slice(start, SCRIPT.indexOf("\nesac", start));
  const accepting = /^case [^\n]*\n\s*([^\n)]*)\)\s*;;\n\s*\*\)([\s\S]*)$/.exec(block);

  it("carries the guard, and its catch-all arm fails the job", () => {
    expect(accepting, "the preflight case on the flag is missing or reshaped").not.toBeNull();
    expect(accepting?.[2] ?? "").toMatch(/^\s*exit 1\s*$/m);
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

  it("runs before the first prune, pull or recreate", () => {
    expect(start).toBeGreaterThan(-1);
    for (const command of ["docker image prune", "$COMPOSE pull", "$COMPOSE up"]) {
      expect(SCRIPT.indexOf(command), `${command} runs before the guard`).toBeGreaterThan(start);
    }
  });
});
