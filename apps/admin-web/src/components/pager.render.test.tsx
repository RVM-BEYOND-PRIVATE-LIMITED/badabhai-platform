import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Pager } from "./pager";

/**
 * The keyset Pager's one link re-renders the same page with a new cursor — the query-only
 * navigation the console's no-boundary rule is about — so it carries the navigation pending cue
 * (components/nav-pending.tsx, delta review of #2095).
 */
describe("Pager", () => {
  it("renders nothing on the last page", () => {
    expect(renderToStaticMarkup(<Pager basePath="/workers" params={{}} nextCursor={null} />)).toBe(
      "",
    );
  });

  it("its Next page link keeps the filters, carries the next cursor and the pending cue", () => {
    const out = renderToStaticMarkup(
      <Pager basePath="/workers" params={{ status: "active" }} nextCursor="c2" />,
    );
    expect(out).toContain('href="/workers?status=active&amp;cursor=c2"');
    expect(out).toMatch(
      /Next page<i class="ph-fill ph-caret-right" aria-hidden="true"><\/i><span class="nav-pending" aria-hidden="true"><\/span><\/a>/,
    );
  });
});
