import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PayerList } from "./payer-list";
import type { PayerListItem } from "../lib/entities";
import type { IdentityPosture } from "../lib/identity";

/**
 * The shared Companies/Agencies roster, under the three name postures.
 *
 * This component is shared by two routes, which is exactly why the posture is a PROP rather than
 * something it works out for itself: two sections deciding independently is two chances to
 * disagree about what a dash means. What is tested here is that it obeys the prop — including
 * refusing to render the column when told not to, which is the half a "does it show names" test
 * would never catch.
 */

const PAYER_ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";

const FACELESS: PayerListItem = {
  id: PAYER_ID,
  role: "employer",
  status: "active",
  previous_status: null,
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
};

const NAMED: PayerListItem = { ...FACELESS, org_name: "Acme Fabrication Pvt Ltd" };
const UNNAMED: PayerListItem = { ...FACELESS, org_name: null };

const render = (payers: PayerListItem[], posture: IdentityPosture) =>
  renderToStaticMarkup(
    <PayerList
      payers={payers}
      basePath="/companies"
      emptyMessage="No company accounts registered yet."
      posture={posture}
    />,
  );

/** The cells of the first body row, in order. */
function firstRowCells(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"));
  return body.slice(0, body.indexOf("</tr>")).split("<td").slice(1);
}

describe("the named posture", () => {
  it("renders an Organisation column, before the id", async () => {
    const out = render([NAMED], "named");
    expect(out).toContain('<th scope="col">Organisation</th>');
    expect(out).toContain("Acme Fabrication Pvt Ltd");
    expect(out.indexOf("Acme Fabrication")).toBeLessThan(out.indexOf(PAYER_ID));
  });

  it("keeps the id link, which is where the detail page and the spine are reached", () => {
    const out = render([NAMED], "named");
    expect(out).toContain(`href="/companies/${PAYER_ID}"`);
    expect(out).toContain(`title="${PAYER_ID}"`);
  });

  it("dashes an account that never recorded an organisation name", () => {
    const out = render([UNNAMED], "named");
    expect(out).toContain('title="No name on record for this account.">—</span>');
  });

  it("dashes a BLANK one rather than leaving the cell empty", () => {
    const out = render([{ ...FACELESS, org_name: "  " }], "named");
    expect(out).toContain('title="No name on record for this account.">—</span>');
  });

  it("keeps header and row widths in step", () => {
    // The off-by-one-column failure: every value after the missing cell shifts left, so
    // Registered reads as Status and the table still looks fine.
    const out = render([NAMED, UNNAMED], "named");
    const headers = (out.match(/<th scope="col">/g) ?? []).length;
    expect(headers).toBe(5);
    expect(firstRowCells(out)).toHaveLength(headers);
  });

  it("uses the basePath it was given, so agency links stay in the agency section", () => {
    const out = renderToStaticMarkup(
      <PayerList payers={[NAMED]} basePath="/agencies" emptyMessage="x" posture="named" />,
    );
    expect(out).toContain(`href="/agencies/${PAYER_ID}"`);
  });
});

describe("the faceless posture", () => {
  it("renders NO Organisation column and no dashes", () => {
    const out = render([FACELESS], "faceless");
    expect(out).not.toContain("Organisation");
    expect(out).not.toContain("No name on record");
  });

  it("is the pre-ruling table, unchanged", () => {
    const out = render([FACELESS], "faceless");
    const headers = (out.match(/<th scope="col">/g) ?? []).length;
    expect(headers).toBe(4);
    expect(firstRowCells(out)).toHaveLength(4);
    expect(out).toContain(`href="/companies/${PAYER_ID}"`);
  });

  it("refuses to render a name even if one somehow rode along on the row", () => {
    // The prop is the authority inside this component. A row that carried a name while the page
    // decided `faceless` is a contradiction the PAGE resolves (see `identityPosture`, which
    // would have said `named`); this component must not resolve it a second, different way.
    const out = render([NAMED], "faceless");
    expect(out).not.toContain("Acme Fabrication");
  });
});

describe("the capped posture renders exactly as the faceless one", () => {
  it("shows no column — the banner above the table is what explains it", () => {
    // The distinction between capped and faceless is a SENTENCE, not a table shape: in both
    // cases nothing was disclosed, so in both cases a Name column would be dashes that lie.
    const capped = render([FACELESS], "capped");
    const faceless = render([FACELESS], "faceless");
    expect(capped).toBe(faceless);
  });
});

describe("the empty state", () => {
  it("says there is nothing to search by, in every posture", () => {
    // The copy used to say accounts were "opaque on this screen by design", which is false the
    // moment a name column exists. What stayed true is that this screen has no SEARCH.
    for (const posture of ["named", "capped", "faceless"] as const) {
      const out = render([], posture);
      expect(out).toContain("No company accounts registered yet.");
      expect(out).toContain("nothing to search by on this screen");
      expect(out).not.toContain("opaque on this screen by design");
      expect(out).toContain('href="/jobs"');
    }
  });
});
