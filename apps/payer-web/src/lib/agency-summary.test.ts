import { describe, expect, it } from "vitest";
import { summarizeAgencyJobs, summarizeJobStatuses, JOB_STATUSES } from "./agency-summary";
import type { AgencyJob, PostingSummary } from "./contracts";

/**
 * Job-status map test. Jobs are OPEN / CLOSED / PAUSED / DRAFT only (HARD LOCK: NO
 * hire-outcome / interview / selected / hired stage). The summary is COUNTS only —
 * no PII enters or leaves (a `PostingSummary` carries no worker name/phone).
 */

function posting(status: PostingSummary["status"], i: number): PostingSummary {
  return {
    id: `0000000${i}-0000-4000-8000-00000000000${i}`,
    roleTitle: "CNC Operator",
    locationLabel: "Pune",
    vacancyBand: "1-5",
    status,
    applicantCount: 0,
    createdAt: "2026-06-22T00:00:00.000Z",
  };
}

describe("summarizeJobStatuses", () => {
  it("counts open / closed / paused / suspended / draft and the total", () => {
    const rows = [
      posting("open", 1),
      posting("open", 2),
      posting("closed", 3),
      posting("paused", 4),
      posting("draft", 5),
    ];
    expect(summarizeJobStatuses(rows)).toEqual({
      total: 5,
      open: 2,
      closed: 1,
      paused: 1,
      suspended: 0,
      draft: 1,
    });
  });

  it("returns all-zero for an empty list", () => {
    expect(summarizeJobStatuses([])).toEqual({
      total: 0,
      open: 0,
      closed: 0,
      paused: 0,
      suspended: 0,
      draft: 0,
    });
  });

  it("recognizes the lifecycle states incl. system `suspended` (no hire/interview stage)", () => {
    expect([...JOB_STATUSES]).toEqual(["draft", "open", "closed", "paused", "suspended"]);
    expect(JOB_STATUSES).not.toContain("hired");
    expect(JOB_STATUSES).not.toContain("interview");
    expect(JOB_STATUSES).not.toContain("selected");
  });
});

function agencyJob(status: AgencyJob["status"], i: number, applicantsReceived: number): AgencyJob {
  return {
    id: `0000000${i}-0000-4000-8000-00000000000${i}`,
    status,
    tradeKey: "cnc_operator",
    title: "CNC Operator",
    city: "Pune",
    area: null,
    payMin: null,
    payMax: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    neededBy: null,
    applicantsReceived,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

describe("summarizeAgencyJobs (LIVE agency jobs — open|paused|suspended|closed)", () => {
  it("splits by status, sums applicants, and counts the total", () => {
    const jobs = [
      agencyJob("open", 1, 3),
      agencyJob("open", 2, 2),
      agencyJob("paused", 3, 4),
      agencyJob("closed", 4, 5),
    ];
    expect(summarizeAgencyJobs(jobs)).toEqual({
      total: 4,
      open: 2,
      paused: 1,
      suspended: 0,
      closed: 1,
      applicantsReceived: 14,
    });
  });

  it("returns all-zero for an empty list", () => {
    expect(summarizeAgencyJobs([])).toEqual({
      total: 0,
      open: 0,
      paused: 0,
      suspended: 0,
      closed: 0,
      applicantsReceived: 0,
    });
  });
});
