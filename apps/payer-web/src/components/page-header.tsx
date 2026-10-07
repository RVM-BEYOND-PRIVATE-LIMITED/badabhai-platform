import type { ReactNode } from "react";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import { PortalLink } from "./portal-link";

/**
 * PageHeader — the ONE header structure every portal page renders (owner ruling 2026-10-01).
 *
 *   [← back (detail / child pages only)]
 *   H1 + one-sentence description  |  status · ONE primary action · secondary actions
 *   [toolbar: an optional filter / search row]
 *
 * It emits the classes the pages already used by hand (`page-back`, `page-head`,
 * `page-head__text` / `__title` / `__sub`, `page-head__actions`), so the shared CSS — the
 * back link's phone hit strip, the phone-shrinkable action group — applies unchanged.
 *
 * RULES (enforced by the props, documented here, pinned by page-header.test.tsx):
 *  - `back` is for a page BELOW a nav destination, and points to its REAL parent, labelled with
 *    that parent's name. A top-level page (one the rail or the account menu opens) has none: the
 *    rail is its way out.
 *  - `title` is the nav label of the page (so the rail, the breadcrumb and the H1 agree), or the
 *    entity's own name on a detail page.
 *  - `description` is one sentence.
 *  - At most ONE primary action, and it acts on this page's subject. Secondaries follow it. Every
 *    action is icon + text (a key action never goes icon-only) at the md control size, which is
 *    the DS tap floor (44px) on every pointer.
 *  - `status` (open / paused / draft …) sits before the actions, as on a posting's detail page.
 *
 * Server-safe: no hooks, no handlers. Authorization is never here — every page keeps its own
 * server gate before it renders this. Each link is a `PortalLink`, which carries the navigation
 * pending cue as a CLIENT child (components/nav-pending.tsx), so this stays a server component.
 */

export interface PageHeaderAction {
  href: string;
  label: string;
  icon: IconName;
}

export interface PageHeaderBack {
  href: string;
  /**
   * The parent page's own name — what its H1 says: "Postings", or a posting's title for a page
   * below that posting (one label per destination, wherever the link to it appears).
   */
  label: string;
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  back?: PageHeaderBack;
  /** A status Badge, rendered first in the action group. */
  status?: ReactNode;
  primaryAction?: PageHeaderAction;
  secondaryActions?: readonly PageHeaderAction[];
  /** A full-width filter / search row under the title. */
  toolbar?: ReactNode;
  /** An extra class on `.page-head` (the QR page's print hook). */
  className?: string;
}

function ActionLink({
  action,
  variant,
}: {
  action: PageHeaderAction;
  variant: "primary" | "secondary";
}) {
  return (
    <PortalLink
      className={`bb-btn bb-btn--${variant}`}
      href={action.href}
      pendingLabel={action.label}
    >
      <Icon name={action.icon} />
      <span>{action.label}</span>
    </PortalLink>
  );
}

/**
 * Two header actions that open the same page are one action shown twice (a draft posting used
 * to offer "Finish and publish" AND "Edit posting", both → its edit page). Dev-only, stripped in
 * production — the same shape as the DS Button's tap-floor guard.
 */
function warnOnDuplicateDestinations(actions: readonly PageHeaderAction[]): void {
  if (process.env.NODE_ENV === "production") return;
  const seen = new Set<string>();
  for (const a of actions) {
    if (seen.has(a.href)) {
      console.error(
        `[bb-ds] PageHeader: two header actions open "${a.href}". One destination is one ` +
          "action — drop the duplicate.",
      );
    }
    seen.add(a.href);
  }
}

export function PageHeader({
  title,
  description,
  back,
  status,
  primaryAction,
  secondaryActions = [],
  toolbar,
  className,
}: PageHeaderProps) {
  const actions = primaryAction ? [primaryAction, ...secondaryActions] : [...secondaryActions];
  warnOnDuplicateDestinations(actions);
  const hasActions = status != null || actions.length > 0;
  return (
    <>
      {back ? (
        <p className="page-back">
          <PortalLink href={back.href} pendingLabel={back.label}>
            <Icon name={ACTION_ICON.back} />
            <span>{back.label}</span>
          </PortalLink>
        </p>
      ) : null}
      <div className={className ? `page-head ${className}` : "page-head"}>
        <div className="page-head__text">
          <h1 className="page-head__title">{title}</h1>
          {description ? <p className="page-head__sub">{description}</p> : null}
        </div>
        {hasActions ? (
          <div className="page-head__actions">
            {status}
            {primaryAction ? <ActionLink action={primaryAction} variant="primary" /> : null}
            {secondaryActions.map((a) => (
              <ActionLink key={`${a.href}|${a.label}`} action={a} variant="secondary" />
            ))}
          </div>
        ) : null}
        {toolbar != null ? <div className="page-head__toolbar">{toolbar}</div> : null}
      </div>
    </>
  );
}
