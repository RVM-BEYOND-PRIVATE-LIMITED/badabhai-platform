import { z } from "zod";

import { ANSWER_TYPES } from "@badabhai/ai-contracts";
import { GENERAL_FORM_ANSWER_STATUSES, GENERAL_FORM_QUESTION_KEYS } from "@badabhai/types";

import type { PreferenceWireKey } from "../../profiles/worker-preferences.dto";
import {
  BRIEF_WIRE_MAX_UNITS,
  BRIEF_REFUSAL_REASONS,
  type BriefRefusalReason,
} from "./general-form-brief";

/**
 * THE GENERAL FORM'S WIRE SHAPE (ADR-0045 §3.3).
 *
 * WHAT IT IS. The offline half of the general road: a worker whose role is outside the 21 was
 * asked for his role and his skills by the chat, and everything else the `bb_general` sheet
 * prints is asked here — with no model anywhere (R4). It is BUILT LIKE THE TRADE FORM on purpose:
 * one round trip, `sections[].screens[]` walked in order, each screen rendered by its `type`, so
 * the app reuses the trade form's widgets rather than growing a third profiling surface.
 *
 * FOUR OF ITS FIVE SECTIONS ARE PAGES THAT ALREADY EXIST. Terms, work history, education and
 * certificates are MARKERS pointing at `PUT /workers/me/{work-preferences,employment,
 * qualifications}`, which own their vocabularies, caps, events and three-state contracts. Only
 * two questions are the form's own — "Kya aapne pehle kahin kaam kiya hai?" and the brief — and
 * those are served as question screens in the trade form's exact question shape.
 *
 * MIRRORED, NOT IMPORTED. The trade form's question/option/saved-answer schemas are module-private
 * and are not exported for this: exporting them would couple this contract to a file the 21's
 * path owns, and a later edit there would move this wire without anyone touching it. They are
 * restated field for field below, and `general-form.dto.test.ts` parses these screens with the
 * trade form's OWN `TradeFormSchemaResponse` — so the day the two shapes drift, a test fails
 * rather than a widget.
 *
 * STRICT THROUGHOUT. Every object here is `.strict()`: this is a NEW contract with no shipped
 * reader to stay lenient for, and a strict shape is what makes the test above mean something.
 */

/** A chip, in the three fields every profiling surface uses (`trade-form.dto.ts` OptionSchema). */
const OptionSchema = z
  .object({
    option_key: z.string(),
    label_text: z.string(),
    is_none_of_above: z.boolean(),
  })
  .strict();

/** One question, field for field the trade form's `FormQuestionSchema` (itself the voice form's). */
const FormQuestionSchema = z
  .object({
    question_key: z.enum(GENERAL_FORM_QUESTION_KEYS),
    prompt_text: z.string(),
    why_text: z.string().nullable(),
    answer_type: z.enum(ANSWER_TYPES),
    options: z.array(OptionSchema),
  })
  .strict();

/**
 * What the worker already said, replayed — the trade form's `SavedAnswerSchema`, field for field.
 * NULL MEANS UNANSWERED; `declined` is a real, settled answer (the brief skipped).
 */
const SavedAnswerSchema = z
  .object({
    status: z.enum(GENERAL_FORM_ANSWER_STATUSES),
    option_keys: z.array(z.string()),
    text: z.string().nullable(),
    number: z.number().nullable(),
    bool: z.boolean().nullable(),
    other_text: z.string().nullable(),
  })
  .strict();
export type GeneralFormSavedAnswer = z.infer<typeof SavedAnswerSchema>;

/**
 * A question screen — the trade form's shape exactly, so its question body renders it.
 *
 * `ui.searchable` is always false (neither question has options to search) and `suggestion` is
 * always null (no résumé suggests a brief). Both are kept rather than dropped because the trade
 * decoder the app reuses expects them.
 *
 * DECLINING. The brief is declinable ("Chhod dein" → `{kind: "declined"}`); `has_work_history` is
 * NOT — `profile.general_form_answered` cannot express a declined yes/no, so the server answers a
 * declined `has_work_history` with 400 `answer_kind_not_allowed`. The trade widget draws its
 * decline link on every question, so the app must hide it on this key; the shape carries no flag
 * for it because adding one would stop this being the trade form's question shape.
 */
const QuestionScreenSchema = z
  .object({
    type: z.literal("question"),
    question: FormQuestionSchema,
    ui: z.object({ searchable: z.boolean() }).strict(),
    answer: SavedAnswerSchema.nullable(),
    suggestion: z.null(),
  })
  .strict();
export type GeneralFormQuestionScreen = z.infer<typeof QuestionScreenSchema>;

