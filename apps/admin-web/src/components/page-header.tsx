import Link from "next/link";
import type { ReactNode } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * Where a page's back link goes: its real parent, and that parent's name.
 *
 * The label is how the parent names itself. For a list page that is its h1 and nav label
 * ("Workers", "Postings"). For an entity detail page it is the entity and its short id
 * ("Worker 1a2b3c4d"), because a child route does not fetch the parent's display name just to
 * label a link. Doing so would spend the name budget and write an audit row on every page view.
 */
export interface PageBack {
  href: string;
  label: string;
}

/** The title block: everything in a header except its controls. */
export interface PageHeaderContent {
  /** Child and detail pages only. A top-level page (one the sidebar opens) has no back link. */
  back?: PageBack;
  title: ReactNode;
  /** An opaque id as the title, set in the id face. A name never takes it. */
  titleMono?: boolean;
  /** One sentence. Mechanics belong in a notice or a panel's sub-line, not here. */
  description?: ReactNode;
}

export interface PageHeaderProps extends PageHeaderContent {
  /** The page's own state-changing action. Rendered first. */
  primaryAction?: ReactNode;
  /** Related views and other page-relevant links, after the primary action. */
  secondaryActions?: ReactNode;
  /** The filters or search row for the page's main list, rendered directly below the header. */
  filters?: ReactNode;
}

/**
 * The ONE page header in the admin portal.
 *
 * Every page renders the same structure: [back link, detail pages only] · title · one-sentence
 * description · the actions (primary first, then secondary) · the filter row directly below.
 * That is the same order payer-web uses. The three detail-page client headers pass their
 * buttons into this component rather than each carrying its own copy of the markup.
 *
 * Server-safe: no hooks, no handlers. A client header can render it too.
 */
export function PageHeader({
  back,
  title,
  titleMono,
  description,
  primaryAction,
  secondaryActions,
  filters,
}: PageHeaderProps) {
  const hasActions = Boolean(primaryAction || secondaryActions);
  return (
    <>
      <header className="page__head">
        <div>
          {back ? <BackLink {...back} /> : null}
          <h1 className={titleMono ? "page__title mono" : "page__title"}>{title}</h1>
          {description ? <p className="page__sub">{description}</p> : null}
        </div>
        {hasActions ? (
          <div className="page__actions">
            {primaryAction}
            {secondaryActions}
          </div>
        ) : null}
      </header>
      {filters ?? null}
    </>
  );
}

/** A detail page's way back to its parent: the `arrow-left` glyph and the parent's name. */
export function BackLink({ href, label }: PageBack) {
  return (
    <p className="page__back">
      <Link className="backlink" href={href}>
        <Icon name={ACTION_ICON.back} />
        <span>{label}</span>
      </Link>
    </p>
  );
}
