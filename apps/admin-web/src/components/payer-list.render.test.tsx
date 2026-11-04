import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { columnHeaders } from "../../test/grid-markup";
import { PayerList } from "./payer-list";
import type { PayerListItem } from "../lib/entities";
import type { IdentityPosture } from "../lib/identity";
import type { CustomerKindFilter } from "../lib/customer";

/**
 * The customers roster (Directory › Companies — Companies and Agencies in one list since A6,
 * #2576), under the three name postures and the page's Kind filter.
 *
 * The posture is a PROP rather than something it works out for itself: the page decides it from
 * the rows and the capability, once, so the list cannot disagree with it about what a dash means.
 * What is tested here is that it obeys the prop — including refusing to render the column when
 * told not to, which is the half a "does it show names" test would never catch.
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
const AGENCY: PayerListItem = { ...NAMED, id: "a9e7c1d2-0000-4000-8000-00000000a9e7", role: "agent" };

/** The Companies view (`?kind=company`) unless a test asks for another — "all" is no Kind filter. */
const render = (
  payers: PayerListItem[],
  posture: IdentityPosture,
  view: CustomerKindFilter | "all" = "company",
) =>
  renderToStaticMarkup(
    <PayerList
      payers={payers}
      basePath="/companies"
      emptyMessage="No companies registered yet."
      posture={posture}
      kind={view === "all" ? undefined : view}
    />,
  );

/**
 * The DATA cells of the first body row, in order — the row link's end chevron (an aria-hidden
 * cell with no header of its own, A4) is decoration, not a column.
 */
function firstRowCells(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"));
  return body
    .slice(0, body.indexOf("</tr>"))
    .split("<td")
    .slice(1)
    .filter((cell) => !cell.startsWith(' class="grid__end"'));
}

describe("the named posture", () => {
  it("renders an Organisation column, before the id", async () => {
    const out = render([NAMED], "named");
    expect(columnHeaders(out)[0]).toBe("Organisation");
    expect(out).toContain("Acme Fabrication Pvt Ltd");
    expect(out.indexOf("Acme Fabrication")).toBeLessThan(out.indexOf(`title="${PAYER_ID}"`));
  });

  it("heads the id column Customer — never Account (owner ruling 2026-10-01; sweep AW-12)", () => {
    const out = render([NAMED], "named");
    expect(columnHeaders(out)).toContain("Customer");
    expect(out).toContain('<caption class="sr-only">Customers, newest first</caption>');
    expect(columnHeaders(out)).not.toContain("Account");
  });

  it("links the row through the organisation's NAME, and keeps the id beside it", () => {
    // Since A4 the row's one link is its name, stretched over the row — the detail page and the
    // spine are reached from anywhere on it. The id stays a cell of its own, its full value in
    // its title.
    const out = render([NAMED], "named");
    expect(out).toMatch(
      new RegExp(`<a class="grid__link" href="/companies/${PAYER_ID}"><span class="grid__link-text" title="Acme Fabrication Pvt Ltd">`),
    );
    expect(out).toContain(`<span class="mono" title="${PAYER_ID}">`);
  });

  it("dashes an account whose organisation name did not come back", () => {
    // The COPY is payer-specific, and that is the point. `payers.org_name_enc` is `NOT NULL` and
    // is always written at signup, so a null here cannot mean "never recorded" — it can only be
    // a decrypt failure (retired kid, rotated key, corruption; the server degrades all three to
    // null rather than 500ing an operations list). Telling an operator that a paying customer
    // never supplied a name, on a screen with a suspend button, would be a lie shaped like data.
    const out = render([UNNAMED], "named");
    expect(out).toContain('title="No readable name is stored for this customer.">—</span>');
    expect(out).not.toContain("No name on record");
  });

  it("dashes a BLANK one rather than leaving the cell empty", () => {
    const out = render([{ ...FACELESS, org_name: "  " }], "named");
    expect(out).toContain('title="No readable name is stored for this customer.">—</span>');
  });

  it("keeps header and row widths in step", () => {
    // The off-by-one-column failure: every value after the missing cell shifts left, so
    // Registered reads as Status and the table still looks fine.
    const out = render([NAMED, UNNAMED], "named");
    const headers = columnHeaders(out).length;
    expect(headers).toBe(5);
    expect(firstRowCells(out)).toHaveLength(headers);
  });

  it("opens an agency in the one customers section too — never the retired /agencies", () => {
    // Since A6 a Company and an Agency share Directory › Companies; /agencies only redirects.
    const out = render([AGENCY], "named", "agency");
    expect(out).toContain(`href="/companies/${AGENCY.id}"`);
    expect(out).not.toContain("/agencies");
  });
});

/**
 * THE KIND COLUMN (A6 follow-up, after A4's grid). The All view mixes Companies and Agencies, so each
 * row names its kind — the stored role in the console's words; a Kind-filtered view has one kind,
 * which the page's header says, and no column repeating it on every row.
 */
describe("the Kind column", () => {
  it("is drawn in the All view, after the id, naming each row's kind", () => {
    const out = render([NAMED, AGENCY], "named", "all");
    const headers = columnHeaders(out);
    expect(headers).toEqual(["Organisation", "Customer", "Kind", "Status", "Registered", "Last updated"]);
    expect(firstRowCells(out)).toHaveLength(headers.length);
    const kindCell = (html: string) => firstRowCells(html)[2];
    expect(kindCell(out)).toContain(">Company</td>");
    expect(kindCell(render([AGENCY, NAMED], "named", "all"))).toContain(">Agency</td>");
  });

  it("names the stored role, never the role's raw value", () => {
    const out = render([AGENCY], "faceless", "all");
    expect(columnHeaders(out)).toEqual(["Customer", "Kind", "Status", "Registered", "Last updated"]);
    expect(out).toContain(">Agency</td>");
    expect(out).not.toContain(">agent<");
  });

  it.each(["company", "agency"] as const)("is not drawn in the %s view", (kind) => {
    expect(columnHeaders(render([NAMED], "named", kind))).not.toContain("Kind");
    expect(columnHeaders(render([FACELESS], "faceless", kind))).not.toContain("Kind");
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
    const headers = columnHeaders(out).length;
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
      expect(out).toContain("No companies registered yet.");
      expect(out).toContain("nothing to search by on this screen");
      expect(out).not.toContain("opaque on this screen by design");
      expect(out).toContain('href="/jobs"');
    }
  });
});
