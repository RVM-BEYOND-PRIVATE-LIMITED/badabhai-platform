import type { JobPostingChatState, JobPostingDraft } from "@badabhai/ai-contracts";
import { workerVisibleTextScreens, type WorkerVisibleScreen } from "@badabhai/validators";

/**
 * THE WORKER-VISIBLE TEXT SCREEN, AT INTERVIEW TIME (#1911).
 *
 * Workers read a posting's `role_title` as the card title and its `description` verbatim, so
 * both run ADR-0024's screen (`workerVisibleTextScreens`: phone/email, legal-entity company
 * name, link) on every posting write — including the chat's publish (#1823 B3). Until this
 * module the chat met that screen ONLY at publish: the draft kept the refused value, publish
 * answered 400, and no retry could ever clear it, because the interview had already marked
 * the topic answered and would never ask for it again.
 *
 * So the screen now also runs on every turn's draft, before anything is stored. A refused
 * value is dropped and its question is put back on screen with a plain reason. The SAME
 * shared helper decides — there is no second copy of the check list, and no Python mirror.
 * Publish keeps its own screen as defence in depth.
 *
 * WHY THE ENGINE STATE IS EDITED, NOT JUST THE DRAFT. The ai-service rebuilds the draft from
 * `conversation_state.collected` on every turn, and it attributes the payer's next message to
 * the LAST id in `asked_question_ids`. Nulling the draft field alone would bring the value
 * straight back next turn, with the topic still closed. So {@link reaskRefusedFields} makes
 * the minimum state change that makes the engine itself re-ask: it drops the answer,
 * un-serves the question the engine picked this turn (the payer never sees it), and puts the
 * refused topic last so the next message answers it.
 *
 * THE ENGINE FACTS THIS RELIES ON are mirrored in {@link FIELD_POLICY} and pinned from both
 * sides, because CI runs each language's suite only when its own paths change. The screen
 * suite reads the bank and the engine from Python source. And
 * apps/ai-service/tests/test_job_posting_chat_reask_contract.py reads this file's source and
 * drives the real engine with re-ask-shaped states.
 *
 * NEVER THE TEXT. Everything here returns field and screen NAMES. The reply names the field
 * and the reason class; it never quotes what the payer typed.
 *
 * Pure: no Nest, no I/O. `JobPostingChatService.postMessage` is the only caller.
 */

/**
 * The draft fields a worker reads verbatim that the interview fills from free text, in the
 * ai-service bank's order. Each is also its own engine topic id (`role_title` and
 * `description` are the two topics whose id IS the draft field name).
 */
export const SCREENED_DRAFT_FIELDS = ["role_title", "description"] as const;
export type ScreenedDraftField = (typeof SCREENED_DRAFT_FIELDS)[number];

/** One refused field: its name and every screen it tripped, never the value. */
export interface RefusedDraftField {
  readonly field: ScreenedDraftField;
  readonly screens: readonly WorkerVisibleScreen[];
}

/** One screened turn, ready to persist and reply with in place of the engine's. */
export interface ReaskTurn {
  readonly refused: readonly RefusedDraftField[];
  /** Refused fields whose earlier clean value was put back instead of left empty. */
  readonly kept: readonly ScreenedDraftField[];
  /** The topic now on screen. The payer's next message is attributed to it. */
  readonly askedField: ScreenedDraftField;
  /** Deterministic copy. Names the field and the reason class, never the refused text. */
  readonly replyText: string;
  /** The engine's draft with each refused value nulled, or replaced by its kept earlier text. */
  readonly draft: JobPostingDraft;
  /** The engine's state with the refused answers dropped (or put back) and one re-asked. */
  readonly state: JobPostingChatState;
}

