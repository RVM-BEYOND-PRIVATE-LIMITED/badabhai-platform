import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminActionResultBanner } from "./admin-action-result-banner";

/**
 * What `AdminActionResultBanner` renders — the load-bearing rule from Step 3 of the admin
 * write-action plan: `changed: false` is a SUCCESSFUL no-op, and must render with the same
 * neutral/success family as `changed: true`, never the danger tone reserved for `ok: false`.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const TIMELINE = { href: "/companies/p-1/timeline", label: "View event timeline" };

describe("AdminActionResultBanner", () => {
  it("changed: true renders the success tone", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: true, message: "Account suspended." }}
        eventsLink={TIMELINE}
      />,
    );
    expect(out).toContain("alert--success");
    expect(out).toContain("Account suspended.");
    expect(out).toContain("/companies/p-1/timeline");
  });

  it("changed: false is STILL success-family, never the danger tone", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: false, message: "Already suspended — no change." }}
        eventsLink={TIMELINE}
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
        eventsLink={{ href: "/events?subjectType=admin_session", label: "View events" }}
      />,
    );
    expect(out).toContain("alert--danger");
    expect(out).toContain("Cannot demote the last active super_admin");
    expect(out).not.toContain("alert__actions");
  });

  it("links to the href it was given on success, under the name it was given", () => {
    const one = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: true, message: "Worker flagged." }}
        eventsLink={{ href: "/workers/w-9/timeline", label: "View event timeline" }}
      />,
    );
    expect(one).toContain('href="/workers/w-9/timeline"');
    expect(one).toContain(">View event timeline<");

    // An admin-directory action has no per-admin timeline: it is the global log, so it is
    // never called a timeline.
    const all = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: true, message: "Role changed." }}
        eventsLink={{ href: "/events?subjectType=admin_session", label: "View events" }}
      />,
    );
    expect(all).toContain(">View events<");
    expect(all).not.toContain("timeline");
  });

  it("offers no link at all to a reader who cannot read events (eventsLink null)", () => {
    const out = html(
      <AdminActionResultBanner
        outcome={{ ok: true, changed: true, message: "Worker flagged." }}
        eventsLink={null}
      />,
    );
    expect(out).toContain("alert--success");
    expect(out).not.toContain("alert__actions");
    expect(out).not.toContain("<a ");
  });
});
