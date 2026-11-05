"use client";

/**
 * OtpCodeInput — the one-time code as six boxes (#2588, W8).
 *
 * Controlled: the caller owns the code and hears every edit (`onChange`) — and `onComplete` on the
 * edit that fills the last box (the sixth digit, or a whole code at once), which is where it
 * submits ("auto-submit"). A whole code arrives in one go from a paste (into any box) or the
 * browser's one-time-code autofill (into the first). Typing over a digit replaces it. In a code that
 * was already complete that waits for Verify: a correction is never submitted half-made, and each
 * wrong code spends one of the payer's few attempts. A paste that does not fit fills the boxes but
 * is not submitted either — it was not this code as sent.
 *
 * Backspace or Delete takes a box's digit out, and the digits after it move up; the digits typed
 * next put back what was taken out, where it was (the ones that moved up move back), until focus
 * moves. Backspace in an empty box clears the digit before it; the arrows, Home and End move
 * between boxes. The code has no gaps: a click on an empty box lands on the first empty one, and
 * the boxes past it are not tab stops — so Tab from the first empty box leaves the group (to the
 * form's Verify) instead of being sent back to it.
 *
 * `success` locks the boxes — read-only, never `disabled`, so the accepted digits keep full
 * contrast and stay focusable to re-read — and fades a check in beside the label. The check is
 * decorative: the caller announces the outcome (the sign-in form's status region does).
 *
 * MOTION (globals.css, the W8 block): a digit pops as it lands (scale 1.04 over --duration-press,
 * ease-out); the check fades in over --duration-base (ease-out) and out over --duration-fast
 * (ease-in). Opacity and transform only; both tokens are 0 under reduced motion, and the pop's
 * scale is 1 there too. Nothing waits on an animation: every edit is applied at once.
 *
 * A NEW component beside the DS `OtpInput` (components/ds/otp-input.tsx), whose fill rule it reuses
 * (`distributeOtpDigits`). The sign-in form's code step renders it (app/login/login-form.tsx).
 */
import { useId, useRef } from "react";
import type { ClipboardEvent, FocusEvent, FormEvent, KeyboardEvent } from "react";
import { Icon } from "@badabhai/icons";
import { distributeOtpDigits } from "./ds/otp-input";

export interface OtpCodeInputProps {
  /** The group's visible label — also its accessible name ("Digit N of M" names each box in it). */
  label: string;
  /** How many boxes. @default 6 */
  length?: number;
  /** The digits entered so far, in order. */
  value: string;
  /** Every edit, with the whole code. */
  onChange: (value: string) => void;
  /** The edit that fills the last box (or brings a whole code), with the code — submit here. */
  onComplete?: (code: string) => void;
  /** The code was accepted: the boxes lock (read-only, full contrast) and a check fades in. */
  success?: boolean;
  /** Focus the first box on mount. */
  autoFocus?: boolean;
  /** Id(s) of a hint or error line every box is described by. */
  describedBy?: string;
}

/** An edit's outcome. */
export interface OtpEdit {
  /** The code after it. */
  value: string;
  /** The box that takes focus. */
  focus: number;
  /**
   * How many digits were just taken out at `focus` (Backspace, Delete, a cut): the digits typed
   * there next put them back, in AHEAD of the digits that moved up rather than over them. 0: none.
   */
  refill: number;
  /** It filled the last box — the sixth digit, or a whole code at once: submit the code. */
  completes: boolean;
}

/** Every box holds a digit. */
export function isCompleteCode(value: string, length: number): boolean {
  return value.length === length && /^\d+$/.test(value);
}

/**
 * Whether a write is the one to submit: it changed the code and left it complete — having been
 * incomplete before, or bringing a whole code at once. Typing over a digit of a complete code
 * waits for Verify (one digit of a correction is not the code), and digits that did not fit were
 * not this code as given: either submitted would spend one of the payer's attempts on a code
 * they never meant.
 */
function writeCompletes(
  before: string,
  after: string,
  length: number,
  whole: boolean,
  overflow: boolean,
): boolean {
  if (overflow || after === before || !isCompleteCode(after, length)) return false;
  return whole || !isCompleteCode(before, length);
}

/**
 * What an input event put into a box that held `held`: its digits — less the one it already held,
 * when typing landed beside it rather than over it ("56" or "65" in a box that held "5" is a "6").
 * Several new digits are the browser's autofill, delivering the whole code into one box.
 */
