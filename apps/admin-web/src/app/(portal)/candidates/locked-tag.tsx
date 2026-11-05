"use client";

import { useId } from "react";
import { Icon } from "@badabhai/icons";
import { useIconTipHandlers } from "@badabhai/icons/button";

/**
 * Why each locked field is locked (ADR-0062 §3.4, owner ruling 2026-11-04): support may correct
 * every candidate field EXCEPT these, and the API refuses a correction to any of them. There is
 * no edit control to disable — the lock is the whole statement.
 */
export const LOCK_REASONS = {
  name: "Locked: only the worker can change their name. Admins never edit it.",
  phone: "Locked: the phone is the worker's sign-in. Admins never edit it.",
  photo: "Locked: whether the resume shows the photo is the worker's own setting.",
} as const;

/**
 * "Locked", with the reason one hover or one Tab away — the console's shared tooltip
 * (`.bb-icon-tip`, shown on hover and keyboard focus; Escape dismisses it, and still closes the
 * drawer around it). Focusable so the keyboard reaches the reason too; screen readers read it as
 * the tag's description.
 */
export function LockedTag({ why }: { why: string }) {
  const tipId = useId();
  return (
    <span
      className="lock-tag"
      role="img"
      aria-label="Locked"
      aria-describedby={tipId}
      tabIndex={0}
      {...useIconTipHandlers()}
    >
      <Icon name="lock-key" />
      <span aria-hidden="true">Locked</span>
      <span className="bb-icon-tip bb-icon-tip--top-start" role="tooltip" id={tipId}>
        {why}
      </span>
    </span>
  );
}
