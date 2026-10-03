import type { JobPostingChatState, JobPostingDraft } from "@badabhai/ai-contracts";
import { workerVisibleTextScreens, type WorkerVisibleScreen } from "@badabhai/validators";

/**
 * THE WORKER-VISIBLE TEXT SCREEN, AT INTERVIEW TIME (#1911, #1921).
 *
 * Workers read a posting's `role_title` as the card title, its `description` verbatim and each
 * `benefits` / `requirements` chip as typed, so all four run ADR-0024's screen
 * (`workerVisibleTextScreens`: phone/email, legal-entity company name, link) on every posting
 * write — including the chat's publish (#1823 B3). Until #1911 the chat met that screen ONLY at
 * publish: the draft kept the refused value, publish answered 400, and no retry could ever clear
 * it, because the interview had already marked the topic answered and would never ask for it
 * again.
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
 * A CHIP LIST LOSES ONLY ITS REFUSED CHIPS, AND IS STILL ASKED AGAIN (#1921). The engine asks
 * each list once and UNIONS every answer into the list in `collected`. So the refused chips
 * leave the draft AND that stored list, or the next rebuild would bring them back. The clean
 * chips stay in both. And the topic goes back on screen: dropping the chips without asking
 * again would leave the payer no way to restate them in the chat, and clearing the list to
 * reopen it would throw away chips that passed. On that question "no" keeps the list as it is,
 * and any other answer is added to it. The question offers "No" as a tap, because a typed
 * "no more" is not the engine's refusal and would be added as a chip.
 *
 * AFTER THE WRAP-UP THE DESCRIPTION TAKES THE NEXT MESSAGE (#1921). A list re-asked on or after
 * the wrap-up is put last so the payer's answer reaches it. The wrap-up that follows would leave
 * it there, and every later message would be added to it as a chip, so
 * {@link restoreWrapUpTarget} moves the description back to the end.
 *
 * THE ENGINE FACTS THIS RELIES ON are mirrored in {@link FIELD_POLICY} and
 * {@link BANK_TOPIC_ORDER} and pinned from both sides, because CI runs each language's suite
 * only when its own paths change. The screen suite reads the bank and the engine from Python
 * source. And apps/ai-service/tests/test_job_posting_chat_reask_contract.py reads this file's
 * source and drives the real engine with re-ask-shaped states.
 *
 * NEVER THE TEXT. Everything here returns field and screen NAMES. The reply names the field
 * and the reason class; it never quotes what the payer typed.
 *
 * Pure: no Nest, no I/O. `JobPostingChatService.postMessage` is the only caller.
 */

/**
 * The draft fields a worker reads verbatim that the interview fills from free text, in the
 * ai-service bank's order. Each is also its own engine topic id (the topic id IS the draft
 * field name for all four).
 */
export const SCREENED_DRAFT_FIELDS = [
  "role_title",
  "benefits",
  "requirements",
  "description",
] as const;
export type ScreenedDraftField = (typeof SCREENED_DRAFT_FIELDS)[number];

/**
 * The chip lists among them: a `string[]` on the draft, built from a list the engine
 * ACCUMULATES in `collected`. The other two are one text value each.
 */
export const SCREENED_LIST_FIELDS = [
  "benefits",
  "requirements",
] as const satisfies readonly ScreenedDraftField[];
type ScreenedListField = (typeof SCREENED_LIST_FIELDS)[number];

const isListField = (field: string): field is ScreenedListField =>
  (SCREENED_LIST_FIELDS as readonly string[]).includes(field);

/**
 * The ai-service bank's topic ids, in order (question_bank.py `_TOPICS`). That is the order of
 * `draft.missing_fields`, so a field this module empties is listed as missing again at its
 * place in it.
 */
export const BANK_TOPIC_ORDER = [
  "role_title",
  "skills",
  "location_label",
  "city",
  "vacancy",
  "pay_range",
  "pay_type",
  "experience",
  "shift",
  "needed_by",
  "benefits",
  "requirements",
  "description",
] as const;

/** One refused field: its name and every screen it (or one of its chips) tripped. Never text. */
export interface RefusedDraftField {
  readonly field: ScreenedDraftField;
  readonly screens: readonly WorkerVisibleScreen[];
}

