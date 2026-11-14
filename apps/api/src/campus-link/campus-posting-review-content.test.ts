import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { POSTING_REVIEW_CONTENT_COLUMNS, jobPostings } from "@badabhai/db";
import {
  CLEARABLE_POSTING_FIELDS,
  PayerCreateJobPostingWithAudienceSchema,
  PayerUpdateJobPostingSchema,
} from "../job-postings/job-postings.dto";
import { CampusPostingSchema } from "./campus-link.contract";

/**
 * #2746 PR 5 — WHAT A REVIEW DECISION COVERS IS WHAT CAMPUS SHOWS. A decision counts only for the
 * content it saw, through `postingReviewContentHash` (`@badabhai/db` `job-review.ts`). If Campus's
 * posting projection (`CampusPostingSchema`, the `GET job-postings` feed) showed a field the hash
 * does not read, a company could edit that field after approval and students would see the edit
 * still "approved". This suite ties the three lists together, in both directions:
 *
 *   1. every field of `CampusPostingSchema` is declared below, as the `job_postings` column it is
 *      read from or as not company content (a new field fails until it is classified);
 *   2. the content columns are EXACTLY the hash's columns (`POSTING_REVIEW_CONTENT_COLUMNS`);
 *   3. every key a company may write (`PayerCreateJobPostingWithAudienceSchema`,
 *      `PayerUpdateJobPostingSchema`) is either hashed or declared as not shown to Campus.
 *
 * THE BINDING FOR THE FEED. #2752 Part E builds `GET job-postings`; it must read each field from
 * the column named here. `company.name` in particular is `job_postings.org_label` — the label the
 * company typed on the posting — never `payers.org_name_enc` or a `payer_orgs` name, which the
 * hash does not read and the company can change without touching the posting.
 */

type Source =
  | { column: string }
  /** Not company content: an id, lifecycle, BadaBhai's own state, or reference data. */
  | { notContent: string };

const CAMPUS_POSTING_SOURCES: Record<string, Source> = {
  id: { notContent: "the posting's id" },
  "company.id": { notContent: "the owning company's id (job_postings.payer_id); not editable" },
  "company.name": { column: "org_label" },
  title: { column: "role_title" },
  description: { column: "description" },
  "location.label": { column: "location_label" },
  "location.city": { column: "city" },
  "location.state": { column: "state" },
  "location.area": { column: "area" },
  "pay.min": { column: "pay_min" },
  "pay.max": { column: "pay_max" },
  "pay.type": { column: "pay_type" },
  vacancy_band: { column: "vacancy_band" },
  shift: { column: "shift" },
  "experience_years.min": { column: "min_experience_years" },
  "experience_years.max": { column: "max_experience_years" },
  requirements: { column: "requirements" },
  benefits: { column: "benefits" },
  status: { notContent: "lifecycle (open / closed), not content: a close needs no re-review" },
  audience: { column: "audience" },
  branch_ids: { column: "rvm_branch_ids" },
  // The ids are posting content; each name is the option's label in `rvm_targeting_options`,
  // reference data Campus itself sets (`PUT targeting-options`), never the company's text.
  courses: { column: "rvm_course_ids" },
  review_state: { notContent: "the review itself" },
  changed_at: { notContent: "a timestamp" },
  content_hash: { notContent: "the hash itself" },
};

/**
 * Company-writable keys that Campus does not show. Each is checked against the projection above:
 * none of them may be a column a Campus field reads.
 */
const COMPANY_KEYS_NOT_SHOWN_TO_CAMPUS: Record<string, string> = {
  skills: "descriptive skill phrases (skill_phrases / skill_ids), not in the projection",
  status: "lifecycle (publish)",
  needed_by: "not in the projection",
  role_kind: "classification art, not in the projection",
  trade_level: "trade form, not in the projection",
  trade_answers: "trade form, not in the projection",
  match_skill_ids: "match inputs, not in the projection",
  unticked_related_ids: "match inputs, not in the projection",
  clear: "names fields to unset; each name is classified below",
};

/** A company key and the column it writes, where the names differ. */
const COLUMN_OF_COMPANY_KEY: Record<string, string> = { vacancies: "vacancy_band" };

/** Every leaf field of a zod object, as dotted paths (arrays and scalars are leaves). */
function leafPaths(schema: z.ZodType, prefix = ""): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(([key, child]) =>
      leafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return [prefix];
}

const columnSources = Object.entries(CAMPUS_POSTING_SOURCES).flatMap(([field, source]) =>
  "column" in source ? [[field, source.column] as const] : [],
);
const shownColumns = new Set(columnSources.map(([, column]) => column));
const hashed = new Set(POSTING_REVIEW_CONTENT_COLUMNS);

describe("the review hash covers every company-editable column Campus shows (#2746 PR 5)", () => {
  it("classifies every field of CampusPostingSchema, and nothing else", () => {
    expect(leafPaths(CampusPostingSchema).sort()).toEqual(
      Object.keys(CAMPUS_POSTING_SOURCES).sort(),
    );
  });

  it("every column a Campus field reads is in the hash, and the hash reads nothing else", () => {
    for (const [field, column] of columnSources) {
      expect(hashed.has(column), `${field} reads ${column}, which the hash does not cover`).toBe(
        true,
      );
    }
    expect([...hashed].sort()).toEqual([...shownColumns].sort());
  });

  it("every source column is a real job_postings column", () => {
    const columns = new Set(Object.values(getTableColumns(jobPostings)).map((c) => c.name));
    for (const column of shownColumns) expect(columns.has(column), column).toBe(true);
  });

  it("company.name is the posting's own org_label, never a payer or org name", () => {
    expect(CAMPUS_POSTING_SOURCES["company.name"]).toEqual({ column: jobPostings.orgLabel.name });
    expect(hashed.has("org_label")).toBe(true);
    for (const column of hashed) expect(column).not.toMatch(/org_name|payer/);
  });

  it("every key a company may write is hashed, or declared as not shown to Campus", () => {
    const companyKeys = new Set([
      ...Object.keys(PayerCreateJobPostingWithAudienceSchema.shape),
      ...Object.keys(PayerUpdateJobPostingSchema.shape),
    ]);
    for (const key of companyKeys) {
      if (key in COMPANY_KEYS_NOT_SHOWN_TO_CAMPUS) {
        // Declared not shown: then no Campus field may read it.
        expect(shownColumns.has(key), `${key} is declared not shown but Campus reads it`).toBe(
          false,
        );
        continue;
      }
      const column = COLUMN_OF_COMPANY_KEY[key] ?? key;
      expect(hashed.has(column), `company key ${key} (column ${column}) is not hashed`).toBe(true);
    }
    // Non-vacuous, and the declarations stay current.
    expect(companyKeys.size).toBeGreaterThan(20);
    for (const key of Object.keys(COMPANY_KEYS_NOT_SHOWN_TO_CAMPUS)) {
      expect(companyKeys.has(key), `${key} is no longer a company key; drop it here`).toBe(true);
    }
  });

  it("every field a company may clear is hashed or not shown to Campus", () => {
    for (const field of CLEARABLE_POSTING_FIELDS) {
      const shown = shownColumns.has(field);
      expect(!shown || hashed.has(field), `${field} can be cleared but is not hashed`).toBe(true);
    }
  });
});
