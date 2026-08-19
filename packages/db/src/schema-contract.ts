/**
 * "Is this database ready for the code on `main`?" — one read-only question, one command.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * On 2026-08-19 production was running code from `9bb12992` against a database without
 * migration `0078`. Every write to `unresolved_phrase` had been failing since the first deploy
 * after that merge: the interview path swallows the error by design (`identify.service.ts`
 * logs "the interview is unaffected"), so nothing was on fire and nothing was in an alert —
 * the platform simply stopped recording the growth signal that table exists to collect, and
 * `POST /skills/unresolved` and `POST /occupation/unresolved` returned 500 to anyone who
 * called them.
 *
 * Every individual control worked. The migration was correctly marked APPLY BEFORE DEPLOY, the
 * header explained why, `MIGRATIONS.md` listed it. What was missing was any way to ASK a
 * database whether it had it. `drizzle.__drizzle_migrations` does not answer that question
 * usefully — its row count does not line up with the repo's file count (76 vs 79 here, because
 * earlier migrations were baselined), so "76 applied" reads as alarming and means nothing. The
 * only reliable question is whether the OBJECTS the deployed code dereferences exist.
 *
 * ===========================================================================
 * WHAT GOES IN THE MANIFEST
 * ===========================================================================
 * Not every object — that would be a schema differ, and drizzle already owns that job. Only
 * objects where **code on `main` names the object unconditionally**, so a database without it
 * produces a runtime failure rather than a dormant feature. That is exactly the set for which
 * "apply before deploy" is the correct instruction, which is why each entry records the
 * migration, the code path, and what the failure looks like from outside.
 *
 * An entry earns its place by answering: if this is missing and we deploy, what breaks and how
 * would we find out? If the answer is "nothing" the migration is not apply-before-deploy and
 * does not belong here.
 */

/** One object the deployed code requires, and the consequence of its absence. */
export interface SchemaRequirement {
  /** Stable id, used in output and in tests. */
  readonly id: string;
  /** The migration that introduces it. */
  readonly migration: string;
  /** `table` | `column` | `constraint` | `index`. */
  readonly kind: "table" | "column" | "constraint" | "index";
  readonly table: string;
  /** Column name for `column`, constraint/index name otherwise. Unused for `table`. */
  readonly object?: string;
  /** The code that names it unconditionally. */
  readonly requiredBy: string;
  /** What an operator would see if it is missing. */
  readonly failureMode: string;
}

/**
 * The apply-before-deploy set.
 *
 * `unresolved_phrase_scope_uq` is listed as its own requirement rather than being folded into
 * the column check, because the two fail differently and only one of them is loud. Without the
 * COLUMN, the INSERT throws. With the column but the OLD four-column index, every INSERT
 * SUCCEEDS — and two canonical misses of the same phrase in different job domains silently
 * merge into one row with a summed count. That is the failure the widening exists to prevent,
 * and it leaves no error anywhere.
 */
export const SCHEMA_REQUIREMENTS: readonly SchemaRequirement[] = [
  {
    id: "0078-column",
    migration: "0078_unresolved_phrase_job_domain_id",
    kind: "column",
    table: "unresolved_phrase",
    object: "job_domain_id",
    requiredBy: "SkillsRepository.recordUnresolved — named in the INSERT column list and the ON CONFLICT target, unconditionally",
    failureMode:
      "every unresolved write throws. POST /skills/unresolved and POST /occupation/unresolved return 500; the interview path catches and logs, so canonical growth signal is lost SILENTLY",
  },
  {
    id: "0078-unique-index",
    migration: "0078_unresolved_phrase_job_domain_id",
    kind: "index",
    table: "unresolved_phrase",
    object: "unresolved_phrase_scope_uq",
    requiredBy: "SkillsRepository.recordUnresolved — ON CONFLICT (scope, phrase, domain_id, job_domain_id, lang)",
    failureMode:
      "with the old 4-column index the ON CONFLICT target does not match any index and the INSERT throws; if it were widened WITHOUT NULLS NOT DISTINCT, occupation-scope rows would stop deduping instead",
  },
  {
    id: "0078-check",
    migration: "0078_unresolved_phrase_job_domain_id",
    kind: "constraint",
    table: "unresolved_phrase",
    object: "unresolved_phrase_one_domain_chk",
    requiredBy: "the at-most-one-vocabulary invariant; the repository also refuses pre-DB, so this is defence in depth",
    failureMode:
      "a row carrying BOTH domain_id and job_domain_id becomes storable. Nothing throws; the row is simply meaningless to both retrieval paths",
  },
] as const;

/** What the live database actually has, keyed by requirement id. */
export type PresenceMap = Readonly<Record<string, boolean>>;

export interface ContractResult {
  readonly requirement: SchemaRequirement;
  readonly present: boolean;
}

/** Join the manifest against observed presence. Pure, so the reporting logic is testable. */
export function evaluateContract(
  requirements: readonly SchemaRequirement[],
  presence: PresenceMap,
): ContractResult[] {
  return requirements.map((requirement) => ({ requirement, present: presence[requirement.id] === true }));
}

/**
 * The single sentence a deploy gate would read. `null` = the database is ready.
 *
 * Deliberately names the MIGRATIONS rather than the objects: an operator's next action is
 * `pnpm --filter @badabhai/db db:migrate`, not `ALTER TABLE`.
 */
export function contractBlockReason(results: readonly ContractResult[]): string | null {
  const missing = results.filter((r) => !r.present);
  if (missing.length === 0) return null;
  const migrations = [...new Set(missing.map((m) => m.requirement.migration))].sort();
  return (
    `${missing.length} required object(s) missing, from migration(s) ${migrations.join(", ")}. ` +
    `The deployed code names them unconditionally — apply before the code reaches the box.`
  );
}

/**
 * The unique index must be present AND have the widened column list; an index of the right
 * name and the wrong shape is the more dangerous state, because `ON CONFLICT` fails loudly on
 * a mismatch but a silently-narrow key merges rows.
 */
export function uniqueIndexMatches(indexdef: string | null): boolean {
  if (indexdef === null) return false;
  const cols = /\(([^)]*)\)/.exec(indexdef)?.[1] ?? "";
  const wanted = ["scope", "phrase", "domain_id", "job_domain_id", "lang"];
  const got = cols.split(",").map((c) => c.trim());
  return wanted.every((w) => got.includes(w)) && /NULLS NOT DISTINCT/i.test(indexdef);
}
