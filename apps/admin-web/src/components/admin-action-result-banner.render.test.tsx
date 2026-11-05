import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALL_ADMIN_ACTIONS_LINK,
  AdminActionResultBanner,
  successToast,
  timelineLink,
} from "./admin-action-result-banner";

/**
 * #2689 — an action's SUCCESS is a quiet toast (it renders no inline banner), while a FAILURE
 * stays in place as a polite inline notice with Retry. The old success/danger banner is gone,
 * and nothing here uses assertive `role="alert"`.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const TIMELINE = { href: "/companies/p-1/timeline", label: "View event timeline" };

describe("AdminActionResultBanner — success is a toast", () => {
  it("renders no inline banner on success; the toast carries the result", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: true, message: "Account suspended." }}
        eventsLink={TIMELINE}
      />,
    );
    expect(out).toBe("");
  });

  it("changed: false is still a success-family toast, never the danger tone", () => {
    expect(successToast({ ok: true, changed: false, message: "Already suspended." }, TIMELINE)).toEqual({
      message: "Already suspended.",
      tone: "info",
      action: { label: "View event timeline", href: "/companies/p-1/timeline" },
    });
  });

  it("changed: true is a success toast with the link under the name it was given", () => {
    expect(successToast({ ok: true, changed: true, message: "Worker flagged." }, TIMELINE)).toEqual({
      message: "Worker flagged.",
      tone: "success",
      action: { label: "View event timeline", href: "/companies/p-1/timeline" },
    });
  });

  it("an admin-directory action is never called a timeline", () => {
    const toast = successToast({ ok: true, changed: true, message: "Role changed." }, ALL_ADMIN_ACTIONS_LINK);
    expect(toast.action?.label).toBe("View all admin actions");
    expect(toast.action?.label).not.toContain("timeline");
  });

  it("a reader who cannot read events gets no action at all", () => {
    expect(successToast({ ok: true, changed: true, message: "Done." }, null).action).toBeUndefined();
  });

  it("timelineLink builds the one-record link, or none", () => {
    expect(timelineLink("/candidates/w-9/timeline")).toEqual({
      href: "/candidates/w-9/timeline",
      label: "View event timeline",
    });
    expect(timelineLink(null)).toBeNull();
  });
});

describe("AdminActionResultBanner — failure is an inline notice with Retry", () => {
  it("renders a POLITE inline notice, never an assertive alert or a success banner", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: false, error: "The record changed since you loaded it." }}
        eventsLink={TIMELINE}
      />,
    );
    expect(out).toContain('role="status"');
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain("alert--success");
    expect(out).toContain("Action failed");
    expect(out).toContain("The record changed since you loaded it.");
    expect(out).toContain(">Retry<");
  });

  it("calls the retry callback when the caller supplied one", () => {
    let retried = 0;
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: false, error: "Try again." }}
        eventsLink={null}
        onRetry={() => {
          retried += 1;
        }}
      />,
    );
    expect(out).toContain(">Retry<");
    expect(retried).toBe(0);
  });

  it("offers no event link on a failure", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: false, error: "Refused." }}
        eventsLink={TIMELINE}
      />,
    );
    expect(out).not.toContain("/companies/p-1/timeline");
  });
});
