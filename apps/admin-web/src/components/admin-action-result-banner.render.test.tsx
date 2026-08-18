import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminActionResultBanner } from "./admin-action-result-banner";

/**
 * What `AdminActionResultBanner` renders — the load-bearing rule from Step 3 of the admin
 * write-action plan: `changed: false` is a SUCCESSFUL no-op, and must render with the same
 * neutral/success family as `changed: true`, never the danger tone reserved for `ok: false`.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("AdminActionResultBanner", () => {
  it("changed: true renders the success tone", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: true, message: "Payer suspended." }}
        timelineHref="/companies/p-1/timeline"
      />,
    );
    expect(out).toContain("alert--success");
    expect(out).toContain("Payer suspended.");
    expect(out).toContain("/companies/p-1/timeline");
  });

  it("changed: false is STILL success-family, never the danger tone", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: false, message: "Already suspended — no change." }}
        timelineHref="/companies/p-1/timeline"
      />,
    );
    expect(out).toContain("alert--info");
    expect(out).not.toContain("alert--danger");
    expect(out).toContain("Already suspended — no change.");
    expect(out).toContain("No change");
  });

  it("ok: false renders the danger tone and the error text, with no timeline link", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: false, error: "Cannot demote the last active super_admin" }}
        timelineHref="/events?subjectType=admin_session"
      />,
    );
    expect(out).toContain("alert--danger");
    expect(out).toContain("Cannot demote the last active super_admin");
    expect(out).not.toContain("alert__actions");
  });

  it("always links to the timeline href it was given on success", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: true, message: "Worker flagged." }}
        timelineHref="/workers/w-9/timeline"
      />,
    );
    expect(out).toContain('href="/workers/w-9/timeline"');
  });
});
