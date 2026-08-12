import { describe, expect, it } from "vitest";
import {
  BASE_COMPOSE_PATH,
  STAGING_COMPOSE_PATH,
  environmentOfFile,
} from "../common/testing/compose-env";

/**
 * THE DEPLOYED REAL-LLM POSTURE, PINNED (#798).
 *
 * WHAT #798 WAS. The worker app showed a flat, canned profiling chat while the ai-service CLI
 * gave a full LLM-led interview. `GET /health` reported `checks.ai_posture: "mock"`. The client
 * was ruled out — it already renders chips, `question_kind`, `input_mode`, `lookahead` and
 * `close`. The cause was entirely in this repo's compose wiring, and it was TWO defects, not one:
 *
 *   1. `AI_ENABLE_REAL_CALLS` was the hard literal `"false"` in the staging overlay. A compose
 *      `environment:` entry with a literal value BEATS the box's shell/.env, so the flip that
 *      apps/ai-service/.env.staging.example and docs/ai/enable-real-llm-extraction.md instruct
 *      the operator to perform had no path into the container. The documented arming procedure
 *      was inert, and nothing said so.
 *   2. `CHAT_LLM_INTERVIEW_ENABLED` was declared NOWHERE — not in either compose file, not in a
 *      workflow. Compose forwards only the names a service's `environment:` block declares, so
 *      the api read the schema default `false` and the deterministic engine answered every turn.
 *      Fixing (1) ALONE would have flipped `ai_posture` to `real` and changed nothing a worker
 *      sees, which is the trap this file exists to keep shut.
 *
 * WHY A TEST AND NOT A COMMENT. Both defects are invisible to every other test in the repo: the
 * api boots fine, /health is green, the interview completes, and only a human reading a
 * 300-line compose file would notice. This is the third instance of the class
 * (`VOICE_NOTES_BUCKET`, `WORKER_PHOTOS_BUCKET` #794, now these two).
 *
 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts the SHAPE that keeps the box
 * authoritative and the blast radius bounded — the substitution form, the one-task allowlist,
 * and the dev-laptop file staying unarmed. It does NOT assert that any credential is set: keys
 * are box-supplied and never committed, so a test demanding one would fail on `main` forever.
 */

/** The `${VAR:-default}` form: a committed default the BOX can still override, both ways. */
function overridableDefault(name: string, value: string): string {
  return `\${${name}:-${value}}`;
}

