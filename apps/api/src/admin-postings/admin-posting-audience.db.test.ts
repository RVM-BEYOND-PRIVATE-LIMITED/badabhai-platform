import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDbClient, events, reachesBadaBhaiWorkers, type DbClient } from "@badabhai/db";

import { CampusPostingsRepository } from "../campus-link/campus-postings.repository";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import type { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { JobPostingsService } from "../job-postings/job-postings.service";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PostingAudienceService } from "../job-postings/posting-audience.service";
import { AdminPostingAudienceRepository } from "./admin-posting-audience.repository";
import { AdminPostingAudienceService } from "./admin-posting-audience.service";
import { AdminPostingsRepository } from "./admin-postings.repository";

/**
 * #2956 — AN ADMIN DECIDES WHERE A JOB SHOWS, against a real Postgres: the owner's three cases end
 * to end through the admin service, read back the way BadaBhai workers (`reachesBadaBhaiWorkers`)
 * and Campus (the Campus feed, `CampusPostingsRepository.listFeed`) read them.
 *
 *   A. A CNC turner job with a few openings, Campus only: students see it (approved), workers not.
 *   B. The same job widened to both: workers see it too.
 *   C. A painter job: refused for Campus (RVM does not train painters), stays BadaBhai only.
 *
 * Plus the admin list's tabs, "changed since decision" after a company edit, a job taken off
 * Campus reaching Campus's feed as closed, and a Campus-origin job's hold following the choice.
 * Reach is not rebuilt here (`job-audience-visibility.db.test.ts` proves the reach core obeys the
 * audience); the post-commit rebuild is a stub.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test admin-posting-audience.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const CORRELATION = uuid(0x29560001);
const CTX: RequestContext = { correlationId: CORRELATION, requestId: "admin-posting-audience-db" };
const CREATED_BY = uuid(0x29560002);
const PAYER = uuid(0x29560003);
const ADMIN = uuid(0x29560004);
const P_CNC = uuid(0x29561001);
const P_PAINT = uuid(0x29561002);
const P_CAMPUS = uuid(0x29561003);
const ALL = [P_CNC, P_PAINT, P_CAMPUS];
const REASON = { reason_code: "other" as const, reason_text: "Openings checked with the company" };

describe.skipIf(!RUN)("#2956 an admin decides where each job shows", () => {
  let client!: DbClient;
  let service!: AdminPostingAudienceService;
  let feed!: CampusPostingsRepository;
  let repo!: AdminPostingAudienceRepository;

  async function workersSee(id: string): Promise<boolean> {
    const rows = (await client.db.execute(sql`
      SELECT ${reachesBadaBhaiWorkers("jp")} AS w FROM job_postings jp WHERE jp.id = ${id}::uuid
    `)) as unknown as { w: boolean }[];
    return rows[0]?.w === true;
  }

  async function campusFeed(changedSince?: Date) {
    const rows = await feed.listFeed({ limit: 500, ...(changedSince ? { changedSince } : {}) });
    return rows.filter((r) => ALL.includes(r.id));
  }

  async function listed(filter: Parameters<AdminPostingAudienceRepository["list"]>[0]["filter"]) {
    const rows = await repo.list({ filter, limit: 500 });
    return rows.map((r) => r.jobPostingId).filter((id) => ALL.includes(id)).sort();
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    await cleanup(client);
    await seed(client);
    const eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    repo = new AdminPostingAudienceRepository(client.db);
    feed = new CampusPostingsRepository(client.db);
    service = new AdminPostingAudienceService(
      repo,
      new AdminPostingsRepository(client.db),
      new PostingAudienceService(
        {} as FeatureRolloutService,
        new PostingAudienceRepository(client.db),
        eventsService,
      ),
      { materializeAfterWorkerVisibility: vi.fn(async () => true) } as unknown as JobPostingsService,
      eventsService,
    );
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("before any decision: the RVM-trade job and the held Campus job are to decide; the painter job is not", async () => {
    expect(await listed("to_decide")).toEqual([P_CNC, P_CAMPUS].sort());
    expect(await listed("badabhai")).toEqual([P_CNC, P_PAINT].sort());
    expect(await listed("campus")).toEqual([P_CAMPUS]); // held from workers = Campus only
  }, 30_000);

  it("case A: Campus only — students see it approved, BadaBhai workers do not", async () => {
    const result = await service.set(ADMIN, P_CNC, { audience: "rvm_students", ...REASON }, CTX);
    expect(result).toEqual({ posting_id: P_CNC, outcome: "changed", shown_to: "campus" });
    expect(await workersSee(P_CNC)).toBe(false);
    const [row] = (await campusFeed()).filter((r) => r.id === P_CNC);
    expect(row?.takesApplications).toBe(true);
    expect(row?.reviewStateNow).toBe("approved");
    expect(await listed("campus")).toContain(P_CNC);
    expect(await listed("to_decide")).not.toContain(P_CNC);
    const audits = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE actor_id = ${ADMIN}::uuid AND entity_id = ${P_CNC}::uuid AND action = 'posting_audience_set'`;
    expect(audits[0]?.n).toBe(1);
    // The same decision again, for the same content: unchanged, nothing more written.
    expect(
      (await service.set(ADMIN, P_CNC, { audience: "rvm_students", ...REASON }, CTX)).outcome,
    ).toBe("unchanged");
  }, 30_000);

  it("case B: both — workers see it too, students still see it approved", async () => {
    const result = await service.set(ADMIN, P_CNC, { audience: "both", ...REASON }, CTX);
    expect(result.shown_to).toBe("both");
    expect(await workersSee(P_CNC)).toBe(true);
    const [row] = (await campusFeed()).filter((r) => r.id === P_CNC);
    expect(row?.reviewStateNow).toBe("approved");
  }, 30_000);

  it("a company edit after the decision: the job shows under 'changed', and Campus reads it pending", async () => {
    await client.sql`UPDATE job_postings SET vacancy_band = '25+' WHERE id = ${P_CNC}::uuid`;
    expect(await listed("changed")).toEqual([P_CNC]);
    const [row] = (await campusFeed()).filter((r) => r.id === P_CNC);
    expect(row?.reviewStateNow).toBe("pending");
    // The admin looks again and confirms: approved for the new content, off the changed tab.
    expect((await service.set(ADMIN, P_CNC, { audience: "both", ...REASON }, CTX)).outcome).toBe(
      "changed",
    );
    expect(await listed("changed")).toEqual([]);
    const [after] = (await campusFeed()).filter((r) => r.id === P_CNC);
    expect(after?.reviewStateNow).toBe("approved");
  }, 30_000);

  it("case C: a painter job cannot be sent to Campus, and stays BadaBhai only", async () => {
    for (const audience of ["rvm_students", "both"] as const) {
      expect((await service.set(ADMIN, P_PAINT, { audience, ...REASON }, CTX)).outcome).toBe(
        "trade_not_taught_at_campus",
      );
    }
    expect(await workersSee(P_PAINT)).toBe(true);
    expect((await campusFeed()).map((r) => r.id)).not.toContain(P_PAINT);
  }, 30_000);

  it("taken off Campus: gone from the open feed, and sent once as closed to a changed-since read", async () => {
    const before = new Date(Date.now() - 60_000);
    await service.set(ADMIN, P_CNC, { audience: "badabhai_workers", ...REASON }, CTX);
    expect(await workersSee(P_CNC)).toBe(true);
    expect((await campusFeed()).map((r) => r.id)).not.toContain(P_CNC);
    const [closed] = (await campusFeed(before)).filter((r) => r.id === P_CNC);
    expect(closed?.takesApplications).toBe(false);
    // The wire has no BadaBhai-only audience; Campus closes its copy.
    expect(closed?.audience).toBe("rvm_students");
  }, 30_000);

  it("a Campus-origin job: Campus only records its hold as an admin decision; both needs a trade", async () => {
    expect(
      (await service.set(ADMIN, P_CAMPUS, { audience: "rvm_students", ...REASON }, CTX)).outcome,
    ).toBe("changed");
    const [hold] = await client.sql<{ state: string; decided: boolean }[]>`
      SELECT state, decided_at IS NOT NULL AS decided FROM job_posting_worker_visibility
      WHERE job_posting_id = ${P_CAMPUS}::uuid`;
    expect(hold).toEqual({ state: "off", decided: true });
    expect(await workersSee(P_CAMPUS)).toBe(false);
    expect((await service.set(ADMIN, P_CAMPUS, { audience: "both", ...REASON }, CTX)).outcome).toBe(
      "trade_required",
    );
    expect(await listed("to_decide")).toEqual([]);
  }, 30_000);
});

async function seed(client: DbClient): Promise<void> {
  const { sql: q } = client;
  await q`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
    VALUES (${PAYER}::uuid, 'employer', 'enc:t2956-audience', 'hash:t2956-audience',
            'enc:org-t2956-audience', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  // RVM trains CNC turning; painting is not on the list.
  await q`
    INSERT INTO campus_trades (trade_key, added_by_admin_id)
    VALUES ('cnc_turner', ${ADMIN}::uuid)
    ON CONFLICT (trade_key) DO UPDATE SET removed_at = NULL, removed_by_admin_id = NULL
  `;
  const posting = async (
    id: string,
    roleKind: string | null,
    audience: "badabhai_workers" | "both",
    title: string,
  ) => {
    await q`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, audience, role_kind, published_at, city)
      VALUES (${id}::uuid, ${CREATED_BY}::uuid, ${PAYER}::uuid, 'Audience Fixture', ${title},
              '2-5', 'open', ${audience}, ${roleKind}, '2099-04-01T00:00:00Z', 'Pune')
    `;
  };
  await posting(P_CNC, "cnc_turner", "badabhai_workers", "t2956 CNC Turner");
  await posting(P_PAINT, "painter_coating", "badabhai_workers", "t2956 Painter");
  // A job RVM's placement team posted from Campus: `both`, held from workers, no trade.
  await posting(P_CAMPUS, null, "both", "t2956 Campus job");
  await q`
    INSERT INTO job_posting_worker_visibility (job_posting_id, state, origin)
    VALUES (${P_CAMPUS}::uuid, 'off', 'campus_posted')
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql: q } = client;
  // Decisions, review rows and holds cascade with their postings; the audit rows do not.
  await q`DELETE FROM audit_logs WHERE actor_id = ${ADMIN}::uuid`;
  for (const id of ALL) await q`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  await q`DELETE FROM campus_trades WHERE added_by_admin_id = ${ADMIN}::uuid`;
  await q`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
  await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
}
