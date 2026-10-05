import type { CompanionEditRow } from "@badabhai/ai-contracts";
import { catalogueEntry, normaliseValue, opAllowed } from "./edit-catalogue";
import { rowCarriesField, type SnapshotRow } from "./edit-snapshot";

/**
 * LIST FIELDS TAKE MEMBERS, NOT REPLACEMENTS (ADR-0046 O5; WP4, 2026-10-05).
 *
 * The catalogue offers `add`/`delete` — never `edit` — on the three list preferences
 * (`preferred_cities`, `work_types`, `documents_ready`), because a worker has MANY cities, many
 * work types and many documents, and there is no single "the" value to replace. The 2026-10-01
 * eval measured the primary model answering list changes with `op: "edit"` (3 of 74 cases: two
 * `preferred_cities`, one `work_types`), which the API dropped as out-of-catalogue and the worker
 * got no card for.
 *
 * THIS IS THE SECOND LAYER, AND IT IS DETERMINISTIC. The prompt tells the model the rule; this
 * function catches a model that ignored it, BEFORE `validateRow`: an `edit` on a list field whose
 * ref names a stored member becomes `delete old` + `add new` — the replace the model meant, always
 * in that order — with the values normalised through the field's own dictionary. Replacing a member
 * with itself drops both rows (nothing changed). ANY ambiguity drops the row (fail closed): no ref,
 * a ref the snapshot does not hold, a ref whose entry lacks the field, a member the dictionary
 * refuses, or a non-list field. The model never decides, and the code never guesses.
 *
 * The 3-row cap (O5) still applies AFTER expansion, in `propose` — the pair counts as two rows.
 * This module is pure: it reads the rows and the snapshot the request already built, writes
 * nothing, logs nothing.
 */

/** One model row as this transform reads it — the contract's own shape, restated structurally. */
type ModelRow = CompanionEditRow;

/**
 * Every model row, with each `edit`-on-a-list-member expanded into its `delete` + `add` pair.
 * Order is preserved; an untouched row passes through by identity.
 */
export function expandListEdits(
  rows: readonly ModelRow[],
  byRef: ReadonlyMap<string, SnapshotRow>,
): ModelRow[] {
  const out: ModelRow[] = [];
  for (const row of rows) {
    const entry = row.field === null ? undefined : catalogueEntry(row.section, row.field);
    // Not a list field: anything the catalogue lets through untouched (including every legal
    // `edit`, and any row the catalogue does not know — `validateRow` owns that verdict).
    if (
      entry === undefined ||
      row.op !== "edit" ||
      opAllowed(entry, "edit") ||
      !(opAllowed(entry, "add") && opAllowed(entry, "delete"))
    ) {
      out.push(row);
      continue;
    }

    const source = row.ref === null ? undefined : byRef.get(row.ref);
    if (source === undefined || source.section !== entry.section) continue;
    if (!rowCarriesField(source, entry.field)) continue;
    const before = source.fields[entry.field] ?? null;
    if (before === null || row.value === null) continue;
    const from = normaliseValue(entry.section, entry.field, before);
    const to = normaliseValue(entry.section, entry.field, row.value);
    if (from === null || to === null || from === to) continue;

    out.push({ op: "delete", section: row.section, ref: row.ref, field: row.field, value: null });
    out.push({ op: "add", section: row.section, ref: null, field: row.field, value: row.value });
  }
  return out;
}