export interface ScreenedFieldPolicy {
  /** How the reply names the field. */
  readonly label: string;
  /** The re-ask. Plain professional English, one question, the bank's tone. */
  readonly question: string;
  /**
   * Is the topic in the engine's `ESSENTIAL_TOPICS`
   * (apps/ai-service/app/job_posting_chat/interview_engine.py)? `role_title` is, and it is
   * that tuple's first member, so it is prepended to `unanswered_essentials`.
   */
  readonly essential: boolean;
  /**
   * Where the topic sits in the bank (question_bank.py `_TOPICS`), which is the order of
   * `draft.missing_fields`. `role_title` opens the bank and `description` closes it.
   */
  readonly bankEdge: "first" | "last";
}

/**
 * Every value here mirrors the ai-service. Both sides check it: the screen suite reads the
 * bank and the engine from Python SOURCE, and the Python contract test reads this block from
 * TypeScript source — so keep each key on its own line, and each `question` one plain string
 * literal.
 */
export const FIELD_POLICY: Readonly<Record<ScreenedDraftField, ScreenedFieldPolicy>> = {
  role_title: {
    label: "job title",
    // The bank's own re-ask for the title, VERBATIM (question_bank.py `retry_question`), so
    // a reply the engine cannot read is followed by the same words, not a near-copy.
    question: "What is the job title — for example CNC Operator, MIG Welder or Plumber?",
    essential: true,
    bankEdge: "first",
  },
  description: {
    label: "job description",
    // Ours: the bank asks the description once and so carries no re-ask wording for it.
    question: "Could you describe the day-to-day work again?",
    essential: false,
    bankEdge: "last",
  },
};

/**
 * Appended when the question on screen is a field whose earlier value was KEPT. "no" is the
 * engine's refusal word on every topic: it records nothing, so the kept value survives. Any
 * other reply to that question replaces it, so the payer is told which word keeps it.
 */
const KEEP_HINT = 'Reply "no" to keep the earlier one.';

/**
 * The reason class each screen names in the reply. EXHAUSTIVE over `WorkerVisibleScreen`, so
 * a heuristic added to `workerVisibleTextScreens` fails the typecheck here until the chat can
 * say what it refused.
 */
const SCREEN_REASON: Readonly<Record<WorkerVisibleScreen, string>> = {
  contact_details: "contact details",
  company_name: "a company name",
  link: "website links",
};

/** The screens' own order (pii → company → link), so the reply reads the same every time. */
const SCREEN_ORDER: readonly WorkerVisibleScreen[] = ["contact_details", "company_name", "link"];

const isClean = (text: string): boolean => workerVisibleTextScreens(text).length === 0;

/** Which screened fields of `draft` the shared screen refuses. Names only. */
export function refusedDraftFields(draft: JobPostingDraft): RefusedDraftField[] {
  const out: RefusedDraftField[] = [];
  for (const field of SCREENED_DRAFT_FIELDS) {
    const value = draft[field];
    if (value === null) continue;
    const screens = workerVisibleTextScreens(value);
    if (screens.length > 0) out.push({ field, screens });
  }
  return out;
}

/** `role_title:company_name,description:link+contact_details` — names only, for a log line. */
export function refusedNames(refused: readonly RefusedDraftField[]): string {
  return refused.map((r) => `${r.field}:${r.screens.join("+")}`).join(",");
}

/**
 * `draft` with every `refused` value nulled and listed as missing again. For a draft that
 * has no engine state to reopen; {@link reaskRefusedFields} is the turn path.
 */
export function blankRefusedFields(
  draft: JobPostingDraft,
  refused: readonly RefusedDraftField[],
): JobPostingDraft {
  return screenedDraft(draft, refused, new Map());
}

/** A refused field's clean value from BEFORE this turn: the state's answer and its draft text. */
interface EarlierValue {
  readonly collected: string;
  readonly shown: string;
}

/**
 * Screen one engine turn. `null` when the draft is clean, so the caller keeps the engine's
 * turn untouched.
 *
 * KEEPING AN EARLIER CLEAN VALUE. The question on screen always takes the payer's answer,
 * and after the wrap-up the description stays the last asked question, so any later message
 * overwrites it. A refused overwrite therefore puts back the clean value the field held
 * before this turn rather than leaving it empty: a payer who added a line with a link keeps
 * the description they already gave. The field is still asked again, with {@link KEEP_HINT}.
 *
 * WHICH FIELD GOES ON SCREEN. A field left EMPTY before one that was kept, then bank order:
 * when both are refused and empty, the title (essential, the bank's first topic). A second
 * empty field is reopened as never asked, so the engine serves it again later and its
 * must-ask gate owes it until then. A second field that was kept stays answered.
 */
