"use client";

/**
 * OtpCodeInput — the one-time code as six boxes (#2588, W8).
 *
 * Controlled: the caller owns the code and hears every edit (`onChange`) — and `onComplete` on the
 * edit that fills the last box, which is where it submits ("auto-submit"). A whole code arrives in
 * one go from a paste (into any box) or the browser's one-time-code autofill (into the first);
 * Backspace clears a box and walks back through the empty ones; the arrows, Home and End move
 * between boxes. The code has no gaps: a click on an empty box lands on the first empty one.
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
 * (`distributeOtpDigits`). The sign-in form still renders the DS one; moving it to this one is a
 * separate change at that call site.
 */
import { useId, useRef } from "react";
import type { ChangeEvent, ClipboardEvent, FocusEvent, KeyboardEvent } from "react";
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
  /** The edit that fills the last box, with the code — submit here. */
  onComplete?: (code: string) => void;
  /** The code was accepted: the boxes lock (read-only, full contrast) and a check fades in. */
  success?: boolean;
  /** Focus the first box on mount. */
  autoFocus?: boolean;
  /** Id(s) of a hint or error line every box is described by. */
  describedBy?: string;
}

/** An edit's outcome: the code after it, and the box that takes focus. */
export interface OtpEdit {
  value: string;
  focus: number;
}

/** Every box holds a digit. */
export function isCompleteCode(value: string, length: number): boolean {
  return value.length === length && /^\d+$/.test(value);
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
 * whole code — as many digits as boxes — always fills from the first, whichever box took the paste.
 * Focus lands after the last digit written (on the last box once the code is complete).
 */
export function otpWrite(value: string, length: number, index: number, digits: string): OtpEdit {
  if (digits === "") return { value, focus: index };
  const from = digits.length >= length ? 0 : Math.min(index, value.length);
  const next = distributeOtpDigits(value, length, from, digits);
  return { value: next.value, focus: next.caret };
}

/**
 * Backspace in box `index`: a box with a digit loses it (the digits after it move up one box, as
 * in any text field) and keeps focus; an empty box clears the digit before it and moves there.
 * Null when there is nothing to clear.
 */
export function otpBackspace(value: string, index: number): OtpEdit | null {
  if (index < value.length) return { value: value.slice(0, index) + value.slice(index + 1), focus: index };
  if (value.length === 0) return null;
  return { value: value.slice(0, -1), focus: value.length - 1 };
}

/** The box focus may rest in: no further than the first empty one (the last box when complete). */
export function otpFocusable(value: string, length: number, index: number): number {
  return Math.max(0, Math.min(index, value.length, length - 1));
}

/** The box a navigation key moves focus to from box `index` (clamped as above); null for any other key. */
export function otpKeyTarget(key: string, value: string, length: number, index: number): number | null {
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
  // Only digits, never more than the boxes hold — whatever the caller passes.
  const code = value.replace(/\D/g, "").slice(0, length);

  /** Focus a box with its digit selected, so the next keystroke replaces it. */
  const focusBox = (i: number) => {
    const box = boxes.current[i];
    box?.focus();
    box?.select();
  };

  /** Apply an edit: tell the caller (and, on the edit that completes the code, submit), then focus. */
  const apply = ({ value: next, focus }: OtpEdit) => {
    if (next !== code) {
      onChange(next);
      if (isCompleteCode(next, length)) onComplete?.(next);
    }
    focusBox(focus);
  };

  const onBoxChange = (i: number, e: ChangeEvent<HTMLInputElement>) => {
    if (success) return;
    const raw = e.target.value;
    // Emptied without a key (a cut): the box's digit goes, as with Backspace.
    if (raw === "") {
      if (i < code.length) apply({ value: code.slice(0, i) + code.slice(i + 1), focus: i });
      return;
    }
    // Anything that is not a digit is dropped; the box shows the code again on the next render.
    apply(otpWrite(code, length, i, typedInto(raw, code[i] ?? "")));
  };

  // Intercepted, not left to the browser: a paste must spread across the boxes, and a whole code
  // pasted into a later box still starts at the first.
  const onBoxPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    if (success) return;
    const digits = e.clipboardData.getData("text").replace(/\D/g, "");
    if (digits === "") return;
    e.preventDefault();
    apply(otpWrite(code, length, i, digits));
  };

  const onBoxKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    const move = otpKeyTarget(e.key, code, length, i);
    if (move !== null) {
      e.preventDefault();
      focusBox(move);
      return;
    }
    if (success || (e.key !== "Backspace" && e.key !== "Delete")) return;
    e.preventDefault();
    const edit =
      e.key === "Backspace"
        ? otpBackspace(code, i)
        : i < code.length
          ? { value: code.slice(0, i) + code.slice(i + 1), focus: i }
          : null;
    if (edit) apply(edit);
  };

  const onBoxFocus = (i: number, e: FocusEvent<HTMLInputElement>) => {
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
              readOnly={success}
              value={digit}
              autoFocus={autoFocus && i === 0}
              onChange={(e) => onBoxChange(i, e)}
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