export function typedInto(raw: string, held: string): string {
  const digits = raw.replace(/\D/g, "");
  if (held !== "" && digits.length === 2 && digits.includes(held)) {
    return digits[0] === held ? digits[1]! : digits[0]!;
  }
  return digits;
}

/**
 * Write `digits` from box `index`. Never past the first empty box (the code has no gaps), and a
 * whole code — as many digits as boxes, or more — always replaces the code from the first box,
 * whichever box took it. The first `refill` digits put back what was just taken out at that box
 * (OtpEdit.refill): they go in ahead of the digits that moved up; any after them are written over
 * the boxes that follow. Focus lands after the last digit written (on the last box once the code is
 * complete). Digits past the last box are dropped — and such a write is never submitted.
 */
export function otpWrite(
  value: string,
  length: number,
  index: number,
  digits: string,
  refill = 0,
): OtpEdit {
  if (digits === "") return { value, focus: index, refill, completes: false };
  if (digits.length >= length) {
    const whole = distributeOtpDigits(value, length, 0, digits);
    return {
      value: whole.value,
      focus: whole.caret,
      refill: 0,
      completes: writeCompletes(value, whole.value, length, true, digits.length > length),
    };
  }
  const from = Math.min(index, value.length);
  const back = digits.slice(0, Math.max(0, Math.min(refill, length - value.length)));
  const opened = value.slice(0, from) + back + value.slice(from);
  const next = distributeOtpDigits(opened, length, from + back.length, digits.slice(back.length));
  return {
    value: next.value,
    focus: Math.min(next.caret, length - 1),
    refill: Math.max(0, Math.min(refill - back.length, length - next.value.length)),
    completes: writeCompletes(value, next.value, length, false, from + digits.length > length),
  };
}

/**
 * Take box `index`'s digit out: the digits after it move up one box and focus stays, so the box
 * now holds the digit that moved up — and the next digit typed there goes back in AHEAD of it
 * (`refill` counts the digits taken out there, so several are put back in turn). With nothing
 * after it there is nothing to put back ahead of. Null on an empty box.
 */
export function otpDelete(value: string, index: number, refill = 0): OtpEdit | null {
  if (index < 0 || index >= value.length) return null;
  const next = value.slice(0, index) + value.slice(index + 1);
  return {
    value: next,
    focus: index,
    refill: index < next.length ? refill + 1 : 0,
    completes: false,
  };
}

/**
 * Backspace in box `index`: a box with a digit loses it (otpDelete); an empty box clears the digit
 * before it and moves there. Null when there is nothing to clear.
 */
export function otpBackspace(value: string, index: number, refill = 0): OtpEdit | null {
  if (index < value.length) return otpDelete(value, index, refill);
  if (value.length === 0) return null;
  return { value: value.slice(0, -1), focus: value.length - 1, refill: 0, completes: false };
}

/** The box focus may rest in: no further than the first empty one (the last box when complete). */
export function otpFocusable(value: string, length: number, index: number): number {
  return Math.max(0, Math.min(index, value.length, length - 1));
}

/** The box a navigation key moves focus to from box `index` (clamped as above); null for any other key. */
export function otpKeyTarget(
  key: string,
  value: string,
  length: number,
  index: number,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return otpFocusable(value, length, index - 1);
    case "ArrowRight":
      return otpFocusable(value, length, index + 1);
    case "Home":
      return 0;
    case "End":
      return otpFocusable(value, length, length - 1);
    default:
      return null;
  }
}

