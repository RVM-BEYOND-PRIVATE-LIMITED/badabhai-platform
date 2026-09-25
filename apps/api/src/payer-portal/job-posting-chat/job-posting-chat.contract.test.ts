import { describe, it, expect } from "vitest";
import { JobPostingDraftSchema } from "@badabhai/ai-contracts";
import {
  EXPERIENCE_MAX_YEARS,
  experienceYearsSchema,
  neededBySchema,
  payTypeSchema,
  shiftSchema,
} from "../../common/job-content.schemas";
import { PayerCreateJobPostingSchema } from "../../job-postings/job-postings.dto";
import { WORKER_CARD_FIELDS } from "./job-posting-chat.dto";

/**
 * DRAFT <-> CREATE-DTO VALUE PARITY (#1726).
 *
 * `JobPostingDraftSchema` lives in `@badabhai/ai-contracts` and carries its OWN copies of
 * the card vocabularies and caps, because that package cannot import from apps/api. The
 * golden keys fixture pins key NAMES only. This suite pins the VALUES: a draft enum or cap
 * that drifts from the create path either 400s a publish (draft wider) or makes a value
 * the posting accepts inexpressible in chat (draft narrower) — so both directions fail.
 */

/** The minimum a payer create needs; each probe adds one card field to it. */
const CREATE_BASE = { org_label: "Acme Works", role_title: "Welder", vacancy_band: "1" } as const;

const draftAccepts = (patch: Record<string, unknown>): boolean =>
  JobPostingDraftSchema.safeParse(patch).success;
const createAccepts = (patch: Record<string, unknown>): boolean =>
  PayerCreateJobPostingSchema.safeParse({ ...CREATE_BASE, ...patch }).success;

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("job-posting chat draft — value parity with the create path (#1726)", () => {
  it("the probe base is itself a valid create (otherwise every probe below is vacuous)", () => {
    expect(createAccepts({})).toBe(true);
  });

  it("pay_type is the SAME closed vocabulary as payTypeSchema", () => {
    const draft = JobPostingDraftSchema.shape.pay_type.removeDefault().unwrap().options;
    expect(sorted(draft)).toEqual(sorted(payTypeSchema.options));
    for (const v of draft) expect(createAccepts({ pay_type: v }), v).toBe(true);
  });

  it("needed_by is the SAME closed vocabulary as neededBySchema", () => {
    const draft = JobPostingDraftSchema.shape.needed_by.removeDefault().unwrap().options;
    expect(sorted(draft)).toEqual(sorted(neededBySchema.options));
    for (const v of draft) expect(createAccepts({ needed_by: v }), v).toBe(true);
  });

  it("shift is the SAME closed vocabulary as shiftSchema", () => {
    const draft = JobPostingDraftSchema.shape.shift.removeDefault().unwrap().options;
    expect(sorted(draft)).toEqual(sorted(shiftSchema.options));
  });

  it("city: the draft and the create DTO accept exactly the same lengths (cap 80)", () => {
    for (let n = 1; n <= 120; n++) {
      const city = "x".repeat(n);
      expect(draftAccepts({ city }), `len ${n}`).toBe(createAccepts({ city }));
    }
    // Boundary sanity, so a shared wrong cap cannot pass the equality above.
    expect(createAccepts({ city: "x".repeat(80) })).toBe(true);
    expect(createAccepts({ city: "x".repeat(81) })).toBe(false);
  });

  it("experience: both ends accept exactly what experienceYearsSchema accepts (whole years 0..60)", () => {
    expect(EXPERIENCE_MAX_YEARS).toBe(60);
    const probes = [-1, 0, 1, 2.5, 59, 60, 61, 100];
    for (const key of ["min_experience_years", "max_experience_years"]) {
      for (const v of probes) {
        const expected = experienceYearsSchema.safeParse(v).success;
        expect(draftAccepts({ [key]: v }), `${key}=${v} (draft)`).toBe(expected);
        expect(createAccepts({ [key]: v }), `${key}=${v} (create)`).toBe(expected);
      }
    }
  });

  it("every worker-card field the publish report can name is a draft field the chat can fill", () => {
    const draftKeys = Object.keys(JobPostingDraftSchema.shape);
    for (const f of WORKER_CARD_FIELDS) expect(draftKeys, f).toContain(f);
  });
});
