import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JobCardPreview } from "./job-card-preview";
import {
  cardFieldsFromPostingWire,
  toJobCardView,
  type CardFields,
} from "../lib/job-card-view";
import { toPayerJobPostingBody } from "../lib/payer-api";
import { jobPostingWireSchema, type CreatePostingInput } from "../lib/contracts";
import { JOB_ROLE_LABELS, TRADE_FORM_KINDS_ALL } from "../lib/job-roles";

/**
 * The preview is the payer-facing card. These pin that it NEVER renders a company name, a verified
 * seal, a boost/urgent claim, or a spots count (ADR-0024 addendum, #1823), that it carries the exact
 * ADR-0024 caption, and — the whole lineage — that a role picked in the form round-trips through the
 * create body, the wire echo and the ONE mapper to the label on the preview, for all 21 roles.
 */

const html = (fields: CardFields) => renderToStaticMarkup(<JobCardPreview fields={fields} />);

const FULL: CardFields = {
  role_title: "CNC Machinist",
  role_kind: "cnc_turner",
  city: "Pune",
  area: "Chakan",
  pay_min: 16000,
  pay_max: 26000,
  pay_type: "in_hand",
  min_experience_years: 2,
  max_experience_years: 5,
  shift: "day",
  needed_by: "immediate",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
};

describe("JobCardPreview — renders only from the card, never a trust/identity claim", () => {
  it("renders the role label, place, salary + pay-type pill, and duty chips", () => {
    const out = html(FULL);
    expect(out).toContain("CNC Turner");
    expect(out).toContain("MAHINE KI SALARY");
    expect(out).toContain("₹16,000–26,000/mah");
    expect(out).toContain("IN-HAND");
    expect(out).toContain("Duty &amp; Suvidhayein");
    expect(out).toContain("Day Shift");
  });

  it("carries EXACTLY the ADR-0024 caption — never 'what workers see'", () => {
    const out = html(FULL);
    expect(out).toContain("Card preview — built from what you entered");
    expect(out.toLowerCase()).not.toContain("what workers see");
  });

  it("NEVER renders a company name, verified seal, boost, urgent, or a spots count", () => {
    // Even if a company-shaped string were somehow present in the card, the preview reads no such
    // field — so it cannot appear. The card carries none of these keys by construction.
    const out = html(FULL).toLowerCase();
    expect(out).not.toContain("verified");
    expect(out).not.toContain("boost");
    expect(out).not.toContain("urgent");
    expect(out).not.toContain("spots");
    expect(out).not.toContain("pvt ltd");
  });

  it("hides a row whose value is absent (no empty salary box / no invented chips)", () => {
    const out = html({ ...FULL, pay_min: null, pay_max: null, shift: null, needed_by: null });
    expect(out).not.toContain("MAHINE KI SALARY");
    expect(out).not.toContain("Shift");
  });
});

/** The wire fields that ride along a backend echo, added to the create body to make a full row. */
function wireEcho(body: Record<string, unknown>) {
  return jobPostingWireSchema.parse({
    id: "aaaa1111-0000-4000-8000-000000000001",
    payer_id: "bbbb2222-0000-4000-8000-000000000002",
    created_by: "bbbb2222-0000-4000-8000-000000000002",
    vacancy_band: "1-5",
    status: "draft",
    skill_phrases: [],
    skill_ids: [],
    location_label: null,
    description: null,
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    closed_at: null,
    ...body,
  });
}

describe("the lineage — form → body → wire echo → view → preview, for all 21 roles", () => {
  it.each(TRADE_FORM_KINDS_ALL)("role_kind=%s round-trips to its label on the preview", (kind) => {
    const input: CreatePostingInput = {
      roleKind: kind,
      roleTitle: "Operator",
      vacancies: 3,
      city: "Pune",
      payMin: 16000,
      payMax: 26000,
      payType: "in_hand",
    };
    // form → body (create) → the backend echoes role_kind + the card fields back on the row.
    const body = toPayerJobPostingBody(input, "Acme Manufacturing");
    const wire = wireEcho(body);
    // wire echo → the ONE mapper → view.
    const card = cardFieldsFromPostingWire(wire);
    const view = toJobCardView(card);
    const label = JOB_ROLE_LABELS[kind].label;
    expect(view.roleLabel).toBe(label);
    // → preview contains the label (HTML-escaped — "Tool & Die Maker" renders "&amp;").
    expect(html(card)).toContain(label.replace(/&/g, "&amp;"));
  });
});
