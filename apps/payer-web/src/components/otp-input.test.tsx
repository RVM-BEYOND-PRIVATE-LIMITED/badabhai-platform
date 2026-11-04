import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * #2588 (W8) — the OTP code input. Node env: the edit rules are pure and tested as such; the
 * markup goes through React's server renderer; the handlers are driven on the element tree with
 * stand-in boxes (each records `focus` / `select`). `useId` and `useRef` answer outside a renderer
 * so the component can be called as a plain function.
 */
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useId: () => ":otp:",
    useRef: <T,>(current: T) => ({ current }),
  };
});

const {
  OtpCodeInput,
  isCompleteCode,
  otpBackspace,
  otpFocusable,
  otpKeyTarget,
  otpWrite,
  typedInto,
} = await import("./otp-input");

const LABEL = "Enter the 6-digit login code";
const noop = () => {};

describe("the edit rules (pure)", () => {
  it("a code is complete when every box holds a digit", () => {
    expect(isCompleteCode("123456", 6)).toBe(true);
    expect(isCompleteCode("12345", 6)).toBe(false);
    expect(isCompleteCode("1234", 4)).toBe(true);
    expect(isCompleteCode("", 6)).toBe(false);
  });

  it("typedInto: what an input event put in a box — less the digit it already held", () => {
    expect(typedInto("7", "")).toBe("7");
    expect(typedInto("57", "5")).toBe("7"); // caret after the held digit
    expect(typedInto("75", "5")).toBe("7"); // caret before it
    expect(typedInto("55", "5")).toBe("5"); // the same digit again
    expect(typedInto("123456", "1")).toBe("123456"); // autofill: the whole code into one box
    expect(typedInto("a", "")).toBe("");
    expect(typedInto("1 2", "")).toBe("12");
  });

  it("otpWrite: never past the first empty box, so the code has no gaps", () => {
    expect(otpWrite("12", 6, 5, "3")).toEqual({ value: "123", focus: 3 });
    expect(otpWrite("12", 6, 2, "34")).toEqual({ value: "1234", focus: 4 });
    // Over a held digit, in place.
    expect(otpWrite("123456", 6, 2, "9")).toEqual({ value: "129456", focus: 3 });
    expect(otpWrite("12", 6, 1, "")).toEqual({ value: "12", focus: 1 });
  });

  it("otpWrite: a whole code fills from the FIRST box, whichever box took the paste", () => {
    expect(otpWrite("", 6, 3, "123456")).toEqual({ value: "123456", focus: 5 });
    expect(otpWrite("999", 6, 2, "1234567")).toEqual({ value: "123456", focus: 5 });
  });

  it("otpBackspace: a box loses its digit and keeps focus; an empty one clears the one before", () => {
    expect(otpBackspace("123", 3)).toEqual({ value: "12", focus: 2 });
    expect(otpBackspace("123", 5)).toEqual({ value: "12", focus: 2 });
    expect(otpBackspace("123", 2)).toEqual({ value: "12", focus: 2 });
    expect(otpBackspace("123", 0)).toEqual({ value: "23", focus: 0 });
    expect(otpBackspace("", 0)).toBeNull();
  });

  it("otpFocusable / otpKeyTarget: focus rests no further than the first empty box", () => {
    expect(otpFocusable("12", 6, 5)).toBe(2);
    expect(otpFocusable("123456", 6, 5)).toBe(5);
    expect(otpFocusable("12", 6, -1)).toBe(0);
    expect(otpKeyTarget("ArrowLeft", "123", 6, 1)).toBe(0);
    expect(otpKeyTarget("ArrowLeft", "123", 6, 0)).toBe(0);
    expect(otpKeyTarget("ArrowRight", "123", 6, 2)).toBe(3);
    expect(otpKeyTarget("ArrowRight", "123", 6, 3)).toBe(3);
    expect(otpKeyTarget("Home", "123", 6, 3)).toBe(0);
    expect(otpKeyTarget("End", "123", 6, 0)).toBe(3);
    expect(otpKeyTarget("End", "123456", 6, 0)).toBe(5);
    expect(otpKeyTarget("Tab", "123", 6, 0)).toBeNull();
    expect(otpKeyTarget("Backspace", "123", 6, 0)).toBeNull();
  });
});

