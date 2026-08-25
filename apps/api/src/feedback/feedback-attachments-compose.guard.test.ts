import { describe, expect, it } from "vitest";
import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * THE DEPLOYED BOX MUST BE ABLE TO ARM FEEDBACK ATTACHMENTS AT ALL (#1191).
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT PARANOIA ────────────────────────────────────
 * Compose forwards ONLY the names a service's `environment:` block declares — it does not pass
 * the host shell through. So "the operator exports it on the box" is not a fact about the box,
 * it is a fact about `docker-compose.staging.yml`, and a name missing there is invisible to
 * every other test in this repo: the value sits in the shell, the process reads its schema
 * default, and the feature is silently off with nothing naming the cause.
 *
 * That exact failure has shipped FOUR times — `VOICE_NOTES_BUCKET` (asymmetric defaults),
 * `WORKER_PHOTOS_BUCKET` (#794, undeclared), `CHAT_LLM_INTERVIEW_ENABLED` (#798, undeclared),
 * `ZEPTOMAIL_API_URL` (#813, undeclared) — which is what makes a guard cheaper than a review
 * habit. This feature is the highest-risk shape yet for it, because the DORMANT state is
 * indistinguishable from a working one from the outside: the shipped Flutter client degrades
 * honestly on the mint's 503, so a box where this name never reached the container looks
 * exactly like a box where the bucket was never provisioned — text feedback arrives, images
 * silently never do, and nothing is on fire.
 *
 * ── WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────
 * It asserts the names are DECLARED and are fail-closed `:-` pass-throughs. It does NOT assert
 * any value is set: empty is the correct, committed posture until the bucket is provisioned, so
 * a test demanding a real bucket here would fail on `main` forever and be deleted. Testing what
 * the rule PERMITS is the point.
 *
 * ── AND API-ONLY IS PART OF THE RULE ────────────────────────────────────────────────────
 * Unlike voice notes — which the ai-service reads in order to transcribe — an attachment never
 * crosses the AI boundary. It is worker-supplied imagery that may show a payslip, a gate pass or
 * a face, and CLAUDE.md §2 puts raw PII out of bounds for LLM prompts. Declaring the bucket on
 * the ai-service block would be the first step toward it being read there, so its ABSENCE is
 * asserted rather than left to be noticed.
 */
const API_ONLY_VARS = [
  "WORKER_FEEDBACK_ATTACHMENTS_BUCKET",
  "FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR",
  "FEEDBACK_ATTACHMENT_MAX_BYTES",
] as const;

describe("docker-compose.staging.yml — feedback attachments can be armed from the box (#1191)", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const aiService = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");

  it("parses both service environments (guards the parser itself, not the rule)", () => {
    // If the parser silently found nothing, every assertion below would pass vacuously — and
    // the ABSENCE assertions would pass most vacuously of all. One canary per service, both
    // literals fixed by the deploy's own topology and unrelated to this feature.
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
    expect(aiService.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
  });

  it.each(API_ONLY_VARS)("%s is declared on the api service", (name) => {
    expect(api.has(name), `${name} missing from the api service`).toBe(true);
  });

  it.each(API_ONLY_VARS)("%s is a fail-closed `:-` pass-through, never required", (name) => {
    // `${VAR:?}` would fail the whole deploy when unset, which is what the owner's small
    // required-secret set is deliberately kept small to avoid. Empty must stay a legal,
    // dormant state — and for the bucket it IS the committed state today.
    expect(api.get(name)).toBe(`\${${name}:-}`);
  });

  it.each(API_ONLY_VARS)(
    "%s is NOT declared on the ai-service — attachments never cross the AI boundary",
    (name) => {
      // The bytes are worker-supplied imagery (a payslip, a gate pass, a face). Nothing in
      // apps/ai-service reads this bucket, and the way to keep that true is for the name to have
      // no path into that container at all.
      expect(aiService.has(name), `${name} must not be declared on the ai-service`).toBe(false);
    },
  );

  it("keeps the attachments bucket SEPARATE from the profile-photos one", () => {
    // Two names, never one. A face photo and a photograph of a broken screen are different
    // sensitivity classes and will want different retention and different mime allowlists;
    // collapsing them into one bucket would fuse those two decisions permanently — and the
    // account-deletion sweep records them as two legs for the same reason.
    expect(api.has("WORKER_PHOTOS_BUCKET")).toBe(true);
    expect(api.get("WORKER_FEEDBACK_ATTACHMENTS_BUCKET")).not.toBe(api.get("WORKER_PHOTOS_BUCKET"));
  });
});
