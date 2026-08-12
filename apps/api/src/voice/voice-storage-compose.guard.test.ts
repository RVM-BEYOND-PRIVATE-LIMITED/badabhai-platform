import { describe, expect, it } from "vitest";
import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

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
/** Read by both services; a name here that is declared for only one of them is the bug. */
const SHARED_STORAGE_VARS = [
  "VOICE_NOTES_BUCKET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

describe("docker-compose.staging.yml — voice storage is declared symmetrically", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const aiService = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");

  it("parses both service environments (guards the parser itself, not the rule)", () => {
    // If the parser silently found nothing, every assertion below would pass vacuously.
    // BOTH canaries are unrelated to voice and have been in the file since CD-1 — one per
    // service, so a parse that finds only one block still fails here.
    //
    // NOT `AI_ENABLE_REAL_CALLS` any more: #798 made it a substitution, so its value is a MOVING
    // target owned by the real-call posture guard. A canary must be something stable that
    // this file does not care about, or it turns every posture change into a spurious
    // failure in the voice suite. `AI_SERVICE_URL` and `NODE_ENV` are both literals fixed
    // by the deploy's own topology.
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
    expect(aiService.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
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

  it("the arming credential stays empty-by-default", () => {
    expect(aiService.get("SARVAM_API_KEY")).toBe("${SARVAM_API_KEY:-}");
  });

  it("NEITHER Sarvam leg is on the default real-call allowlist", () => {
    // THE ASSERTION HERE CHANGED SHAPE WITH #798, AND THE INVARIANT DID NOT. This used to
    // read `AI_REAL_CALL_TASKS === "${AI_REAL_CALL_TASKS:-}"` — an EMPTY allowlist, which
    // blocked every task and so blocked these two for free. #798 put exactly one task on it
    // (`profiling_chat_turn`), so "empty" is no longer the thing that protects the voice
    // legs and asserting it would only re-assert the chat decision from the wrong file.
    //
    // What voice actually needs is unchanged and is now stated DIRECTLY: STT sends real
    // worker AUDIO, which cannot be pseudonymized before the provider hears it, and TTS
    // spends per-utterance — both are separate owner decisions (the #701 listening gate),
    // not something a chat rollout may switch on in passing.
    const allowlist = aiService.get("AI_REAL_CALL_TASKS") ?? "";
    expect(allowlist).not.toContain("stt_transcription");
    expect(allowlist).not.toContain("tts_synthesis");
  });
});
