"use client";

import { useEffect, useRef, useState } from "react";
import { ACTION_ICON } from "@badabhai/icons";
import { IconButton } from "./icon-button";

/** How long the check and the "Copied" toast stay up before the button reverts (#2572). */
export const COPIED_FEEDBACK_MS = 1200;

/**
 * The copy affordance that travels with every shortened id (#2572). `shortId` drops the middle
 * of the value on screen; this puts the WHOLE value on the clipboard, so a truncated id is never
 * a dead end. A sibling of the id, never inside its link: a button nested in an anchor is
 * invalid markup and swallows the link's click.
 *
 * On success the icon becomes a check and a small "Copied" toast shows beside it for
 * {@link COPIED_FEEDBACK_MS}, announced politely to assistive tech. When the clipboard is
 * refused (insecure origin, permission policy) nothing claims success — the full id is still in
 * the id's `title` to select by hand.
 */
export function CopyId({ id, label = "id" }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      setCopied(false);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }

  return (
    <span className="copy-id">
      <IconButton
        icon={copied ? ACTION_ICON.approve : ACTION_ICON.copy}
        label={copied ? "Copied" : `Copy ${label}`}
        size="sm"
        className="copy-id__btn"
        onClick={copy}
      />
      <span
        className={`copy-id__toast${copied ? " copy-id__toast--on" : ""}`}
        role="status"
        aria-live="polite"
      >
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}
