import { z } from "zod";

import { ANSWER_TYPES } from "@badabhai/ai-contracts";

import { TRADE_FORM_KINDS } from "../trade-form-router";

/**
 * THE TRADE FORM'S WIRE SHAPE.
 *
 * WHY A THIRD PROFILING SURFACE, after chat and the voice form. Those two are INTERVIEWS: one
 * question on screen, the engine choosing the next from the answer to the last, an ask budget
 * spent on the questions where phrasing carries meaning. This is a FORM — every question is known
 * up front, they can be answered in any order, and the worker can leave halfway and come back.
 * The two disagree about almost everything except the shape of a question, which is why that one
 * shape is reused verbatim below and nothing else is.
 *
 * THE SCREEN LIST IS DATA. The client walks `sections[].screens[]` in order and renders each by
 * its `type`. Adding a trade adds a pack and a resume map; it does not add a client branch.
 */

/** A chip, in the same three fields every other profiling surface uses. */
const OptionSchema = z.object({
  option_key: z.string(),
  label_text: z.string(),
  is_none_of_above: z.boolean(),
});

/**
 * One pack question, in EXACTLY the shape `ProfilingStepSchema.question` already carries.
 *
 * Copied field-for-field on purpose: the Flutter `HttpVoiceFormGateway` already parses this shape
 * and `VoiceChoiceChips` already renders it, so the form's question screens cost the client a
 * layout rather than a parser. A different shape here would be a second definition of "a question"
 * free to drift from the one the voice form uses.
 */
const FormQuestionSchema = z.object({
  question_key: z.string(),
  prompt_text: z.string(),
  why_text: z.string().nullable(),
  answer_type: z.enum(ANSWER_TYPES),
  options: z.array(OptionSchema),
});

/**
 * What the worker has already said, replayed so a half-finished form comes back filled in.
 *
 * NULL MEANS UNANSWERED, and an empty `option_keys` does NOT: a worker who ticked nothing and
 * moved on has answered "none of these", which is a real answer and must not be re-asked as a
 * blank. The two states are kept apart here for the same reason `SetMyPreferencesSchema` keeps
 * `undefined` apart from `[]`.
 */
const SavedAnswerSchema = z.object({
  status: z.enum(["answered", "declined"]),
  option_keys: z.array(z.string()),
  text: z.string().nullable(),
  number: z.number().nullable(),
  bool: z.boolean().nullable(),
});

const ScreenSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("question"),
    question: FormQuestionSchema,
    /**
     * Presentation hints the client cannot derive without re-implementing the rule.
     *
     * `searchable` is computed from the option count, not authored: a worker scrolling twenty-three
     * materials needs a search box and a worker choosing between four tolerance bands does not,
     * and that is a property of the pack's data rather than of the trade. Computed server-side so
     * the threshold has ONE definition; an authored flag would drift the first time a pack version
     * added options and nobody remembered to flip it.
     */
    ui: z.object({ searchable: z.boolean() }),
    answer: SavedAnswerSchema.nullable(),
  }),
  /**
   * The closed-set preferences page — availability, salary band, cities, shift, languages,
   * documents, education components.
   *
   * A MARKER, NOT A COPY. It is already served and validated by
   * `PUT /workers/me/work-preferences`, which owns its vocabulary, its city gazetteer resolution
   * and its salary bounds. Restating those fields here would be a second contract for one page.
   * The client already implements it; this says WHERE it sits in the worker's journey.
   */
  z.object({
    type: z.literal("preferences"),
    endpoint: z.literal("PUT /workers/me/work-preferences"),
  }),
  /** Work history. Same argument: `PUT /workers/me/employment` owns it. */
  z.object({ type: z.literal("employment"), endpoint: z.literal("PUT /workers/me/employment") }),
  /**
   * Zone 5's credentials — certificates and education (migration 0098).
   *
   * A MARKER, LIKE THE TWO ABOVE, because `PUT /workers/me/qualifications` owns the vocabulary,
   * the caps and the three-state contract. Restating those here would be a second definition of
   * one page.
   *
   * SAFE TO SERVE BEFORE THE APP SHIPS. `trade_form_repository_impl.dart:175` fails SOFT on a
   * `type` it does not know — the screen is dropped, not fatal to the rest of the form — so an
   * existing build renders exactly the form it renders today. That property is what lets the
   * server land this without waiting on the client, and it is the reason this is a fourth
   * variant rather than a widening of one of the three.
   *
   * `suggested_certificates` IS THE ONE THING THE ENDPOINT CANNOT SERVE. A certificate name is
   * free text and cannot be a closed set — the reference sheets carry training-centre courses,
   * OEM certifications, an IATF auditor qualification and a state wireman's licence — but a
   * worker should not have to type "Fanuc Programming" from memory. The suggestions are
   * PER-TRADE and this is the only response that already knows which trade the worker is on;
   * serving them from `me/qualifications/options` would mean serving all twenty-one lists to
   * everybody. They are a SEARCH BOX'S CONTENTS, never a validation list: the endpoint accepts
   * anything the worker settles on.
   */
  z.object({
    type: z.literal("qualifications"),
    endpoint: z.literal("PUT /workers/me/qualifications"),
    suggested_certificates: z.array(z.string()),
  }),
]);

