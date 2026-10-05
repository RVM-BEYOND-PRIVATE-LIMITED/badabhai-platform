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
 * THE MATCHING V1 CUTOVER GATE (#1904, ADR-0036 §8) — ONE NAME, THE API ONLY, OFF.
 *
 * `MATCH_V1_ENABLED` is read by the api alone, so it is declared on the api service alone, in
 * the one form a dark flag may take here: `${NAME:-false}`. Production's `job_reach` and
 * `worker_skill` are empty, so an armed box today serves every worker an empty deck.
 *
 * The deploy job's `env:` line and its ssh `envs:` entry are asserted in
 * deploy-workflow-taxonomy.guard.test.ts. What is pinned HERE is the boot-safety preflight: the
 * api's `booleanFromString` throws at boot on any other value, the api `up` has no automatic
 * rollback, and the secret cannot be read back — so scripts/deploy/staging-deploy.sh refuses a
 * bad value before any container moves. Comments are stripped so prose cannot satisfy these.
 */
const NAME = "MATCH_V1_ENABLED";
const DECLARATION = `${NAME}: \${${NAME}:-false}`;

describe(`${NAME} — declared on the api only, overridable, off by default`, () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");

  it("parses the api environment (canary: guards the parser, not the rule)", () => {
    expect(api.get("NODE_ENV")).toBe("production");
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
  });

  it("is declared on the api service as a :-false substitution", () => {
    expect(api.get(NAME), `${NAME} missing or armed on the api service`).toBe(`\${${NAME}:-false}`);
  });

  it("is declared EXACTLY once in the file, and not on the ai-service", () => {
    // `environmentOf` returns a Map, so a second byte-identical line would collapse into the
    // first while YAML's last-key-wins made the later copy the real one. Count the raw text.
    const occurrences = readFileSync(STAGING_COMPOSE_PATH, "utf8").split(DECLARATION).length - 1;
    expect(occurrences).toBe(1);
    expect(environmentOfFile(STAGING_COMPOSE_PATH, "ai-service").has(NAME)).toBe(false);
  });

  it("is NOT declared in the DEV-LAPTOP file", () => {
    expect(environmentOfFile(BASE_COMPOSE_PATH, "api").has(NAME)).toBe(false);
  });
});

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
