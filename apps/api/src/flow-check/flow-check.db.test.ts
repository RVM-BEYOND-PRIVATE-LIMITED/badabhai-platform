import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { FlowCheckRepository, type FlowCountWindow } from "./flow-check.repository";

/**
 * #2890 — the daily flow check's SQL against real Postgres: each count finds the rows it must and
 * none it must not. The database is shared, so every assertion is a DELTA over this file's rows:
 * one window is read before the seed and again after, and the difference must be exactly what was
 * seeded (the CI gate step runs one file at a time, so no other file inserts in between).
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run flow-check.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const HOUR = 60 * 60 * 1000;

describe.skipIf(!RUN)("#2890 flow check counts against Postgres", () => {
  let client: DbClient;
  let repo: FlowCheckRepository;
  const TAG = randomUUID().slice(0, 8);
  const NOW = new Date();
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
  // The service's defaults: window 24 h, review wait 48 h, zero-reach grace 24 h, untouched 72 h.
  const WINDOW: FlowCountWindow = {
    now: NOW,
    since: new Date(NOW.getTime() - 24 * HOUR),
    reviewCutoff: new Date(NOW.getTime() - 48 * HOUR),
    reachCutoff: new Date(NOW.getTime() - 24 * HOUR),
    untouchedFrom: new Date(NOW.getTime() - 96 * HOUR),
    untouchedTo: new Date(NOW.getTime() - 72 * HOUR),
  };

  const PAYER = randomUUID();
  const SKILL = `flowtest_${TAG}`;
  const W = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
  const P = {
    posted: randomUUID(), // open, published 2 h ago: jobs posted, inside the reach grace
    zero: randomUUID(), // open, published 30 h ago, no reach: zero-reach
    reached: randomUUID(), // open, published 30 h ago, one reach row: not zero-reach
    hidden: randomUUID(), // open, hidden by BadaBhai, no reach: not counted
    rvmOverdue: randomUUID(), // rvm_students, review pending 50 h: overdue, never zero-reach
    rvmFresh: randomUUID(), // both, published 2 h ago, review pending 10 h: neither
    rvmClosed: randomUUID(), // closed rvm_students, review pending 50 h: not overdue
    rvmApproved: randomUUID(), // rvm_students, review approved: not overdue
    old: randomUUID(), // a company's closed posting with 80-hour-old applications
    ops: randomUUID(), // an ops posting (no payer) with an 80-hour-old application
  };
  const IA = { live: randomUUID(), unlinked: randomUUID(), withdrawn: randomUUID() };
  let before: Awaited<ReturnType<FlowCheckRepository["readCounts"]>>;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 2 });
    repo = new FlowCheckRepository(client.db);
    before = await repo.readCounts(WINDOW);
    const sql = client.sql;

    await sql`INSERT INTO skill (skill_id, label_en, source) VALUES (${SKILL}, 'Flow test skill', 'rvm')`;
    for (const [i, id] of W.entries()) {
      await sql`INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, ${`enc:flow-${TAG}-${i}`}, ${`hash:flow-${TAG}-${i}`}, 'active')`;
    }

    const posting = async (
      id: string,
      o: {
        status?: string;
        audience?: string;
        publishedHoursAgo?: number;
        payer?: string | null;
        hidden?: boolean;
      },
    ) => {
      const hiddenAt = o.hidden ? at(1) : null;
      await sql`INSERT INTO job_postings
          (id, created_by, payer_id, org_label, role_title, vacancy_band, status, audience,
           published_at, hidden_at, hidden_by, hidden_reason_code, hidden_reason_text)
        VALUES (${id}::uuid, ${randomUUID()}::uuid,
          ${o.payer === undefined ? PAYER : o.payer}::uuid, 'Flow Test Works', 'CNC Turner', '1',
          ${o.status ?? "open"}, ${o.audience ?? "badabhai_workers"},
          ${o.publishedHoursAgo === undefined ? null : at(o.publishedHoursAgo)}::timestamptz,
          ${hiddenAt}::timestamptz, ${o.hidden ? randomUUID() : null}::uuid,
          ${o.hidden ? "other" : null}, ${o.hidden ? "flow test" : null})`;
    };
    await posting(P.posted, { publishedHoursAgo: 2 });
    await posting(P.zero, { publishedHoursAgo: 30 });
    await posting(P.reached, { publishedHoursAgo: 30 });
    await posting(P.hidden, { publishedHoursAgo: 30, hidden: true });
    await posting(P.rvmOverdue, { audience: "rvm_students", publishedHoursAgo: 30 });
    await posting(P.rvmFresh, { audience: "both", publishedHoursAgo: 2 });
    await posting(P.rvmClosed, {
      audience: "rvm_students",
      status: "closed",
      publishedHoursAgo: 30,
    });
    await posting(P.rvmApproved, { audience: "rvm_students", publishedHoursAgo: 30 });
    await posting(P.old, { status: "closed", publishedHoursAgo: 100 });
    await posting(P.ops, { status: "closed", publishedHoursAgo: 100, payer: null });

    await sql`INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      VALUES (${P.reached}::uuid, ${W[0]}::uuid, 1, ${SKILL})`;

    const pending = (id: string, hoursAgo: number) =>
      sql`INSERT INTO job_posting_institute_reviews (job_posting_id, institute_code, state, created_at, updated_at)
        VALUES (${id}::uuid, 'rvm', 'pending', ${at(hoursAgo)}::timestamptz, ${at(hoursAgo)}::timestamptz)`;
    await pending(P.rvmOverdue, 50);
    await pending(P.rvmFresh, 10);
    await pending(P.rvmClosed, 50);
    await sql`INSERT INTO job_posting_institute_reviews
        (job_posting_id, institute_code, state, reviewer_ref, reviewed_at, content_hash, created_at, updated_at)
      VALUES (${P.rvmApproved}::uuid, 'rvm', 'approved', ${randomUUID()}, ${at(40)}::timestamptz,
        ${"a".repeat(64)}, ${at(60)}::timestamptz, ${at(40)}::timestamptz)`;

    const apply = async (
      worker: string,
      postingId: string,
      hoursAgo: number,
      action = "applied",
    ) => {
      const id = randomUUID();
      await sql`INSERT INTO applications (id, job_posting_id, worker_id, action, created_at, updated_at)
        VALUES (${id}::uuid, ${postingId}::uuid, ${worker}::uuid, ${action},
          ${at(hoursAgo)}::timestamptz, ${at(hoursAgo)}::timestamptz)`;
      return id;
    };
    // In the window: two applies (one of them through Campus) and a skip that is not one.
    await apply(W[0], P.posted, 1);
    await apply(W[1], P.posted, 1, "skipped");
    const campusApp = await apply(W[2], P.posted, 1);
    // The untouched cohort [96 h, 72 h): one untouched, one moved on the board, one opened.
    await apply(W[0], P.old, 80);
    await apply(W[1], P.old, 80);
    await apply(W[2], P.old, 80);
    await apply(W[3], P.old, 50); // too recent for the cohort
    await apply(W[0], P.ops, 80); // an ops posting: no company to act on it
    await sql`INSERT INTO payer_applicant_stages (posting_kind, posting_id, worker_id, stage, actor_payer_id)
      VALUES ('company_posting', ${P.old}::uuid, ${W[1]}::uuid, 'shortlist', ${PAYER}::uuid)`;
    await sql`INSERT INTO unlocks (payer_id, worker_id, job_posting_id, status)
      VALUES (${PAYER}::uuid, ${W[2]}::uuid, ${P.old}::uuid, 'granted')`;

    await sql`INSERT INTO institute_applications
        (id, institute_code, external_ref, application_id, job_posting_id, worker_id, owns_application, created_at, updated_at)
      VALUES (${IA.live}::uuid, 'rvm', ${`flow-${TAG}-live`}, ${campusApp}::uuid, ${P.posted}::uuid,
        ${W[2]}::uuid, true, ${at(1)}::timestamptz, ${at(1)}::timestamptz)`;
    // Live on Campus, but its BadaBhai row is gone (#2782).
    await sql`INSERT INTO institute_applications
        (id, institute_code, external_ref, application_id, job_posting_id, worker_id, created_at, updated_at)
      VALUES (${IA.unlinked}::uuid, 'rvm', ${`flow-${TAG}-gone`}, NULL, ${P.zero}::uuid,
        ${W[3]}::uuid, ${at(40)}::timestamptz, ${at(40)}::timestamptz)`;
    // Withdrawn: no row by design.
    await sql`INSERT INTO institute_applications
        (id, institute_code, external_ref, application_id, job_posting_id, worker_id, withdrawn_at, created_at, updated_at)
      VALUES (${IA.withdrawn}::uuid, 'rvm', ${`flow-${TAG}-wdrn`}, NULL, ${P.zero}::uuid,
        ${W[3]}::uuid, ${at(30)}::timestamptz, ${at(40)}::timestamptz, ${at(30)}::timestamptz)`;
  });

  afterAll(async () => {
    if (!client) return;
    const sql = client.sql;
    const postings = Object.values(P);
    try {
      await sql`DELETE FROM institute_applications WHERE id = ANY(${Object.values(IA)}::uuid[])`;
      await sql`DELETE FROM unlocks WHERE payer_id = ${PAYER}::uuid`;
      await sql`DELETE FROM payer_applicant_stages WHERE posting_id = ANY(${postings}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE id = ANY(${postings}::uuid[])`;
      await sql`DELETE FROM workers WHERE id = ANY(${[...W]}::uuid[])`;
      await sql`DELETE FROM skill WHERE skill_id = ${SKILL}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("each count moves by exactly what this file seeded", async () => {
    const after = await repo.readCounts(WINDOW);
    const delta = Object.fromEntries(
      Object.entries(after).map(([k, v]) => [k, v - before[k as keyof typeof before]]),
    );
    expect(delta).toEqual({
      // P.posted and P.rvmFresh were published in the window; nothing else was.
      jobsPosted: 2,
      // Two applies in the window (one from Campus); the skip is not an application.
      applicationsReceived: 2,
      campusApplications: 1,
      // Pending 50 h and open: overdue. Pending 10 h, closed, or approved: not.
      rvmReviewOverdue: 1,
      // Only P.zero: P.posted / P.rvmFresh are inside the grace, P.reached has reach, P.hidden is
      // hidden, the rvm_students postings never reach a worker, P.old and P.ops are closed.
      liveZeroReach: 1,
      // The Campus row whose BadaBhai application is gone; the withdrawn one is not.
      campusUnlinked: 1,
      // W0 on P.old: W1 was moved on the board, W2's contact was opened, W3 is too recent, and
      // the ops posting has no company.
      applicationsUntouched: 1,
    });
  });

  it("names this file's rows among the ids behind the three counts an operator fixes", async () => {
    const after = await repo.readCounts(WINDOW);
    const ids = await repo.sampleIds(WINDOW);
    for (const list of Object.values(ids)) expect(list.length).toBeLessThanOrEqual(20);
    // Oldest first, at most 20: only assert membership when the whole set fits.
    if (after.rvmReviewOverdue <= 20) expect(ids.rvmReviewOverdue).toContain(P.rvmOverdue);
    if (after.liveZeroReach <= 20) expect(ids.liveZeroReach).toContain(P.zero);
    if (after.campusUnlinked <= 20) expect(ids.campusUnlinked).toContain(IA.unlinked);
    expect(ids.liveZeroReach).not.toContain(P.reached);
    expect(ids.liveZeroReach).not.toContain(P.hidden);
    expect(ids.liveZeroReach).not.toContain(P.rvmOverdue);
    expect(ids.rvmReviewOverdue).not.toContain(P.rvmClosed);
    expect(ids.rvmReviewOverdue).not.toContain(P.rvmApproved);
    expect(ids.campusUnlinked).not.toContain(IA.withdrawn);
  });

  it("a posting held for an admin's opening (#2891) is not a worker posting, so not zero-reach", async () => {
    const sql = client.sql;
    const baseline = (await repo.readCounts(WINDOW)).liveZeroReach;
    await sql`INSERT INTO job_posting_worker_visibility (job_posting_id, state, origin)
      VALUES (${P.zero}::uuid, 'off', 'campus_posted')`;
    try {
      expect((await repo.readCounts(WINDOW)).liveZeroReach).toBe(baseline - 1);
    } finally {
      await sql`DELETE FROM job_posting_worker_visibility WHERE job_posting_id = ${P.zero}::uuid`;
    }
  });
});