export function reaskRefusedFields(input: {
  readonly draft: JobPostingDraft;
  readonly state: JobPostingChatState;
  /** The state the engine was handed this turn (`null` on a fresh interview). */
  readonly priorState: JobPostingChatState | null;
  /** The draft stored with `priorState` (`null` on a fresh interview or an unreadable row). */
  readonly priorDraft: JobPostingDraft | null;
  /** The question the engine picked this turn; `null` on its wrap-up. */
  readonly engineAskedId: string | null;
}): ReaskTurn | null {
  const refused = refusedDraftFields(input.draft);
  const first = refused[0];
  if (!first) return null;
  const earlier = earlierCleanValues(refused, input.priorState, input.priorDraft);
  const onScreen = (refused.find((r) => !earlier.has(r.field)) ?? first).field;
  return {
    refused,
    kept: refused.filter((r) => earlier.has(r.field)).map((r) => r.field),
    askedField: onScreen,
    replyText: reaskReply(refused, onScreen, earlier),
    draft: screenedDraft(input.draft, refused, earlier),
    state: reopenTopics(input.state, input.priorState, input.engineAskedId, refused, {
      onScreen,
      earlier,
    }),
  };
}

/**
 * The value each refused field held before this turn, where BOTH the stored state and the
 * stored draft hold one that passes the screen. Requiring both keeps the two in step: the
 * engine rebuilds the draft from the state, and the payer sees the draft.
 */
function earlierCleanValues(
  refused: readonly RefusedDraftField[],
  prior: JobPostingChatState | null,
  priorDraft: JobPostingDraft | null,
): ReadonlyMap<ScreenedDraftField, EarlierValue> {
  const out = new Map<ScreenedDraftField, EarlierValue>();
  for (const { field } of refused) {
    const collected = prior?.collected[field];
    const shown = priorDraft?.[field] ?? null;
    if (typeof collected !== "string" || shown === null) continue;
    if (isClean(collected) && isClean(shown)) out.set(field, { collected, shown });
  }
  return out;
}

/** "a", "a or b", "a, b or c". */
function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * The re-ask, e.g. "Workers see the job title, so it can't include a company name. What is
 * the job title — for example CNC Operator, MIG Welder or Plumber?". Every part is a constant
 * picked by field and screen NAME, so no path here can carry the refused text.
 */
function reaskReply(
  refused: readonly RefusedDraftField[],
  onScreen: ScreenedDraftField,
  earlier: ReadonlyMap<ScreenedDraftField, EarlierValue>,
): string {
  const labels = refused.map((r) => FIELD_POLICY[r.field].label);
  const tripped = new Set(refused.flatMap((r) => r.screens));
  const reasons = SCREEN_ORDER.filter((s) => tripped.has(s)).map((s) => SCREEN_REASON[s]);
  const kept = refused.filter((r) => earlier.has(r.field)).map((r) => FIELD_POLICY[r.field].label);
  const parts = [
    `Workers see the ${labels.join(" and ")}, so ${labels.length === 1 ? "it" : "they"} ` +
      `can't include ${joinOr(reasons)}.`,
  ];
  if (kept.length > 0) {
    parts.push(
      `Your earlier ${kept.join(" and ")} ${kept.length === 1 ? "is" : "are"} still in the draft.`,
    );
  }
  parts.push(FIELD_POLICY[onScreen].question);
  if (earlier.has(onScreen)) parts.push(KEEP_HINT);
  return parts.join(" ");
}

