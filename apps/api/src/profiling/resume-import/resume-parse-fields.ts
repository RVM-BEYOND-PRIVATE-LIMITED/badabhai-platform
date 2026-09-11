import type { TargetField } from "@badabhai/ai-contracts";

/**
 * The closed list of fields a résumé parse may fill (ADR-0041 RI-3).
 *
 * THIS LIST IS GATE 5. `checkVocabulary` drops any field id the model returns that is not
 * here, on both sides of the wall — so this file is not configuration, it is the definition
 * of what the model is allowed to say at all. Adding an id here widens the model's authority;
 * nothing else does.
 *
 * ── WHY THESE EIGHT, AND NOT THE TRADE FORM'S EIGHTEEN ───────────────────────────────────
 *
 * The approved plan measured it: 15 of `qp_cnc_turning`'s 18 items are closed-option
 * CAPABILITY claims — which controllers, which workholding, which tolerance band — and real
 * worker résumés almost never carry them. Asking the model for those would not produce
 * coverage; it would produce guesses that gate 3 and gate 5 then throw away, one LLM call's
 * worth of tokens at a time. Worse, the ones that survived would be the plausible-sounding
 * ones, which is the failure mode the whole citation design exists to prevent: a résumé
 * saying "Handled CNC operations" does not say the worker runs a Fanuc to ±0.02 mm, and a
 * model asked directly will happily infer that it does.
 *
 * So this is the high-yield set the plan named — the universal keys plus the two labels the
 * deterministic router needs — and RI-7 is the phase that measures per-field coverage and
 * decides whether any capability field earns a place here. Nothing is added on a hunch.
 *
 * `domain_label` AND `role_label` ARE THE POINT OF THE WHOLE PHASE. They are the two free-text
 * labels `routeToTradeForm()` consumes, and that function — deterministic, pure, no model —
 * is what decides form-versus-chat. The model contributes two labels; CODE decides. That is
 * why "identify whether the profile is form-based or chat-based" needed no new AI authority
 * and no new decision logic: the seam already existed.
 */
export const RESUME_PARSE_TARGET_FIELDS: readonly TargetField[] = Object.freeze([
  // The router's two inputs. Free text BY DESIGN — `OccupationService.resolve()` pins them to
  // the taxonomy afterwards, and an LLM must never produce, choose or approve a canonical id.
  field("domain_label", "string"),
  field("role_label", "string"),

  // The universal keys. Every one of these is something a résumé actually prints.
  field("experience_years", "number", { unit: "years" }),
  field("current_city", "string"),
  field("education_level", "string"),
  field("salary_expected", "number", { unit: "inr_per_month" }),
  field("availability", "enum", {
    enum: ["immediate", "notice_period", "not_looking", "unknown"],
  }),
  // Machines a résumé NAMES, not machines the trade implies. Rule 5 of the prompt and gate 3's
  // item-level string check are what keep this from becoming a guessed list.
  field("machines", "string_array"),
]);

function field(
  fieldId: string,
  type: string,
  extra: { enum?: string[]; unit?: string } = {},
): TargetField {
  return {
    field_id: fieldId,
    type,
    enum: extra.enum ?? null,
    unit: extra.unit ?? null,
    // NOTHING IS REQUIRED. A résumé is not an interview: it carries what its author chose to
    // put on it, and marking a field required would push the model toward filling it from
    // context — the exact behaviour rule 5 of the prompt forbids and gate 1 exists to catch.
    required: false,
  };
}
