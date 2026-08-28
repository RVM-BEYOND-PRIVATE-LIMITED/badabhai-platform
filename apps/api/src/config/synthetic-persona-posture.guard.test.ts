import { describe, expect, it } from "vitest";
import {
  BASE_COMPOSE_PATH,
  STAGING_COMPOSE_PATH,
  environmentOfFile,
} from "../common/testing/compose-env";

/**
 * THE SYNTHETIC-PERSONA HARNESS MUST NOT BE ABLE TO REACH A DEPLOYED BOX (R7 §1).
 *
 * WHAT THE CAPABILITY IS. `AI_SYNTHETIC_PERSONA_MODE` unlocks `/synthetic/*` on the ai-service,
 * which runs the real Phase C body with the pseudonymisation gateway REPLACED by a passthrough.
 * On a developer machine that is exactly right — invented personas have to reach the model whole
 * or the sheet cannot be diffed against the ratified samples. On any box carrying real worker
 * traffic it is the one setting that would send raw PII to a provider, silently.
 *
 * THREE BARRIERS, AND THIS FILE IS THE THIRD:
 *   1. it is a REASON STRING, not a bool — deliberate, visible in shell history, uninheritable;
 *   2. `main.py` registers the routes ONLY when that reason is set, so an unarmed process 404s
 *      at the router with nothing behind it (asserted on the Python side);
 *   3. **this test** — neither compose file may declare the variable, so it cannot arrive on a
 *      deployed box at all. Compose forwards only the names a service's `environment:` block
 *      declares (#794's lesson), so an UNDECLARED name has no path into the container even if
 *      someone exports it on the host.
 *
 * WHY ABSENCE RATHER THAN `${VAR:-}`. Every other flag here is a substitution so the box stays
 * authoritative in both directions — that is #798's whole point. This one is the exception on
 * purpose: there is no operator procedure that should ever arm it on a deployed service, so the
 * value of "the box can override it" is negative. Absence is the strongest form available.
 */

const SYNTHETIC = "AI_SYNTHETIC_PERSONA_MODE";

describe("the synthetic-persona harness cannot arrive on a deployed box", () => {
  const stagingAi = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");
  const baseAi = environmentOfFile(BASE_COMPOSE_PATH, "ai-service");

  it("parses both ai-service environments (guards the parser, not the rule)", () => {
    // Without this a parser that silently found nothing would make both assertions below pass
    // vacuously — the exact failure mode #798's own guard file calls out.
    expect(stagingAi.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
    expect(baseAi.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
  });

  it("is NOT declared in docker-compose.staging.yml", () => {
    expect(
      stagingAi.has(SYNTHETIC),
      `${SYNTHETIC} must never be declared on a deployed service — it bypasses pseudonymisation`,
    ).toBe(false);
  });

  it("is NOT declared in docker-compose.yml either", () => {
    // The base file is what a developer's `compose up` inherits and what the e2e paths use.
    // Declaring it here would put the bypass one stray export away on every local stack — and
    // the harness does not need it, because it runs the ai-service directly rather than in
    // compose.
    expect(baseAi.has(SYNTHETIC)).toBe(false);
  });
});
