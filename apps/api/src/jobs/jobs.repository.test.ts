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

// =============================================================================================
// searchOpenPostings (#822)
// =============================================================================================

/**
 * WHY THIS BLOCK EXISTS. `jobs.service.test.ts` drives `searchJobs` against a MOCKED repository,
 * so every acceptance criterion of #822 that lives in SQL rather than in the mapper was
 * unverified: partial-and-case-insensitive city, the state filter, the deterministic order, and
 * the already-decided exclusion. Each is a one-word edit away from silently regressing — `ILIKE`
 * to `=` narrows a worker's results to nothing, and the whole api suite stays green.
 *
 * Statement facts, like the blocks above: this asserts the SQL the repository BUILDS, not what
 * Postgres does with it.
 */
const WORKER_ID = "11111111-1111-4111-8111-111111111111";

interface SearchQuery extends Query {
  orderBy?: unknown[];
  offset?: number;
}

/** The search chain is `select().from().where().orderBy().limit().offset()` — offset resolves. */
function makeSearchDb(rows: unknown[] = []) {
  const queries: SearchQuery[] = [];
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => {
      const q: SearchQuery = { selection };
      queries.push(q);
      const node: Record<string, unknown> = {
        from: (t: unknown) => ((q.from = t), node),
        where: (c: unknown) => ((q.where = c), node),
        orderBy: (...o: unknown[]) => ((q.orderBy = o), node),
        limit: (n: number) => ((q.limit = n), node),
        offset: (n: number) => ((q.offset = n), Promise.resolve(rows)),
      };
      return node;
    }),
  };
  return { repo: new JobsRepository(db as never), queries };
}

const SEARCH_ARGS = {
  workerId: WORKER_ID,
  q: null as string | null,
  city: null as string | null,
  state: null as string | null,
  limit: 20,
  offset: 0,
};

/** Compile a node to `{ sql, params }` — the params matter for the wildcard assertions. */
const compile = (node: unknown) => {
  const c = dialect.sqlToQuery(sql`${node}` as SQL);
  return { sql: c.sql.replace(/\s+/g, " "), params: c.params };
};

describe("searchOpenPostings — the filters #822 specifies", () => {
  it("ALWAYS gates on status='open', with or without filters", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings(SEARCH_ARGS);
    expect(compile(queries[0]!.where).sql).toMatch(/"status" = \$\d/);
  });

  it("city is a PARTIAL, case-insensitive match — never the feed's exact equality", async () => {
    // The one-word regression this pins: ILIKE '%pune%' becoming = 'pune' turns "pun" from a
    // search into zero results, which reads to a worker as "there are no jobs".
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings({ ...SEARCH_ARGS, city: "pun" });
    const { sql: text, params } = compile(queries[0]!.where);
    expect(text).toMatch(/"city" ilike \$\d/i);
    expect(params).toContain("%pun%");
  });

  it("state filters the same way", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings({ ...SEARCH_ARGS, state: "maha" });
    const { sql: text, params } = compile(queries[0]!.where);
    expect(text).toMatch(/"state" ilike \$\d/i);
    expect(params).toContain("%maha%");
  });

  it("q matches the role title OR a skill phrase", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings({ ...SEARCH_ARGS, q: "welder" });
    const { sql: text, params } = compile(queries[0]!.where);
    expect(text).toMatch(/"role_title" ilike \$\d/i);
    expect(text).toMatch(/jsonb_array_elements_text/i);
    expect(params).toContain("%welder%");
  });

  it("a worker's wildcards are LITERAL — the term is a parameter, never interpolated", async () => {
    // Interpolating would let a search box become a wildcard the worker never asked for and —
    // with the term inside the statement text — an injection surface.
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings({ ...SEARCH_ARGS, q: "100%_operator" });
    const { sql: text, params } = compile(queries[0]!.where);
    expect(text).not.toContain("100%_operator");
    expect(params).toContain("%100%_operator%");
  });

  it("omits every filter clause when no filter is given", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings(SEARCH_ARGS);
    expect(compile(queries[0]!.where).sql).not.toMatch(/ilike/i);
  });

  it("EXCLUDES what the worker already applied to or skipped, scoped to that worker", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings(SEARCH_ARGS);
    const { sql: text, params } = compile(queries[0]!.where);
    expect(text).toMatch(/not exists/i);
    expect(text).toMatch(/job_posting_id/);
    // Keyed on the BEARER's worker id — the exclusion must never be shapeable from a query param.
    expect(params).toContain(WORKER_ID);
  });
});

describe("searchOpenPostings — deterministic order and paging (§3: AI must not rank)", () => {
  it("orders by relevance, then published_at DESC NULLS LAST, then id — a total order", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings({ ...SEARCH_ARGS, q: "welder" });
    const order = queries[0]!.orderBy!.map((o) => compile(o).sql);

    expect(order).toHaveLength(3);
    expect(order[0]).toMatch(/case when/i); // the relevance ladder
    expect(order[1]).toMatch(/"published_at" DESC NULLS LAST/i);
    // `id` LAST is what makes the order TOTAL. Without it two postings published in the same
    // transaction tie, and page 2 can repeat or drop a row page 1 already showed.
    expect(order[2]).toMatch(/"id"/);
  });

  it("ranks a prefix title hit above a substring hit", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings({ ...SEARCH_ARGS, q: "weld" });
    const { params } = compile(queries[0]!.orderBy![0]);
    // Prefix (`weld%`) is tier 0; contains (`%weld%`) is tier 1; anything else is tier 2.
    expect(params).toContain("weld%");
    expect(params).toContain("%weld%");
  });

  it("is a CONSTANT order with no query — never random, never AI-scored", async () => {
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings(SEARCH_ARGS);
    const order = queries[0]!.orderBy!.map((o) => compile(o).sql).join(" ");
    expect(order).not.toMatch(/random|score|embedding|similarity/i);
  });

  it("probes limit+1 to learn has_more, and returns only `limit` rows", async () => {
    // 21 rows back for a limit of 20: the 21st exists ONLY to answer "is there another page?"
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `job-${i}` }));
    const { repo, queries } = makeSearchDb(rows);

    const out = await repo.searchOpenPostings({ ...SEARCH_ARGS, limit: 20, offset: 40 });

    expect(queries[0]!.limit).toBe(21);
    expect(queries[0]!.offset).toBe(40);
    expect(out.rows).toHaveLength(20);
    expect(out.hasMore).toBe(true);
  });

  it("reports has_more=false when the probe row does not come back", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `job-${i}` }));
    const { repo } = makeSearchDb(rows);
    const out = await repo.searchOpenPostings({ ...SEARCH_ARGS, limit: 20 });
    expect(out.rows).toHaveLength(20);
    expect(out.hasMore).toBe(false);
  });
});

describe("searchOpenPostings — the PII-free projection", () => {
  it("selects NO employer identity, payer id, or free-text location", async () => {
    // Same rule the detail read enforces: one added column here reaches every worker's search
    // results, and the service maps whatever it is handed.
    const { repo, queries } = makeSearchDb();
    await repo.searchOpenPostings(SEARCH_ARGS);
    const projection = projectionOf(queries[0]!).toLowerCase();

    for (const forbidden of ["org_label", "payer_id", "location_label", "contact", "employer"]) {
      expect(projection, `${forbidden} must never be selected`).not.toContain(forbidden);
    }
  });
});