export function OtpCodeInput({
  label,
  length = 6,
  value,
  onChange,
  onComplete,
  success = false,
  autoFocus = false,
  describedBy,
}: OtpCodeInputProps) {
  const labelId = useId();
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  // True while THIS component moves focus: the box's focus event fires inside `focus()`, during
  // the edit that moved it — before the caller re-renders with the new code — so the stale code
  // would send focus straight back. Our own moves are already right; only the payer's are checked.
  const steering = useRef(false);
  // Digits just taken out at box `at`, which the next digits typed there put back (OtpEdit.refill).
  // Only while focus stays where an edit left it: any move of the payer's ends it, and typing over
  // a digit replaces it again.
  const refill = useRef({ at: -1, count: 0 });
  // Only digits, never more than the boxes hold — whatever the caller passes.
  const code = value.replace(/\D/g, "").slice(0, length);
  // The last box focus may rest in: the first empty one (the last box once the code is complete).
  const lastReachable = otpFocusable(code, length, length - 1);

  /** The digits to put back at box `i` (none, unless the last edit left focus there with some). */
  const refillAt = (i: number) => (refill.current.at === i ? refill.current.count : 0);
  const endRefill = () => {
    refill.current = { at: -1, count: 0 };
  };

  /** Focus a box with its digit selected, so the next keystroke replaces it. */
  const focusBox = (i: number) => {
    const box = boxes.current[i];
    if (!box) return;
    steering.current = true;
    try {
      box.focus();
    } finally {
      steering.current = false;
    }
    box.select();
  };

  /** Apply an edit: tell the caller (and, on the edit that completes the code, submit), then focus. */
  const apply = (edit: OtpEdit) => {
    refill.current = { at: edit.focus, count: edit.refill };
    if (edit.value !== code) onChange(edit.value);
    if (edit.completes) onComplete?.(edit.value);
    focusBox(edit.focus);
  };

  // The input event, not React's onChange: React reports no change when a box's value comes out as
  // it was — its selected digit typed over with the same digit — so that keystroke would be lost,
  // focus would stay put, and the next digit would land on top of it.
  const onBoxInput = (i: number, e: FormEvent<HTMLInputElement>) => {
    if (success) return;
    const raw = e.currentTarget.value;
    // Emptied without a key (a cut): the box's digit goes, as with Backspace.
    if (raw === "") {
      const edit = otpDelete(code, i, refillAt(i));
      if (edit) apply(edit);
      return;
    }
    // Anything that is not a digit is dropped; the box shows the code again on the next render.
    apply(otpWrite(code, length, i, typedInto(raw, code[i] ?? ""), refillAt(i)));
  };

  // Intercepted, not left to the browser: a paste must spread across the boxes, and a whole code
  // pasted into a later box still starts at the first.
  const onBoxPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    if (success) return;
    const digits = e.clipboardData.getData("text").replace(/\D/g, "");
    if (digits === "") return;
    e.preventDefault();
    apply(otpWrite(code, length, i, digits, refillAt(i)));
  };

  const onBoxKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    const move = otpKeyTarget(e.key, code, length, i);
    if (move !== null) {
      e.preventDefault();
      endRefill();
      focusBox(move);
      return;
    }
    if (success || (e.key !== "Backspace" && e.key !== "Delete")) return;
    e.preventDefault();
    const edit =
      e.key === "Backspace" ? otpBackspace(code, i, refillAt(i)) : otpDelete(code, i, refillAt(i));
    if (edit) apply(edit);
  };

  const onBoxFocus = (i: number, e: FocusEvent<HTMLInputElement>) => {
    if (steering.current) return;
    // The payer moved: typing over a digit replaces it again.
    endRefill();
    const at = otpFocusable(code, length, i);
    if (at !== i) focusBox(at);
    else e.target.select();
  };

  return (
    <div className={success ? "otp-code otp-code--success" : "otp-code"}>
      <div className="otp-code__head">
        <span className="otp-code__label" id={labelId}>
          {label}
        </span>
        <Icon name="check-circle" size="md" className="otp-code__check" />
      </div>
      <div className="bb-otp otp-code__boxes" role="group" aria-labelledby={labelId}>
        {Array.from({ length }, (_, i) => {
          const digit = code[i] ?? "";
          return (
            <input
              key={i}
              ref={(el) => {
                boxes.current[i] = el;
              }}
              className={digit ? "bb-otp__cell bb-otp__cell--filled" : "bb-otp__cell"}
              type="text"
              inputMode="numeric"
              // Only the first box advertises one-time-code autofill: the browser fills ONE field,
              // and the whole code spreads from there. No maxLength — it would cut that code to a
              // digit before it arrived.
              autoComplete={i === 0 ? "one-time-code" : "off"}
              aria-label={`Digit ${i + 1} of ${length}`}
              aria-describedby={describedBy}
              // Past the first empty box: reachable by click (which lands on that box), never by
              // Tab — Tab there would only be handed back.
              tabIndex={i > lastReachable ? -1 : undefined}
              readOnly={success}
              value={digit}
              autoFocus={autoFocus && i === 0}
              onInput={(e) => onBoxInput(i, e)}
              onPaste={(e) => onBoxPaste(i, e)}
              onKeyDown={(e) => onBoxKey(i, e)}
              onFocus={(e) => onBoxFocus(i, e)}
            />
          );
        })}
      </div>
    </div>
  );
}
