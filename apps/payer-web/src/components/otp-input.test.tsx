import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * #2588 (W8) — the OTP code input. Node env: the edit rules are pure and tested as such; the
 * markup goes through React's server renderer; the handlers are driven on the element tree with
 * stand-in boxes (each records `focus` / `select`). `useId` and `useRef` answer outside a renderer
 * so the component can be called as a plain function — and `useRef` hands the same object to the
 * same call on every render of one instance, as React does, so `mount` can re-render it with each
 * new code the way a caller holding the code in state does (`fresh` starts a new instance).
 */
const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, next: 0 }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useId: () => ":otp:",
    useRef: <T,>(current: T) => (hooks.refs[hooks.next++] ??= { current }) as { current: T },
  };
});
const fresh = () => {
  hooks.refs = [];
  hooks.next = 0;
};

const {
  OtpCodeInput,
  isCompleteCode,
  otpBackspace,
  otpDelete,
  otpFocusable,
  otpKeyTarget,
  otpWrite,
  typedInto,
} = await import("./otp-input");

const LABEL = "Enter the 6-digit login code";
const noop = () => {};
/** An expected OtpEdit. */
const edit = (value: string, focus: number, refill = 0, completes = false) => ({
  value,
  focus,
  refill,
  completes,
});

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
    expect(otpWrite("12", 6, 5, "3")).toEqual(edit("123", 3));
    expect(otpWrite("12", 6, 2, "34")).toEqual(edit("1234", 4));
    // Over a held digit, in place.
    expect(otpWrite("1234", 6, 2, "9")).toEqual(edit("1294", 3));
    expect(otpWrite("12", 6, 1, "")).toEqual(edit("12", 1));
  });

  it("otpWrite: a whole code replaces the code from the FIRST box, whichever box took it", () => {
    expect(otpWrite("", 6, 3, "123456")).toEqual(edit("123456", 5, 0, true));
    // Over a complete code too: a whole code is the payer saying "this one".
    expect(otpWrite("654321", 6, 0, "123456")).toEqual(edit("123456", 5, 0, true));
    // The same code again changes nothing, so there is nothing new to submit.
    expect(otpWrite("123456", 6, 4, "123456")).toEqual(edit("123456", 5, 0, false));
  });

  it("otpWrite completes on the sixth digit — not on a digit typed over in a complete code", () => {
    expect(otpWrite("12345", 6, 5, "6")).toEqual(edit("123456", 5, 0, true));
    expect(otpWrite("123", 6, 3, "456")).toEqual(edit("123456", 5, 0, true));
    // One digit of a correction is not the code: it waits for Verify.
    expect(otpWrite("123456", 6, 2, "9")).toEqual(edit("129456", 3, 0, false));
  });

  it("otpWrite: digits that do not fit are dropped, and the write never completes", () => {
    // A code copied with other digits around it ("Code (valid 10 min): 123456").
    expect(otpWrite("", 6, 0, "10123456")).toEqual(edit("101234", 5, 0, false));
    expect(otpWrite("999", 6, 2, "1234567")).toEqual(edit("123456", 5, 0, false));
    // Part of a code that runs past the last box.
    expect(otpWrite("123", 6, 3, "4567")).toEqual(edit("123456", 5, 0, false));
  });

  it("otpWrite with a refill: the digits put back go in AHEAD of the ones that moved up", () => {
    // "123456" lost its 3 at box 2: the 9 goes back where the 3 was, the 4 back to box 3.
    expect(otpWrite("12456", 6, 2, "9", 1)).toEqual(edit("129456", 3, 0, true));
    // Two taken out: put back one at a time, the caret still ahead of the 5 after the first.
    expect(otpWrite("1256", 6, 2, "7", 2)).toEqual(edit("12756", 3, 1));
    expect(otpWrite("12756", 6, 3, "8", 1)).toEqual(edit("127856", 4, 0, true));
    // Or both at once (a paste) — and digits beyond what was taken out are written over the next.
    expect(otpWrite("1256", 6, 2, "78", 2)).toEqual(edit("127856", 4, 0, true));
    expect(otpWrite("12456", 6, 2, "98", 1)).toEqual(edit("129856", 4, 0, true));
    // Never more back than the code has room for.
    expect(otpWrite("12456", 6, 2, "9", 3)).toEqual(edit("129456", 3, 0, true));
  });

  it("otpDelete: a box's digit goes, the later ones move up, and focus stays to put it back", () => {
    expect(otpDelete("123456", 2)).toEqual(edit("12456", 2, 1));
    expect(otpDelete("12456", 2, 1)).toEqual(edit("1256", 2, 2));
    // The last digit: nothing moved up, so nothing to put back ahead of.
    expect(otpDelete("123", 2)).toEqual(edit("12", 2));
    expect(otpDelete("123", 3)).toBeNull();
    expect(otpDelete("", 0)).toBeNull();
  });

  it("otpBackspace: a box loses its digit (otpDelete); an empty one clears the one before", () => {
    expect(otpBackspace("123", 3)).toEqual(edit("12", 2));
    expect(otpBackspace("123", 5)).toEqual(edit("12", 2));
    expect(otpBackspace("123", 2)).toEqual(edit("12", 2));
    expect(otpBackspace("123", 0)).toEqual(edit("23", 0, 1));
    expect(otpBackspace("23", 0, 1)).toEqual(edit("3", 0, 2));
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
  const html = (props: Partial<Parameters<typeof OtpCodeInput>[0]> = {}) => {
    fresh();
    return renderToStaticMarkup(<OtpCodeInput label={LABEL} value="" onChange={noop} {...props} />);
  };
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

  it("no keyboard trap: the boxes past the first empty one are not tab stops", () => {
    // Tab from the first empty box must leave the group (to Verify): a later box would only hand
    // focus back to it.
    const tabStops = (value: string) =>
      boxes(html({ value })).map((b) => (/tabindex="-1"/i.test(b) ? "-" : "tab"));
    expect(tabStops("")).toEqual(["tab", "-", "-", "-", "-", "-"]);
    expect(tabStops("12")).toEqual(["tab", "tab", "tab", "-", "-", "-"]);
    expect(tabStops("123456")).toEqual(["tab", "tab", "tab", "tab", "tab", "tab"]);
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
  onInput: (e: unknown) => void;
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

/**
 * One instance, driven like a page holding the code in state: each event's handler runs on the
 * render it was dispatched to; any new code it hands `onChange` is rendered once it returns.
 */
function mount(value: string, over: { success?: boolean; autoFocus?: boolean } = {}) {
  fresh();
  const onChange = vi.fn();
  const onComplete = vi.fn();
  let code = value;
  let inputs: Input[] = [];
  // Like a browser's: `focus()` dispatches the box's focus event at once — while the edit that
  // moved it is still being handled, i.e. before the caller has re-rendered with the new code.
  const boxes = Array.from({ length: 6 }, (_, i) => {
    const box = {
      focus: vi.fn(() => inputs[i]!.props.onFocus({ target: box })),
      select: vi.fn(),
    };
    return box;
  });
  const render = () => {
    hooks.next = 0;
    const tree = OtpCodeInput({ label: LABEL, value: code, onChange, onComplete, ...over });
    inputs = inputsOf(tree as ReactElement);
    inputs.forEach((input, i) => input.props.ref(boxes[i]));
  };
  render();
  const dispatch = <E,>(e: E, handle: (e: E) => void): E => {
    const calls = onChange.mock.calls.length;
    handle(e);
    if (onChange.mock.calls.length > calls) {
      code = onChange.mock.calls.at(-1)![0] as string;
      render();
    }
    return e;
  };
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
  /** The box's value after the browser applied the keystroke (`raw`): the input event. */
  const input = (i: number, raw: string) =>
    dispatch({ currentTarget: { value: raw } }, (e) => inputs[i]!.props.onInput(e));
  const key = (i: number, k: string) =>
    dispatch({ key: k, preventDefault: vi.fn() }, (e) => inputs[i]!.props.onKeyDown(e));
  const paste = (i: number, text: string) =>
    dispatch({ clipboardData: { getData: () => text }, preventDefault: vi.fn() }, (e) =>
      inputs[i]!.props.onPaste(e),
    );
  /** The payer focuses box `i` (a click, or Tab). */
  const focus = (i: number) =>
    dispatch({ target: { select: vi.fn() } }, (e) => inputs[i]!.props.onFocus(e)).target;
  return {
    get inputs() {
      return inputs;
    },
    boxes,
    onChange,
    onComplete,
    focused,
    input,
    key,
    paste,
    focus,
  };
}

describe("typing — the sixth digit completes the code (auto-submit)", () => {
  it("the sixth digit: onChange with the code, then onComplete with it — once; focus stays on the last box", () => {
    const m = mount("12345");
    m.input(5, "6");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.onChange.mock.invocationCallOrder[0]).toBeLessThan(
      m.onComplete.mock.invocationCallOrder[0]!,
    );
    expect(m.focused()).toBe(5);
    // The box is selected, so the next keystroke replaces its digit.
    expect(m.boxes[5]!.select).toHaveBeenCalled();
  });

  it("focus moves on even though the caller has not re-rendered yet (no bounce back)", () => {
    // The next box's focus event fires inside the move, while this render still holds "12": it
    // must not read that stale code as "past the first empty box" and send focus back.
    const m = mount("12");
    m.input(2, "3");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("123");
    expect(m.focused()).toBe(3);
    expect(m.boxes[2]!.focus).not.toHaveBeenCalled();
  });

  it("any digit before the sixth only changes the code, and moves on a box", () => {
    const m = mount("1234");
    m.input(4, "5");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("12345");
    expect(m.onComplete).not.toHaveBeenCalled();
    expect(m.focused()).toBe(5);
  });

  it("the browser's autofill puts the whole code into the first box: it spreads, and completes", () => {
    const m = mount("");
    m.input(0, "123456");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("123456");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("123456");
  });

  it("a digit typed over in a complete code changes it — and waits for Verify (one digit of a correction is not the code)", () => {
    const m = mount("123456");
    m.input(2, "39");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("129456");
    expect(m.onComplete).not.toHaveBeenCalled();
    m.input(3, "48");
    expect(m.onChange).toHaveBeenLastCalledWith("129856");
    expect(m.onComplete).not.toHaveBeenCalled();
  });

  it("a letter changes nothing; the same digit again submits nothing twice", () => {
    const m = mount("12");
    m.input(2, "a");
    expect(m.onChange).not.toHaveBeenCalled();
    const full = mount("123456");
    full.input(5, "66");
    expect(full.onChange).not.toHaveBeenCalled();
    expect(full.onComplete).not.toHaveBeenCalled();
  });

  it("keystrokes are read from the input event: React's onChange drops one that leaves a box as it was", () => {
    // A selected digit typed over with the same digit comes out unchanged, so React would never
    // call onChange for it — the keystroke lost, focus left behind for the next digit to land on.
    for (const box of mount("").inputs) {
      expect(typeof box.props.onInput).toBe("function");
      expect("onChange" in box.props).toBe(false);
    }
  });

  it("the same digit typed over itself still moves on — so retyping a code over itself leaves it as it was", () => {
    const m = mount("123456");
    m.focus(0);
    for (const [i, d] of [..."123456"].entries()) {
      m.input(i, d); // the selected digit, replaced by itself
      expect(m.focused()).toBe(Math.min(i + 1, 5));
    }
    expect(m.onChange).not.toHaveBeenCalled();
    expect(m.onComplete).not.toHaveBeenCalled();
  });

  it("a cut empties the box like Backspace", () => {
    const m = mount("123");
    m.input(1, "");
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

  it("a whole code pasted over a complete one is submitted — it is the payer's new code", () => {
    const m = mount("654321");
    m.paste(0, "123456");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("123456");
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

  it("more digits than boxes fill them — but are never submitted for the payer: it was not this code as sent", () => {
    const m = mount("");
    m.paste(0, "Code (valid 10 min): 123456");
    expect(m.onChange).toHaveBeenCalledExactlyOnceWith("101234");
    expect(m.onComplete).not.toHaveBeenCalled();
    // Nor when the browser's autofill brings them, or a paste runs past the last box.
    const filled = mount("");
    filled.input(0, "1234567");
    expect(filled.onChange).toHaveBeenCalledExactlyOnceWith("123456");
    expect(filled.onComplete).not.toHaveBeenCalled();
    const tail = mount("123");
    tail.paste(3, "4567");
    expect(tail.onChange).toHaveBeenCalledExactlyOnceWith("123456");
    expect(tail.onComplete).not.toHaveBeenCalled();
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

describe("a digit taken out, then the right one typed — it goes back where the old one was", () => {
  // After Backspace or Delete, the box shows the digit that moved up. The browser puts the next
  // keystroke beside it (caret after or before it) or over it (selected): each way, the typed digit
  // goes in AHEAD of it, and the digits after move back to their boxes.
  it.each(["49", "94", "9"])(
    "Backspace on box 3 of 123456, then 9 (the box reads %j): 129456 — and that completes it",
    (raw) => {
      const m = mount("123456");
      m.key(2, "Backspace");
      expect(m.onChange).toHaveBeenLastCalledWith("12456");
      m.input(2, raw);
      expect(m.onChange).toHaveBeenLastCalledWith("129456");
      expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("129456");
      expect(m.focused()).toBe(3);
    },
  );

  it("Delete, or a cut, the same", () => {
    const deleted = mount("123456");
    deleted.key(2, "Delete");
    deleted.input(2, "49");
    expect(deleted.onChange).toHaveBeenLastCalledWith("129456");
    expect(deleted.onComplete).toHaveBeenCalledExactlyOnceWith("129456");
    const cut = mount("123456");
    cut.input(2, "");
    cut.input(2, "49");
    expect(cut.onChange).toHaveBeenLastCalledWith("129456");
  });

  it("two taken out are put back in turn, and the code completes once", () => {
    const m = mount("123456");
    m.key(2, "Backspace");
    m.key(2, "Backspace");
    expect(m.onChange).toHaveBeenLastCalledWith("1256");
    m.input(2, "57");
    expect(m.onChange).toHaveBeenLastCalledWith("12756");
    m.input(3, "58");
    expect(m.onChange).toHaveBeenLastCalledWith("127856");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("127856");
  });

  it("putting back the same digit that moved up loses nothing", () => {
    const m = mount("123356");
    m.key(2, "Backspace");
    expect(m.onChange).toHaveBeenLastCalledWith("12356");
    m.input(2, "3"); // the selected 3 that moved up, typed over with a 3
    expect(m.onChange).toHaveBeenLastCalledWith("123356");
    expect(m.onComplete).toHaveBeenCalledExactlyOnceWith("123356");
  });

  it("once what was taken out is back, typing replaces digits again", () => {
    const m = mount("12345");
    m.key(1, "Backspace");
    m.input(1, "39");
    expect(m.onChange).toHaveBeenLastCalledWith("19345");
    m.input(2, "38");
    expect(m.onChange).toHaveBeenLastCalledWith("19845");
  });

  it("a move of the payer's ends it: after the arrows, or a click, typing replaces the digit", () => {
    const arrows = mount("123456");
    arrows.key(2, "Backspace");
    arrows.key(2, "ArrowLeft");
    arrows.key(1, "ArrowRight");
    arrows.input(2, "49");
    expect(arrows.onChange).toHaveBeenLastCalledWith("12956");
    const click = mount("123456");
    click.key(2, "Backspace");
    click.focus(1);
    click.focus(2);
    click.input(2, "49");
    expect(click.onChange).toHaveBeenLastCalledWith("12956");
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
    m.input(5, "7");
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
