import { NO_NAME_ON_RECORD, displayName } from "../lib/identity";

/**
 * One row's name, or the honest dash.
 *
 * Rendered ONLY inside a `named` posture (see `lib/identity.ts`) — a dash under a Name heading
 * means "no name came back for this row", so it must never stand in for "your role may not see
 * names" or "this read was capped". Those two never render a Name column at all.
 *
 * The dash is a `<span>`, not bare text: an empty-looking cell is indistinguishable from a
 * broken one, and the `title` is what turns the mark from a shrug into a statement.
 *
 * ── WHY THE TITLE IS A PROP AND NOT A CONSTANT ──────────────────────────────────────────
 * What a dash MEANS depends on whether the underlying column can be null. On `workers` and
 * `admin_users` it can, so "no name on record" is the true reading and the default. On `payers`
 * it cannot — `org_name_enc` is `NOT NULL` and is always written at signup — so a dash there can
 * only be a decrypt failure or blank whitespace, and the default copy would assert something
 * false about a paying customer. Callers on that surface pass `NAME_UNREADABLE` (`lib/identity`).
 */
export function NameCell({
  value,
  absentTitle = NO_NAME_ON_RECORD,
}: {
  value: string | null | undefined;
  /** Hover copy for the dash. Defaults to the nullable-column reading. */
  absentTitle?: string;
}) {
  const name = displayName(value);
  if (name === null) {
    return (
      <span className="table__meta" title={absentTitle}>
        —
      </span>
    );
  }
  return <>{name}</>;
}
