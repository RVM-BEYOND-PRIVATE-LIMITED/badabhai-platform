import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JobCardPreview } from "./job-card-preview";
import { PostingFacts } from "./posting-preview-rail";
import {
  JOB_CARD_CLAMPS,
  cardFieldsFromPostingWire,
  type CardFields,
  type JobCardDraft,
} from "../lib/job-card-view";
import { companyPostingFacts } from "../lib/posting-facts";
import { toPayerJobPostingBody } from "../lib/payer-api";
import { jobPostingWireSchema, type CreatePostingInput } from "../lib/contracts";
import { JOB_ROLE_LABELS, TRADE_FORM_KINDS_ALL } from "../lib/job-roles";

/**
 * The preview is the worker's swipe card. These pin that it NEVER renders a company name, a
 * verified seal, a boost/urgent claim, a spots/openings count or a role-kind row (none is on the
 * worker's card — ADR-0024 addendum, #1823, #1651), that it carries the exact ADR-0024 caption,
 * that every clamped slot is stamped with the phone's line limit, and — the lineage — that a role
 * picked in the form round-trips through the create body and the wire echo to the "Also in your
 * posting" list (not the card), for all 21 roles. Slot ORDER vs the worker card is pinned by the
 * cross-language fixture (job-card-contract.test.tsx).
 */

const html = (fields: CardFields, draft?: JobCardDraft) =>
  renderToStaticMarkup(<JobCardPreview fields={fields} draft={draft} />);

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

