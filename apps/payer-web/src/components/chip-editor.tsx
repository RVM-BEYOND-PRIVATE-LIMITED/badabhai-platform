import type { MouseEvent } from "react";
import { Button, Chip, Input } from "./ds";

/**
 * A small add-a-chip editor: an input + Add button, and the current chips as removable pills.
 * Text left in the box is ADDED when the payer leaves it (and the form's submit carries it too) —
 * a typed requirement is never silently dropped.
 *
 * `error` (a refused publish's "Add a requirement") is drawn UNDER the row, not inside the field,
 * so the Add button stays level with the box; the box points at it with `aria-describedby`. A
 * long unbroken chip wraps inside its pill (`.chip-editor__text`) instead of widening the page.
 *
 * Each chip's remove control is the DS Chip's real button, named for its item ("Remove Fanuc
 * control"). Removing a chip from the KEYBOARD keeps focus in the list: on the chip that takes its
 * place, else the one before, else the box — never dropped to the top of the page.
 */

/**
 * Where focus goes once the chip at `removedIndex` is gone — given the remove buttons AFTER the
 * removal: the next chip (now at the same index), else the previous one, else the box.
 */
export function focusTargetAfterRemoval<T>(
  removeButtons: readonly T[],
  removedIndex: number,
  box: T | null,
): T | null {
  return removeButtons[removedIndex] ?? removeButtons[removedIndex - 1] ?? box;
}

/** After the list re-renders (next frame), focus the chip that took the removed one's place. */
function keepFocusInList(listId: string, boxId: string, removedIndex: number): void {
  window.requestAnimationFrame(() => {
    const list = document.getElementById(listId);
    const buttons = list ? Array.from(list.querySelectorAll<HTMLElement>(".bb-chip__remove")) : [];
    focusTargetAfterRemoval(buttons, removedIndex, document.getElementById(boxId))?.focus();
  });
}

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
  const listId = `${id}-chips`;
  const remove = (index: number) => (e: MouseEvent<HTMLButtonElement>) => {
    // Only a remove button that HAD focus hands it on (a keyboard press, or a click in a browser
    // that focuses buttons); a click that never focused it leaves focus where it was.
    const hadFocus = typeof document !== "undefined" && e.currentTarget === document.activeElement;
    onRemove(index);
    if (hadFocus) keepFocusInList(listId, id, index);
  };
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
        <div className="chip-editor__chips" id={listId}>
          {items.map((item, i) => (
            <Chip key={`${item}:${i}`} removeLabel={`Remove ${item}`} onRemove={remove(i)}>
              <span className="chip-editor__text">{item}</span>
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