const SectionSchema = z.object({
  id: z.string(),
  /** The heading the sheet itself prints for this zone, so the form reads like its own output. */
  title: z.string(),
  screens: z.array(ScreenSchema),
});

export const TradeFormSchemaResponse = z.object({
  kind: z.enum(TRADE_FORM_KINDS),
  /** Pinned, so an answer written against v1 is never replayed into a v2 form. */
  pack_id: z.string(),
  pack_version: z.number().int().positive(),
  sections: z.array(SectionSchema),
});
export type TradeFormSchemaResponse = z.infer<typeof TradeFormSchemaResponse>;

/**
 * One answer.
 *
 * A DISCRIMINATED UNION, matching `ProfilingAnswerSchema` on the voice surface — the client sends
 * what the worker DID (tapped chips, typed, answered yes/no, skipped) rather than a pre-coerced
 * value, and the server owns every rule about what that means for the question's declared type.
 *
 * `declined` IS AN ANSWER. "Pata nahi" settles a question; it is not a gap and must not be
 * re-asked, which is why it is a variant here rather than an absent request.
 */
export const TradeFormAnswerSchema = z
  .object({
    question_key: z
      .string()
      .max(40)
      .regex(/^[a-z_]+$/, "question_key must be a pack slug"),
    answer: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("chips"), option_keys: z.array(z.string().max(64)).max(30) }),
      z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(600) }),
      z.object({ kind: z.literal("boolean"), value: z.boolean() }),
      z.object({ kind: z.literal("declined") }),
    ]),
  })
  .strict();
export type TradeFormAnswerDto = z.infer<typeof TradeFormAnswerSchema>;

export const TradeFormAnswerResponse = z.object({
  question_key: z.string(),
  status: z.enum(["answered", "declined"]),
  /** How many of this form's pack questions are now settled, for the client's progress rail. */
  answered: z.number().int().nonnegative(),
  /**
   * How many questions this worker is STILL ASKED — not how many the pack defines.
   *
   * A senior turner is not asked the three fresher questions, so a denominator of "every item in
   * the pack" is one the worker can never reach: they finish the form at 15/18 and are told they
   * have not finished.
   */
  total: z.number().int().nonnegative(),
  /**
   * The screen list the client fetched no longer matches what the server would serve now.
   *
   * WHY A FLAG AND NOT A NEW SCHEMA IN THE RESPONSE. The form is one round trip precisely so a
   * worker on 2G in a basement can fill it without a request per screen; returning the whole
   * schema on every answer would undo that. The flag is a few bytes and lets the client decide —
   * refetch now, or at the section boundary.
   *
   * DEFAULTED, SO AN OLDER CLIENT IS UNAFFECTED. A client that never reads it behaves exactly as
   * it does today: it keeps the list it has, which is a superset of the questions still relevant.
   * That is the pre-existing behaviour, not a regression, which is what lets this ship before the
   * app does.
   */
  schema_stale: z.boolean().default(false),
});
export type TradeFormAnswerResponse = z.infer<typeof TradeFormAnswerResponse>;
