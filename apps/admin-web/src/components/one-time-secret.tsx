"use client";

import { useState, type ReactNode } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/** How long "Copied" shows before the button goes back to its copy label. */
const COPIED_MS = 2000;

/**
 * A value shown ONCE for the operator to hand over — an invite accept link, a new admin's
 * temporary password — with a copy button.
 *
 * A BEARER SECRET, treated like one: rendered for the operator to copy, never logged, never put in
 * an analytics event, never persisted. The caller drops it from state when its dialog closes, so
 * it cannot be shown again. The field is readOnly, not disabled, so it can still be selected by
 * hand when the clipboard API is unavailable (insecure origin, permission policy).
 */
export function OneTimeSecret({
  title,
  body,
  value,
  inputLabel,
  copyLabel,
  mono = false,
}: {
  title: string;
  body: ReactNode;
  value: string;
  inputLabel: string;
  copyLabel: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // Long enough to be seen, short enough that the button does not lie about a clipboard the
      // operator may have overwritten since.
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Clipboard denied. The value is on screen and selectable — say nothing misleading.
      setCopied(false);
    }
  }

  return (
    <div className="alert alert--success" role="status">
      <div className="alert__text">
        <p className="alert__title">{title}</p>
        <p className="alert__body">{body}</p>
        <input
          className={`field__input${mono ? " mono" : ""}`}
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={inputLabel}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <button type="button" className="btn" onClick={copy}>
        <Icon name={copied ? ACTION_ICON.approve : ACTION_ICON.copy} />
        <span>{copied ? "Copied" : copyLabel}</span>
      </button>
    </div>
  );
}
