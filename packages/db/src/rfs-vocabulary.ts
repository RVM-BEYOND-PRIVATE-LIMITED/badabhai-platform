/**
 * The Resume Field Set — the closed vocabulary a `target_kind: "rfs"` question may write into.
 *
 * WHY THIS FILE EXISTS. The Phase 4 plan lists "`target_field` ∈ the RFS vocabulary" among the
 * validator's build-time assertions, and `validateQuestionPackCorpus` implements it — behind
 * `opts.fields`, which the deploy gate never passed. The check was written, coded, unit-tested in
 * isolation, and **dead against the real corpus**. It went unenforced long enough for the
 * UNIVERSAL pack — the fallback every unauthored trade resolves to — to ship with four invented
 * field ids (`experience`, `city`, `relocation`, `education`).
 *
 * That is not cosmetic. `answer-capture.ts` picks its normalizer BY `target_field`, so an id
 * outside this vocabulary silently gets no normalizer: the worker's raw sentence is stored where
 * a typed value belongs, and the fail-closed guarantee — "the deterministic answer map alone must
 * be a usable profile" — quietly stops holding for the one pack that matters most.
 *
 * THE PYTHON SIDE IS AUTHORITATIVE, and this list is checked against it rather than trusted:
 * `apps/ai-service/app/config.py` owns `profiling_required_fields` / `profiling_optional_fields`,
 * because the ai-service is what actually gates `is_complete` on them. `rfs-vocabulary.test.ts`
 * reads that file and fails if the two disagree — the same mirror discipline the profiling lexicon
 * uses, and the reason this is a copy that cannot drift rather than a copy that will.
 */
import { FIELD_CROSSWALK, type CrosswalkEntry } from "@badabhai/profiling-lexicon";

/**
 * REQUIRED — these gate interview completion. Persona Law 4's six askable fields with location
 * split in two ("current AND preferred, never conflated").
 */
export const RFS_REQUIRED_FIELDS = [
  "trade",
  "skills",
  "experience_years",
  "current_city",
  "preferred_locations",
  "salary_expected",
  "availability",
] as const;

/**
 * OPTIONAL — captured if volunteered, never asked. Law 4 governs what may be ASKED, not what may
 * be RECORDED: a worker who mentions ITI or a licence unprompted gets it on their resume.
 */
export const RFS_OPTIONAL_FIELDS = [
  "tools_equipment",
  "salary_current",
  "education_level",
  "education_field",
  "certifications",
  "work_history",
  "languages",
  "relocation_willingness",
] as const;

export type RfsRequiredField = (typeof RFS_REQUIRED_FIELDS)[number];
export type RfsOptionalField = (typeof RFS_OPTIONAL_FIELDS)[number];
export type RfsField = RfsRequiredField | RfsOptionalField;

/** The whole vocabulary, as the set `validateQuestionPackCorpus` wants for `opts.fields`. */
export const RFS_FIELD_IDS: ReadonlySet<string> = new Set<string>([
  ...RFS_REQUIRED_FIELDS,
  ...RFS_OPTIONAL_FIELDS,
]);

/** Is this a legal `target_field` for a `target_kind: "rfs"` question? */
export function isRfsField(fieldId: string | null | undefined): fieldId is RfsField {
  return typeof fieldId === "string" && RFS_FIELD_IDS.has(fieldId);
}

/**
 * RFS field id → its declared value type, for `opts.fields.types`.
 *
 * DERIVED FROM `FIELD_CROSSWALK`, NEVER RE-LISTED. The crosswalk is the only table in the repo
 * that declares a type per RFS field, and it is the same table `answer-capture.ts` reads when it
 * decides whether to keep a chip's value. A hand-written second copy here would let the deploy
 * gate bless a chip that capture then refuses — precisely the class of silent drift the crosswalk
 * comment calls "a parallel thing to forget".
 *
 * A field the crosswalk does not know contributes no entry, so the rule simply does not fire on
 * it. That mirrors capture, which treats an unknown field as having nothing to contradict.
 */
export const RFS_FIELD_TYPES: ReadonlyMap<string, CrosswalkEntry["type"]> = new Map(
  Object.entries(FIELD_CROSSWALK).map(([fieldId, entry]) => [fieldId, entry.type]),
);
