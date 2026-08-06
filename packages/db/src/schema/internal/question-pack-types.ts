/**
 * Closed vocabularies for the question-pack schema (migration 0069).
 *
 * KEPT BESIDE THE SCHEMA, NOT IN @badabhai/types, for the same reason the job-domain
 * corpus lives in packages/db: these unions exist to type `$type<>()` on text columns
 * whose values are pinned by CHECK constraints in the same file. The CHECK is the
 * authority; this is the TypeScript view of it. Splitting them across packages is how
 * they drift.
 *
 * EVERY UNION HERE HAS A MATCHING CHECK in `../question-pack.ts`. Adding a value to one
 * without the other produces either a row the type system rejects or a value the database
 * rejects — both at runtime, both far from the edit.
 */

/** Lifecycle shared by families and packs. `draft` is authored-but-not-servable. */
export type ProfilingFamilyStatus = "active" | "draft" | "deprecated";

export type QuestionPackStatus = "active" | "draft" | "deprecated";

/**
 * Where a question's answer goes.
 *
 * `rfs`          — a Resume Field Set id (the profile vocabulary).
 * `match_skill`  — asserts a `skill` row, for the match engine.
 * `attribute`    — a family-specific attribute that is not an RFS field.
 * `none`         — deliberately recorded but not projected anywhere.
 */
export type QuestionTargetKind = "rfs" | "match_skill" | "attribute" | "none";

/**
 * How an answer is captured and normalized.
 *
 * `city`, `salary` and `duration` are separate from `text`/`number` because each has a
 * dedicated normalizer in packages/profiling-lexicon — a salary needs period
 * disambiguation ("pandrah hazaar" is monthly, "do lakh" is annual) and a city needs
 * gazetteer canonicalization. Collapsing them into `text` would move that work to the
 * LLM parse call, which is exactly the direction this project is moving away from.
 */
export type AnswerType =
  | "text"
  | "number"
  | "boolean"
  | "single_select"
  | "multi_select"
  | "city"
  | "salary"
  | "duration";

/** Binding granularity, highest first. The numbers ARE `specificity` — see the CHECK. */
export const BINDING_SPECIFICITY = {
  jobDomain: 50,
  iscoUnit: 40,
  iscoMinor: 30,
  iscoSubmajor: 20,
  iscoMajor: 10,
  universal: 0,
} as const;

export type BindingSpecificity =
  (typeof BINDING_SPECIFICITY)[keyof typeof BINDING_SPECIFICITY];
