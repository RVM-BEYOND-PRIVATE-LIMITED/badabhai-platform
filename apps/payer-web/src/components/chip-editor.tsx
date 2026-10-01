import { Button, Chip, Input } from "./ds";

/**
 * A small add-a-chip editor: an input + Add button, and the current chips as removable pills.
 * Text left in the box is ADDED when the payer leaves it (and the form's submit carries it too) —
 * a typed requirement is never silently dropped.
 *
 * `error` (a refused publish's "Add a requirement") is drawn UNDER the row, not inside the field,
 * so the Add button stays level with the box; the box points at it with `aria-describedby`. A
 * long unbroken chip wraps inside its pill (`.chip-editor__text`) instead of widening the page.
 */
export function ChipEditor({
  id,
  label,
  placeholder,
  draft,
  items,
  error,
  onDraft,
  onAdd,
  onRemove,
}: {
  id: string;
  label: string;
  placeholder: string;
  draft: string;
  items: string[];
  error?: string;
  onDraft: (v: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="chip-editor">
      <div className="chip-editor__row">
        <Input
          id={id}
          label={label}
          placeholder={placeholder}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() !== "") onAdd();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <Button type="button" variant="secondary" iconLeft="plus" onClick={onAdd}>
          Add
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="bb-field__error chip-editor__error">
          {error}
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className="chip-editor__chips">
          {items.map((item, i) => (
            <Chip key={`${item}:${i}`} onRemove={() => onRemove(i)}>
              <span className="chip-editor__text">{item}</span>
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