describe("JobCardPreview — the worker card's rows, never a trust/identity claim", () => {
  it("renders the place (area first), the salary + pay-type pill, and the duty chips", () => {
    const out = html(FULL);
    expect(out).toContain("Chakan, Pune");
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

  it("NEVER renders a company name, verified seal, boost, urgent, spots/openings or the role kind", () => {
    const out = html(FULL).toLowerCase();
    for (const banned of [
      "verified",
      "boost",
      "urgent",
      "spots",
      "pvt ltd",
      "openings",
      "vacanc",
    ]) {
      expect(out, banned).not.toContain(banned);
    }
    // role_kind "cnc_turner" → "CNC Turner" is NOT a card row (the title here is "CNC Machinist"):
    // the role reaches the card ONLY as its decorative illustration, never as text.
    expect(out).not.toContain("cnc turner");
    expect(out.replace('data-role-art="cnc_turner"', "")).not.toContain("cnc_turner");
    expect(out).not.toContain("ph-briefcase");
  });

  it("heads the card with the picked role's illustration — decorative, before the title", () => {
    const out = html(FULL);
    expect(out).toMatch(
      /<svg class="bb-role-art bb-role-art--animated jcp__art"[^>]*data-role-art="cnc_turner"[^>]*aria-hidden="true"/,
    );
    expect(out.indexOf("data-role-art")).toBeLessThan(out.indexOf('data-slot="title"'));
  });

  it.each(TRADE_FORM_KINDS_ALL)(
    "role_kind=%s draws that role's art (the picker changes the picture)",
    (kind) => {
      expect(html({ ...FULL, role_kind: kind })).toContain(`data-role-art="${kind}"`);
    },
  );

  it.each([null, "not_a_role", ""])("role_kind=%s draws the generic art, never a blank", (kind) => {
    expect(html({ ...FULL, role_kind: kind })).toContain('data-role-art="generic"');
  });

  it("hides a row whose value is absent (no empty salary box / no invented chips)", () => {
    const out = html({ ...FULL, pay_min: null, pay_max: null, shift: null, needed_by: null });
    expect(out).not.toContain("MAHINE KI SALARY");
    expect(out).not.toContain("Shift");
  });

  it("stamps every clamped slot with the PHONE's line limit (and keeps the full text in title)", () => {
    const long = "Senior CNC Turner / VMC Setter-Operator cum In-process Quality Inspector";
    const out = html({ ...FULL, role_title: long });
    expect(out).toContain(
      `data-slot="title" data-clamp="${JOB_CARD_CLAMPS.title}" title="${long}"`,
    );
    expect(out).toContain(
      `data-slot="place" data-clamp="${JOB_CARD_CLAMPS.place}" title="Chakan, Pune"`,
    );
    expect(out).toContain(`data-slot="pay_label" data-clamp="${JOB_CARD_CLAMPS.pay_label}"`);
    expect(out).toContain(`data-slot="pay_band" data-clamp="${JOB_CARD_CLAMPS.pay_band}"`);
    expect(out).toContain(`data-clamp="${JOB_CARD_CLAMPS.chip}" title="Fanuc control"`);
    expect(JOB_CARD_CLAMPS).toEqual({ title: 2, place: 1, pay_label: 1, pay_band: 1, chip: 2 });
  });

  it("draws the reference phone's fold: a clip-line marker and a show-all control (hidden until counted)", () => {
    const out = html(FULL);
    expect(out).toContain('data-fold-line=""');
    expect(out).toContain('<details class="jcp__fold" data-fold="">');
    expect(out).not.toContain("data-cut"); // only the browser's count reveals it
    expect(out).toContain("cut off on a typical phone — show all");
  });

  it("an empty title keeps the worker's empty text; the placeholder lives in CSS (data-placeholder)", () => {
    const out = html({ ...FULL, role_title: null });
    expect(out).toContain(
      'class="jcp__title jcp__title--empty" data-slot="title" data-clamp="2" data-placeholder="Your role title"></h3>',
    );
  });

  it("the place row is ALWAYS drawn, like the phone's: an empty pin row with a CSS-only placeholder", () => {
    const none = html({ ...FULL, city: null, area: null });
    expect(none).toContain("ph-map-pin");
    expect(none).toContain(
      'class="jcp__place-text jcp__place-text--empty" data-slot="place" data-clamp="1" data-placeholder="Area, City"></span>',
    );
    // No city: the phone's own "Area, " — drawn, not hidden and not tidied.
    expect(html({ ...FULL, city: "" })).toContain('title="Chakan, ">Chakan, </span>');
  });

  it("the fold summary's words are one accessible name ('17 chips cut off…', never 'chipscut')", () => {
    const out = html(FULL);
    // The space is its own text node BETWEEN the count and the words, outside both spans.
    expect(out).toContain(
      '<span data-fold-count=""></span> <span class="jcp__fold-closed">cut off on a typical phone — show all</span>',
    );
  });

  it("a live form's issues replace their rows; a pending chip is dashed and announced", () => {
    const out = html(
      { ...FULL, requirements: ["Fanuc control", "MIG welding"] },
      {
        payIssue: "Pay needs a whole number",
        experienceIssue: "Experience needs whole years",
        pendingRequirement: "MIG welding",
      },
    );
    expect(out).toContain('data-slot="pay_issue">Pay needs a whole number<');
    expect(out).not.toContain('data-slot="pay_band"');
    expect(out).toContain("jcp__chip--invalid");
    expect(out).toContain("Experience needs whole years");
    expect(out).not.toContain("2–5 yrs experience");
    expect(out).toContain("jcp__chip--pending");
    expect(out).toContain("typed, not added yet");
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

describe("the lineage — form → body → wire echo → 'Also in your posting', for all 21 roles", () => {
  it.each(TRADE_FORM_KINDS_ALL)("role_kind=%s is listed beside the card, never on it", (kind) => {
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
    const card = cardFieldsFromPostingWire(wireEcho(body));
    const label = JOB_ROLE_LABELS[kind].label;
    const escaped = label.replace(/&/g, "&amp;"); // "Tool & Die Maker" renders "&amp;"
    // The card itself carries no role row…
    expect(html(card)).not.toContain(escaped);
    // …the "Also in your posting" list does.
    const facts = renderToStaticMarkup(
      <PostingFacts
        facts={companyPostingFacts({
          roleKind: card.role_kind,
          openings: "3",
          locationNote: "",
          matchSkills: null,
          description: "",
        })}
      />,
    );
    expect(facts).toContain(escaped);
    expect(facts).toContain("not on the worker&#x27;s card");
  });
});
