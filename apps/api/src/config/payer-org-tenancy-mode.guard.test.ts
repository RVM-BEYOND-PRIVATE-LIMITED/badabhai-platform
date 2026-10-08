import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serverEnvSchema } from "@badabhai/config";
import { describe, expect, it } from "vitest";

import {
  BASE_COMPOSE_PATH,
  STAGING_COMPOSE_PATH,
  environmentOfFile,
} from "../common/testing/compose-env";

/** One top-level ci.yml job's text, comment lines dropped (prose must not satisfy a pin). */
function jobText(job: string): string {
  const ci = readFileSync(join(__dirname, "../../../../.github/workflows/ci.yml"), "utf8");
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) throw new Error(`job '${job}' not found in ci.yml`);
  const next = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:$/.test(l));
  return lines
    .slice(start, next < 0 ? lines.length : next)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/**
 * ADR-0053 (PAY-DB-01) — PAYER_ORG_TENANCY_MODE, from the secret to the container.
 *
 * Declared on the api only, as `${NAME:-off}` (never `:?`, which would make an unset secret stop
 * the box). The deploy job's `env:` and `envs:` bridge is pinned in
 * deploy-workflow-taxonomy.guard.test.ts. Pinned HERE:
 *  - the boot-safety preflight: the api's z.enum throws at boot on anything but off/shadow/on
 *    (empty reads as unset), the api `up` has no automatic rollback and the secret cannot be read
 *    back — so scripts/deploy/staging-deploy.sh must refuse a bad value before anything moves;
 *  - the PHASE GATE (security review of PR #2167, M1; risk R66): until PAY-DB-01 Phase 3 the
 *    preflight also refuses `on`. Before every tenant predicate is converted (the T5 UNCONVERTED
 *    list in payer-tenancy.static.test.ts is empty), `on` would scope some routes by org and the
 *    rest by login. The api's enum keeps accepting `on` — the e2e job runs with it. The P3 PR
 *    lifts this refusal (ORG_TENANCY_PLAN §5);
 *  - the e2e job runs the api with the mode `on`, so every suite exercises solo identity.
 * Comments are stripped so prose cannot satisfy these.
 */
const NAME = "PAYER_ORG_TENANCY_MODE";
const DECLARATION = `${NAME}: \${${NAME}:-off}`;

describe(`${NAME} — declared on the api only, off by default`, () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");

  it("parses the api environment (canary: guards the parser, not the rule)", () => {
    expect(api.get("NODE_ENV")).toBe("production");
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
  });

  it("is declared on the api service as a :-off substitution", () => {
    expect(api.get(NAME), `${NAME} missing or armed on the api service`).toBe(`\${${NAME}:-off}`);
  });

  it("is declared EXACTLY once in the file, never with :?, and not on the ai-service", () => {
    const raw = readFileSync(STAGING_COMPOSE_PATH, "utf8");
    expect(raw.split(DECLARATION).length - 1).toBe(1);
    expect(raw).not.toContain(`\${${NAME}:?`);
    expect(environmentOfFile(STAGING_COMPOSE_PATH, "ai-service").has(NAME)).toBe(false);
  });

  it("is NOT declared in the DEV-LAPTOP file (the schema default, off, applies there)", () => {
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
  // Three arms, in order: the accepting arm, the Phase-gate arm for `on`, the catch-all.
  const arms = /^case [^\n]*\n\s*([^\n)]*)\)\s*;;\n\s*on\)([\s\S]*?);;\n\s*\*\)([\s\S]*)$/.exec(
    block,
  );
  const field = serverEnvSchema.shape[NAME];

  it("carries the guard, and its catch-all arm fails the job", () => {
    expect(arms, "the preflight case on the mode is missing or reshaped").not.toBeNull();
    expect(arms?.[3] ?? "").toMatch(/^\s*exit 1\s*$/m);
  });

  it("accepts exactly off, shadow and empty — the values the api boots on, minus `on` until Phase 3", () => {
    const accepted = (arms?.[1] ?? "")
      .split("|")
      .map((alternative) => alternative.trim().replace(/^"(.*)"$/, "$1"));
    expect([...accepted].sort()).toEqual(["", "off", "shadow"]);
    for (const value of accepted) {
      expect(field.safeParse(value).success, `the api refuses ${JSON.stringify(value)}`).toBe(true);
    }
    // …and the api really does refuse what the preflight refuses (the guard is not decorative).
    for (const value of ["ON", "true", "1", "enabled"]) {
      expect(field.safeParse(value).success, value).toBe(false);
    }
  });

  it("REFUSES `on` until PAY-DB-01 Phase 3: its own arm fails the job and says P3 lifts it (R66)", () => {
    const onArm = arms?.[2] ?? "";
    expect(onArm).toMatch(/^\s*exit 1\s*$/m);
    expect(onArm).toMatch(/::error::/);
    expect(onArm).toMatch(/Phase 3/);
    expect(onArm, "the refusal must name what to set instead").toMatch(/\bshadow\b/);
  });

  it("…while the api's config still accepts `on` (the e2e job runs the api with it)", () => {
    expect(field.safeParse("on").success).toBe(true);
  });

  it("runs before the first prune, pull or recreate", () => {
    expect(start).toBeGreaterThan(-1);
    for (const command of ["docker image prune", "$COMPOSE pull", "$COMPOSE up"]) {
      expect(SCRIPT.indexOf(command), `${command} runs before the guard`).toBeGreaterThan(start);
    }
  });
});

describe(`${NAME} — the e2e job runs the api with tenancy ON`, () => {
  it("sets the mode to on in the e2e job's environment (and nowhere in the deploy job)", () => {
    expect(jobText("e2e")).toMatch(/^\s+PAYER_ORG_TENANCY_MODE: "on"$/m);
    // The deploy job only bridges the secret; it never carries a literal.
    expect(jobText("deploy-lightsail")).not.toMatch(
      /PAYER_ORG_TENANCY_MODE:\s*"?(off|shadow|on)"?\s*$/m,
    );
  });
});