describe("docker-compose.staging.yml — the deployed real-LLM posture (#798)", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const aiService = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");

  it("parses both service environments (guards the parser itself, not the rule)", () => {
    // Without this, a parser that silently found nothing would make every assertion below
    // pass vacuously and this guard would report green while asserting nothing at all.
    // Both canaries are literals fixed by the deploy's own topology, not by any posture
    // decision — so a future flip cannot make them drift.
    expect(api.get("NODE_ENV")).toBe("production");
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
  });

  describe("defect 1 — the master gate is reachable from the box", () => {
    it("AI_ENABLE_REAL_CALLS is a substitution, NEVER a bare literal", () => {
      const value = aiService.get("AI_ENABLE_REAL_CALLS");

      // The regression this file is named for. A literal here — `"false"` OR `"true"` —
      // silently wins over the box env in BOTH directions: it re-breaks the documented
      // arming procedure, and it removes the emergency OFF switch, making a rollback a
      // code change and a rebuild instead of an export and a re-deploy.
      expect(value, "a literal value cannot be overridden on the box").toMatch(
        /^\$\{AI_ENABLE_REAL_CALLS:-(true|false)\}$/,
      );
    });

    it("defaults to OFF — R30 is open, and this is the flag its residual names", () => {
      // THE ASSERTION ABOVE DELIBERATELY ACCEPTS EITHER DIRECTION, because what it is about
      // is the SUBSTITUTION FORM (#798's actual defect: a literal the box cannot override).
      // That leaves the DIRECTION unpinned, and the direction is a separate, privacy-owned
      // decision that must not be able to drift in silently — so it gets its own assertion.
      //
      // WHY OFF. apps/ai-service/app/pseudonymize.py records R30 as OPEN and states its own
      // precondition against this exact flag: "Neither is live: AI_ENABLE_REAL_CALLS=false
      // by default (invariant #5). Both MUST be re-assessed before that flag flips."
      // R30's open half is a 9-13 digit phone split by a WORD ("mera number 98765 aur 43210
      // hai") — not masked, not blocked, and pinned as an HONEST NEGATIVE by
      // apps/ai-service/tests/test_pseudonymize.py. That is free-text worker chat, which is
      // `profiling_chat_turn` — the one task the allowlist below arms. Defaulting this to
      // `true` egresses a raw worker phone number to a provider on the first armed box.
      //
      // THIS IS NOT A BLOCK ON ARMING, and it must not be read as one: arming is one export
      // on the box (`export AI_ENABLE_REAL_CALLS=true`) next to the GEMINI_FLASH_API_KEY it
      // already owes, which is exactly what the substitution form above exists to permit.
      // What it blocks is arming EVERY box by committing it, silently, while a test in this
      // repo asserts the leak.
      //
      // WHEN R30 CLOSES (or is accepted in writing by the owner), flip the default here and
      // update this assertion in the same commit — that pairing is the point.
      expect(
        aiService.get("AI_ENABLE_REAL_CALLS"),
        "arming the committed default requires closing R30 first — see pseudonymize.py",
      ).toBe(overridableDefault("AI_ENABLE_REAL_CALLS", "false"));
    });

    it("uses `:-` so an EMPTY export falls back to the default", () => {
      // `-` (unset only) would let an empty export through, and empty is not a legal
      // `booleanFromString` input on the api side nor a meaningful bool on this one. The
      // deploy's own secrets bridge is what makes this concrete: an UNSET GitHub secret
      // expands to "" and drone-ssh exports it anyway.
      expect(aiService.get("AI_ENABLE_REAL_CALLS")).toContain(":-");
    });

    it("the provider key stays box-supplied and uncommitted", () => {
      // The master flag is NOT sufficient on its own: real_calls_blocked_reason() also
      // requires this key, so an armed flag on a keyless box still reports ai_posture
      // "mock" and answers from the mock path. That is the intended fail-closed order.
      expect(aiService.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
      expect(aiService.get("ANTHROPIC_API_KEY")).toBe("${ANTHROPIC_API_KEY:-}");
    });
  });

  describe("defect 2 — the interview flag reaches the api at all", () => {
    it("CHAT_LLM_INTERVIEW_ENABLED is DECLARED on the api service", () => {
      // The #794 failure class: an undeclared name has NO path into the container, so
      // exporting it on the box changes nothing and no error names the cause.
      expect(
        api.has("CHAT_LLM_INTERVIEW_ENABLED"),
        "CHAT_LLM_INTERVIEW_ENABLED missing from the api service — the box cannot set it",
      ).toBe(true);
    });

    it("is armed, and still overridable from the box", () => {
      expect(api.get("CHAT_LLM_INTERVIEW_ENABLED")).toBe(
        overridableDefault("CHAT_LLM_INTERVIEW_ENABLED", "true"),
      );
    });

    it("is declared on the api ONLY — it is not an ai-service setting", () => {
      // The gate lives in LlmTurnService (apps/api). Declaring it on the ai-service too
      // would imply a second source of truth for one decision and invite a half-flip.
      expect(aiService.has("CHAT_LLM_INTERVIEW_ENABLED")).toBe(false);
    });
  });

  describe("the allowlist bounds the blast radius", () => {
    const allowlist = () => aiService.get("AI_REAL_CALL_TASKS") ?? "";

    it("arms profiling_chat_turn — the task #798 is about", () => {
      // Without this the two flags above are INERT: real_call_enabled_for() requires the
      // master flag AND the key AND membership here, and an empty allowlist is fail-closed
      // (owner ruling 2026-08-01 — no wildcard). #798 would reproduce exactly as filed.
      expect(allowlist()).toContain("profiling_chat_turn");
    });

    it("arms NOTHING else by default", () => {
      // The staged rollout survives this change rather than being replaced by it. Each of
      // these is its own owner decision: extraction and resume spend on the capable tier,
      // and the two Sarvam legs carry raw worker audio (STT) / per-utterance spend (TTS).
      const parsed = allowlist()
        .replace(/^\$\{AI_REAL_CALL_TASKS:-/, "")
        .replace(/\}$/, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      expect(parsed).toEqual(["profiling_chat_turn"]);
    });

    it("stays overridable so widening or narrowing is an env action", () => {
      expect(allowlist()).toMatch(/^\$\{AI_REAL_CALL_TASKS:-.*\}$/);
    });
  });
});

describe("docker-compose.yml — the DEV-LAPTOP file stays unarmed (#798)", () => {
  const aiService = environmentOfFile(BASE_COMPOSE_PATH, "ai-service");

  it("parses the base ai-service environment (canary)", () => {
    expect(aiService.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
  });

  it("real calls are OFF in the base file, which every `compose up` inherits", () => {
    // #798 made the STAGING OVERLAY arm-able from the box, and only that. This file is what
    // a developer runs locally and what the e2e/dev paths compose against; making it
    // arm-able would put real money one stray export away on every `docker compose up`,
    // and send worker text to a provider from a laptop.
    //
    // A LITERAL is correct HERE, unlike in the overlay: there is no box to arm, no operator
    // procedure to honour, and the value's whole job is to be unconditional.
    expect(aiService.get("AI_ENABLE_REAL_CALLS")).toBe('"false"');
  });
});