/**
 * The draft with each refused value replaced by its kept earlier text, or nulled. A nulled
 * field is listed in `missing_fields` again, in bank order.
 *
 * `confidence` and `clarification_questions` are the engine's own derivations and are NOT
 * recomputed here. The engine rebuilds the whole draft from the reopened state on the next
 * turn, and neither field feeds a decision (the publish gate is `PayerCreateJobPostingSchema`).
 */
function screenedDraft(
  draft: JobPostingDraft,
  refused: readonly RefusedDraftField[],
  earlier: ReadonlyMap<ScreenedDraftField, EarlierValue>,
): JobPostingDraft {
  const emptied = refused
    .map((r) => r.field)
    .filter((f) => !earlier.has(f) && !draft.missing_fields.includes(f));
  const head = emptied.filter((f) => FIELD_POLICY[f].bankEdge === "first");
  const tail = emptied.filter((f) => FIELD_POLICY[f].bankEdge === "last");
  const next: JobPostingDraft = {
    ...draft,
    missing_fields: [...head, ...draft.missing_fields, ...tail],
  };
  for (const { field } of refused) next[field] = earlier.get(field)?.shown ?? null;
  return next;
}

/**
 * The engine state with the refused answers dropped (or put back) and `onScreen` asked again.
 *
 *  1. Each refused answer leaves `collected`, or is replaced by its kept earlier value. Only
 *     a field left EMPTY leaves `answered_topics`; a kept one is still answered.
 *  2. The engine's pick for this turn is UN-SERVED. The re-ask replaces its question, so the
 *     payer never saw it. Its ask count and its place in `asked_question_ids` go back to what
 *     the prior state held. Otherwise an ask-once topic would count as asked and be skipped
 *     for good. Restoring from the prior state, rather than decrementing, is also right on
 *     the engine's clarify path, which re-serves without counting.
 *  3. An emptied field that is NOT on screen is owed again from scratch (never asked).
 *  4. `onScreen` becomes the last asked id, because the engine attributes the next message
 *     to `asked_question_ids[-1]`. Its ask count is left alone: the engine's per-topic bound
 *     guards against a parser that cannot read an answer, and a refusal is not that.
 *  5. `clarify_count` resets, because a different question is now on screen.
 *
 * `turn_count` keeps the engine's advance: a turn did happen.
 */
function reopenTopics(
  state: JobPostingChatState,
  prior: JobPostingChatState | null,
  engineAskedId: string | null,
  refused: readonly RefusedDraftField[],
  placement: {
    readonly onScreen: ScreenedDraftField;
    readonly earlier: ReadonlyMap<ScreenedDraftField, EarlierValue>;
  },
): JobPostingChatState {
  const { onScreen, earlier } = placement;
  const emptied = refused.map((r) => r.field).filter((f) => !earlier.has(f));
  const emptiedSet = new Set<string>(emptied);

  const collected = { ...state.collected };
  for (const { field } of refused) {
    const kept = earlier.get(field);
    if (kept) collected[field] = kept.collected;
    else delete collected[field];
  }

  const askCounts = { ...state.ask_counts };
  let asked = [...state.asked_question_ids];

  if (engineAskedId !== null) {
    const priorCount = prior?.ask_counts[engineAskedId];
    if (priorCount === undefined) delete askCounts[engineAskedId];
    else askCounts[engineAskedId] = priorCount;
    if (!prior?.asked_question_ids.includes(engineAskedId)) {
      asked = asked.filter((id) => id !== engineAskedId);
    }
  }

  for (const f of emptied) {
    if (f === onScreen) continue;
    delete askCounts[f];
    asked = asked.filter((id) => id !== f);
  }
  asked = [...asked.filter((id) => id !== onScreen), onScreen];

  const reopenedEssentials = emptied.filter(
    (f) => FIELD_POLICY[f].essential && !state.unanswered_essentials.includes(f),
  );

  return {
    ...state,
    answered_topics: state.answered_topics.filter((t) => !emptiedSet.has(t)),
    asked_question_ids: asked,
    collected,
    clarify_count: 0,
    ask_counts: askCounts,
    unanswered_essentials: [...reopenedEssentials, ...state.unanswered_essentials],
  };
}
