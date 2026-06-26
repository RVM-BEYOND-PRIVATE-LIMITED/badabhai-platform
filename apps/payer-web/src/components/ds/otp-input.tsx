"use client";

/**
 * BadaBhai Design System — OtpInput (mock-OTP login cells).
 *
 * Client primitive: holds focus refs and auto-advances. Controlled — the parent owns
 * the value and is told the full string on every change. Digits only; no business
 * logic. Prop contract mirrors docs/design/.../components/forms/OtpInput.d.ts.
 */
import { useRef } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

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

export function OtpInput({ length = 4, value = "", onChange, autoFocus = false }: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const chars = Array.from({ length }, (_, i) => value[i] || "");

  const setChar = (i: number, c: string) => {
    const next = chars.slice();
    next[i] = c;
    onChange?.(next.join(""));
  };

  const handleChange = (i: number, e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.replace(/\D/g, "");
    if (!v) {
      setChar(i, "");
      return;
    }
    setChar(i, v[v.length - 1]!);
    if (i < length - 1) refs.current[i + 1]?.focus();
  };

  const handleKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !chars[i] && i > 0) refs.current[i - 1]?.focus();
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
          maxLength={1}
          value={c}
          // Per-cell accessible name (a11y): the group is labelled "One-time passcode";
          // each cell names its position so a screen reader announces "Digit N of M".
          aria-label={`Digit ${i + 1} of ${length}`}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
        />
      ))}
    </div>
  );
}
