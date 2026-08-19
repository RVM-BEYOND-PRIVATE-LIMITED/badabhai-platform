import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BucketList } from "./bucket-list";
import { CaveatList } from "./caveat-list";

/**
 * Two small honesty rules, asserted where they actually happen — in the markup.
 *
 *  1. `BucketList` — the API's `other` bucket is HIDDEN WHILE ZERO and LOUD WHEN NOT. Four of
 *     the five enums the dashboard densifies have no database CHECK behind them, and the
 *     headline totals are summed from these very buckets, so a non-zero `other` is data
 *     corruption asking to be looked at. Hiding it would conceal that; showing a permanent
 *     "other: 0" on five lists would train an operator to skip the row that matters.
 *
 *  2. `CaveatList` — a caveat is the server saying "this measurement does not exist for this
 *     data". Dropping one re-creates exactly the failure the field was added to prevent: a
 *     missing measurement rendering as a confident zero.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("BucketList — the `other` bucket", () => {
  const members = [
    { key: "pending", count: 5 },
    { key: "active", count: 36 },
    { key: "suspended", count: 0 },
  ];

  it("renders every enum member, zeros included", () => {
    // "0 suspended workers" and "we did not measure suspended workers" are the same JSON
    // unless the server densifies and the client renders the zeros.
    const out = html(<BucketList buckets={[...members, { key: "other", count: 0 }]} />);
    expect(out).toContain("suspended");
    expect(out).toContain(">0<");
  });

  it("HIDES `other` while it is zero", () => {
    const out = html(<BucketList buckets={[...members, { key: "other", count: 0 }]} />);
    expect(out).not.toContain("other");
  });

  it("SHOWS `other` the moment it is not, and says why it matters", () => {
    const out = html(<BucketList buckets={[...members, { key: "other", count: 3 }]} />);
    expect(out).toContain("other (not a known value)");
    expect(out).toContain("worth investigating");
    expect(out).toContain(">3<");
  });

  it("says so rather than rendering an empty list", () => {
    const out = html(<BucketList buckets={[]} />);
    expect(out).toContain("No breakdown was returned");
  });
});

describe("CaveatList — the honest-absence channel", () => {
  it("renders nothing at all when there is nothing to qualify", () => {
    expect(html(<CaveatList caveats={[]} headingId="x" />)).toBe("");
  });

  it("renders each caveat as a sentence, not as a code", () => {
    const out = html(
      <CaveatList
        caveats={["interview_kit_attribution_since_0079", "ai_cost_not_recorded"]}
        headingId="x"
      />,
    );
    expect(out).toContain("migration 0079");
    expect(out).toContain("never recorded");
    // The one that matters most: an absent per-session cost is not a measured ₹0.
    expect(out).toContain("cost nothing");
  });

  it("shows a code this build has never seen rather than dropping it", () => {
    const out = html(<CaveatList caveats={["an_absence_added_later"]} headingId="x" />);
    expect(out).toContain("an_absence_added_later");
  });
});