/**
 * The Availability & Terms fields THIS form asks, as wire keys of `PUT /workers/me/work-preferences`
 * — ADR-0045 R4: salary (a monthly band, min and max), preferred locations, shift and work types,
 * languages, availability/notice.
 *
 * `satisfies` THE PAGE'S OWN KEY SET, so a key renamed or removed there is a type error here
 * rather than a field the app asks and the page 400s on.
 */
export const GENERAL_FORM_TERMS_FIELDS = [
  "salary_expected_min",
  "salary_expected_max",
  "preferred_cities",
  "shift",
  "work_types",
  "languages",
  "availability",
] as const satisfies readonly PreferenceWireKey[];
export type GeneralFormTermsField = (typeof GENERAL_FORM_TERMS_FIELDS)[number];

/**
 * The preferences page, ASKING ONLY `fields`.
 *
 * ASK-ONLY, EXACTLY LIKE THE TRADE FORM'S `tier_scope.hidden_fields` — and the round-trip rule is
 * the load-bearing half. Every OTHER preferences field (documents, job type, salary period,
 * commute, travel, relocation, accommodation, the education components) is not asked, but the
 * page is a WHOLE-RECORD REPLACE for a body without `touched_only: true`: the client must either
 * send `touched_only: true` and only the keys the worker touched, or load
 * `GET /workers/me/work-preferences` and send every stored value back unchanged. Dropping them
 * would erase answers the worker gave on another surface.
 */
const PreferencesMarkerSchema = z
  .object({
    type: z.literal("preferences"),
    endpoint: z.literal("PUT /workers/me/work-preferences"),
    fields: z.array(z.enum(GENERAL_FORM_TERMS_FIELDS)).min(1),
  })
  .strict();

/**
 * The work-history page, with the START MONTH REQUIRED.
 *
 * `require_start_ym: true` because on this road total experience is the sum of DATED jobs and
 * nothing else (R5, §4.2): an undated job makes the headline's total unknown. The page itself
 * keeps accepting an undated job (the trade form's behaviour is unchanged), so this flag is what
 * tells the client to insist. A literal `true`, not a boolean: there is no general-form state in
 * which it is optional.
 */
const EmploymentMarkerSchema = z
  .object({
    type: z.literal("employment"),
    endpoint: z.literal("PUT /workers/me/employment"),
    require_start_ym: z.literal(true),
  })
  .strict();

/** The three lists `PUT /workers/me/qualifications` owns. Three-state: an absent list survives. */
export const QUALIFICATION_LISTS = ["educations", "certificates", "trainings"] as const;

/** One education credential chip: the slug the page accepts and the label the sheet prints. */
const EducationOptionSchema = z.object({ key: z.string(), label: z.string() }).strict();

/**
 * The qualifications page, SPLIT across two sections by `lists`.
 *
 * WHY THE SPLIT IS SAFE. The page is three-state per list (`worker-qualifications.dto.ts`): an
 * absent list is left alone, so the Education section sends only `educations` and the
 * Certificates section only `certificates`/`trainings`, and neither can erase the other's.
 *
 * `education_options` ONLY ON THE SECTION THAT ASKS EDUCATION, and it is the WHOLE credential
 * vocabulary — `postgraduate` and `doctorate` included (ADR-0045 §6). The options endpoint serves
 * the trade forms' six-slug chip set; this form's choices ride its own schema, exactly as the
 * trade form's per-trade `suggested_certificates` do.
 *
 * `suggested_certificates` is always `[]`: there is no trade here to suggest for, and the key is
 * kept because the trade decoder the app reuses requires it.
 */
const QualificationsMarkerSchema = z
  .object({
    type: z.literal("qualifications"),
    endpoint: z.literal("PUT /workers/me/qualifications"),
    suggested_certificates: z.array(z.string()),
    lists: z.array(z.enum(QUALIFICATION_LISTS)).min(1),
    education_options: z.array(EducationOptionSchema).optional(),
  })
  .strict();

const ScreenSchema = z.discriminatedUnion("type", [
  QuestionScreenSchema,
  PreferencesMarkerSchema,
  EmploymentMarkerSchema,
  QualificationsMarkerSchema,
]);
export type GeneralFormScreen = z.infer<typeof ScreenSchema>;

/** The sections, in the order they are served. CLOSED: a new section is a new member. */
export const GENERAL_FORM_SECTION_IDS = [
  "terms",
  "work_history",
  "education",
  "certifications",
  "brief",
] as const;
export type GeneralFormSectionId = (typeof GENERAL_FORM_SECTION_IDS)[number];

const SectionSchema = z
  .object({
    id: z.enum(GENERAL_FORM_SECTION_IDS),
    title: z.string(),
    screens: z.array(ScreenSchema),
  })
  .strict();

