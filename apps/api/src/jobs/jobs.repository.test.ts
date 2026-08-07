import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { JobsRepository } from "./jobs.repository";

/**
 * STRUCTURAL tests for the worker-visible job detail read (ADR-0024 final addendum)
 * and its ADR-0036 `job_postings` fallback.
 *
 * WHY THIS FILE EXISTS. This repository is the ONLY place the worker-visible SHOW set
 * is chosen. The service above it maps field-by-field from whatever the repo hands
 * back, and `jobs.service.test.ts` drives that mapper with hand-built row literals —
 * so a column ADDED to either SELECT here (say `org_label`, one word from `role_title`)
 * would flow onto the worker's detail screen with the entire api suite still green.
 * The V1 fallback doubled the number of places that can happen.
 *
 * Same PgDialect capture-and-compile pattern as match-feed.repository.test.ts.
 * These are statement facts, not Postgres facts.
 */

const dialect = new PgDialect();
/**
 * Compile one projection/predicate node to text. Wrapped in a `sql` template because a
 * Drizzle selection mixes SQL nodes (the literal `NULL`s) with BARE COLUMN references
 * (`jobPostings.city`), and `sqlToQuery` only accepts the former.
 */
const render = (node: unknown): string =>
  dialect.sqlToQuery(sql`${node}` as SQL).sql.replace(/\s+/g, " ");

const JOB_ID = "33333333-3333-4333-8333-333333333333";

interface Query {
  selection?: Record<string, unknown>;
  from?: unknown;
  where?: unknown;
  limit?: number;
}

/**
 * `findWorkerVisibleJobById` issues up to TWO statements: legacy `jobs` first, then the
 * `job_postings` fallback only if the first missed. `legacyRows` drives that branch.
 */
function makeDb(legacyRows: unknown[] = [], postingRows: unknown[] = []) {
  const queries: Query[] = [];
  const queue = [legacyRows, postingRows];
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => {
      const q: Query = { selection };
      queries.push(q);
      const node: Record<string, unknown> = {
        from: (t: unknown) => ((q.from = t), node),
        where: (c: unknown) => ((q.where = c), node),
        limit: (n: number) => ((q.limit = n), Promise.resolve(queue.shift() ?? [])),
      };
      return node;
    }),
  };
  return { repo: new JobsRepository(db as never), queries, db };
}

const projectionOf = (q: Query): string => Object.values(q.selection!).map(render).join(" | ");

describe("findWorkerVisibleJobById — the legacy path is tried first and short-circuits", () => {
  it("issues ONE statement when the legacy job resolves", async () => {
    const { repo, queries } = makeDb([{ id: JOB_ID }]);
    const out = await repo.findWorkerVisibleJobById(JOB_ID);
    // No second round-trip for the overwhelmingly common legacy hit.
    expect(queries).toHaveLength(1);
    expect(out).toEqual({ id: JOB_ID });
  });

  it("falls back to `job_postings` only when the legacy lookup misses", async () => {
    const { repo, queries } = makeDb([], [{ id: JOB_ID }]);
    const out = await repo.findWorkerVisibleJobById(JOB_ID);
    // ADR-0036: the feed serves postings, so a tapped/applied id is a POSTING id and the
    // legacy query cannot match it. Without this the detail screen had only the light
    // title/place it was handed.
    expect(queries).toHaveLength(2);
    expect(out).toEqual({ id: JOB_ID });
  });

  it("returns undefined when NEITHER resolves", async () => {
    const { repo } = makeDb([], []);
    // The service turns this into the neutral 404 — an unknown id and a CLOSED job are
    // byte-identical, so there is no closed-vs-unknown oracle.
    expect(await repo.findWorkerVisibleJobById(JOB_ID)).toBeUndefined();
  });
});

describe("findWorkerVisibleJobById — BOTH statements gate on status='open'", () => {
  it.each([
    ["legacy", 0, [] as unknown[], [{ id: JOB_ID }]],
    ["posting", 1, [], [{ id: JOB_ID }]],
  ])("the %s query filters on open", async (_label, index, legacy, posting) => {
    const { repo, queries } = makeDb(legacy, posting);
    await repo.findWorkerVisibleJobById(JOB_ID);
    const where = render(queries[index]!.where);
    // The no-oracle rule lives in the WHERE, not in a post-filter: a closed job must fold
    // into `undefined` exactly like an unknown id. The fallback has to carry the SAME rule
    // or a closed posting becomes readable through the back door.
    expect(where).toContain('"status"');
    expect(queries[index]!.limit).toBe(1);
  });
});

describe("findWorkerVisibleJobById — the PII-free SHOW set (ADR-0024 §Surfaces)", () => {
  it("the V1 fallback never selects employer identity or internal bookkeeping", async () => {
    const { repo, queries } = makeDb([], [{ id: JOB_ID }]);
    await repo.findWorkerVisibleJobById(JOB_ID);
    const projection = projectionOf(queries[1]!);

    // `org_label` sits one line from `role_title` in the schema, and `payer_id` one from
    // `city`. ADR-0024 is stricter than a masked descriptor: employer identity is off the
    // worker path ENTIRELY. `applicants_received`/`status` are internal bookkeeping.
    expect(projection).not.toContain("org_label");
    expect(projection).not.toContain("payer_id");
    expect(projection).not.toContain("created_by");
    expect(projection).not.toContain("verification_status");
  });

  it("the V1 fallback never back-fills `city` from the free-text location_label", async () => {
    const { repo, queries } = makeDb([], [{ id: JOB_ID }]);
    await repo.findWorkerVisibleJobById(JOB_ID);
    const city = render(queries[1]!.selection!.city);

    // `location_label` is up to 200 chars of poster-typed free text, EXEMPT from the PII
    // heuristic by design (job-postings.dto.ts screens `description` only), and may name
    // the site or the employer — "Near <Employer> gate 3". COALESCEing it into `city`
    // reads as a one-word convenience and is the same leak match-feed.service.ts already
    // refuses for `area`. A posting with no coarse bucket returns NULL; the client hides
    // the row rather than being shown an address.
    expect(city).toContain("city");
    expect(city).not.toContain("location_label");
    expect(projectionOf(queries[1]!)).not.toContain("location_label");
  });

  it("the V1 fallback INVENTS nothing — absent posting fields are literal NULL", async () => {
    const { repo, queries } = makeDb([], [{ id: JOB_ID }]);
    await repo.findWorkerVisibleJobById(JOB_ID);
    const sel = queries[1]!.selection!;

    // `job_postings` carries no trade, area, experience window, benefits or requirements.
    // Null is the honest answer the client hides; back-deriving a trade through a bridge
    // the spec retired, or widening the experience window to a default, would be
    // fabricated content on a worker-facing screen.
    for (const field of [
      "tradeKey",
      "area",
      "minExperienceYears",
      "maxExperienceYears",
      "benefits",
      "requirements",
    ]) {
      expect(render(sel[field]), `${field} must be a literal NULL`).toMatch(/^NULL$/i);
    }
  });
});
