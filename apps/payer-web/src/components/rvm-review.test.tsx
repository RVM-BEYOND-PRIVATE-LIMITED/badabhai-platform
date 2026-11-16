import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RvmReviewBadge, RvmReviewNotice } from "./rvm-review";

/**
 * #2746 — the placement team writes `reason`, so it must render as PLAIN TEXT: no markup, no
 * markdown, no auto-linking. React escapes the text; these pin that a hostile-looking string is
 * escaped and never becomes an element or a link.
 */
describe("RvmReviewNotice", () => {
  it("shows pending, approved and rejected", () => {
    expect(renderToStaticMarkup(<RvmReviewBadge review={{ state: "pending" }} />)).toContain(
      "RVM review: pending",
    );
    expect(renderToStaticMarkup(<RvmReviewBadge review={{ state: "approved" }} />)).toContain(
      "RVM review: approved",
    );
    expect(renderToStaticMarkup(<RvmReviewBadge review={{ state: "rejected" }} />)).toContain(
      "RVM review: rejected",
    );
  });

  it("renders the reason as escaped plain text — never HTML, markdown or a link", () => {
    const reason = '<img src=x onerror=alert(1)> **not bold** https://evil.test';
    const html = renderToStaticMarkup(
      <RvmReviewNotice review={{ state: "rejected", reason }} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<strong>not");
    expect(html).toContain("&lt;img");
    expect(html).toContain("**not bold**");
  });

  it("renders nothing without a review (a BadaBhai-only posting has none)", () => {
    expect(renderToStaticMarkup(<RvmReviewNotice review={null} />)).toBe("");
    expect(renderToStaticMarkup(<RvmReviewBadge review={null} />)).toBe("");
  });
});
