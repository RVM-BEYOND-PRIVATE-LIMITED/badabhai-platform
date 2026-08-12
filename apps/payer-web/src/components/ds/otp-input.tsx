"use client";

/**
 * BadaBhai Design System — OtpInput (mock-OTP login cells).
 *
 * Client primitive: holds focus refs and auto-advances. Controlled — the parent owns
 * the value and is told the full string on every change. Digits only; no business
 * logic. Prop contract mirrors docs/design/.../components/forms/OtpInput.d.ts.
 */
import { useRef } from "react";
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from "react";

export interface OtpInputProps {
  /** Number of digit cells. @default 4 */
  length?: number;
  /** Controlled value (the digits entered so far). */
  value?: string;
  /** Called with the full string on every change. */
  onChange?: (value: string) => void;
  /** Focus the first cell on mount. */
  autoFocus?: boolean;
}

/**
 * Write `digits` into `value` starting at cell `from`, and report where the caret lands.
 *
 * Pure, and exported, because this is the whole behaviour of the component that is worth
 * asserting and the component itself cannot be invoked outside a renderer (it holds focus
 * refs). Keeping the rule here means the paste/autofill contract is covered by ordinary
 * unit tests rather than by a DOM harness this repo does not carry.
 *
 * Overflow is truncated rather than wrapped: a code longer than the field is a paste of
 * something that is not this code, and silently filling from the end would hide that.
 */
export function distributeOtpDigits(
  value: string,
  length: number,
  from: number,
  digits: string,
): { value: string; caret: number } {
  const chars = Array.from({ length }, (_, i) => value[i] || "");
  const clean = digits.replace(/\D/g, "");
  if (!clean) return { value: chars.join(""), caret: from };
  for (let k = 0; k < clean.length && from + k < length; k += 1) {
    chars[from + k] = clean[k]!;
  }
  return {
    value: chars.join(""),
    caret: Math.min(from + clean.length, length - 1),
  };
}

export function OtpInput({ length = 4, value = "", onChange, autoFocus = false }: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const chars = Array.from({ length }, (_, i) => value[i] || "");

  const setChar = (i: number, c: string) => {
    const next = chars.slice();
    next[i] = c;
    onChange?.(next.join(""));
  };

  /**
   * Write `digits` across the cells starting at `from`, then park the caret on the first
   * still-empty cell (or the last one, if the code is complete).
   *
   * This is the path a WHOLE code arrives on. Typing hits it with one digit; pasting the
   * code out of the email, and the browser's own one-time-code autofill, hit it with all
   * six at once. Before this existed the handler kept `v[v.length - 1]` — a single
   * character — so a pasted "123456" collapsed to one digit in one cell and the user had
   * to retype the code by hand, which is the single most common thing anyone does on an
   * OTP screen.
   */
  const fillFrom = (from: number, digits: string) => {
    if (!digits) return;
    const next = distributeOtpDigits(value, length, from, digits);
    onChange?.(next.value);
    refs.current[next.caret]?.focus();
  };

  const handleChange = (i: number, e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.replace(/\D/g, "");
    if (!v) {
      setChar(i, "");
      return;
    }
    // One character is a keystroke; more than one is autofill delivering the whole code
    // into a single cell. Both are the same operation at different lengths.
    fillFrom(i, v);
  };

  /**
   * `maxLength={1}` makes the browser truncate a pasted code to its first character before
   * it ever reaches onChange, so paste has to be intercepted rather than handled after the
   * fact. Digits are extracted so a code copied with stray spacing ("123 456") still works.
   */
  const handlePaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!pasted) return;
    e.preventDefault();
    fillFrom(i, pasted);
  };

  const handleKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !chars[i] && i > 0) refs.current[i - 1]?.focus();
    // Arrow keys move between cells — without this the only way back to an earlier digit
    // is the mouse, or backspacing through everything after it.
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < length - 1) refs.current[i + 1]?.focus();
  };

  return (
    <div className="bb-otp" role="group" aria-label="One-time passcode">
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`bb-otp__cell ${c ? "bb-otp__cell--filled" : ""}`}
          inputMode="numeric"
          // Only the FIRST cell advertises one-time-code autofill, so the browser/devtools targets
          // a single field (a code from SMS/email fills the first cell, then auto-advances). This
          // is what resolves Chrome DevTools' "input should have autocomplete" issue on OTP forms.
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={c}
          // Per-cell accessible name (a11y): the group is labelled "One-time passcode";
          // each cell names its position so a screen reader announces "Digit N of M".
          aria-label={`Digit ${i + 1} of ${length}`}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => handleChange(i, e)}
          onPaste={(e) => handlePaste(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
        />
      ))}
    </div>
  );
}
