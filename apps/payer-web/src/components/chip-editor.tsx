import { Button, Chip, Input } from "./ds";

/**
 * A small add-a-chip editor: an input + Add button, and the current chips as removable pills.
 * Text left in the box is ADDED when the payer leaves it (and the form's submit carries it too) —
 * a typed requirement is never silently dropped.
 */
export function ChipEditor({
  id,
  label,
  placeholder,
  draft,
  items,
  onDraft,
  onAdd,
  onRemove,
}: {
  id: string;
  label: string;
  placeholder: string;
  draft: string;
  items: string[];
  onDraft: (v: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="chip-editor">
      <div className="chip-editor__row">
        <Input
          id={id}
          label={label}
          placeholder={placeholder}
          value={draft}
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
      {items.length > 0 ? (
        <div className="chip-editor__chips">
          {items.map((item, i) => (
            <Chip key={`${item}:${i}`} onRemove={() => onRemove(i)}>
              {item}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
