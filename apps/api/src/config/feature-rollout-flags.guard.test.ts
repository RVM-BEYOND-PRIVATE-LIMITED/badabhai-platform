import { readFileSync } from "node:fs";
import { join } from "node:path";

import { featureRolloutMode, serverEnvSchema } from "@badabhai/config";
import { describe, expect, it } from "vitest";

import {
  BASE_COMPOSE_PATH,
  STAGING_COMPOSE_PATH,
  environmentOfFile,
} from "../common/testing/compose-env";
import { FEATURE_ROLLOUT_CONFIG } from "../feature-rollout/feature-rollout.keys";

/**
 * THE ROLLOUT SWITCHES (#2746) — ONE NAME EACH, THE API ONLY, OFF.
 *
 * Each `*_ROLLOUT` switch is read by the api alone (`FeatureRolloutService`), so it is declared on
 * the api service alone, as `${NAME:-off}`: a literal beats the box in both directions (#798
 * defect 1), and `:-on` / `:-pilot` would arm every box by commit.
 *
 * The deploy job's `env:` line and its ssh `envs:` entry are asserted in
 * deploy-workflow-taxonomy.guard.test.ts. Pinned HERE is the boot-safety preflight: the api's
 * enum throws at boot on any other value, the api `up` has no automatic rollback, and a secret
 * cannot be read back, so scripts/deploy/staging-deploy.sh refuses a bad value before any
 * container moves. Comments are stripped so prose cannot satisfy these.
 */
const NAMES = Object.values(FEATURE_ROLLOUT_CONFIG);

describe("every rollout switch in the config is in the map (so every guard below covers it)", () => {
  it("the schema's featureRolloutMode fields are exactly FEATURE_ROLLOUT_CONFIG's", () => {
    // A switch declared with `featureRolloutMode` but left out of the map would escape the
    // single-reader, compose, preflight and taxonomy guards alike (security review, L2).
    const shape = serverEnvSchema.shape as Record<string, unknown>;
    const switches = Object.keys(shape).filter((key) => shape[key] === featureRolloutMode);
    expect(switches.sort()).toEqual([...NAMES].sort());
  });
});

const SCRIPT = readFileSync(join(__dirname, "../../../../scripts/deploy/staging-deploy.sh"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe.each(NAMES)("%s — declared on the api only, overridable, off by default", (name) => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const declaration = `${name}: \${${name}:-off}`;

  it("is declared on the api service as a :-off substitution", () => {
    expect(api.get(name), `${name} missing or armed on the api service`).toBe(`\${${name}:-off}`);
  });

  it("is declared EXACTLY once in the file, and not on the ai-service", () => {
    // `environmentOf` returns a Map, so a second identical line would collapse into the first
    // while YAML's last-key-wins made the later copy the real one. Count the raw text.
    const occurrences = readFileSync(STAGING_COMPOSE_PATH, "utf8").split(declaration).length - 1;
    expect(occurrences).toBe(1);
    expect(environmentOfFile(STAGING_COMPOSE_PATH, "ai-service").has(name)).toBe(false);
  });

  it("is NOT declared in the DEV-LAPTOP file", () => {
    expect(environmentOfFile(BASE_COMPOSE_PATH, "api").has(name)).toBe(false);
  });
});

describe.each(NAMES)("%s — the deploy refuses a value outside the api's grammar", (name) => {
  const head = `case "\${${name}-}" in`;
  // The case statement alone, up to its OWN `esac`: a pattern allowed to run past it would find
  // some later `exit 1` in the script and pass with the catch-all arm gutted.
  const start = SCRIPT.indexOf(head);
  const block = start < 0 ? "" : SCRIPT.slice(start, SCRIPT.indexOf("\nesac", start));
  const accepting = /^case [^\n]*\n\s*([^\n)]*)\)\s*;;\n\s*\*\)([\s\S]*)$/.exec(block);

  it("carries the guard, and its catch-all arm fails the job", () => {
    expect(accepting, "the preflight case on the switch is missing or reshaped").not.toBeNull();
    expect(accepting?.[2] ?? "").toMatch(/^\s*exit 1\s*$/m);
  });

  it("accepts exactly what the api boots on: off, pilot, on and empty", () => {
    const accepted = (accepting?.[1] ?? "")
      .split("|")
      .map((alternative) => alternative.trim().replace(/^"(.*)"$/, "$1"));
    expect([...accepted].sort()).toEqual(["", "off", "on", "pilot"]);
    for (const value of accepted) {
      expect(featureRolloutMode.safeParse(value).success, `the api refuses ${value}`).toBe(true);
    }
  });

  it("runs before the first prune, pull or recreate", () => {
    expect(start).toBeGreaterThan(-1);
    for (const command of ["docker image prune", "$COMPOSE pull", "$COMPOSE up"]) {
      expect(SCRIPT.indexOf(command), `${command} runs before the guard`).toBeGreaterThan(start);
    }
  });
});
