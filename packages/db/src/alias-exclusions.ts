/**
 * ALIAS EXCLUSIONS — the durable half of duplicate election.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * Path B's candidate predicate admits a row the moment it holds a vector:
 *
 *     WHERE sa.domain_id = $1 AND s.status = 'active' AND sa.embedding IS NOT NULL
 *
 * So the only way to take a row OUT of retrieval without deleting it — and CLAUDE.md §10
 * forbids deleting it — is to NULL its `embedding`. That works, and it is reversible, but on
 * its own it is not DURABLE: `db:embed:skills` fetches `WHERE embedding IS NULL`, so the very
 * next routine backfill would re-embed the row and silently undo a reviewed decision. So would
 * `--reset-embeddings`, which clears the whole table's vectors and provenance.
 *
 * Writing the decision into a committed file fixes that. The runner seeds its blocked-id list
 * from here, which is a mechanism it ALREADY has (`pendingAliasWhere(blocked, …)` — the list of
 * rows the provider refused mid-run). Nothing about the predicate changes; the list simply
 * starts non-empty.
 *
 * A file rather than a column, deliberately:
 *   - the decision is editorial, not operational — it wants a reviewer, and a JSON diff in a PR
 *     IS the review;
 *   - it carries the REASON, which no boolean column can, and the reason is the whole value of
 *     the record a year from now; and
 *   - it needs no migration, and migrations on this project are applied by hand.
 *
 * `is_searchable` is the column that LOOKS like it should do this job. It cannot, measured:
 * all 106 Path B candidates carry `is_searchable = false` (the normalizer has only ever run
 * over the 197-row growth corpus), so adding it to the predicate would empty Path B outright
 * rather than trim it.
 */
import { existsSync, readFileSync } from "node:fs";

/** One deliberately de-elected alias row. Every field is evidence, not decoration. */
export interface AliasExclusion {
  readonly alias_id: string;
  readonly skill_id: string;
  readonly text: string;
  readonly domain_id: string | null;
  /** The skill that KEEPS this text. Null when the text is retired outright. */
  readonly winner_skill_id: string | null;
  readonly reason: string;
  readonly decided_by: string;
  readonly phase: string;
}

export interface AliasExclusionFile {
  readonly kind: "alias-exclusions";
  readonly why?: string;
  readonly exclusions: readonly AliasExclusion[];
}

/** The committed list, relative to `packages/db`. */
export const ALIAS_EXCLUSIONS_PATH = "data/taxonomy/decollided-aliases.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse + VALIDATE. Fail closed: a malformed exclusion file must stop the runner, never
 * degrade to "no exclusions" — silently embedding a de-elected row is the exact failure this
 * file exists to prevent, and it would look like success.
 */
export function parseAliasExclusions(raw: string): readonly AliasExclusion[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e: unknown) {
    throw new Error(`[alias-exclusions] not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const f = doc as Partial<AliasExclusionFile>;
  if (f.kind !== "alias-exclusions") {
    throw new Error(`[alias-exclusions] wrong kind: expected "alias-exclusions", got ${JSON.stringify(f.kind)}`);
  }
  if (!Array.isArray(f.exclusions)) throw new Error(`[alias-exclusions] "exclusions" must be an array`);

  const seen = new Set<string>();
  for (const x of f.exclusions) {
    if (typeof x?.alias_id !== "string" || !UUID.test(x.alias_id)) {
      throw new Error(`[alias-exclusions] alias_id is not a uuid: ${JSON.stringify(x?.alias_id)}`);
    }
    if (seen.has(x.alias_id)) throw new Error(`[alias-exclusions] duplicate alias_id ${x.alias_id}`);
    seen.add(x.alias_id);
    // The reason is load-bearing, not a comment: it is what a reviewer reads when deciding
    // whether a de-election still holds. An empty one makes the record worthless.
    for (const k of ["skill_id", "text", "reason", "decided_by", "phase"] as const) {
      if (typeof x[k] !== "string" || x[k].trim() === "") {
        throw new Error(`[alias-exclusions] ${x.alias_id}: "${k}" must be a non-empty string`);
      }
    }
    // A row cannot lose a text to itself — that is a copy-paste error, and it would exclude a
    // row while claiming the same skill still serves the text.
    if (x.winner_skill_id !== null && x.winner_skill_id === x.skill_id) {
      throw new Error(`[alias-exclusions] ${x.alias_id}: winner_skill_id equals skill_id (${x.skill_id})`);
    }
  }
  return f.exclusions;
}

/** Load the committed list. A MISSING file is legitimately empty; a malformed one is fatal. */
export function loadAliasExclusions(path: string = ALIAS_EXCLUSIONS_PATH): readonly AliasExclusion[] {
  if (!existsSync(path)) return [];
  return parseAliasExclusions(readFileSync(path, "utf8"));
}

/** Just the ids, which is what the embed runner's blocked list wants. */
export function excludedAliasIds(path?: string): readonly string[] {
  return loadAliasExclusions(path).map((x) => x.alias_id);
}
