import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiCostRecordedPayload } from "@badabhai/event-schema";
import type { AiCostTaskType } from "@badabhai/event-schema";

/**
 * A PROVIDER SURFACE THAT SPENDS MUST HAVE AN EMITTER — or be named here as one that does not.
 *
 * WHY THE EXISTING PARITY TEST IS NOT THIS TEST, and why #738 asked for a second one.
 * `apps/ai-service/tests/test_task_type_ledger_parity.py` proves every spending task type is
 * NAMEABLE by `aiTaskType`. It was green for the entire life of the #738 bug, because
 * `stt_transcription` was in the enum the whole time and simply had nobody emitting it. Nameable
 * and ledgered are different properties, and only the first one was guarded.
 *
 * That gap has a specific shape: `AiCostRecorder` swallows emit failures by design — cost
 * observability must never fail the work it observes — so an unledgered surface does not raise.
 * It produces an empty result for `SELECT ... WHERE task_type = ?`, which reads as "no spend"
 * rather than "not instrumented". Silence is the failure mode, so the guard has to be structural.
 *
 * WHAT THIS ASSERTS. Every member of the enum is classified: either apps/api emits for it, or it
 * is recorded below as a known gap. A NEW task type is in neither set and fails, which is the
 * point — the next provider surface cannot arrive unledgered without somebody saying so in
 * writing.
 *
 * PRIVACY: reads its own repository's source text. No worker data.
 */

/** apps/api source, minus tests — the emitter has to be in shipping code, not in a fixture. */
function apiSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...apiSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Task types passed to an emitter call in shipping apps/api code.
 *
 * Matches the task-type argument of `record(...)` / `recordAiCost(...)`, tolerating the line
 * breaks Prettier introduces — `aiCost.record(` and its arguments are routinely split across five
 * lines, so a single-line regex would find one of the three real call sites and silently report
 * the other two as missing.
 */
function emittedTaskTypes(): Set<string> {
  const found = new Set<string>();
  const call =
    /\b(?:aiCost\.record|this\.recordAiCost|this\.aiCost\.record)\s*\(([\s\S]{0,400}?)\)/g;
  for (const file of apiSourceFiles(join(__dirname, ".."))) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(call)) {
      for (const literal of match[1]!.matchAll(/"([a-z_]+)"/g)) found.add(literal[1]!);
    }
  }
  return found;
}

const ALL_TASK_TYPES = AiCostRecordedPayload.shape.task_type.options as readonly AiCostTaskType[];

/**
 * Surfaces that reach a provider and have NO `ai.cost_recorded` emitter in apps/api today.
 *
 * NAMED RATHER THAN TOLERATED. Delete an entry the moment its emitter lands.
 *
 * #745 CLOSED THREE OF THE FIVE and they are gone from this list:
 *
 *   skill_embedding     `/skills/canonicalize` — real Gemini spend on a contract that carried
 *                       no cost field (#738's exact root cause). `SkillCanonicalization` now
 *                       carries `ai_metadata`; `JobPostingsService.canonicalizeSkills` emits
 *                       ONE record per phrase, because a 10-skill posting is 10 billable
 *                       embeds and a per-posting record would under-count it tenfold.
 *   resume_generation   `/resume/generate` — same contract gap. `router.run` had always built
 *                       the metadata; the route discarded it. `ResumeService.generate` now
 *                       emits before any write, so a later failure cannot lose the record.
 *   profiling_chat_turn `/job-posting-chat/respond` — wired in `JobPostingChatService`. NOTE,
 *                       because the issue said otherwise and re-measurement disagreed: this
 *                       route makes ZERO LLM calls today, so it spends nothing and the
 *                       emitter is a no-op until the documented rephrase seam is armed in
 *                       the ai-service. It is wired ahead of the spend deliberately — the
 *                       person who arms that seam edits Python, not this app, which is
 *                       exactly how `stt_transcription` shipped unledgered.
 *
 * WHAT REMAINS, and why neither is a gap of the same shape — both spend OUTSIDE apps/api, so
 * there is no request path here that could emit for them:
 *
 *   tts_synthesis       no apps/api caller at all; spend originates in the render CLI (#701)
 *   domain_match        no apps/api caller; routed inside the ai-service
 */
const KNOWN_UNLEDGERED: readonly AiCostTaskType[] = ["domain_match", "tts_synthesis"];

describe("every task type that can spend is either emitted or named as unledgered (#738)", () => {
  it("finds the real emitter call sites — without this the coverage check is vacuous", () => {
    // `emittedTaskTypes` reads source text, so a moved file, a renamed method or a reformat that
    // outruns the window would quietly return an empty set and make the classification test below
    // pass by finding nothing to classify. Pin the six that exist today (#745 added three).
    const emitted = emittedTaskTypes();
    expect([...emitted].sort()).toEqual([
      "profile_extraction",
      "profile_parse",
      "profiling_chat_turn",
      "resume_generation",
      "skill_embedding",
      "stt_transcription",
    ]);
  });

  it("classifies EVERY enum member — a new provider surface fails until someone decides", () => {
    const emitted = emittedTaskTypes();
    const unclassified = ALL_TASK_TYPES.filter(
      (task) => !emitted.has(task) && !KNOWN_UNLEDGERED.includes(task),
    );
    expect(
      unclassified,
      `these task types can be named by \`ai.cost_recorded\` but nothing in apps/api emits one, ` +
        `and they are not recorded as known gaps: ${JSON.stringify(unclassified)}. Wire an ` +
        `emitter, or add them to KNOWN_UNLEDGERED with the reason — an unledgered surface is ` +
        `silently unmeasured, never loudly rejected.`,
    ).toEqual([]);
  });

  it("the two sets are disjoint — an emitted task type must not still be listed as a gap", () => {
    // The cleanup step #738 itself performed: `stt_transcription` had to leave this list in the
    // same change that gave it an emitter, or the list becomes a stale record of a fixed bug.
    const emitted = emittedTaskTypes();
    const stale = KNOWN_UNLEDGERED.filter((task) => emitted.has(task));
    expect(
      stale,
      `${JSON.stringify(stale)} now HAS an emitter — remove from KNOWN_UNLEDGERED`,
    ).toEqual([]);
  });

  it("the enum is non-empty and still contains the surface #738 wired", () => {
    // Guards the whole file against an import that silently resolves to an empty enum.
    expect(ALL_TASK_TYPES.length).toBeGreaterThan(5);
    expect(ALL_TASK_TYPES).toContain("stt_transcription");
  });
});
