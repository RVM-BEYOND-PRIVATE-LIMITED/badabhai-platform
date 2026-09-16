/**
 * `seedFromWorkerRecord` — seeding a FRESH interview's `current_city` answer from whatever
 * `/name` already collected (#1504 item 5, "city-seed").
 *
 * WHAT THIS CLOSES. The universal pack asks `current_city` on every interview, even when the
 * worker already gave it to `/name` a minute earlier — the two surfaces never talked to each
 * other, so the chat re-asked a question the worker had just answered. This seeds the pack's own
 * `current_city` item at turn 0, before the interview's first question is chosen, so the engine's
 * own "already answered" logic skips it exactly as it would a question the worker typed in chat.
 *
 * PURE, deliberately: this function reads nothing and writes nothing on its own. The caller
 * (`ProfilingOrchestrator`) is the one with an I/O boundary — a database read for the city, a
 * Redis write for the envelope — and keeping the merge itself pure is what makes it safe to call
 * from both `takeTurn` and `openTurn`'s CAS retry loops without a second implementation to keep
 * in sync.
 *
 * ═══ THE CORRECTION LIMITATION, STATED HERE ON PURPOSE ═══
 *
 * A seeded city can be WRONG — `/name` collects free text, not a verified location — and this
 * module deliberately gives chat NO way to notice or correct that mid-conversation. Earlier
 * drafts of this design proposed a `mayCommit(correcting)` escape that would let an explicit
 * correction utterance overwrite a settled, seeded key inside `fillCrossQuestion`. That escape
 * does not exist and cannot run: `fillCrossQuestion` (see `orchestrator.service.ts`) skips any
 * key that is already settled BEFORE it ever reaches a correction check, so there is no code
 * path in the turn loop that would fire it. Building one would be new mid-chat correction
 * machinery this design was never asked to add.
 *
 * The two correction paths that DO exist and are left untouched:
 *   1. Re-editing the `/name` screen changes `workers.current_city`, but only the interview's
 *      NEXT fresh envelope reads it — a live session's seed was already written.
 *   2. The post-flush review screen's `correctAnswer` (`orchestrator.service.ts`), which writes
 *      a real `turn > 0` record exactly as any other correction does, and removes the key from
 *      `prefilledKeys` when it does (see that method).
 *
 * A worker whose seeded city is wrong and who never opens the review screen keeps the wrong
 * value. That is an accepted limitation (owner ruling, 2026-09-16), not an oversight.
 */

import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { canonicalCity } from "@badabhai/profiling-lexicon";

import { answersOf, withAnswers, type ProfilingEnvelope } from "./conversation-state";
import { isSettled } from "./answer-map";
import { recordAnswer } from "./answer-map";
import { factForPackItem } from "./facts/worker-fact.registry";

/** What the seed did, for the caller to log — never the city value itself. */
export interface WorkerRecordSeedOutcome {
  readonly envelope: ProfilingEnvelope;
  /** Whether a seed was actually written. False on every skip branch. */
  readonly seeded: boolean;
  /**
   * Whether the seeded value resolved against the city gazetteer. `null` when nothing was
   * seeded — there is no recognition verdict for a city that was never written.
   */
  readonly cityRecognized: boolean | null;
}

/**
 * Seed `envelope.answerMap`'s `current_city` record from the worker's own `workers.current_city`
 * column, IF this interview has never touched that question.
 *
 * SKIPS, IN ORDER:
 *  1. No `current_city` item in this interview's resolved packs — nothing to seed against.
 *  2. `city` is blank or whitespace-only — `/name` never collected one.
 *  3. The question is already settled (`answered` or `declined`) — FIRST-WRITE-WINS. `/name`
 *     runs before the interview, so this only ever fires when a fresh envelope is seeded twice
 *     in the same CAS retry (the caller memoizes against that) or when the interview itself
 *     already captured an answer before this ran, which today it cannot — the seed is applied
 *     before question selection. Kept as a guard anyway: cheap, and it is what makes this
 *     function safe to call more than once against the same envelope.
 *
 * THE VALUE, WHEN SEEDED. `canonicalCity(city)?.value ?? city.trim()` — a recognized city is
 * normalized exactly as a chat-captured answer would be; an unrecognized one is kept AS TYPED,
 * matching the existing custom-answer convention (`workers.service.ts`'s `setLocation`). Keeping
 * the raw value is what lets the interview correctly treat the question as settled and skip it,
 * even though nothing downstream may PROJECT that raw value into matching (see
 * `profile-extraction.processor.ts` / `answer-map-projector.ts`, which refuse to project a
 * `current_city` value the gazetteer does not recognize regardless of who wrote it).
 */
export function seedFromWorkerRecord(
  envelope: ProfilingEnvelope,
  city: string,
  items: readonly Pick<QuestionPackItem, "question_key" | "target_field">[],
): WorkerRecordSeedOutcome {
  const trimmed = city.trim();
  if (trimmed.length === 0) return { envelope, seeded: false, cityRecognized: null };

  const item = items.find((candidate) => factForPackItem(candidate)?.fact === "current_city");
  if (!item) return { envelope, seeded: false, cityRecognized: null };

  const answers = answersOf(envelope);
  if (isSettled(answers, item.question_key)) {
    return { envelope, seeded: false, cityRecognized: null };
  }

  const canonical = canonicalCity(trimmed);
  const valueNormalized = canonical?.value ?? trimmed;

  const nextAnswers = recordAnswer(
    answers,
    {
      questionKey: item.question_key,
      targetField: item.target_field,
      valueRaw: null,
      valueNormalized,
      evidence: null,
    },
    0,
  );

  const seededEnvelope: ProfilingEnvelope = {
    ...withAnswers(envelope, nextAnswers),
    prefilledKeys: envelope.prefilledKeys.includes(item.question_key)
      ? envelope.prefilledKeys
      : [...envelope.prefilledKeys, item.question_key],
  };

  return { envelope: seededEnvelope, seeded: true, cityRecognized: canonical !== null };
}
