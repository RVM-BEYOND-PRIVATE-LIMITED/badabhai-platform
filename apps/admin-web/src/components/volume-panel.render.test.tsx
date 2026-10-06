import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VolumePanel } from "./volume-panel";
import { volumeSummarySchema, type VolumeSummary } from "../lib/dashboard";

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
