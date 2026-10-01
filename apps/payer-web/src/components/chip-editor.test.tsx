import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChipEditor, focusTargetAfterRemoval } from "./chip-editor";
import { Chip, Input, type ChipProps } from "./ds";

/**
 * The chip editor never drops a typed chip: text left in the box is added when the payer leaves
 * it, Enter adds without submitting the form, and a refused publish's reason sits under the row
 * and is the box's described-by. A long unbroken chip is wrapped for the CSS that keeps it inside
 * its pill (it widened the page by up to 698px).
 */

type InputProps = {
  onBlur: () => void;
  onKeyDown: (e: { key: string; preventDefault: () => void }) => void;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

function editor(over: Partial<Parameters<typeof ChipEditor>[0]> = {}) {
  const onAdd = vi.fn();
  const props = {
    id: "requirements",
    label: "Requirements",
    placeholder: "e.g. Fanuc control",
    draft: "MIG welding",
    items: ["Fanuc control"],
    onDraft: vi.fn(),
    onAdd,
    onRemove: vi.fn(),
    ...over,
  };
  const tree = ChipEditor(props) as ReactElement;
  return { tree, onAdd, props };
}

/** The DS Input element the editor renders (found by type, without rendering it). */
function inputOf(node: ReactNode): ReactElement<InputProps> {
  const stack: ReactNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || n === undefined || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      stack.push(...n);
      continue;
    }
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (el.type === Input) return el as unknown as ReactElement<InputProps>;
    if (el.props && "children" in el.props) stack.push(el.props.children);
  }
  throw new Error("no Input");
}

describe("ChipEditor — a typed chip is never dropped", () => {
  it("leaving the box with text in it ADDS the chip", () => {
    const { tree, onAdd } = editor();
    inputOf(tree).props.onBlur();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("leaving an empty (or blank) box adds nothing", () => {
    for (const draft of ["", "   "]) {
      const { tree, onAdd } = editor({ draft });
      inputOf(tree).props.onBlur();
      expect(onAdd).not.toHaveBeenCalled();
    }
  });

  it("Enter adds the chip and does NOT submit the form (preventDefault)", () => {
    const { tree, onAdd } = editor();
    const preventDefault = vi.fn();
    inputOf(tree).props.onKeyDown({ key: "Enter", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("other keys neither add nor block typing", () => {
    const { tree, onAdd } = editor();
    const preventDefault = vi.fn();
    inputOf(tree).props.onKeyDown({ key: "a", preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("ChipEditor — a refused publish's reason, and long chips", () => {
  it("shows the reason under the row and points the box at it", () => {
    const { tree } = editor({ error: "At least one requirement chip." });
    const input = inputOf(tree);
    expect(input.props["aria-invalid"]).toBe(true);
    expect(input.props["aria-describedby"]).toBe("requirements-error");
    expect(renderToStaticMarkup(tree)).toContain(
      '<p id="requirements-error" class="bb-field__error chip-editor__error">At least one requirement chip.</p>',
    );
  });

  it("without a reason, the box is not marked invalid", () => {
    const input = inputOf(editor().tree);
    expect(input.props["aria-invalid"]).toBeUndefined();
    expect(input.props["aria-describedby"]).toBeUndefined();
  });

  it("wraps each chip's text so a long unbroken token can wrap inside its pill", () => {
    const long = "Fanuc/Siemens/Mitsubishi-0i-TF-Plus-control-experience-mandatory-and-more";
    const out = renderToStaticMarkup(editor({ items: [long] }).tree);
    expect(out).toContain(`<span class="chip-editor__text">${long}</span>`);
  });
});

describe("ChipEditor — each chip's remove is a real button, named for its item (CR-L1)", () => {
  /** The DS Chip elements the editor renders (props only — the remove button is the DS's). */
  function chipsOf(node: ReactNode): ReactElement<ChipProps>[] {
    const out: ReactElement<ChipProps>[] = [];
    const stack: ReactNode[] = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n === null || n === undefined || typeof n !== "object") continue;
      if (Array.isArray(n)) {
        stack.push(...n);
        continue;
      }
      const el = n as ReactElement<{ children?: ReactNode }>;
      if (el.type === Chip) out.push(el as unknown as ReactElement<ChipProps>);
      else if (el.props && "children" in el.props) stack.push(el.props.children);
    }
    return out.reverse();
  }

  it("names every remove button for its own item — never a list of bare 'Remove'", () => {
    const { tree } = editor({ items: ["Fanuc control", "Night shift ok"] });
    expect(chipsOf(tree).map((c) => (c.props as { removeLabel?: string }).removeLabel)).toEqual([
      "Remove Fanuc control",
      "Remove Night shift ok",
    ]);
    const out = renderToStaticMarkup(tree);
    expect(out).toContain('<button type="button" class="bb-chip__remove" aria-label="Remove Fanuc control"');
    expect(out).not.toContain('role="button"');
    // The list has an id, so a removal can hand focus to the chip that takes the place.
    expect(out).toContain('<div class="chip-editor__chips" id="requirements-chips">');
  });

  it("activating a remove button removes THAT chip", () => {
    const { tree, props } = editor({ items: ["a", "b", "c"] });
    const second = chipsOf(tree)[1]!.props as { onRemove: (e: unknown) => void };
    second.onRemove({ currentTarget: {} });
    expect(props.onRemove).toHaveBeenCalledWith(1);
  });

  it("focus after a removal: the chip now in its place, else the one before, else the box", () => {
    expect(focusTargetAfterRemoval(["b2", "c2"], 0, "box")).toBe("b2"); // removed the first of 3
    expect(focusTargetAfterRemoval(["a2", "b2"], 2, "box")).toBe("b2"); // removed the last of 3
    expect(focusTargetAfterRemoval(["a2", "c2"], 1, "box")).toBe("c2"); // removed the middle
    expect(focusTargetAfterRemoval([], 0, "box")).toBe("box"); // removed the only one
    expect(focusTargetAfterRemoval([], 0, null)).toBeNull();
  });
});