/** One screened turn, ready to persist and reply with in place of the engine's. */
export interface ReaskTurn {
  readonly refused: readonly RefusedDraftField[];
  /**
   * Refused fields that still hold a clean value: a text field's value from before this turn,
   * put back instead of left empty, or a list's chips that passed the screen.
   */
  readonly kept: readonly ScreenedDraftField[];
  /** The topic now on screen. The payer's next message is attributed to it. */
  readonly askedField: ScreenedDraftField;
  /** Deterministic copy. Names the field and the reason class, never the refused text. */
  readonly replyText: string;
  /**
   * Tap-to-answer chips for the topic on screen: the bank's own options, or none. On a list's
   * add-question, the options a tap would still add, then {@link ADD_CHIP}.
   */
  readonly chips: readonly string[];
  /** The engine's draft without the refused values (a text value nulled or put back). */
  readonly draft: JobPostingDraft;
  /** The engine's state with the refused answers dropped (or put back) and one re-asked. */
  readonly state: JobPostingChatState;
}

export interface ScreenedFieldPolicy {
  /** How the reply names the field. */
  readonly label: string;
  /**
   * The re-ask when the field holds nothing clean. Plain professional English, one question,
   * the bank's tone.
   */
  readonly question: string;
  /**
   * Is the topic in the engine's `ESSENTIAL_TOPICS`
   * (apps/ai-service/app/job_posting_chat/interview_engine.py)? `role_title` is, and it is
   * that tuple's first member, so it is prepended to `unanswered_essentials`.
   */
  readonly essential: boolean;
  /** The bank's own `options` for the topic, VERBATIM, served with the re-ask. */
  readonly chips: readonly string[];
}

/**
 * A list's two questions are OPEN ones, never yes/no: the engine records any answer to a list
 * question as chips, so a "yes" would become a benefit.
 */
export interface ScreenedListPolicy extends ScreenedFieldPolicy {
  /** The re-ask when clean chips are left. Any answer but "no" is ADDED to them. */
  readonly addQuestion: string;
}

/** One policy per screened field. A list's also says how to ask for more. */
type FieldPolicies = {
  readonly [F in ScreenedDraftField]: F extends ScreenedListField
    ? ScreenedListPolicy
    : ScreenedFieldPolicy;
};

/**
 * Every value here mirrors the ai-service. Both sides check it: the screen suite reads the
 * bank and the engine from Python SOURCE, and the Python contract test reads this block from
 * TypeScript source — so keep each key on its own line, each question one plain string
 * literal, and each chip list on one line.
 */
export const FIELD_POLICY: FieldPolicies = {
  role_title: {
    label: "job title",
    // The bank's own re-ask for the title, VERBATIM (question_bank.py `retry_question`), so
    // a reply the engine cannot read is followed by the same words, not a near-copy.
    question: "What is the job title — for example CNC Operator, MIG Welder or Plumber?",
    essential: true,
    chips: [],
  },
  benefits: {
    label: "benefits",
    // The bank's own question, VERBATIM: the topic is asked once, so it has no re-ask wording.
    question: "Which benefits are included — PF, ESI, canteen, transport or accommodation?",
    addQuestion: "Which other benefits are included?",
    essential: false,
    chips: ["PF + ESI", "Canteen", "Transport", "Accommodation"],
  },
  requirements: {
    label: "requirements",
    // Ours: the bank's "Any other must-haves …?" follows the experience question and reads
    // as a yes/no one.
    question: "What must candidates have — a qualification, certificate or licence?",
    addQuestion: "Which other requirements must candidates meet?",
    essential: false,
    chips: [],
  },
  description: {
    label: "job description",
    // Ours: the bank asks the description once and so carries no re-ask wording for it.
    question: "Could you describe the day-to-day work again?",
    essential: false,
    chips: [],
  },
};

/**
 * Appended when the question on screen is a text field whose earlier value was KEPT. "no" is
 * the engine's refusal word on every topic: it records nothing, so the kept value survives.
 * Any other reply to that question replaces it, so the payer is told which word keeps it.
 */
const KEEP_HINT = 'Reply "no" to keep the earlier one.';

/**
 * Appended when the question on screen is a list with clean chips left. The same refusal word
 * records nothing, so the list stays as it is. Any other reply is added to it.
 */
const ADD_HINT = 'Reply "no" if there are none.';

