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
 *
 * RECEIVER-NAME-AGNOSTIC (`this.<anything>.record`), AND THAT IS A FIX FOR A MEASURED BLINDNESS.
 * The previous pattern enumerated receiver names — `aiCost.record`, `this.aiCost.record`,
 * `this.recordAiCost` — and `LlmTurnService` injected the recorder as `cost`. So
 * `this.cost.record(..., "profiling_chat_turn", ...)` matched NOTHING, the interview turn's
 * emitter was invisible here, and the list below carried `profiling_chat_turn` as a known gap
 * with the explanation "no apps/api caller" from the day #785 gave it one. The check reported
 * an unledgered surface that had been ledgered for months — the exact inversion of the failure
 * it exists to catch. A name-coupled matcher over source text is the wrong contract; the field
 * was ALSO renamed to `aiCost` for consistency, but this pattern is what makes the check hold
 * if someone renames it again.
 *
 * Two unrelated `this.X.record(` calls exist in apps/api (`actions.record`,
 * `erasureAudit.record`); neither carries a quoted lowercase literal in its argument window, so
 * neither contributes. The pinned set in the first test below is what keeps that true.
 *
 * ── COMMENTS ARE STRIPPED FIRST, AND THIS IS A MEASURED FIX, NOT TIDINESS ────────────────
 * The window is bounded at 400 characters and ends at the FIRST `)`, so anything sitting between
 * a call's task-type literal and that paren competes for the budget — including the comment
 * lines this codebase puts INSIDE argument lists to explain a null or a flag. Migration 0083
 * added a `text` argument to `ProfileExtractionProcessor.recordAiCost` with a short rationale
 * comment above each of the four call sites, and three of the four immediately fell out of this
 * scan: `profile_parse` went from ledgered to "unclassified" with its emitter untouched, ten
 * lines from where it had always been. That is the failure this file's own header warns about
 * ("a reformat that outruns the window") arriving as a comment rather than as a reformat, and
 * only the pinned set in the first test stopped it reading as a real regression.
 *
 * Stripping is also a CORRECTNESS fix in the other direction, which is why it beats simply
 * raising the cap: a comment inside an argument list is not an argument, so a quoted lowercase
 * word in one (`// see "profile_parse" above`) would otherwise register as an emitted task type
 * that nothing emits. Same technique, same reason, as `admin-static-guards.test.ts`.
 */
const stripComments = (src: string): string =>
  src
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

function emittedTaskTypes(): Set<string> {
  const found = new Set<string>();
  const call = /\b(?:this\.[\w$]+\.record|this\.recordAiCost)\s*\(([\s\S]{0,400}?)\)/g;
  for (const file of apiSourceFiles(join(__dirname, ".."))) {
    const src = stripComments(readFileSync(file, "utf8"));
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
 * #745 CLOSED THREE and they are gone from this list:
 *
 *   skill_embedding     BOTH of its call paths, which is the correction this list exists to
 *                       force. `/skills/canonicalize` (the job-posting write) emits one
 *                       record per phrase via `JobPostingsService.canonicalizeSkills`, and
 *                       the `/profile/extract` canonicalization fan-out emits one per embed
 *                       via `ProfileExtractionProcessor` (that route is reached on the
 *                       LEGACY extraction path — a session with no answer map, i.e. a
 *                       pre-cutover interview or the "make the profile anyway" escape
 *                       hatch). Wiring only the first would have left
 *                       `WHERE task_type = 'skill_embedding'` returning part of the spend,
 *                       and a partial ledger reads as complete where an empty one reads as
 *                       "not instrumented" and invites a look.
 *                       THE LESSON THIS ENCODES: this list is keyed by TASK TYPE, so ONE
 *                       emitter anywhere satisfies it and deletes the entry naming ALL of
 *                       that type's call paths. Before deleting an entry, enumerate every
 *                       call path of that task type — not just the one you wired.
 *   resume_generation   `/resume/generate` — the contract carried no cost field (#738's
 *                       exact root cause). `router.run` had always built the metadata; the
 *                       route discarded it. `ResumeService.generate` now emits before any
 *                       write, so a later failure cannot lose the record.
 *   job_posting_chat_turn
 *                       `/job-posting-chat/respond` — wired in `JobPostingChatService`.
 *                       NOTE, because the issue said otherwise and re-measurement
 *                       disagreed: this route makes ZERO LLM calls today, so it spends
 *                       nothing and the emitter is a no-op until the documented rephrase
 *                       seam is armed in the ai-service. It is wired ahead of the spend
 *                       deliberately — the person who arms that seam edits Python, not this
 *                       app, which is exactly how `stt_transcription` shipped unledgered.
 *
 * WHAT REMAINS, and why none of the three is a gap of the same shape — all spend OUTSIDE
 * apps/api, so there is no request path here that could emit for them:
 *
 *   tts_synthesis       no apps/api caller at all; spend originates in the render CLI (#701)
 *   domain_match        no apps/api caller; routed inside the ai-service
 *
 * `profiling_chat_turn` LEFT THIS LIST, AND IT SHOULD HAVE LEFT IT MONTHS AGO. The entry said
 * "no apps/api caller — the WORKER profiling chat is routed inside the ai-service and this app
 * never calls it". That stopped being true when #785 shipped `LlmTurnService`, which makes the
 * `/profiling/respond` Phase A call FROM THIS APP and has emitted for it ever since. Nothing
 * noticed because the matcher above enumerated receiver names and that service called the
 * recorder `this.cost`, not `this.aiCost` — so the emitter was invisible and the stale entry
 * looked like a deliberate, current decision. Two lessons, both encoded above rather than
 * narrated here: a source-text matcher must not be coupled to a variable name, and an entry on
 * this list is a claim about TODAY that has to be re-derived, not inherited.
 */
const KNOWN_UNLEDGERED: readonly AiCostTaskType[] = ["domain_match", "tts_synthesis"];

describe("every task type that can spend is either emitted or named as unledgered (#738)", () => {
  it("finds the real emitter call sites — without this the coverage check is vacuous", () => {
    // `emittedTaskTypes` reads source text, so a moved file, a renamed method or a reformat that
    // outruns the window would quietly return an empty set and make the classification test below
    // pass by finding nothing to classify. Pin the seven that exist today (#745 added three;
    // `profiling_chat_turn` was always the seventh and the matcher simply could not see it).
    const emitted = emittedTaskTypes();
    expect([...emitted].sort()).toEqual([
      "job_posting_chat_turn",
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
