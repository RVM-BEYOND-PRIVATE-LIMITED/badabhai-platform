import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VolumePanel } from "./volume-panel";
import { volumeSummarySchema, type VolumeSummary } from "../lib/dashboard";
import { SECTION, childTags } from "../../test/panel-markup";

/**
 * The volume panel speaks the console's names (owner ruling 2026-10-01), not the stored ones:
 *  - a payer role is a Company or an Agency — the buckets read `employer` / `agent`, with a
 *    legend translating them underneath (sweep AW-12);
 *  - a worker's apply or skip on a Posting is a POSTING decision, not a "job decision" (AW-13).
 * Parsed through the REAL schema, so the fixture is a payload the API can actually send.
 */
const VOLUME: VolumeSummary = volumeSummarySchema.parse({
  workers: { total: 41, by_status: [{ key: "active", count: 41 }], pending_deletion: 0 },
  worker_profiles: { workers_with_profile: 12, by_status: [{ key: "confirmed", count: 12 }] },
  job_postings: { total: 9, by_status: [{ key: "open", count: 9 }] },
  applications: { total: 30, applied: 21 },
  payers: {
    total: 7,
    by_role: [
      { key: "employer", count: 5 },
      { key: "agent", count: 2 },
      { key: "other", count: 0 },
    ],
    by_status: [{ key: "active", count: 7 }],
  },
  unlocks: { issued: 3 },
  resumes: { total: 4 },
});

const html = () => renderToStaticMarkup(<VolumePanel volume={VOLUME} />);
const label = (text: string) => `<span class="funnel__label">${text}</span>`;

describe("VolumePanel — customer types", () => {
  it("names the role buckets Company and Agency", () => {
    const out = html();
    expect(out).toContain(label("Company"));
    expect(out).toContain(label("Agency"));
    expect(out).toContain("Customers by type");
  });

  it("shows neither stored role, and no legend translating them", () => {
    const out = html();
    expect(out).not.toContain(label("employer"));
    expect(out).not.toContain(label("agent"));
    expect(out).not.toContain("employer = Company");
    expect(out).not.toContain("account type");
  });

  it("still renders a stored role this build has no name for, rather than dropping it", () => {
    const drifted = {
      ...VOLUME,
      payers: { ...VOLUME.payers, by_role: [{ key: "reseller", count: 1 }] },
    };
    const out = renderToStaticMarkup(<VolumePanel volume={drifted} />);
    expect(out).toContain(label("reseller"));
  });
});

describe("VolumePanel — posting decisions", () => {
  it("counts applies + skips as posting decisions, never job decisions", () => {
    const out = html();
    expect(out).toContain("Posting decisions (applies + skips)");
    expect(out).not.toMatch(/job decisions?/i);
  });
});

describe("volume grouped Supply / Demand / Engagement (#2572)", () => {
  /** The text between one group heading and the next. */
  const group = (out: string, title: string) => {
    const start = out.indexOf(`>${title}</h3>`);
    const next = out.indexOf('class="volume-group__title"', start + 1);
    return out.slice(start, next === -1 ? undefined : next);
  };

  it("renders the three named groups in order", () => {
    const out = renderToStaticMarkup(<VolumePanel volume={VOLUME} />);
    const order = ["Supply", "Demand", "Engagement"].map((t) => out.indexOf(`>${t}</h3>`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("puts each tile in its group", () => {
    const out = renderToStaticMarkup(<VolumePanel volume={VOLUME} />);
    expect(group(out, "Supply")).toContain("Workers with a profile");
    expect(group(out, "Supply")).toContain("Deletions scheduled");
    expect(group(out, "Demand")).toContain("Customers");
    expect(group(out, "Demand")).toContain("Contact unlocks");
    expect(group(out, "Engagement")).toContain("Applies");
    expect(group(out, "Engagement")).not.toContain("Contact unlocks");
  });
});

describe("each block is a PanelSection (A1, #2571)", () => {
  const ROOT = '<section class="panel" aria-labelledby="volume-heading">';

  it("stacks the groups and the two breakdown rows as sibling sections under the head", () => {
    // Siblings, so `.panel__section + .panel__section` sets 24px and a hairline between them.
    expect(childTags(html(), ROOT)).toEqual([
      '<div class="panel__head">',
      SECTION,
      SECTION,
      SECTION,
    ]);
  });

  it("lays each breakdown row's columns out as sections of its .cols grid", () => {
    const out = html();
    expect(childTags(out, '<div class="cols">')).toEqual([SECTION, SECTION]);
    // The customer column stacks two sections of its own: by type, then by status.
    expect(childTags(out, '<div class="cols">', 1)).toEqual([SECTION, "<div>"]);
  });

  it("titles every breakdown with a section heading that its list still names itself by", () => {
    const out = html();
    for (const [id, title] of [
      ["volume-workers", "Workers by status"],
      ["volume-profiles", "Profiles by status"],
      ["volume-postings", "Postings by status"],
      ["volume-payers-role", "Customers by type"],
      ["volume-payers-status", "Customers by status"],
    ] as const) {
      expect(out).toContain(`<h3 class="panel__section-title" id="${id}">${title}</h3>`);
      expect(out).toContain(`<ul class="funnel" aria-labelledby="${id}">`);
    }
    expect(out).not.toContain('<h3 class="panel__title"');
  });
});