/**
 * The tap served with a list's add-question: the {@link ADD_HINT} word, so it records nothing
 * and the list stays as it is. The engine's refusal is a short fixed list of words. A typed
 * "no more" or "that's it" is not on it and would be added to the list as a chip.
 */
const ADD_CHIP = "No";

/**
 * The topic that takes the payer's messages after the wrap-up: the bank's last topic. It is
 * must-ask, so it has been asked at every wrap-up the bank drains to.
 */
export const WRAP_UP_TOPIC = "description" satisfies ScreenedDraftField;

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

/** The draft text a field holds: a list's chips, or a text value when it has one. */
function draftTexts(draft: JobPostingDraft, field: ScreenedDraftField): readonly string[] {
  if (isListField(field)) return draft[field];
  const value = draft[field];
  return value === null ? [] : [value];
}

/** Which screened fields of `draft` the shared screen refuses. Names only. */
export function refusedDraftFields(draft: JobPostingDraft): RefusedDraftField[] {
  const out: RefusedDraftField[] = [];
  for (const field of SCREENED_DRAFT_FIELDS) {
    const tripped = new Set(draftTexts(draft, field).flatMap((t) => workerVisibleTextScreens(t)));
    if (tripped.size > 0) out.push({ field, screens: SCREEN_ORDER.filter((s) => tripped.has(s)) });
  }
  return out;
}

/** `role_title:company_name,benefits:contact_details+link` — names only, for a log line. */
export function refusedNames(refused: readonly RefusedDraftField[]): string {
  return refused.map((r) => `${r.field}:${r.screens.join("+")}`).join(",");
}

/**
 * `draft` without the `refused` values (text nulled, refused chips removed), each field left
 * empty listed as missing again. For a draft that has no engine state to reopen;
 * {@link reaskRefusedFields} is the turn path.
 */
export function blankRefusedFields(
  draft: JobPostingDraft,
  refused: readonly RefusedDraftField[],
): JobPostingDraft {
  return screenedDraft(draft, refused, new Map());
}

/** What a refused field holds instead of being left empty. */
type KeptValue =
  /** A text field's clean value from BEFORE this turn: the state's answer and its draft text. */
  | { readonly kind: "text"; readonly collected: string; readonly shown: string }
  /** A list's stored items, THIS turn's, without the refused ones. */
  | { readonly kind: "list"; readonly collected: unknown[] };

/**
 * Screen one engine turn. `null` when the draft is clean, so the caller keeps the engine's
 * turn untouched.
 *
 * KEEPING A CLEAN VALUE. The question on screen always takes the payer's answer, and after
 * the wrap-up the description stays the last asked question, so any later message overwrites
 * it. A refused text overwrite therefore puts back the clean value the field held before this
 * turn rather than leaving it empty: a payer who added a line with a link keeps the
 * description they already gave. A list keeps the chips that pass. Either way the field is
 * still asked again, with {@link KEEP_HINT} or {@link ADD_HINT}.
 *
 * WHICH FIELD GOES ON SCREEN. A field left EMPTY before one that kept a value, then bank
 * order: when the title and another field are refused and empty, the title (essential, the
 * bank's first topic). A second empty field is reopened as never asked, so the engine serves it
 * again later and its must-ask gate owes it until then. A second field that kept a value stays
 * answered and is not asked again; the reply says what it kept.
 *
 * In one engine turn only the topic on screen takes free text (none of the four is read in
 * passing), so two refused fields at once means a draft stored before this screen ran.
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
  const kept = keptValues(refused, input.state, input.priorState, input.priorDraft);
  const onScreen = (refused.find((r) => !kept.has(r.field)) ?? first).field;
  return {
    refused,
    kept: refused.filter((r) => kept.has(r.field)).map((r) => r.field),
    askedField: onScreen,
    replyText: reaskReply(refused, onScreen, kept),
    chips: reaskChips(onScreen, kept.get(onScreen)),
    draft: screenedDraft(input.draft, refused, kept),
    state: reopenTopics(input.state, input.priorState, input.engineAskedId, refused, {
      onScreen,
      kept,
    }),
  };
}

/**
 * The engine's state after a clean turn, with the description put back as the topic that takes
 * the next message once the interview has wrapped up.
 *
 * The engine attributes each message to `asked_question_ids[-1]` and appends nothing to that
 * list when it wraps up. So after the wrap-up the topic asked last takes every later message.
 * Normally that is {@link WRAP_UP_TOPIC}, and a later message replaces the description. But a
 * list re-asked on or after the wrap-up was put last so the answer reaches it, and the wrap-up
 * that follows leaves it there. Every later message ("ok", "Please publish it") would then be
 * added to the list as a chip workers read. So on a wrap-up turn (`engineAskedId` null) whose
 * last asked topic is a screened list, the description goes back to the end. No id is added or
 * removed, so what the engine still owes and whether the draft is ready do not change.
 *
 * Otherwise the state is returned as it is, the same object. That includes a description never
 * asked: the engine's ask ceiling wrapped up before the bank drained, so the topic it asked last
 * stays the target, as it was before lists were re-asked.
 */