describe("the markup — six labelled boxes in a labelled group", () => {
  const html = (props: Partial<Parameters<typeof OtpCodeInput>[0]> = {}) =>
    renderToStaticMarkup(<OtpCodeInput label={LABEL} value="" onChange={noop} {...props} />);
  const boxes = (out: string) => Array.from(out.matchAll(/<input\b[^>]*>/g), (m) => m[0]);

  it("a visible label names the group; each box names its place", () => {
    const out = html({ value: "12" });
    expect(out).toContain(`<span class="otp-code__label" id=":otp:">${LABEL}</span>`);
    expect(out).toContain(
      '<div class="bb-otp otp-code__boxes" role="group" aria-labelledby=":otp:">',
    );
    const all = boxes(out);
    expect(all).toHaveLength(6);
    all.forEach((box, i) => expect(box).toContain(`aria-label="Digit ${i + 1} of 6"`));
  });

  it("numeric keypad on every box; only the FIRST advertises one-time-code autofill; no maxlength", () => {
    const all = boxes(html());
    expect(all[0]).toContain('autoComplete="one-time-code"');
    for (const box of all.slice(1)) expect(box).toContain('autoComplete="off"');
    for (const box of all) {
      expect(box).toContain('inputMode="numeric"');
      expect(box).not.toMatch(/maxlength/i);
    }
  });

  it("the entered digits fill the boxes in order; only digits, never more than six", () => {
    const all = boxes(html({ value: "1a2-3456789" }));
    expect(all.map((b) => /value="([^"]*)"/.exec(b)?.[1])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(all.every((b) => b.includes("bb-otp__cell--filled"))).toBe(true);
    const partial = boxes(html({ value: "12" }));
    expect(partial.filter((b) => b.includes("bb-otp__cell--filled"))).toHaveLength(2);
  });

  it("a hint or error line describes every box", () => {
    for (const box of boxes(html({ describedBy: "code-error" }))) {
      expect(box).toContain('aria-describedby="code-error"');
    }
  });

  it("success: the boxes lock READ-ONLY — never disabled, so the digits keep full contrast — and the check is drawn", () => {
    const out = html({ value: "123456", success: true });
    expect(out.startsWith('<div class="otp-code otp-code--success">')).toBe(true);
    const all = boxes(out);
    for (const box of all) {
      // (React's server renderer keeps the camel case; HTML attribute names ignore it.)
      expect(box).toMatch(/\sreadonly=""/i);
      expect(box).not.toMatch(/disabled/i);
    }
    // Decorative (aria-hidden): the caller announces the outcome.
    expect(out).toContain(
      '<i class="ph-fill ph-check-circle bb-icon--md otp-code__check" aria-hidden="true"></i>',
    );
  });

  it("before success the boxes are editable and the root carries no success class", () => {
    const out = html({ value: "12" });
    expect(out.startsWith('<div class="otp-code">')).toBe(true);
    expect(out).not.toMatch(/readonly/i);
  });

  it("another length draws that many boxes", () => {
    const all = boxes(html({ length: 4 }));
    expect(all).toHaveLength(4);
    expect(all[3]).toContain('aria-label="Digit 4 of 4"');
  });
});

/* ---- the handlers, driven ---- */

type Input = ReactElement<{
  ref: (el: unknown) => void;
  autoFocus: boolean;
  onChange: (e: unknown) => void;
  onPaste: (e: unknown) => void;
  onKeyDown: (e: unknown) => void;
  onFocus: (e: unknown) => void;
}>;

function inputsOf(node: ReactNode, out: Input[] = []): Input[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) inputsOf(n, out);
    return out;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === "input") out.push(el as Input);
  if (el.props && "children" in el.props) inputsOf(el.props.children, out);
  return out;
}

function mount(value: string, over: { success?: boolean; autoFocus?: boolean } = {}) {
  const onChange = vi.fn();
  const onComplete = vi.fn();
  const tree = OtpCodeInput({ label: LABEL, value, onChange, onComplete, ...over }) as ReactElement;
  const inputs = inputsOf(tree);
  const boxes = inputs.map((input) => {
    const box = { focus: vi.fn(), select: vi.fn() };
    input.props.ref(box);
    return box;
  });
  /** The box that took focus last, by index (-1: none). */
  const focused = () => {
    let at = -1;
    let latest = -1;
    boxes.forEach((b, i) => {
      const order = b.focus.mock.invocationCallOrder.at(-1) ?? -1;
      if (order > latest) [latest, at] = [order, i];
    });
    return at;
  };
  const change = (i: number, raw: string) => inputs[i]!.props.onChange({ target: { value: raw } });
  const key = (i: number, k: string) => {
    const e = { key: k, preventDefault: vi.fn() };
    inputs[i]!.props.onKeyDown(e);
    return e;
  };
  const paste = (i: number, text: string) => {
    const e = { clipboardData: { getData: () => text }, preventDefault: vi.fn() };
    inputs[i]!.props.onPaste(e);
    return e;
  };
  const focus = (i: number) => {
    const target = { select: vi.fn() };
    inputs[i]!.props.onFocus({ target });
    return target;
  };
  return { inputs, boxes, onChange, onComplete, focused, change, key, paste, focus };
}

