import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE STAGING BOX MUST NEVER SEE VOICE STORAGE FROM ONLY ONE SIDE (V8).
 *
 * WHY THIS FILE EXISTS. `VOICE_NOTES_BUCKET` is read by BOTH services: apps/api mints the
 * signed upload URL and erases objects on a DSAR, apps/ai-service fetches the object to
 * transcribe. They once disagreed about what "unset" meant — the api defaulted to `""`, the
 * ai-service to the literal `"worker-voice-notes"` — so arming one side alone was a silent
 * TOTAL failure: uploads land in bucket X, transcription reads bucket Y, every transcript
 * comes back empty, and `/health` is green on both because neither reports a bucket.
 *
 * That was fixed twice over — the ai-service default is `""` now, and the compose file declares
 * the names on both services — and BOTH fixes are invisible to every other test in this repo.
 * A future edit that adds a storage variable to one service block and not the other rebuilds
 * the exact failure class, and nothing would say so until a worker's answer vanished.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts SYMMETRY and the
 * fail-closed `:-` form. It does NOT assert that any value is set: empty is the correct,
 * committed posture until the owner arms the flip, so a test demanding a real bucket here
 * would fail on `main` forever and be deleted. Testing what the rule PERMITS is the point —
 * an unset bucket must pass, an asymmetric declaration must not.
 */
const COMPOSE_PATH = join(__dirname, "../../../../docker-compose.staging.yml");

/** Read by both services; a name here that is declared for only one of them is the bug. */
const SHARED_STORAGE_VARS = [
  "VOICE_NOTES_BUCKET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/**
 * The `environment:` entries of one service, as `NAME: value` pairs.
 *
 * Hand-rolled rather than a YAML dependency: this repo has no yaml parser in any package.json
 * and adding one to assert three names would cost more than it proves. The file's shape is
 * fixed and machine-checked by compose itself — 2-space service keys, 6-space environment
 * entries — so anchoring on that indentation is stable, and a shape change loud enough to
 * break this parser would also break the deploy.
 */
function environmentOf(compose: string, service: string): Map<string, string> {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in ${COMPOSE_PATH}`);

  const env = new Map<string, string>();
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // the next service — stop.
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment && /^ {4}\S/.test(line)) inEnvironment = false; // a sibling of environment.
    if (!inEnvironment) continue;

    const entry = /^ {6}([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (entry) env.set(entry[1]!, entry[2]!.trim());
  }
  return env;
}

describe("docker-compose.staging.yml — voice storage is declared symmetrically", () => {
  const compose = readFileSync(COMPOSE_PATH, "utf8");
  const api = environmentOf(compose, "api");
  const aiService = environmentOf(compose, "ai-service");

  it("parses both service environments (guards the parser itself, not the rule)", () => {
    // If the parser silently found nothing, every assertion below would pass vacuously.
    // These two are unrelated to voice and have been in the file since CD-1.
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
    expect(aiService.get("AI_ENABLE_REAL_CALLS")).toBe('"false"');
  });

  it.each(SHARED_STORAGE_VARS)("%s is declared for BOTH services", (name) => {
    expect(api.has(name), `${name} missing from the api service`).toBe(true);
    expect(aiService.has(name), `${name} missing from the ai-service service`).toBe(true);
  });

  it.each(SHARED_STORAGE_VARS)("%s is a fail-closed `:-` pass-through, never required", (name) => {
    // `${VAR:?}` would fail the deploy when unset, which is what the owner's STAGING-SECRETS-1
    // set is deliberately kept small to avoid. Empty must stay a legal, dormant state.
    for (const [service, env] of [
      ["api", api],
      ["ai-service", aiService],
    ] as const) {
      expect(env.get(name), `${name} on ${service}`).toBe(`\${${name}:-}`);
    }
  });

  it("the TTS pair carries its default INTO the substitution, so empty never reaches pydantic", () => {
    // `sarvam_tts_model` / `sarvam_tts_speaker` are non-optional `str` with real defaults, so a
    // bare `${VAR:-}` would overwrite them with "" and the first synthesis would post an empty
    // model name. The owner-approved pair (2026-08-08) belongs in the substitution itself.
    expect(aiService.get("SARVAM_TTS_MODEL")).toBe('"${SARVAM_TTS_MODEL:-bulbul:v2}"');
    expect(aiService.get("SARVAM_TTS_SPEAKER")).toBe('"${SARVAM_TTS_SPEAKER:-anushka}"');
  });

  it("the arming credential and the task allowlist stay empty-by-default", () => {
    expect(aiService.get("SARVAM_API_KEY")).toBe("${SARVAM_API_KEY:-}");
    // Empty means NO task may go real — fail-closed, not a wildcard.
    expect(aiService.get("AI_REAL_CALL_TASKS")).toBe("${AI_REAL_CALL_TASKS:-}");
  });
});
