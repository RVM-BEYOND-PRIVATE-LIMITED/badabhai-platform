import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #2569 — the empty-feed read must stay the SAME eligibility rule the worker app's feed uses.
 *
 * NOT THE PARITY PROOF. These are source-text pins on the admin side only: they cannot see the
 * feed's own SQL change, nor a semantic edit that keeps a pinned substring. The executed proof
 * is the parity suite in `admin-empty-feed.db.test.ts` (listed ⇔ `ApplicationsService.getFeed`
 * serves zero cards, per mode, per seeded worker). These stay as a cheap, DB-free early warning.
 *
 * Pinned here, the source-level invariants that are easy to lose in a refactor:
 *
 *  - the active mode is chosen from the feed's own two flags;
 *  - every arm keeps `open` inventory only and removes this worker's own applications;
 *  - the V1 arm keeps the reach/twin/source guards;
 *  - the projection stays faceless (no phone/name/email/photo column);
 *  - test accounts are excluded unless explicitly requested;
 *  - the CURRENT-profile rule is the shared `CURRENT_PROFILE_ORDER`, not a local ORDER BY.
 */
const DIR = __dirname;
const repo = readFileSync(join(DIR, "admin-empty-feed.repository.ts"), "utf8")
  .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")
  .replace(/\s+/g, " ");
const service = readFileSync(join(DIR, "admin-empty-feed.service.ts"), "utf8")
  .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")
  .replace(/\s+/g, " ");

describe("#2569 empty-feed source pins (the executed parity proof is the .db suite)", () => {
  it("chooses the mode from the feed's flags in the feed's precedence", () => {
    expect(service).toContain("isMatchV1Enabled");
    expect(service).toContain("isFeedPostingsUnionEnabled");
    const body = service.slice(service.indexOf("static feedMode"));
    expect(body.indexOf("isMatchV1Enabled")).toBeLessThan(
      body.indexOf("isFeedPostingsUnionEnabled"),
    );
  });

  it("legacy arm: OPEN jobs minus this worker's applied rows", () => {
    expect(repo).toContain("jobs.status = 'open'");
    expect(repo).toContain("applications.action = 'applied'");
    expect(repo).toContain("applications.job_id = jobs.id");
  });

  it("union arm: open published postings, applications on both ids, twin guard, wanted-skill overlap", () => {
    expect(repo).toContain("job_postings.status = 'open'");
    expect(repo).toContain("job_postings.published_at IS NOT NULL");
    expect(repo).toContain("applications.job_posting_id = job_postings.id");
    expect(repo).toContain("applications.job_id = job_postings.source_job_id");
    expect(repo).toContain("jobs.status = 'open'");
    expect(repo).toContain("worker_skill.wants");
    expect(repo).toContain("job_postings.reach_skill_ids ?|");
  });

  it("V1 arm: job_reach + open posting + live twin source + decisions on both ids", () => {
    expect(repo).toContain("FROM job_reach");
    expect(repo).toContain("job_reach.worker_id");
    expect(repo).toContain("job_postings.sync_source IS NULL OR src.status = 'open'");
    expect(repo).toContain("applications.job_posting_id = job_postings.id");
    expect(repo).toContain("applications.job_id = job_postings.source_job_id");
  });

  it("the worker projection uses the shared CURRENT_PROFILE_ORDER and only faceless columns", () => {
    expect(repo).toContain("CURRENT_PROFILE_ORDER");
    expect(repo).toContain("worker_profiles.worker_id = w.id");
    // The four fields the screen is allowed to show.
    for (const field of [
      "w.current_city",
      "worker_profiles.profile_status",
      "worker_profiles.canonical_trade_id",
      "w.created_at",
    ]) {
      expect(repo).toContain(field);
    }
    // PII never enters the projection.
    for (const pii of ["phone_e164", "phone_hash", "full_name", "email_enc", "photo_storage_key"]) {
      expect(repo).not.toContain(pii);
    }
  });

  it("active workers only, and test accounts excluded unless asked", () => {
    expect(repo).toContain("w.status = 'active'");
    expect(repo).toContain("w.is_test_account = false");
    expect(repo).toContain("includeTestAccounts");
  });
});
