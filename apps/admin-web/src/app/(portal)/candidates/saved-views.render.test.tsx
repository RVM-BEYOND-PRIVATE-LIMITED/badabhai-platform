import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A7 (#2577) — saved views' first paint: the naming field over the list, and the empty
 * shelf until the operator keeps one. The storage logic itself is pinned in
 * `candidate-search.test.ts` (`parseSavedViews`, `savedViewQuery`); what this pins is the
 * contract that matters in markup — a saved view is a plain link to a query the address
 * can already carry (filters, sort, page size), never a search term.
 */
const { CandidateSavedViews } = await import("./saved-views");

const render = (currentQuery: string) =>
  renderToStaticMarkup(<CandidateSavedViews currentQuery={currentQuery} />);

describe("saved views", () => {
  it("names the field with an example, and keeps nothing on the empty shelf", () => {
    const out = render("status=active");
    expect(out).toContain("Name this view");
    expect(out).toContain('placeholder="e.g. Welders in Pune"');
    expect(out).toContain("No saved views yet");
  });

  it("cannot save the bare list — there is nothing to name", () => {
    const out = render("");
    expect(out).toContain("disabled");
    expect(out).not.toContain("?q=");
  });

  it("never renders a view holding a term", () => {
    const out = render("status=active");
    expect(out).not.toMatch(/[?&]q=/);
  });
});
