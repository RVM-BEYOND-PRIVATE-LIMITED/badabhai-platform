import { describe, expect, it } from "vitest";
import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * 13 REAL-PROVIDER/FEATURE BOOLEAN GATES, MADE REACHABLE FROM THE BOX (BL-22).
 *
 * THE SAME FAILURE CLASS AS `resume-render-compose.guard.test.ts` / `real-call-posture-compose.
 * guard.test.ts` / `email-compose.guard.test.ts` — generalized into one guard covering every
 * remaining `booleanFromString` flag a forensic audit (docs/audit/22_REMEDIATION_BACKLOG.md
 * BL-22) found undeclared in this file: `PAYMENTS_ENABLE_REAL`, `MESSAGING_ENABLE_REAL`,
 * `PUSH_ENABLE_REAL`, `AGENCY_PAYOUTS_ENABLED`, `MEMBER_INVITES_ENABLE_REAL`,
 * `MATCH_V1_ENABLED`, `CAPACITY_ENFORCEMENT_ENABLED`, `PACE_ENABLED`, `TEST_LOGIN_ENABLED`,
 * `PAYER_TEST_LOGIN_ENABLED`, `AUTH_ROLLING_TIERS_ENABLED`, `AI_JOBS_RETENTION_DELETE_ENABLED`,
 * and the api-side `AI_ENABLE_REAL_CALLS` (the `GET /health` `ai_posture` observability copy —
 * see the compose file's own comment for how it differs from the ai-service flag the OTHER
 * guard file already covers). None of these were a live incident (all 13 correctly read
 * `false` before this file existed, same as after), but an undeclared name has no path from the
 * box into the container regardless: exporting one on staging and re-deploying would have
 * silently changed nothing, exactly as #793/#794/#798/#813 each did before their own line
 * landed.
 *
 * WHY ONE GUARD, NOT 13. Every name here shares the identical shape (`booleanFromString`,
 * schema default `false`, no owner-ratified reason to commit a `true` default) and the identical
 * risk (a literal beating the box, an undeclared name having no path in) — the per-flag guards
 * this file's siblings use exist because THOSE flags each carry a flag-specific direction
 * decision (R30 for AI_ENABLE_REAL_CALLS's ai-service copy, storage-dependency for
 * RESUME_RENDER_ENABLED) worth its own describe block. These 13 don't; one parameterized
 * assertion covers the actual regression risk without 13 near-identical files.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER. 14 STRING-SECRET SIBLINGS the same audit found
 * (`PAYMENTS_PROVIDER_KEY`/`SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `WHATSAPP_API_KEY`/
 * `PHONE_NUMBER_ID`, `FCM_SERVICE_ACCOUNT_B64`/`PROJECT_ID`, `MEMBER_INVITE_ACCEPT_URL`,
 * `TEST_LOGIN_TOKEN`, `PAYER_TEST_LOGIN_TOKEN`, `SKILLS_INTERNAL_TOKEN`, `GEMINI_FLASH_API_KEY`,
 * `ANTHROPIC_API_KEY`, `LITELLM_API_KEY`) are EVERY ONE a bare `.optional()` /
 * `.min(1).optional()` in the schema, not the `optionalSecret()` helper that treats an empty
 * string as unset — so a `${VAR:-}` pass-through for any of them would declare-empty it the
 * moment this file merged, which `.optional()` REJECTS (only `undefined` passes, not `""`),
 * crashing every boot on this box. This guard asserts they STAY absent, so nobody "generalizes"
 * this pattern onto them by copying a line from below without reading this comment (#858 tracks
 * wiring them properly, schema-first).
 */

/** The `${VAR:-default}` form: a committed default the BOX can still override, both ways. */
function overridableDefault(name: string, value: string): string {
  return `\${${name}:-${value}}`;
}

const BOOLEAN_FLAGS = [
  "PAYMENTS_ENABLE_REAL",
  "MESSAGING_ENABLE_REAL",
  "PUSH_ENABLE_REAL",
  "AGENCY_PAYOUTS_ENABLED",
  "MEMBER_INVITES_ENABLE_REAL",
  "MATCH_V1_ENABLED",
  "CAPACITY_ENFORCEMENT_ENABLED",
  "PACE_ENABLED",
  "TEST_LOGIN_ENABLED",
  "PAYER_TEST_LOGIN_ENABLED",
  "AUTH_ROLLING_TIERS_ENABLED",
  "AI_JOBS_RETENTION_DELETE_ENABLED",
  "AI_ENABLE_REAL_CALLS",
] as const;

/** Deliberately NOT wired here — see the file header's "WHAT THIS DELIBERATELY DOES NOT COVER". */
const DEFERRED_STRING_SECRETS = [
  "PAYMENTS_PROVIDER_KEY",
  "PAYMENTS_PROVIDER_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "WHATSAPP_API_KEY",
  "WHATSAPP_PHONE_NUMBER_ID",
  "FCM_SERVICE_ACCOUNT_B64",
  "FCM_PROJECT_ID",
  "MEMBER_INVITE_ACCEPT_URL",
  "TEST_LOGIN_TOKEN",
  "PAYER_TEST_LOGIN_TOKEN",
  "SKILLS_INTERNAL_TOKEN",
  "GEMINI_FLASH_API_KEY",
  "ANTHROPIC_API_KEY",
  "LITELLM_API_KEY",
] as const;

describe("docker-compose.staging.yml — the 13 real-provider/feature boolean gates (BL-22)", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");

  it("parses the api environment (guards the parser itself, not the rule)", () => {
    // Without this, a parser that silently found nothing would make every assertion below pass
    // vacuously and this guard would report green while asserting nothing at all.
    expect(api.get("NODE_ENV")).toBe("production");
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
  });

  it.each(BOOLEAN_FLAGS)("%s is declared, a substitution, defaulting OFF", (name) => {
    // Declared: an undeclared name has no path into the container regardless of the box's
    // shell/.env (the #794/#798/#813 failure class).
    expect(api.has(name), `${name} missing from the api service — the box cannot set it`).toBe(
      true,
    );
    // A substitution, never a literal: a literal `"false"` OR `"true"` beats the box in both
    // directions — it would re-break arming AND remove the emergency off switch.
    expect(api.get(name), `${name} must stay overridable from the box`).toBe(
      overridableDefault(name, "false"),
    );
    // `:-`, not `-`: the deploy's secrets bridge exports an unset GitHub secret as `""`, and
    // `booleanFromString` needs the fallback to fire on that, not hand the app an empty string.
    expect(api.get(name)).toContain(":-");
  });

  it("TEST_LOGIN_ENABLED reachable does NOT arm the seam without its token", () => {
    // apps/api/src/auth/test-login.guard.ts checks the flag first but then requires
    // TEST_LOGIN_TOKEN >= 32 chars before accepting anything (TD67 — never arm vacuously).
    // The token is one of the 14 deferred secrets: staying undeclared here means a box that
    // exports only TEST_LOGIN_ENABLED=true still gets the same neutral 404 as today.
    expect(api.has("TEST_LOGIN_TOKEN")).toBe(false);
  });

  it("PAYER_TEST_LOGIN_ENABLED reachable does NOT arm the seam without its token", () => {
    // Same shape, apps/api/src/payers/payer-test-login.guard.ts.
    expect(api.has("PAYER_TEST_LOGIN_TOKEN")).toBe(false);
  });

  it.each(DEFERRED_STRING_SECRETS)(
    "%s stays undeclared — a bare `.optional()` schema, not optionalSecret()",
    (name) => {
      // A `${VAR:-}` pass-through here would declare-empty this field the moment it merged.
      // `.optional()` accepts only `undefined`, not `""`, so that would crash every boot on
      // this box — the exact trap BL-21/`optionalSecret()` exists to prevent. See #858.
      expect(
        api.has(name),
        `${name} must stay undeclared until its schema uses optionalSecret() — see #858`,
      ).toBe(false);
    },
  );
});