/** `GET /profiling/general-form`. */
export const GeneralFormSchemaResponse = z
  .object({
    /**
     * The handover session — the one whose `conversation_state.general_road` stamp says it handed
     * over. SERVED BECAUSE THE MIC NEEDS IT, exactly as on the trade form: `POST /voice/upload`
     * files a work-history clip under a session. Never taken back from the client.
     */
    session_id: z.string().uuid(),
    /** The role the chat confirmed (the stamp's), for the form's heading. Null if none settled. */
    role_label: z.string().nullable(),
    /**
     * THIS HANDOVER's form is finished — the worker settled the brief (answered or declined) for
     * it, so the chat stopped offering the card. Per handover, not per worker: after a chat redo
     * hands the form over again, a brief kept from the last time prefills the screen but the new
     * handover is complete only once the brief is saved for it. The same mark the chat reads, so
     * this flag and the chat's card never disagree.
     */
    complete: z.boolean(),
    sections: z.array(SectionSchema),
  })
  .strict();
export type GeneralFormSchemaResponse = z.infer<typeof GeneralFormSchemaResponse>;

/**
 * `POST /profiling/general-form/answer` — one of the form's OWN two questions.
 *
 * THE KEY IS A CLOSED ENUM, not a slug regex as on the trade form: this form has exactly two
 * questions and no pack behind them, so anything else is a client bug, answered with a 400 by the
 * validation pipe before the service runs.
 *
 * THE KIND IS CHECKED PER KEY IN THE SERVICE (`has_work_history` takes only `boolean`; the brief
 * takes `text` or `declined`), because a union keyed on two discriminators is not something Zod
 * can report legibly — and the service's 400 carries a closed code the app can act on.
 *
 * `text` IS RAW, bounded only by the request-size cap {@link BRIEF_WIRE_MAX_UNITS}: emptiness,
 * length, normalisation, the 1..160 bound and the privacy walls are the brief screen's
 * (`general-form-brief.ts`), which answers with a closed reason rather than a validator message.
 */
export const GeneralFormAnswerSchema = z
  .object({
    question_key: z.enum(GENERAL_FORM_QUESTION_KEYS),
    answer: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), text: z.string().max(BRIEF_WIRE_MAX_UNITS) }).strict(),
      z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
      z.object({ kind: z.literal("declined") }).strict(),
    ]),
  })
  .strict();
export type GeneralFormAnswerDto = z.infer<typeof GeneralFormAnswerSchema>;

export const GeneralFormAnswerResponse = z
  .object({
    question_key: z.enum(GENERAL_FORM_QUESTION_KEYS),
    status: z.enum(GENERAL_FORM_ANSWER_STATUSES),
    /** Is this handover's form finished? True on every brief write; on `has_work_history`, as marked. */
    complete: z.boolean(),
    /**
     * The screen list the client holds no longer matches what `GET` would serve: this
     * `has_work_history` write showed or hid the work-history page. False on every other write.
     */
    schema_stale: z.boolean(),
  })
  .strict();
export type GeneralFormAnswerResponse = z.infer<typeof GeneralFormAnswerResponse>;

/**
 * The CLOSED codes a 400 from the answer route carries in `error.code` (beside a neutral
 * `message`). NEVER the worker's text: a refused brief is named by its reason, not quoted.
 */
export const BRIEF_REFUSAL_CODES = {
  empty: "brief_empty",
  too_long: "brief_too_long",
  emoji: "brief_emoji",
  brackets: "brief_brackets",
  identifier: "brief_identifier",
  name: "brief_name",
  contact: "brief_contact",
  link: "brief_link",
  // Owner ruling 2026-09-27 (ADR-0045 §6): money in the brief is refused at write time.
  salary: "brief_salary",
  organisation: "brief_organisation",
  unscreenable: "brief_unscreenable",
} as const satisfies { readonly [R in BriefRefusalReason]: `brief_${R}` };

export type GeneralFormAnswerErrorCode =
  | "answer_kind_not_allowed"
  | (typeof BRIEF_REFUSAL_CODES)[BriefRefusalReason];

/** Every code, in one list — derived from the refusal reasons, so a new wall is a new code. */
export const GENERAL_FORM_ANSWER_ERROR_CODES: [
  GeneralFormAnswerErrorCode,
  ...GeneralFormAnswerErrorCode[],
] = [
  // A kind the question does not take: `has_work_history` answered with text or declined, or the
  // brief answered with a boolean.
  "answer_kind_not_allowed",
  ...BRIEF_REFUSAL_REASONS.map((reason) => BRIEF_REFUSAL_CODES[reason]),
];

/** The 400 body's `error` object, as `AllExceptionsFilter` passes it through. */
export const GeneralFormAnswerErrorSchema = z
  .object({ code: z.enum(GENERAL_FORM_ANSWER_ERROR_CODES), message: z.string() })
  .strict();
export type GeneralFormAnswerError = z.infer<typeof GeneralFormAnswerErrorSchema>;
