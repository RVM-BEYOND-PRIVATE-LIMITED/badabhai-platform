import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { ApplicationsRepository } from "./applications.repository";

/**
 * STRUCTURAL tests for `findApplicationsByWorker` — the read behind the worker's
 * "Applied jobs" tab (`GET /workers/me/applications`) and its ops twin.
 *
 * WHY THIS FILE EXISTS. The dual-source join is invisible from above: the service
 * maps the rows field-for-field and every service/controller test mocks this method,
 * so reverting the LEFT JOINs to the old INNER JOIN — the bug where a worker who
 * applied from the V1 feed saw an EMPTY tab — leaves the whole api suite green. The
 * same is true of the `city` projection, where the tempting one-word "fix" is a
 * privacy leak (see the location_label test below).
 *
 * Same PgDialect capture-and-compile pattern as chat.repository.test.ts and
 * match-feed.repository.test.ts — the statement is rendered and inspected, no Postgres.
 * Nothing here proves Postgres AGREES (that the planner picks a given index, or that a
 * real V1 row surfaces end-to-end); that belongs to the DB-gated suites. What IS
 * provable without a database is that the statement says the right thing.
 */

const dialect = new PgDialect();
/**
 * Compile one projection/predicate node to text. Wrapped in a `sql` template because a
 * Drizzle selection mixes SQL nodes (`coalesce(...)`) with BARE COLUMN references
 * (`applications.action`), and `sqlToQuery` only accepts the former.
 */
const render = (node: unknown): string =>
  dialect.sqlToQuery(sql`${node}` as SQL).sql.replace(/\s+/g, " ");

const WORKER = "11111111-1111-4111-8111-111111111111";

interface Captured {
  selection?: Record<string, unknown>;
  from?: unknown;
  joins: { kind: "left" | "inner"; table: unknown; on: unknown }[];
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
}

function makeDb(rows: unknown[] = []) {
  const captured: Captured = { joins: [] };
  const node: Record<string, unknown> = {
    from: (t: unknown) => ((captured.from = t), node),
    leftJoin: (t: unknown, on: unknown) => (captured.joins.push({ kind: "left", table: t, on }), node),
    innerJoin: (t: unknown, on: unknown) => (captured.joins.push({ kind: "inner", table: t, on }), node),
    where: (c: unknown) => ((captured.where = c), node),
    orderBy: (...o: unknown[]) => ((captured.orderBy = o), node),
    limit: (n: number) => ((captured.limit = n), Promise.resolve(rows)),
  };
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => ((captured.selection = selection), node)),
  };
  return { repo: new ApplicationsRepository(db as never), captured };
}

/** The compiled text of one projected column. */
const col = (captured: Captured, name: string): string => render(captured.selection![name]);

describe("findApplicationsByWorker — a decision from EITHER surface must show", () => {
  it("LEFT JOINs both `jobs` and `job_postings` — never an INNER JOIN", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);

    // THE REGRESSION THIS FILE EXISTS FOR. A V1 decision carries `job_posting_id` and
    // leaves `job_id` NULL, so the old `innerJoin(jobs)` silently dropped every one of
    // them: the worker applied from the V1 feed and the Applied tab still read empty.
    // An INNER JOIN on EITHER table reintroduces it (job_postings-inner would drop
    // every legacy decision instead).
    expect(captured.joins).toHaveLength(2);
    expect(captured.joins.every((j) => j.kind === "left")).toBe(true);
    expect(captured.joins.map((j) => render(j.on)).join(" | ")).toMatch(/job_id.*job_posting_id/s);
  });

  it("coalesces the EFFECTIVE job id, legacy pointer first", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);

    // The id the client hands straight back to `GET /jobs/:id` — which resolves a legacy
    // job first and falls back to an open posting, mirroring this order.
    const jobId = col(captured, "jobId");
    expect(jobId).toMatch(/coalesce/i);
    expect(jobId.indexOf("job_id")).toBeLessThan(jobId.indexOf("job_posting_id"));
  });

  it("coalesces the title from `jobs` then `job_postings.role_title`", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);
    const title = col(captured, "title");
    // Both source columns are NOT NULL and both FKs are ON DELETE CASCADE, so a surviving
    // decision always has one side of the join — which is what makes `sql<string>` honest
    // here and `sql<string | null>` honest for `city` below.
    expect(title).toMatch(/coalesce/i);
    expect(title).toContain("title");
    expect(title).toContain("role_title");
  });
});

describe("findApplicationsByWorker — the location_label boundary", () => {
  it("NEVER back-fills `city` from the poster's free-text location_label", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);
    const city = col(captured, "city");

    // `job_postings.city` is the COARSE, matchable city bucket ("Pune"). `location_label`
    // is up to 200 chars of poster-typed free text that job-postings.dto.ts EXPLICITLY
    // exempts from the PII heuristic (only `description` is screened) and that routinely
    // names the site or the employer. Adding it as a third COALESCE arm reads as a
    // harmless one-word diff and puts payer free text on the worker's Applied tab —
    // the same leak match-feed.service.ts refuses for `area`. A V1 posting with no city
    // bucket sends NULL, which the client already renders as blank.
    expect(city).toMatch(/coalesce/i);
    expect(city).toContain("city");
    expect(city).not.toContain("location_label");
  });

  it("selects no employer identity at all — no org_label, no payer_id, no pay", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);
    const projection = Object.values(captured.selection!).map(render).join(" | ");

    // Widening the join to `job_postings` also widened what is REACHABLE from this
    // statement: `org_label` and `payer_id` are now one word away. They must stay out
    // (ADR-0024 — employer identity is HIDE on the worker path, entirely).
    expect(projection).not.toContain("org_label");
    expect(projection).not.toContain("payer_id");
    expect(projection).not.toContain("pay_min");
    expect(projection).not.toContain("pay_max");
  });
});

describe("findApplicationsByWorker — scope and bound", () => {
  it("scopes to the worker and stays bounded", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);
    expect(render(captured.where)).toContain('"worker_id"');
    // The dual-source join roughly doubles the row set, so the cap matters more than it
    // did — an unbounded ops read over both surfaces is a real payload.
    expect(captured.limit).toBeGreaterThan(0);
  });
});