export function restoreWrapUpTarget(
  state: JobPostingChatState,
  engineAskedId: string | null,
): JobPostingChatState {
  const asked = state.asked_question_ids;
  const last = asked[asked.length - 1];
  if (engineAskedId !== null || last === undefined || !isListField(last)) return state;
  if (!asked.includes(WRAP_UP_TOPIC)) return state;
  return {
    ...state,
    asked_question_ids: [...asked.filter((id) => id !== WRAP_UP_TOPIC), WRAP_UP_TOPIC],
  };
}

/** `items` without the strings the screen refuses. Anything else is left as the engine stored it. */
function withoutRefusedItems(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  const list: readonly unknown[] = items;
  return list.filter((item) => typeof item !== "string" || isClean(item));
}

/**
 * What each refused field keeps.
 *
 * A TEXT field: the value it held before this turn, where BOTH the stored state and the stored
 * draft hold one that passes the screen. Requiring both keeps the two in step: the engine
 * rebuilds the draft from the state, and the payer sees the draft.
 *
 * A LIST: this turn's stored list without the refused items, when a chip is left. The draft's
 * chips are that list's items as stored (the engine cleans and caps a phrase once, when it
 * records it), so screening the list screens what the draft shows. Past the engine's chip
 * cap a stored item is not in this turn's draft; it is screened here all the same.
 */
function keptValues(
  refused: readonly RefusedDraftField[],
  state: JobPostingChatState,
  prior: JobPostingChatState | null,
  priorDraft: JobPostingDraft | null,
): ReadonlyMap<ScreenedDraftField, KeptValue> {
  const out = new Map<ScreenedDraftField, KeptValue>();
  for (const { field } of refused) {
    if (isListField(field)) {
      const collected = withoutRefusedItems(state.collected[field]);
      if (collected.some((item) => typeof item === "string" && item.trim() !== "")) {
        out.set(field, { kind: "list", collected });
      }
      continue;
    }
    const collected = prior?.collected[field];
    const shown = priorDraft?.[field] ?? null;
    if (typeof collected !== "string" || shown === null) continue;
    if (isClean(collected) && isClean(shown)) out.set(field, { kind: "text", collected, shown });
  }
  return out;
}

/** "a", "a or b", "a, b or c". */
function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The re-ask, e.g. "Workers see the benefits, so they can't include website links. The rest
 * of the benefits are still in the draft. Which other benefits are included? Reply "no" if
 * there are none.". Every part is a constant picked by field and screen NAME, so no path here
 * can carry the refused text.
 */
function reaskReply(
  refused: readonly RefusedDraftField[],
  onScreen: ScreenedDraftField,
  kept: ReadonlyMap<ScreenedDraftField, KeptValue>,
): string {
  const fields = refused.map((r) => r.field);
  const label = (f: ScreenedDraftField): string => FIELD_POLICY[f].label;
  const tripped = new Set(refused.flatMap((r) => r.screens));
  const reasons = SCREEN_ORDER.filter((s) => tripped.has(s)).map((s) => SCREEN_REASON[s]);
  const plural = fields.length > 1 || fields.some(isListField);
  const parts = [
    `Workers see the ${joinAnd(fields.map(label))}, so ${plural ? "they" : "it"} ` +
      `can't include ${joinOr(reasons)}.`,
  ];
  const keptText = fields.filter((f) => !isListField(f) && kept.has(f)).map(label);
  if (keptText.length > 0) {
    parts.push(
      `Your earlier ${joinAnd(keptText)} ${keptText.length === 1 ? "is" : "are"} still in the draft.`,
    );
  }
  const keptLists = fields.filter((f) => isListField(f) && kept.has(f)).map(label);
  if (keptLists.length > 0) {
    parts.push(`The rest of the ${joinAnd(keptLists)} are still in the draft.`);
  }
  parts.push(...reaskQuestion(onScreen, kept.has(onScreen)));
  return parts.join(" ");
}

