/**
 * Alias retirements as the DATABASE sees them — the SQL half of
 * `JobDomainAliasRetirementRecord` (see `job-domain-corpus.ts` for what a retirement is and
 * why it is a record rather than a deletion).
 *
 * Three readers, one predicate: `db:normalize:aliases` clears `is_searchable` on retired
 * rows, `db:verify:domains` fails if any is still searchable, and `db:verify:aliases` counts
 * them as REASON 4 of the election. A second spelling of the match in any of them would let
 * the writer and its gates disagree about which rows are retired.
 *
 * ONE SQL SHAPE FOR ZERO OR MANY RETIREMENTS. The list travels as a single jsonb parameter
 * read by `jsonb_to_recordset`, which yields no rows for `[]`. So the statement production
 * runs with three retirements is byte-for-byte the statement CI's e2e job runs with none,
 * against a real Postgres, on every build — rather than an empty-list branch that swaps in a
 * `false` literal and leaves the real path exercised only on the day it first matters.
 *
 * PRIVACY: reference catalogue only — domain ids and normalized occupation phrases.
 */
import { sql as dsql, type SQL } from "drizzle-orm";

import { retiredKeyString, type RetiredAliasKey } from "./job-domain-corpus";

/** The retirement keys as the ONE jsonb parameter the predicate binds. */
export function retiredAliasesJson(keys: readonly RetiredAliasKey[]): string {
  return JSON.stringify(
    keys.map((k) => ({ job_domain_id: k.jobDomainId, lang: k.lang, text_norm: k.textNorm })),
  );
}

/**
 * TRUE when the `job_domain_alias` row aliased `a` in the enclosing query is retired.
 *
 * Matches on `(job_domain_id, lang, text_norm)` — the dedupe group — so every spelling of a
 * retired phrase on that domain goes together. A row whose `text_norm` is still NULL never
 * matches; it is unsearchable anyway, and the normalizer's own NULL rule already says so.
 */
export function retiredAliasPredicate(keys: readonly RetiredAliasKey[]): SQL {
  return dsql`EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(${retiredAliasesJson(keys)}::jsonb)
           AS r("job_domain_id" text, "lang" text, "text_norm" text)
     WHERE r."job_domain_id" = a."job_domain_id"
       AND r."lang" = a."lang"
       AND r."text_norm" = a."text_norm"
  )`;
}

/** The fields of an alias row the retirement match reads. */
export interface RetirableAliasRow {
  readonly id: string;
  readonly parentId: string;
  readonly lang: string | null;
  readonly textNorm: string | null;
}

/**
 * The ids of the rows a retirement list demotes — the same match as `retiredAliasPredicate`,
 * in TypeScript, for `verifyElection`'s REASON 4. Kept beside the SQL so the two are read
 * together and cannot drift apart unnoticed.
 */
export function retiredAliasIds(
  rows: readonly RetirableAliasRow[],
  keys: readonly RetiredAliasKey[],
): Set<string> {
  const retired = new Set(keys.map((k) => retiredKeyString(k.jobDomainId, k.lang, k.textNorm)));
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.textNorm === null || row.lang === null) continue;
    if (retired.has(retiredKeyString(row.parentId, row.lang, row.textNorm))) ids.add(row.id);
  }
  return ids;
}
