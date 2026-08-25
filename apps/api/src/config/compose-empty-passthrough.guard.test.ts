import { describe, expect, it } from "vitest";
import { loadServerConfig } from "@badabhai/config";
import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * EVERY `${VAR:-}` PASS-THROUGH ARRIVES AS AN EMPTY STRING, AND THE API MUST STILL BOOT.
 *
 * ── THE OUTAGE THIS FILE IS THE POST-MORTEM OF (2026-08-25) ─────────────────────────────
 * #1191 added two numeric knobs to the api service with the standard, correct-looking
 * pass-through idiom this whole compose file uses:
 *
 *     FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR: ${FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR:-}
 *
 * Both had schema defaults, so both looked safe. They were not. `${VAR:-}` does not omit the
 * variable — it passes `VAR=""` INTO the container, and Zod's `.default()` fires only for
 * `undefined`. An empty string is PRESENT, so `z.coerce.number()` turned it into `0`,
 * `.positive()` refused it, `loadServerConfig` threw, and the api container crash-looped on a
 * deploy nobody could read as a config error: the two variables named in the failure were
 * variables nobody had ever set.
 *
 * ── WHY THE GUARD THAT ALREADY EXISTED DID NOT CATCH IT ─────────────────────────────────
 * `feedback-attachments-compose.guard.test.ts` asserted the compose literal was exactly
 * `${VAR:-}` — and it PASSED, because the literal was right. What nothing asserted was the
 * CONSEQUENCE of that literal: that the value it produces is one the config schema accepts.
 * A guard on the declaration and no guard on the effect is how a green suite ships a boot
 * failure, and it is the same shape of gap `db:audit:schema-contract` exists to close for
 * migrations ("is the database ready?" rather than "was the file written?").
 *
 * ── WHAT THIS ASSERTS ───────────────────────────────────────────────────────────────────
 * It reads the DEPLOYED compose file, takes every api variable declared with a bare `:-`
 * pass-through, sets all of them to `""` at once, and boots the config. Derived from the file
 * rather than from a hand-kept list, deliberately: a hand-kept list would have to be updated
 * by the same person who adds the variable that breaks it, which is precisely the step that
 * was missed. A variable added tomorrow is covered the moment its compose line lands.
 *
 * The fix belongs in the SCHEMA (`positiveIntFromString`), not in each compose entry: a
 * substitution default (`${VAR:-20}`) would fix this file while leaving a `.env` line with
 * nothing after the `=`, and a CI secret that resolved to nothing, to produce the same empty
 * string — and it would put a second copy of the number somewhere that cannot import the first.
 */

/** The `${VAR:-}` form exactly — a pass-through with NO default carried into the substitution. */
const BARE_PASSTHROUGH = /^\$\{([A-Z_][A-Z0-9_]*):-\}$/;

/** The required secrets, which have no defaults and must stay required. Supplied, not blanked. */
const REQUIRED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(48),
  ADMIN_JWT_SECRET: "y".repeat(48),
  PII_HASH_PEPPER: "z".repeat(48),
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  PIN_PEPPER: "w".repeat(48),
};

describe("docker-compose.staging.yml — an empty pass-through must never stop the API booting", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");

  /** Every api variable whose compose value is a bare `${VAR:-}`. */
  const blanked = [...api.entries()]
    .filter(([, value]) => BARE_PASSTHROUGH.test(value))
    .map(([name]) => name);

  it("finds the pass-throughs (guards the parser, not the rule)", () => {
    // If the parse silently found nothing, the boot assertion below would pass vacuously while
    // asserting nothing at all — the exact failure mode of the guard this file replaces.
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
    // Eleven at the time of writing, and the shape of that list is the diagnosis: every other
    // one is a bucket name or a credential, i.e. a STRING, for which `""` has always been a
    // legal value. The two numeric knobs #1191 added were the first of their kind in this block,
    // which is exactly why every previous use of this idiom being safe did not make it safe.
    expect(blanked.length).toBeGreaterThanOrEqual(10);
    // A canary from the family that caused the outage, so a rename cannot quietly drop it.
    expect(blanked).toContain("FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR");
    expect(blanked).toContain("FEEDBACK_ATTACHMENT_MAX_BYTES");
  });

  it("boots with EVERY bare pass-through set to the empty string", () => {
    // This is what the container actually receives on a box where none of them is exported —
    // which is the ordinary state of most of them, most of the time.
    const env: NodeJS.ProcessEnv = { ...REQUIRED_ENV };
    for (const name of blanked) env[name] = "";

    expect(() => loadServerConfig(env)).not.toThrow();
  });

  it("names the offender when ONE of them is blanked — so a failure is diagnosable", () => {
    // Blanking all of them at once proves the deploy works; blanking one at a time is what
    // turns a future regression into "this variable", not "the config is broken".
    for (const name of blanked) {
      expect(() => loadServerConfig({ ...REQUIRED_ENV, [name]: "" }), name).not.toThrow();
    }
  });

  it("still applies the documented DEFAULT to a blanked numeric knob, never 0", () => {
    // The half that matters after "it boots": an empty value must read as ABSENT, so the knob
    // takes its default. Coercing it to 0 would be worse than the crash — a rate cap of 0
    // rejects every request, silently, with the container reporting healthy.
    const config = loadServerConfig({
      ...REQUIRED_ENV,
      FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR: "",
      FEEDBACK_ATTACHMENT_MAX_BYTES: "",
    });
    expect(config.FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR).toBe(20);
    expect(config.FEEDBACK_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("still honours a real value, and still REFUSES a nonsense one", () => {
    // Accommodating the empty string must not turn the knob into a value-free field: a typo an
    // operator can fix at deploy time is worth failing closed on, and 0/-1 are not "unset".
    const set = loadServerConfig({
      ...REQUIRED_ENV,
      FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR: "5",
    });
    expect(set.FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR).toBe(5);

    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(
        () => loadServerConfig({ ...REQUIRED_ENV, FEEDBACK_ATTACHMENT_MAX_BYTES: bad }),
        bad,
      ).toThrow();
    }
  });
});
