"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Avatar, Badge } from "../../components/ds";
import { useNavigationCue } from "../../components/nav-pending";
import { PortalLink } from "../../components/portal-link";
import { logoutAction } from "./logout-action";

/**
 * Compact account menu (PROF-2) — the shell's collapsed identity.
 *
 * The trigger is the DS Avatar (org initials) rendered as a `<button>`; clicking it
 * toggles a small DS-Card panel that shows the payer's OWN identity: org name, account
 * email (mono), and coarse role + status Badges, plus a link to /account.
 *
 * SECURITY (invariant #2 / B-R2): every value here is the PAYER's OWN data, shown back
 * to them only — never worker PII, never logged or eventized. `email` is a render-only
 * prop: it is NEVER written to localStorage/sessionStorage, a query string, or analytics.
 *
 * A11Y: WAI-ARIA menu-button — `aria-haspopup="menu"` / `aria-expanded` / `aria-controls`,
 * an explicit accessible name, Enter/Space to toggle, Escape to close (focus returns to the
 * trigger), and close-on-outside-click. Focus ring + AA contrast come from tokens.
 *
 * THE PANEL STAYS MOUNTED, `hidden` while closed. Choosing "Account" closes the menu at once, but
 * the link must outlive that click: its navigation's pending cue (components/portal-link.tsx) is
 * the link's own state, so an unmounted link would take the shell's bar and "Opening Account…"
 * line with it — and on a slow backend the click would show nothing until the page arrived.
 */

type Role = "employer" | "agent";
type Status = "pending" | "active" | "suspended";

export interface AccountMenuProps {
  orgName: string;
  email?: string;
  phoneLast4?: string | null;
  role: Role;
  status: Status;
}

const ROLE_LABEL: Record<Role, string> = { employer: "Company", agent: "Agency" };

/** Status → Badge tone (active = go/green, pending = warm, suspended = danger). */
const STATUS_TONE: Record<Status, "success" | "warning" | "danger"> = {
  active: "success",
  pending: "warning",
  suspended: "danger",
};

const STATUS_LABEL: Record<Status, string> = {
  active: "Active",
  pending: "Pending",
  suspended: "Suspended",
};

// `phoneLast4` is part of the shell's identity contract but is shown only on the full
// /account page, not in this compact menu — so it is intentionally not destructured here.
export function AccountMenu({ orgName, email, role, status }: AccountMenuProps) {
  const reactId = useId();
  const panelId = `account-menu-${reactId}`;
  const [open, setOpen] = useState(false);
  const [signingOut, startSignOut] = useTransition();
  // Sign out ends in the action's `redirect("/login")`: a navigation with no router call. The
  // menu closes as it starts, so its "Signing out…" is out of sight — the shell's bar and its
  // "Opening Sign in…" line say it from the action's own transition until /login has rendered.
  useNavigationCue(signingOut, "Sign in");

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const accessibleName = `Signed in as ${orgName}${email ? ", " + email : ""}`;

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Close on an outside click (mirrors the SelectMenu pattern).
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((o) => !o);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  }

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="account-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={accessibleName}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <Avatar name={orgName} size={36} brand />
        <span className="sr-only">{accessibleName}</span>
      </button>

      <div
        id={panelId}
        role="menu"
        hidden={!open}
        className="bb-card bb-card--raised account-menu__panel"
        aria-label="Account"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="account-menu__identity">
          <span className="account-menu__org">{orgName}</span>
          {email ? <span className="account-menu__email bb-mono">{email}</span> : null}
          <div className="account-menu__badges">
            <Badge tone="brand" upper>
              {ROLE_LABEL[role]}
            </Badge>
            <Badge tone={STATUS_TONE[status]} upper>
              {STATUS_LABEL[status]}
            </Badge>
          </div>
        </div>

        <PortalLink
          className="account-menu__link"
          href="/account"
          pendingLabel="Account"
          role="menuitem"
          onClick={() => close(false)}
        >
          <Icon name={ACTION_ICON.settings} />
          {/* The page's own name (its H1 is "Account"), so the menu and the page agree. */}
          <span>Account</span>
          <Icon name={ACTION_ICON.next} className="account-menu__link-arrow" />
        </PortalLink>

        {/* Sign out — same row affordance, danger-tinted. Closes the menu (no focus return,
            the page is about to navigate) then runs the server logout action. */}
        <button
          type="button"
          role="menuitem"
          className="account-menu__link account-menu__link--danger"
          aria-busy={signingOut}
          disabled={signingOut}
          onClick={() => {
            close(false);
            startSignOut(() => logoutAction());
          }}
        >
          <Icon name="sign-out" />
          <span>{signingOut ? "Signing out…" : "Sign out"}</span>
        </button>
      </div>
    </div>
  );
}
