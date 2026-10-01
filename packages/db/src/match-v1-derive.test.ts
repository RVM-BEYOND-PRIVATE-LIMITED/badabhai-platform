/**
 * D4's worker-visible text gate (#1823 B3).
 *
 * D4 (`convert-seed-jobs.ts`) copies `jobs.title` into `job_postings.role_title`, and
 * `description` and each `benefits` / `requirements` chip verbatim, without going through an
 * API DTO. All four reach the worker card, so the copy runs the same three ADR-0024
 * heuristics every API write into `job_postings` runs on them. This file pins the pure check,
 * and pins that the runner calls it before its first insert and refuses `--apply` on a
 * failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { screenJobTextForConversion, type JobTextForConversion } from "./match-v1-derive";

const row = (
  id: string,
  title: string,
  description: string | null = null,
  chips: Pick<JobTextForConversion, "benefits" | "requirements"> = {
    benefits: null,
    requirements: null,
  },
): JobTextForConversion => ({ id, title, description, ...chips });

describe("screenJobTextForConversion", () => {
  it("passes a clean batch with no failures", () => {
    expect(
      screenJobTextForConversion([
        row("j1", "CNC Operator — Night Shift", "Fanuc CNC machine operate karna.", {
          benefits: ["PF + ESI", "Canteen"],
          requirements: ["Fanuc control", "ITI / Diploma"],
        }),
        row("j2", "Welder (MIG/TIG)"),
      ]),
    ).toEqual([]);
  });

  it.each([
    ["title", "contact_details", row("j1", "Fitter — call 98765 43210")],
    ["title", "company_name", row("j1", "Operator at Kalyani Pvt Ltd")],
    ["title", "link", row("j1", "Welder — see www.acme.in")],
    ["description", "contact_details", row("j1", "Welder", "Mail hr@acme.example")],
    ["description", "company_name", row("j1", "Welder", "Line at Acme Private Limited")],
    ["description", "link", row("j1", "Welder", "Form at https://acme.example/hr")],
    [
      "benefits[1]",
      "company_name",
      row("j1", "Welder", null, { benefits: ["PF + ESI", "Acme LLP canteen"], requirements: [] }),
    ],
    [
      "benefits[0]",
      "contact_details",
      row("j1", "Welder", null, { benefits: ["Call 98765 43210"], requirements: null }),
    ],
    [
      "requirements[2]",
      "link",
      row("j1", "Welder", null, {
        benefits: null,
        requirements: ["ITI", "2+ yrs", "Test at acme.in"],
      }),
    ],
  ] as const)("flags %s × %s", (field, screen, r) => {
    expect(screenJobTextForConversion([r])).toEqual([{ jobId: "j1", field, screens: [screen] }]);
  });

  it("names every screen a field trips, and every failing field of every row", () => {
    const failures = screenJobTextForConversion([
      row("j1", "Acme Pvt Ltd 9876543210 acme.in", "Acme Pvt Ltd", {
        benefits: ["Bonus", "www.acme.in"],
        requirements: ["Mehta & Co trained"],
      }),
      row("j2", "Fitter"),
      row("j3", "VMC Operator", "Visit acme.com"),
    ]);
    expect(failures).toEqual([
      { jobId: "j1", field: "title", screens: ["contact_details", "company_name", "link"] },
      { jobId: "j1", field: "description", screens: ["company_name"] },
      { jobId: "j1", field: "benefits[1]", screens: ["link"] },
      { jobId: "j1", field: "requirements[0]", screens: ["company_name"] },
      { jobId: "j3", field: "description", screens: ["link"] },
    ]);
  });

  it("never carries the offending text in its result (ids, fields and screen names only)", () => {
    const out = JSON.stringify(
      screenJobTextForConversion([
        row("j1", "Sharma Pvt Ltd 9876543210", null, {
          benefits: ["Verma LLP canteen"],
          requirements: null,
        }),
      ]),
    );
    expect(out).not.toContain("Sharma");
    expect(out).not.toContain("9876543210");
    expect(out).not.toContain("Verma");
  });

  it("every seed job D4 would convert passes the gate (seed-jobs.ts, read as text)", () => {
    // `seed-jobs.ts` runs `main()` on import, so its JOBS list is read from the source.
    const src = readFileSync(join(__dirname, "seed-jobs.ts"), "utf8");
    const titles = [...src.matchAll(/^\s+title: "([^"]+)",\r?$/gm)].map((m) => m[1]!);
    const descriptions = [...src.matchAll(/^\s+description:\s*"([^"]+)",\r?$/gm)].map((m) => m[1]!);
    const chips = (key: string): string[][] =>
      [...src.matchAll(new RegExp(String.raw`^\s+${key}: (\[.*\]),\r?$`, "gm"))].map(
        (m) => JSON.parse(m[1]!) as string[],
      );
    const benefits = chips("benefits");
    const requirements = chips("requirements");
    expect(titles.length).toBeGreaterThanOrEqual(15); // vacuity guard: one per alpha trade
    expect(descriptions.length).toBe(titles.length);
    expect(benefits.length).toBe(titles.length);
    expect(requirements.length).toBe(titles.length);
    const rows = titles.map((t, i) =>
      row(`seed-${i}`, t, descriptions[i]!, {
        benefits: benefits[i]!,
        requirements: requirements[i]!,
      }),
    );
    expect(screenJobTextForConversion(rows)).toEqual([]);
  });
});

describe("convert-seed-jobs.ts wires the gate before any write", () => {
  const src = readFileSync(join(__dirname, "convert-seed-jobs.ts"), "utf8");

  it("screens the PENDING rows before the first job_postings insert", () => {
    const gate = src.indexOf("screenJobTextForConversion(pendingJobs)");
    const firstInsert = src.indexOf(".insert(jobPostings)");
    expect(gate).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstInsert);
  });

  it("refuses --apply on any failure (a throw guarded by opts.apply inside the gate)", () => {
    const gateBlock = src.slice(
      src.indexOf("screenJobTextForConversion(pendingJobs)"),
      src.indexOf("const unbridgedTrades"),
    );
    expect(gateBlock).toMatch(/if \(opts\.apply\) \{\s*throw new Error\(/);
    expect(gateBlock).toContain("REFUSING --apply");
  });
});