describe("typing — the sixth digit completes the code (auto-submit)", () => {
  it("the sixth digit: onChange with the code, then onComplete with it — once; focus stays on the last box", () => {
    const m = mount("12345");
    m.change(5, "6");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.onChange.mock.invocationCallOrder[0]).toBeLessThan(
      m.onComplete.mock.invocationCallOrder[0]!,
    );
    expect(m.focused()).toBe(5);
    // The box is selected, so the next keystroke replaces its digit.
    expect(m.boxes[5]!.select).toHaveBeenCalled();
  });

  it("any digit before the sixth only changes the code, and moves on a box", () => {
    const m = mount("1234");
    m.change(4, "5");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("12345");
    expect(m.onComplete).not.toHaveBeenCalled();
    expect(m.focused()).toBe(5);
  });

  it("the browser's autofill puts the whole code into the first box: it spreads, and completes", () => {
    const m = mount("");
    m.change(0, "123456");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("123456");
  });

  it("a corrected digit in a complete code is a new code — submitted again", () => {
    const m = mount("123456");
    m.change(2, "39");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("129456");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("129456");
  });

  it("a letter changes nothing; the same digit again submits nothing twice", () => {
    const m = mount("12");
    m.change(2, "a");
    expect(m.onChange).not.toHaveBeenCalled();
    const full = mount("123456");
    full.change(5, "66");
    expect(full.onChange).not.toHaveBeenCalled();
    expect(full.onComplete).not.toHaveBeenCalled();
  });

  it("a cut empties the box like Backspace", () => {
    const m = mount("123");
    m.change(1, "");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("13");
  });
});

describe("paste — a whole code lands across the boxes", () => {
  it("a full code pasted into ANY box fills from the first, and completes", () => {
    const m = mount("");
    const e = m.paste(3, "123 456");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.focused()).toBe(5);
  });

  it("part of a code fills from the first empty box — never leaving a gap", () => {
    const m = mount("12");
    m.paste(4, "34");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("1234");
    expect(m.onComplete).not.toHaveBeenCalled();
    expect(m.focused()).toBe(4);
  });

  it("a paste with no digits is left alone", () => {
    const m = mount("12");
    const e = m.paste(2, "hello");
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(m.onChange).not.toHaveBeenCalled();
  });
});

describe("Backspace, Delete and the arrows", () => {
  it("Backspace in an empty box clears the digit before it and moves there", () => {
    const m = mount("123");
    const e = m.key(3, "Backspace");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("12");
    expect(m.focused()).toBe(2);
  });

  it("Backspace in a box with a digit clears it and stays", () => {
    const m = mount("123");
    m.key(2, "Backspace");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("12");
    expect(m.focused()).toBe(2);
  });

  it("Backspace with nothing entered does nothing; Delete clears the box's own digit", () => {
    const empty = mount("");
    empty.key(0, "Backspace");
    expect(empty.onChange).not.toHaveBeenCalled();
    const m = mount("123");
    m.key(1, "Delete");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("13");
    expect(m.focused()).toBe(1);
  });

  it("the arrows, Home and End move between boxes — no further than the first empty one", () => {
    const m = mount("123");
    m.key(1, "ArrowLeft");
    expect(m.focused()).toBe(0);
    m.key(2, "ArrowRight");
    expect(m.focused()).toBe(3);
    m.key(3, "ArrowRight");
    expect(m.focused()).toBe(3);
    m.key(3, "Home");
    expect(m.focused()).toBe(0);
    m.key(0, "End");
    expect(m.focused()).toBe(3);
    expect(m.onChange).not.toHaveBeenCalled();
  });

  it("other keys are left to the browser (Tab moves on; a digit arrives as input)", () => {
    const m = mount("123");
    expect(m.key(1, "Tab").preventDefault).not.toHaveBeenCalled();
    expect(m.key(1, "7").preventDefault).not.toHaveBeenCalled();
  });
});

describe("focus — a click on an empty box lands on the first empty one", () => {
  it("a box past the first empty one hands focus back to it", () => {
    const m = mount("12");
    m.focus(5);
    expect(m.focused()).toBe(2);
  });

  it("a box within the code keeps focus and selects its digit (typing replaces it)", () => {
    const m = mount("12");
    const target = m.focus(1);
    expect(target.select).toHaveBeenCalled();
    expect(m.focused()).toBe(-1);
  });

  it("autoFocus lands on the first box only", () => {
    expect(mount("", { autoFocus: true }).inputs.map((i) => i.props.autoFocus)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("success — the accepted code is locked, and still readable", () => {
  it("typing, pasting, Backspace and Delete change nothing, and nothing is submitted again", () => {
    const m = mount("123456", { success: true });
    m.change(5, "7");
    m.paste(0, "654321");
    m.key(5, "Backspace");
    m.key(2, "Delete");
    expect(m.onChange).not.toHaveBeenCalled();
    expect(m.onComplete).not.toHaveBeenCalled();
  });

  it("the arrows still move between the boxes, to re-read the code", () => {
    const m = mount("123456", { success: true });
    m.key(0, "End");
    expect(m.focused()).toBe(5);
    m.key(5, "ArrowLeft");
    expect(m.focused()).toBe(4);
  });
});
