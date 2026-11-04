"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { NavPendingCue } from "./nav-pending";

/** The signed-in admin's own settings page (ADR-0060) — the avatar menu's one link. */
export const ACCOUNT_HREF = "/account";

/**
 * THE AVATAR MENU (A6, #2576) — who you are, your Account and Sign out, in the topbar's top-right
 * corner. They lived in the sidebar's foot, which 19 nav items pushed below the fold on a 1080p
 * screen; the topbar is always on screen (it is sticky), so Sign out is always one click away.
 *
 * A DISCLOSURE, not an ARIA menu: a button (`aria-expanded`, `aria-controls`) and a panel of an
 * ordinary link and an ordinary button, reached with Tab — a `role="menu"` would promise arrow-key
 * handling this does not need. Escape closes it and puts focus back on the button; a click
 * outside, Tab leaving it, and a navigation close it too.
 *
 * The panel STAYS MOUNTED, `hidden` while closed: Account's pending cue is its link's own state,
 * so the link must outlive the click that closes the menu (as in payer-web). Opening fades it in
 * and scales it 0.98 → 1 from the top-right over 140ms (`.avatar-menu__panel`; zero under
 * reduced motion).
 *
 * Identity is the server's: the role label and the opaque admin id from `GET /admin/me` — never a
 * name or an email, which the endpoint does not return.
 */
export function AvatarMenu({
  roleLabel,
  adminId,
  signOut,
}: {
  roleLabel: string;
  adminId: string;
  /** The Sign out control, rendered by the server layout (it calls the logout Server Action). */
  signOut: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelId = `${useId()}-account`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A navigation — Account itself, or anywhere else — closes it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // A click outside closes it (listened for only while open).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const closeToTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className="avatar-menu"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          closeToTrigger();
        }
      }}
      onBlur={(e) => {
        // Tab past the last item (or Shift+Tab off the button) leaves the menu: close it.
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className="avatar-menu__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account menu, signed in as ${roleLabel}`}
        onClick={() => setOpen((v) => !v)}
      >
        {/* A person's silhouette — the admin has no name or photo to show (see above). */}
        <span className="avatar-menu__avatar" aria-hidden="true">
          <Icon name="user" />
        </span>
        <span className="avatar-menu__role" aria-hidden="true">
          {roleLabel}
        </span>
        <Icon name={ACTION_ICON.disclosure} className="avatar-menu__caret" />
      </button>

      <div className="avatar-menu__panel" id={panelId} hidden={!open}>
        <p className="avatar-menu__who">
          <span className="avatar-menu__eyebrow">Signed in as</span>
          <span className="avatar-menu__role-name">{roleLabel}</span>
          {/* The opaque admin id, never a name or email — /admin/me returns neither. */}
          <span className="avatar-menu__id mono" title={adminId}>
            {adminId.slice(0, 8)}…
          </span>
        </p>
        <ul className="avatar-menu__list">
          <li>
            <Link
              className="avatar-menu__item"
              href={ACCOUNT_HREF}
              aria-current={pathname === ACCOUNT_HREF ? "page" : undefined}
            >
              <Icon name={ACTION_ICON.settings} />
              <span>Account</span>
              <NavPendingCue message="Opening Account…" />
            </Link>
          </li>
          <li className="avatar-menu__signout">{signOut}</li>
        </ul>
      </div>
    </div>
  );
}
