import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChipEditor } from "./chip-editor";
import { Input } from "./ds";

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
