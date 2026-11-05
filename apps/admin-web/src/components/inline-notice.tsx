import type { ReactNode } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export interface InlineNoticeAction {
  label: string;
  onClick: () => void;
}

/**
 * An in-place notice for a recoverable failure (#2689 rule 2/3).
 *
 * It is a POLITE live region, not an assertive one: the operator is still on the same screen,
 * keeps everything they typed, and the action that failed is right beside the Retry. `role="alert"`
 * is reserved for errors that stop the task outright (the portal error boundary).
 */
export function InlineNotice({
  tone = "danger",
  title,
  children,
  action,
  id,
}: {
  tone?: "info" | "warning" | "danger";
  title?: string;
  children: ReactNode;
  action?: InlineNoticeAction;
  id?: string;
}) {
  return (
    <div className={`alert alert--${tone} notice notice--inline`} role="status" id={id}>
      <div className="alert__text">
        {title ? <p className="alert__title">{title}</p> : null}
        <div className="alert__body">{children}</div>
      </div>
      {action ? (
        <div className="alert__actions">
          <button className="btn btn--ghost btn--sm" type="button" onClick={action.onClick}>
            <Icon name={ACTION_ICON.retry} />
            <span>{action.label}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
