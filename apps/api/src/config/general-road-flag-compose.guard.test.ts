import { describe, expect, it } from "vitest";

import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * THE GENERAL ROAD'S FLAG (ADR-0045) REACHES THE API CONTAINER, AND DEFAULTS OFF.
 *
 * A flag the box cannot set is a flag that silently never turns on; a literal value beats the box
 * in both directions and removes the emergency off switch. So compose must read it as
 * `${NAME:-false}` — `:-` so an unset OR empty secret resolves to off.
 *
 * The other half of the path — the deploy job's `env:` entry and its ssh `envs:` allow-list — is
 * asserted in deploy-workflow-taxonomy.guard.test.ts, which already slices the deploy job and
 * strips comments; a whole-file grep here could be satisfied by a comment.
 */
const NAME = "CHAT_GENERAL_ROAD_ENABLED";

describe(`${NAME} — declared on the api, overridable, off by default`, () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const aiService = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");

  it("parses both services' environments (canaries: guards the parser, not the rule)", () => {
    expect(api.get("NODE_ENV")).toBe("production");
    expect(aiService.has("AI_ENABLE_REAL_CALLS")).toBe(true);
  });

  it("is declared on the api service as a :-false substitution", () => {
    expect(api.get(NAME)).toBe(`\${${NAME}:-false}`);
  });

  it("is NOT declared on the ai-service — the API alone decides the road", () => {
    expect(aiService.has(NAME)).toBe(false);
  });
});
