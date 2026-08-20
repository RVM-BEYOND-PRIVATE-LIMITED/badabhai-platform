import { NO_NAME_ON_RECORD, displayName } from "../lib/identity";

/**
 * One row's name, or the honest dash.
 *
 * Rendered ONLY inside a `named` posture (see `lib/identity.ts`) — a dash under a Name heading
 * means "nobody recorded a name for this row", so it must never stand in for "your role may not
 * see names" or "this read was capped". Those two never render a Name column at all.
 *
 * The dash is a `<span>`, not bare text: an empty-looking cell is indistinguishable from a
 * broken one, and the `title` is what turns the mark from a shrug into a statement.
 */
export function NameCell({ value }: { value: string | null | undefined }) {
  const name = displayName(value);
  if (name === null) {
    return (
      <span className="table__meta" title={NO_NAME_ON_RECORD}>
        —
      </span>
    );
  }
  return <>{name}</>;
}
