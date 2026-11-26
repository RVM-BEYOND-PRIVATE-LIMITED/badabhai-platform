import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, events, type DbClient } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { MatchSkillsService } from "../match/match-skills.service";
import { PublishReachService } from "../match/publish-reach.service";
import { ReachWidenRepository } from "../match/reach-widen.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { PostingTradesService } from "../posting-trades/posting-trades.service";
import type { PackRegistryService } from "../profiling/pack-registry.service";
import { releaseServiceFor } from "../trade-release/trade-release.test-support";
import { AdminPostingsRepository } from "./admin-postings.repository";
import {
  AdminCampusNarrowRepository,
} from "./admin-campus-narrow.repository";
import { AdminCampusNarrowService } from "./admin-campus-narrow.service";

/**
 * #3033 — the Campus narrow queue and the narrow write, against a real Postgres.
 *
 * Fixtures (all open, all Campus-origin, `t3033n` titles so the queue read is provable
 * over the shared gate database):
 *   - QUEUE_HELD: `both`, held `off`, match exactly the general CNC skill — the queue item.
 *   - QUEUE_OPEN: `both`, hold `on` (visible to BadaBhai workers), match the general skill.
 *   - QUEUE_T29: like QUEUE_HELD, for the switched-off-trade refusal.
 *   - NARROWED: already narrowed to CNC Turner — never queues, never re-narrows.
 *   - COMPANY: the general skill but no Campus row — never queues, not Campus-origin.
 *   - CLOSED: Campus-origin and general, but closed — never queues, refused.
 *
 * Narrowing QUEUE_HELD to CNC Turner changes its stored skills from the general one to the
 * trade's, writes the audit row (who, from what), and leaves the queue; narrowing QUEUE_OPEN
 * rebuilds its reach, so a worker holding the turner skill reaches it (this is the "already
 * visible rebuilds its reach" half of the contract — say so in the PR).
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test admin-campus-narrow.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-campus-narrow.db refuses to write to a non-local database host (${host})`);
  }
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const CORRELATION = uuid(0x30330001);
const CTX: RequestContext = { correlationId: CORRELATION, requestId: "admin-campus-narrow-db" };
const CREATED_BY = uuid(0x30330002);
const PAYER = uuid(0x30330003);
const ADMIN = uuid(0x30330004);
const WORKER = uuid(0x30330005);

const GENERAL = "mskill_cnc_operator_general";
const TURNER = "mskill_cnc_turner";
const INDUSTRY = "ind_industrial_manufacturing";

const QUEUE_HELD = uuid(0x30331001);
const QUEUE_OPEN = uuid(0x30331002);
const QUEUE_T29 = uuid(0x30331003);
const NARROWED = uuid(0x30331004);
const COMPANY = uuid(0x30331005);
const CLOSED = uuid(0x30331006);
const ALL = [QUEUE_HELD, QUEUE_OPEN, QUEUE_T29, NARROWED, COMPANY, CLOSED];
const REASON_TEXT = "Campus check: CNC Turner from the job text";

const onlyMine = (ids: readonly string[]): string[] =>
  ids.filter((id) => ALL.includes(id)).sort();

describe.skipIf(!RUN)("#3033 the Campus narrow queue and the narrow write", () => {
  let client!: DbClient;
  let service!: AdminCampusNarrowService;

  async function queued(): Promise<string[]> {
    const page = await service.list({ limit: 200 });
    return onlyMine(page.postings.map((p) => p.posting_id));
  }

  async function matchSkills(id: string): Promise<string[]> {
    const rows = (await client.sql<{ m: string[] }[]>`
      SELECT match_skill_ids AS m FROM job_postings WHERE id = ${id}::uuid`) as unknown as {
      m: string[];
    }[];
    return rows[0]?.m ?? [];
  }

  async function reachWorkers(id: string): Promise<string[]> {
    const rows = (await client.sql<{ w: string }[]>`
      SELECT worker_id::text AS w FROM job_reach WHERE job_posting_id = ${id}::uuid`) as unknown as {
      w: string;
    }[];
    return rows.map((r) => r.w);
  }

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 1 });
    await cleanup(client);
    await seed(client);

    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    const matchConfig = new MatchConfigService(new MatchConfigRepository(client.db));
    const workerSkills = new WorkerSkillsRepository(client.db);
    const matchSkillsSvc = new MatchSkillsService(matchConfig, workerSkills);
    const publish = new PublishReachService(
      matchSkillsSvc,
      workerSkills,
      events,
      new ReachWidenRepository(client.db),
      matchConfig,
    );
    // No seeded packs on a bare migrated database: `loadForFamily` answers null, so the form
    // is the trade's own ladder with no chips — enough for a level-only narrow, which is the
    // route's whole input (role kind + optional rung, never chips).
    const packs = { loadForFamily: async () => null } as unknown as PackRegistryService;
    const releases = releaseServiceFor();
    const postingTrades = new PostingTradesService(packs, releases);
    const jobPostings = new JobPostingsService(
      new JobPostingsRepository(client.db),
      events,
      {} as never, // AiService — narrow sends no `skills`, so canonicalization never runs
      {} as never,
      {} as never,
      publish,
      matchSkillsSvc,
      postingTrades,
      {} as never, // tenancy — the narrow path is admin-scoped, never payer-scoped
      {} as never, // audience — narrowing moves no audience
    );
    service = new AdminCampusNarrowService(
      new AdminCampusNarrowRepository(client.db),
      new AdminPostingsRepository(client.db),
      jobPostings,
      postingTrades,
      events,
    );
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("the queue lists the open Campus jobs on the general skill only, oldest first", async () => {
    const page = await service.list({ limit: 200 });
    const mine = page.postings.filter((p) => ALL.includes(p.posting_id));
    expect(mine.map((p) => p.posting_id)).toEqual([QUEUE_HELD, QUEUE_OPEN, QUEUE_T29]);
    const first = mine[0]!;
    expect(first).toMatchObject({
      company_label: "Narrow Fixture",
      title: "t3033n CNC Operator",
      campus_role_text: "t3033n CNC Operator",
      origin: "campus_posted",
    });
    expect(typeof first.posted_at).toBe("string");
    expect(page.next_cursor).toBeNull();
  }, 30_000);

  it("narrowing a held job changes its stored skills from the general one to the trade's", async () => {
    const result = await service.narrow(
      ADMIN,
      QUEUE_HELD,
      { role_kind: "cnc_turner", trade_level: "operator", ...reason() },
      CTX,
    );
    expect(result.outcome).toBe("changed");
    expect(result.role_kind).toBe("cnc_turner");
    expect(result.match_skill_ids).toEqual([TURNER]);
    // The trade's base skill replaced the general one on the row itself.
    expect(await matchSkills(QUEUE_HELD)).toEqual([TURNER]);
    const rows = (await client.sql<{ role: string | null; level: string | null }[]>`
      SELECT role_kind AS role, trade_level AS level FROM job_postings WHERE id = ${QUEUE_HELD}::uuid`) as unknown as {
      role: string | null;
      level: string | null;
    }[];
    expect(rows[0]).toEqual({ role: "cnc_turner", level: "operator" });
    // …and the row left the queue, while a held posting keeps no reach rows.
    expect(await queued()).toEqual([QUEUE_OPEN, QUEUE_T29].sort());
    expect(await reachWorkers(QUEUE_HELD)).toEqual([]);
  }, 30_000);

  it("the audit row and the admin-action event record who narrowed it and from what", async () => {
    const audits = (await client.sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM audit_logs
      WHERE actor_id = ${ADMIN}::uuid AND entity_id = ${QUEUE_HELD}::uuid
      ORDER BY created_at, id`) as unknown as { action: string; metadata: Record<string, unknown> }[];
    expect(audits.map((a) => a.action)).toEqual(["posting_edited"]);
    expect(audits[0]!.metadata).toMatchObject({
      reason_code: "other",
      reason_text: REASON_TEXT,
      narrowed_from_role_kind: null,
      narrowed_from_match_skill_ids: [GENERAL],
      narrowed_to_role_kind: "cnc_turner",
      narrowed_to_match_skill_ids: [TURNER],
      campus_origin: "campus_posted",
    });
    const performed = (await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE correlation_id = ${CORRELATION}::uuid AND event_name = 'admin.action_performed'`) as unknown as {
      payload: Record<string, unknown>;
    }[];
    expect(
      performed.map((r) => r.payload).filter((p) => p.target_id === QUEUE_HELD),
    ).toEqual([{ admin_id: ADMIN, action_code: "posting_edited", target_type: "job_posting", target_id: QUEUE_HELD }]);
    const updated = (await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
      WHERE correlation_id = ${CORRELATION}::uuid AND event_name = 'job_posting.updated'`) as unknown as {
      n: number;
    }[];
    expect(updated[0]?.n).toBeGreaterThan(0);
  }, 30_000);

  it("narrowing a job already visible to BadaBhai workers rebuilds its reach", async () => {
    expect(await reachWorkers(QUEUE_OPEN)).toEqual([]);
    const result = await service.narrow(
      ADMIN,
      QUEUE_OPEN,
      { role_kind: "cnc_turner", ...reason() },
      CTX,
    );
    expect(result.outcome).toBe("changed");
    expect(result.match_skill_ids).toEqual([TURNER]);
    // The worker holding the turner skill is reached now: the rebuild ran for a visible job.
    expect(await reachWorkers(QUEUE_OPEN)).toContain(WORKER);
    expect(await queued()).toEqual([QUEUE_T29]);
  }, 30_000);

  it("refusals store nothing: not Campus-origin, closed, already narrowed, switched-off trade", async () => {
    expect(
      (await service.narrow(ADMIN, COMPANY, { role_kind: "cnc_turner", ...reason() }, CTX)).outcome,
    ).toBe("not_campus_origin");
    expect(
      (await service.narrow(ADMIN, CLOSED, { role_kind: "cnc_turner", ...reason() }, CTX)).outcome,
    ).toBe("posting_closed");
    expect(
      (await service.narrow(ADMIN, NARROWED, { role_kind: "vmc_milling", ...reason() }, CTX)).outcome,
    ).toBe("not_narrowable");
    // Narrowed once already: narrowing again is refused, not re-written.
    expect(
      (await service.narrow(ADMIN, QUEUE_HELD, { role_kind: "vmc_milling", ...reason() }, CTX))
        .outcome,
    ).toBe("not_narrowable");
    // Injection Moulding is one of the six, but its switch is off: it waits for #3013.
    expect(
      (await service.narrow(
        ADMIN,
        QUEUE_T29,
        { role_kind: "injection_moulding_operator", ...reason() },
        CTX,
      )).outcome,
    ).toBe("trade_not_released");
    expect(await matchSkills(QUEUE_T29)).toEqual([GENERAL]);
    expect(
      (await service.narrow(ADMIN, uuid(0x3033ffff), { role_kind: "cnc_turner", ...reason() }, CTX))
        .outcome,
    ).toBe("not_found");
    expect(await queued()).toEqual([QUEUE_T29]);
  }, 30_000);
});

function reason() {
  return { reason_code: "other" as const, reason_text: REASON_TEXT };
}

async function seed(client: DbClient): Promise<void> {
  const { sql: q } = client;
  // The curated vocabulary rows the FKs need — no-ops where the seeds ran.
  for (const [id, label] of [
    [GENERAL, "CNC Operator (General)"],
    [TURNER, "CNC Turner"],
  ] as const) {
    await q`
      INSERT INTO skill (skill_id, label_en, source, status, kind, industry_id)
      VALUES (${id}, ${label}, 'rvm', 'active', 'match_skill', ${INDUSTRY})
      ON CONFLICT (skill_id) DO NOTHING
    `;
  }
  // The worker the visible-job rebuild must reach.
  await q`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:t3033-narrow', 'hash:t3033-narrow', 'active')
  `;
  await q`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${WORKER}::uuid, ${TURNER}, ${INDUSTRY}, 24, true, 'derived_coarse')
  `;
  await q`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
    VALUES (${PAYER}::uuid, 'employer', 'enc:t3033-narrow', 'hash:t3033-narrow',
            'enc:org-t3033-narrow', 'active')
  `;
  const posting = async (
    id: string,
    opts: {
      status: "open" | "closed";
      roleKind: string | null;
      skills: string[];
      title: string;
      created: string;
    },
  ) => {
    await q`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, audience, role_kind, match_skill_ids, published_at,
                                created_at, city)
      VALUES (${id}::uuid, ${CREATED_BY}::uuid, ${PAYER}::uuid, 'Narrow Fixture', ${opts.title},
              '2-5', ${opts.status}, 'both', ${opts.roleKind}, ${JSON.stringify(opts.skills)}::jsonb,
              ${opts.status === "open" ? "2099-05-01T00:00:00Z" : null}, ${opts.created}, 'Pune')
    `;
  };
  await posting(QUEUE_HELD, {
    status: "open",
    roleKind: null,
    skills: [GENERAL],
    title: "t3033n CNC Operator",
    created: "2099-01-01T00:00:00Z",
  });
  await posting(QUEUE_OPEN, {
    status: "open",
    roleKind: null,
    skills: [GENERAL],
    title: "t3033n Machine Operator",
    created: "2099-01-02T00:00:00Z",
  });
  await posting(QUEUE_T29, {
    status: "open",
    roleKind: null,
    skills: [GENERAL],
    title: "t3033n CNC Operator T29",
    created: "2099-01-03T00:00:00Z",
  });
  await posting(NARROWED, {
    status: "open",
    roleKind: "cnc_turner",
    skills: [TURNER],
    title: "t3033n CNC Turner",
    created: "2099-01-04T00:00:00Z",
  });
  await posting(COMPANY, {
    status: "open",
    roleKind: null,
    skills: [GENERAL],
    title: "t3033n Company general",
    created: "2099-01-05T00:00:00Z",
  });
  await posting(CLOSED, {
    status: "closed",
    roleKind: null,
    skills: [GENERAL],
    title: "t3033n Closed general",
    created: "2099-01-06T00:00:00Z",
  });
  await q`
    INSERT INTO job_posting_worker_visibility (job_posting_id, state, origin)
    VALUES (${QUEUE_HELD}::uuid, 'off', 'campus_posted'),
           (${QUEUE_T29}::uuid, 'off', 'campus_posted'),
           (${NARROWED}::uuid, 'off', 'campus_posted'),
           (${CLOSED}::uuid, 'off', 'campus_imported')
  `;
  await q`
    INSERT INTO job_posting_worker_visibility
      (job_posting_id, state, origin, decided_by_admin_id, decided_at)
    VALUES (${QUEUE_OPEN}::uuid, 'on', 'campus_imported', ${ADMIN}::uuid, now())
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql: q } = client;
  await q`DELETE FROM job_reach WHERE worker_id = ${WORKER}::uuid`;
  await q`DELETE FROM audit_logs WHERE actor_id = ${ADMIN}::uuid`;
  // Visibility rows cascade with their postings.
  for (const id of ALL) await q`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  await q`DELETE FROM worker_skill WHERE worker_id = ${WORKER}::uuid`;
  await q`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
  await q`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
  await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
}