/** The question for the field on screen, and the hint that names the word which keeps a value. */
function reaskQuestion(field: ScreenedDraftField, kept: boolean): string[] {
  if (!kept) return [FIELD_POLICY[field].question];
  if (isListField(field)) return [FIELD_POLICY[field].addQuestion, ADD_HINT];
  return [FIELD_POLICY[field].question, KEEP_HINT];
}

/**
 * The chips for the field on screen. Asked from scratch: the bank's own options. Asked to add
 * to the chips a list kept: the options a tap would still add, then {@link ADD_CHIP}. The
 * engine records a tap as the option's {@link optionChips} and skips any chip the list already
 * holds, so an option whose chips are all held would add nothing.
 */
function reaskChips(field: ScreenedDraftField, kept: KeptValue | undefined): readonly string[] {
  const options = FIELD_POLICY[field].chips;
  if (kept?.kind !== "list") return options;
  const held = new Set(
    kept.collected.filter((item): item is string => typeof item === "string").map(chipKey),
  );
  const adding = options.filter((option) =>
    optionChips(option).some((chip) => !held.has(chipKey(chip))),
  );
  return [...adding, ADD_CHIP];
}

/** The engine's union key for a list item: `str(item).strip().lower()`. */
const chipKey = (chip: string): string => chip.trim().toLowerCase();

/** The chips the engine records for a tap on a bank option: "PF + ESI" is "PF" and "ESI". */
const optionChips = (option: string): string[] => option.split("+").map((part) => part.trim());

/**
 * The draft without the refused values: a text value replaced by its kept earlier text or
 * nulled, a list without its refused chips. A field left empty is listed in `missing_fields`
 * again, in bank order.
 *
 * `confidence` and `clarification_questions` are the engine's own derivations and are NOT
 * recomputed here. The engine rebuilds the whole draft from the reopened state on the next
 * turn, and neither field feeds a decision (the publish gate is `PayerCreateJobPostingSchema`).
 */
function screenedDraft(
  draft: JobPostingDraft,
  refused: readonly RefusedDraftField[],
  kept: ReadonlyMap<ScreenedDraftField, KeptValue>,
): JobPostingDraft {
  const next: JobPostingDraft = { ...draft };
  for (const { field } of refused) {
    if (isListField(field)) {
      next[field] = draft[field].filter(isClean);
    } else {
      const value = kept.get(field);
      next[field] = value?.kind === "text" ? value.shown : null;
    }
  }
  const emptied = refused
    .map((r) => r.field)
    .filter((f) => draftTexts(next, f).length === 0 && !draft.missing_fields.includes(f));
  if (emptied.length > 0) next.missing_fields = inBankOrder([...draft.missing_fields, ...emptied]);
  return next;
}

/** `ids` sorted by bank position (stable). An id the bank does not know keeps its place last. */
function inBankOrder(ids: readonly string[]): string[] {
  const bank: readonly string[] = BANK_TOPIC_ORDER;
  const rank = (id: string): number => {
    const at = bank.indexOf(id);
    return at === -1 ? bank.length : at;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

/**
 * The engine state with the refused answers dropped (or put back) and `onScreen` asked again.
 *
 *  1. Each refused answer leaves `collected`, or is replaced by what it kept: a text field's
 *     earlier value, a list's items without the refused ones. Only a field left EMPTY leaves
 *     `answered_topics`; one that kept a value is still answered.
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
    readonly kept: ReadonlyMap<ScreenedDraftField, KeptValue>;
  },
): JobPostingChatState {
  const { onScreen, kept } = placement;
  const emptied = refused.map((r) => r.field).filter((f) => !kept.has(f));
  const emptiedSet = new Set<string>(emptied);

  const collected = { ...state.collected };
  for (const { field } of refused) {
    const value = kept.get(field);
    if (value) collected[field] = value.collected;
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
