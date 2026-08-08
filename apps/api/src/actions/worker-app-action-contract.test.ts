import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WorkerRecordActionsBatchSchema } from "./actions.dto";

/**
 * THE DART CLIENT'S CONSTANTS, CHECKED AGAINST THE SCHEMA THAT WILL JUDGE THEM (#707).
 *
 * WHY THIS FILE EXISTS. `VoiceFormActionLog` sent `source_surface: 'voice_form'`.
 * `ACTION_SOURCE_SURFACES` is `["worker_app", "ops_console", "system"]` — it names the
 * APPLICATION, not the screen — so `source_surface` being a `z.enum` on a `.strict()` schema
 * made every flush a 400. The client swallows a failed flush by design (telemetry must never
 * surface or block), so the result was a spine sink that never once wrote to the spine, with a
 * green suite on both sides: the Dart test asserted the literal the client sent against a
 * `MockClient` that returns 201 to anything, and nothing on this side had ever seen the client.
 *
 * A MOCK THAT ACCEPTS WHATEVER IT IS HANDED CANNOT FAIL THIS WAY, so the assertion has to cross
 * the language boundary. Reading the Dart source is the cheapest way that exists here: the two
 * constants are string literals in one file, and this repo already pins cross-language artifacts
 * this way (`reply-closure.json` and its ai-service mirror, the profiling lexicon's sha256).
 *
 * If this test breaks because the Dart moved, do not delete it — the contract really did change,
 * and the whole point is that you find out here rather than in a silently dropped signal.
 */
const LOG_PATH = join(
  __dirname,
  "../../../worker-app/lib/features/voice_form/data/voice_form_action_log.dart",
);

/** `static const String kName = 'value';` → `value`. */
function dartConst(source: string, name: string): string {
  const m = new RegExp(`static const String ${name} = '([^']*)'`).exec(source);
  if (!m?.[1]) throw new Error(`could not read ${name} from ${LOG_PATH}`);
  return m[1];
}

function dartIntConst(source: string, name: string): number {
  const m = new RegExp(`static const int ${name} = (\\d+)`).exec(source);
  if (!m?.[1]) throw new Error(`could not read ${name} from ${LOG_PATH}`);
  return Number(m[1]);
}

describe("the worker app's action contract, read from the Dart it actually sends", () => {
  const source = readFileSync(LOG_PATH, "utf8");

  it("the body the client builds is accepted by the schema that judges it", () => {
    // The two real voice-form signals, shaped exactly as `VoiceActionSpine.toAction` shapes them.
    const surface = dartConst(source, "kSourceSurface");
    const screen = dartConst(source, "kScreen");
    const body = {
      actions: ["question_audio_played", "profiling_answer_spoken"].map((action_type) => ({
        action_type,
        source_surface: surface,
        context: { question_index: 3, screen },
      })),
    };

    const parsed = WorkerRecordActionsBatchSchema.safeParse(body);
    expect(
      parsed.success,
      `the client's body is rejected: ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
  });

  it("the client's batch bound does not exceed the one the server enforces", () => {
    // Above the server's max the WHOLE request is rejected, so an unchunked flush loses every
    // buffered signal rather than the excess. The client chunks; this is that number agreeing.
    const perRequest = dartIntConst(source, "kMaxPerRequest");
    const one = { action_type: "app_opened" as const };
    expect(
      WorkerRecordActionsBatchSchema.safeParse({
        actions: Array.from({ length: perRequest }, () => one),
      }).success,
    ).toBe(true);
  });

  it("the detector bites — a screen name in `source_surface` is still a rejection", () => {
    // A guard that cannot fail is not a guard. This is the exact body that shipped.
    const parsed = WorkerRecordActionsBatchSchema.safeParse({
      actions: [
        {
          action_type: "question_audio_played",
          source_surface: "voice_form",
          context: { question_index: 3 },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
