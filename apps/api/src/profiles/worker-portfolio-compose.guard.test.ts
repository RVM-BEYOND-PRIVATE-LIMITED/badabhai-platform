import { describe, expect, it } from "vitest";
import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * THE DEPLOYED BOX MUST BE ABLE TO ARM PORTFOLIO MEDIA AT ALL (ADR-0042 D9 / Layer A (e)).
 *
 * Compose forwards ONLY the names a service's `environment:` block declares — it does not pass
 * the host shell through. A name missing there is invisible to every other test: the operator
 * exports it, the process reads the schema default (`""`, dormant), and the feature is silently
 * off with nothing naming the cause. That exact failure has shipped four times
 * (`VOICE_NOTES_BUCKET`, `WORKER_PHOTOS_BUCKET` #794, `CHAT_LLM_INTERVIEW_ENABLED` #798,
 * `ZEPTOMAIL_API_URL` #813), which is why every bucket gets its own declaration guard.
 *
 * It asserts the name is DECLARED and is a fail-closed `:-` pass-through. It does NOT assert a
 * value is set: empty is the committed posture — and for THIS bucket the arming precondition is
 * still missing (account deletion does not sweep `portfolio/{workerId}/`), so a test demanding a
 * real bucket name here would be wrong twice over.
 *
 * API-ONLY, and that is part of the rule: portfolio media never crosses the AI boundary (CLAUDE.md
 * §2 — raw PII out of LLM prompts) and never reaches a payer surface, so the ai-service block must
 * not declare it.
 */
const API_ONLY_VARS = ["WORKER_PORTFOLIO_BUCKET"] as const;

describe("docker-compose.staging.yml — portfolio media can be armed from the box", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const aiService = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");

  it("parses both service environments (guards the parser itself, not the rule)", () => {
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
    expect(aiService.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
  });

  it.each(API_ONLY_VARS)("%s is declared on the api service", (name) => {
    expect(api.has(name), `${name} missing from the api service`).toBe(true);
  });

  it.each(API_ONLY_VARS)("%s is a fail-closed `:-` pass-through, never required", (name) => {
    // `${VAR:?}` would fail the whole deploy when unset; empty must stay a legal dormant state.
    expect(api.get(name)).toBe(`\${${name}:-}`);
  });

  it.each(API_ONLY_VARS)("%s is NOT declared on the ai-service", (name) => {
    expect(aiService.has(name), `${name} must not be declared on the ai-service`).toBe(false);
  });

  it("keeps the portfolio bucket SEPARATE from the profile-photos one", () => {
    // A face photo and a work sample are different sensitivity classes with different retention
    // decisions; sharing one bucket would fuse them permanently.
    expect(api.has("WORKER_PHOTOS_BUCKET")).toBe(true);
    expect(api.get("WORKER_PORTFOLIO_BUCKET")).not.toBe(api.get("WORKER_PHOTOS_BUCKET"));
  });
});
