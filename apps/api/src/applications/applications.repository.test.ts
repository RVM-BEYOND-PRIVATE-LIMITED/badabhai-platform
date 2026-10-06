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

/** The joins whose ON clause mentions a table, by compiled text. */
const joinsOn = (captured: Captured, table: string) =>
  captured.joins.filter((j) => render(j.on).includes(table));

describe("findApplicationsByWorker — a decision from EITHER surface must show", () => {
  it("LEFT JOINs both `jobs` and `job_postings` — never an INNER JOIN", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);

    // THE REGRESSION THIS FILE EXISTS FOR. A V1 decision carries `job_posting_id` and
    // leaves `job_id` NULL, so the old `innerJoin(jobs)` silently dropped every one of
    // them: the worker applied from the V1 feed and the Applied tab still read empty.
    // An INNER JOIN on EITHER table reintroduces it (job_postings-inner would drop
    // every legacy decision instead).
    // THREE joins since #1051 — `jobs`, `job_postings`, and `job_reach` for the V1 subtitle.
    // The count is asserted so a fourth cannot arrive unnoticed; what matters is the KIND.
    expect(captured.joins).toHaveLength(3);
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

/**
 * THE APPLIED TAB MUST NEVER RENDER AN INTERNAL ID (#1027).
 *
 * `GET /feed` deliberately fills its legacy `trade_key` slot with the matched `mskill_*` id —
 * V1 has no trade on the posting, and `match-feed.service.test.ts` pins that on purpose so an
 * unknown skill is still findable in the audit trail. The worker app is safe from it only
 * because it never renders `FeedItem.tradeKey`: the feed card builds from `title`/`city`/`pay`/
 * `shift` plus `matchedSkillLabel`, a closed-set label.
 *
 * The Applied tab is the one screen that DOES interpolate a trade key —
 * `applied_jobs_screen.dart:181` renders `'${job.tradeKey} · $place'` — and it reads
 * `AppliedJob.tradeKey`, which comes from HERE. The only thing standing between an internal id
 * and that subtitle is this projection being a bare `jobs.trade_key` with no `job_postings` arm.
 *
 * Which makes the tempting change the dangerous one. Every neighbouring field in this selection
 * is a `coalesce(jobs.x, job_postings.y)`, so `tradeKey` reads like the one that was forgotten,
 * and `job_postings` has an obvious-looking candidate one word away. Adding it would put
 * `mskill_mig_welder` on a worker's card in the reading language of a job title. `NULL` is the
 * honest answer for a V1 decision, and the client already renders the subtitle without it.
 */
describe("findApplicationsByWorker — the trade_key boundary (#1027)", () => {
  it("projects `jobs.trade_key` ALONE — no coalesce, no `job_postings` arm", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);
    const tradeKey = col(captured, "tradeKey");

    expect(tradeKey).toContain("trade_key");
    // A coalesce here is the regression: whatever the second arm was, it would be a
    // `job_postings` value reaching a subtitle that reads as a trade name.
    expect(tradeKey).not.toMatch(/coalesce/i);
    expect(tradeKey).not.toContain("job_postings");
  });

  /**
   * SUPERSEDED DELIBERATELY ON 2026-08-20 — left as a record rather than deleted.
   *
   * This block used to assert "never reaches a matched-skill id from this statement", on the
   * grounds that the Applied tab had no use for it. #1051 proved the opposite: `trade_key` is
   * NULL for every V1 decision, so with no reach join the subtitle a worker reads says nothing
   * about the WORK — only the place. The id is now joined on purpose.
   *
   * The invariant did not disappear, it moved. It was never "the repository must not know the
   * id"; it was "a worker must never read one". The repository projects the ID, the service
   * turns it into a closed-set LABEL, and the tests below pin both halves of that seam.
   */
  it("DOES join the reach row's matched-skill id — the V1 subtitle has no other source", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);

    expect(col(captured, "matchedSkillId")).toContain("matched_skill_id");
  });

  it("joins `job_reach` on its FULL primary key, so a decision cannot fan out", async () => {
    // job_reach's PK is exactly (job_posting_id, worker_id). Joining on only one of them would
    // multiply a decision by every other posting that worker can reach — silently, and only
    // for a worker with more than one reach row, which is every real worker and no fixture.
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);

    const reach = joinsOn(captured, "job_reach");
    expect(reach).toHaveLength(1);
    const on = render(reach[0]!.on);
    expect(on).toContain("job_posting_id");
    expect(on).toContain("worker_id");
  });

  it("LEFT joins it, so a legacy decision with no reach row still appears", async () => {
    // All 17 live applications are legacy and have no reach row. An INNER join here would
    // empty the Applied tab outright — a worse regression than the one #1051 was raised for.
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);

    expect(joinsOn(captured, "job_reach")[0]!.kind).toBe("left");
  });

  it("lets NO other projected column carry the raw skill id", async () => {
    // The id may be in the row; it may not sit where a client would render it. Only
    // `matchedSkillId` — a name no subtitle reaches for — is allowed to carry it.
    const { repo, captured } = makeDb();
    await repo.findApplicationsByWorker(WORKER);

    for (const [name, expr] of Object.entries(captured.selection!)) {
      if (name === "matchedSkillId") continue;
      expect(render(expr)).not.toContain("matched_skill_id");
    }
  });
});

/**
 * TD73 — `GET /feed` must exclude the worker's APPLIED jobs SERVER-SIDE.
 *
 * WHY THIS NEEDS ITS OWN TEST. The exclusion is a `NOT EXISTS` inside the WHERE, and
 * every service/controller test mocks `findOpenJobs`, so deleting the anti-join leaves
 * the whole api suite green. The failure it guards against is not cosmetic: `LIMIT 50`
 * applies BEFORE any client-side filter, so once a worker decides the first 50 open jobs
 * the deck is empty forever while undecided jobs 51+ never surface (WA-1).
 *
 * The position of the anti-join is the assertion that matters. In the WHERE it shrinks
 * the set the LIMIT then pages; anywhere after it, the page is already chosen.
 */
describe("findOpenJobs — TD73 applied-exclusion (the WA-1 starvation guard)", () => {
  it("excludes applied jobs with a NOT EXISTS anti-join in the WHERE", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50);

    const where = render(captured.where).toLowerCase();
    expect(where).toContain("not exists");
    expect(where).toContain("applications");
    // Scoped to THIS worker and THIS job — a bare NOT EXISTS on the table would
    // empty the feed for everyone the moment any worker applied to anything.
    expect(where).toContain("worker_id");
    expect(where).toContain("job_id");
  });

  it("excludes ONLY `applied` — skips keep re-serving (owner ruling 2026-07-21)", async () => {
    // Deliberate, not an oversight: re-serving skips preserves the ADR-0009 mind-change
    // path. If a future change starts excluding skips too, that is a PRODUCT decision and
    // this assertion is where it must be argued.
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50);

    const where = render(captured.where).toLowerCase();
    expect(where).toContain("'applied'");
    expect(where).not.toContain("'skipped'");
  });

  it("still restricts to OPEN jobs, and pages AFTER the exclusion", async () => {
    // The ordering of these two is the whole point of TD73: filter, then limit.
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50);

    // `status` is BOUND ($1) while `action = 'applied'` is inlined — the anti-join is
    // raw SQL, the eq() is not. Assert on the column, not on a literal that never appears.
    expect(render(captured.where).toLowerCase()).toContain('"jobs"."status" =');
    expect(captured.limit).toBe(50);
  });

  it("adds the optional trade/city filters without dropping the anti-join", async () => {
    // TD66 will push more filters through this seam. Whatever else it adds, the
    // exclusion must survive — a filtered feed that re-serves applied jobs is the
    // same bug in a smaller window.
    // (`cnc_operator`, not the old `welding`: `tradeKey` is now typed `TradeKey`, since the
    // service drops an unknown value before it reaches this layer — #1905.)
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50, { tradeKey: "cnc_operator", city: "Pune" });

    const where = render(captured.where).toLowerCase();
    expect(where).toContain("not exists");
    expect(where).toContain("trade_key");
    expect(where).toContain("city");
  });
});

/**
 * #1905 — `shift` and `pay_min` reached the service and were DROPPED here: `findOpenJobs` took
 * only trade/city, so a worker who picked "Night" got every shift back. Every service test
 * mocks this method, so only a statement-level test can see the predicate land.
 *
 * The rule is V1's (match-feed.repository.ts `listFeed`), from the shared helpers in
 * feed-filter.predicates.ts; their own test pins the exact SQL. Here: they are WIRED, they
 * keep the NULL arm, they ride alongside the TD73 anti-join, and they stay OFF unless sent.
 */
describe("findOpenJobs — shift and pay floor (#1905)", () => {
  /** WHERE text + bound params of one captured statement. */
  const whereOf = (captured: Captured) => {
    const q = dialect.sqlToQuery(sql`${captured.where}` as SQL);
    return { text: q.sql.replace(/\s+/g, " "), params: q.params };
  };

  it("applies the shift filter NULL-tolerantly — an unstated shift is never excluded", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50, { shift: "night" });

    const { text, params } = whereOf(captured);
    expect(text).toContain('("jobs"."shift" is null or "jobs"."shift" = $');
    expect(params).toContain("night");
  });

  it("applies the pay floor to the TOP of the band, NULL-tolerantly — an open-ended band is never excluded", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50, { payMin: 20000 });

    const { text, params } = whereOf(captured);
    expect(text).toContain('("jobs"."pay_max" is null or "jobs"."pay_max" >= $');
    expect(text).not.toContain('"jobs"."pay_min"');
    expect(params).toContain(20000);
  });

  it("keeps every other predicate when shift + pay ride along", async () => {
    // A filtered feed that lost the TD73 anti-join (or `status = 'open'`) re-serves applied
    // or closed jobs in a smaller window: the same bug, harder to see.
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50, {
      tradeKey: "fitter",
      city: "Pune",
      shift: "day",
      payMin: 15000,
    });

    const text = whereOf(captured).text.toLowerCase();
    expect(text).toContain("not exists");
    expect(text).toContain('"jobs"."status" =');
    expect(text).toContain('"jobs"."trade_key" =');
    expect(text).toContain('"jobs"."city" =');
    expect(text).toContain('"jobs"."shift"');
    expect(text).toContain('"jobs"."pay_max"');
    expect(captured.limit).toBe(50);
  });

  it("adds NOTHING when the worker sent neither — filters are wide or off (ADR-0036 Part 3)", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 50, {});

    const { text } = whereOf(captured);
    expect(text).not.toContain('"jobs"."shift"');
    expect(text).not.toContain('"jobs"."pay_max"');
  });
});


// ---------------------------------------------------------------------------
// #1649 — the feed carried no posting date and was ordered OLDEST FIRST, under a
// Jobs-tab header that said "Aaj N naye jobs" (today / new). A job seeded months ago
// was counted as posted today AND led the deck.
//
// STRUCTURAL, for the same reason the file exists: the service test mocks this method,
// so reverting the ORDER BY leaves every service/controller test green. What is provable
// without Postgres is that the statement says the right thing.
// ---------------------------------------------------------------------------
describe("#1649 — findOpenJobs orders NEWEST FIRST and projects the posting date", () => {
  it("orders by created_at DESC, then id ASC", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 20);

    const order = (captured.orderBy ?? []).map(render);
    expect(order).toHaveLength(2);
    // The recency key, descending. It was `asc` — the deck literally led with the
    // stalest job on the platform while the header claimed the opposite.
    expect(order[0]).toMatch(/created_at/);
    expect(order[0]).toMatch(/desc/i);
    // `id ASC` stays the tiebreak, and is what keeps the order TOTAL: two jobs created
    // in the same transaction must not swap between page loads (E11/Policy 7). ASC on
    // purpose — the tiebreak is for stability, not recency.
    expect(order[1]).toMatch(/"id"/);
    expect(order[1]).not.toMatch(/desc/i);
  });

  it("selects created_at, so the feed can carry an honest posted_at", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 20);

    // The column has to be in the PROJECTION, not merely in the ORDER BY: a sort key is
    // invisible to the client, and `posted_at` is what lets the app print "N naye jobs
    // (aaj)" and badge a fresh card instead of guessing from position.
    expect(Object.keys(captured.selection ?? {})).toContain("createdAt");
  });

  it("still never selects a column that could carry employer identity", async () => {
    // Guard on the widened projection: `created_at` is a timestamp, and adding it must
    // not have been the moment something else slipped in beside it.
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 20);
    const keys = Object.keys(captured.selection ?? {});
    for (const forbidden of ["payerId", "payer_id", "orgLabel", "applicantsReceived", "status"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// =============================================================================================
// Migration 0131 — the job's display ROLE reaches the legacy worker feed as CARD ART (owner
// ruling 2026-10-05, ADR-0024 addendum; supersedes the 2026-09-29 "on no worker read" pin).
// It is a PROJECTION only: never a WHERE or ORDER BY input (ADR-0036 addendum 2026-09-29).
// =============================================================================================
describe("migration 0131 — findOpenJobs projects role_kind for the card, and never filters on it", () => {
  it("selects jobs.role_kind", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 20);
    expect(col(captured, "roleKind")).toContain('"jobs"."role_kind"');
  });

  it("keeps role_kind out of the WHERE and the ORDER BY — even with every filter sent", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenJobs(WORKER, 20, {
      tradeKey: "cnc_operator",
      city: "Pune",
      shift: "night",
      payMin: 20000,
    });
    expect(captured.where).toBeDefined(); // vacuity guard
    expect(render(captured.where)).not.toContain("role_kind");
    expect((captured.orderBy ?? []).map(render).join(" | ")).not.toContain("role_kind");
  });
});

// =============================================================================================
// #1823 (ADR-0049) — THE INTERIM UNION'S READS. Every service test mocks these, so the
// predicates, the projection and the binding are provable only here (and, evaluated, in
// feed-union.db.test.ts). `compile` keeps the bound params, which `render` drops.
// =============================================================================================
const compile = (node: unknown) => {
  const c = dialect.sqlToQuery(sql`${node}` as SQL);
  return { sql: c.sql.replace(/\s+/g, " "), params: c.params };
};

/** The card columns (incl. `roleKind`, 2026-10-05) plus the id and the sort key — and nothing else. */
const POSTING_FEED_PROJECTION = [
  "area",
  "benefits",
  "city",
  "description",
  "id",
  "maxExperienceYears",
  "minExperienceYears",
  "neededBy",
  "payMax",
  "payMin",
  "payType",
  "publishedAt",
  "requirements",
  "roleKind",
  "roleTitle",
  "shift",
];

const MSKILL_A = "mskill_vmc_operator";
const MSKILL_B = "mskill_cnc_turner";

describe("#1823 findOpenPostingsForFeed — the projection is the card, and only the card", () => {
  it("projects EXACTLY the card columns plus id and published_at", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenPostingsForFeed(WORKER, 50, { wantedSkillIds: [] });
    // Vacuity guard: an explicit selection was passed at all (a bare select() is `undefined`).
    expect(captured.selection).toBeDefined();
    expect(Object.keys(captured.selection!).sort()).toEqual(POSTING_FEED_PROJECTION);
    expect(render(captured.from)).toContain('"job_postings"');
  });

  it.each([
    "org_label",
    "payer_id",
    "created_by",
    "location_label",
    "verification_status",
    "boosted_until",
    '"state"',
    "vacancy_band",
    "skill_ids",
    "skill_phrases",
    "match_skill_ids",
    "reach_skill_ids",
    "source_job_id",
  ])("never projects %s (ADR-0024 HIDDEN, or not a card field)", async (column) => {
    const { repo, captured } = makeDb();
    await repo.findOpenPostingsForFeed(WORKER, 50, { wantedSkillIds: [MSKILL_A], city: "Pune" });
    const projection = Object.values(captured.selection!).map(render).join(" | ");
    expect(projection).toContain('"role_title"'); // vacuity: the projection renders columns
    expect(projection).not.toContain(column);
  });
});

describe("#1823 findOpenPostingsForFeed — the §2.1 predicates, each separate", () => {
  async function whereOf(filters: {
    city?: string;
    shift?: "day" | "night" | "rotational";
    payMin?: number;
    wantedSkillIds: string[];
  }) {
    const { repo, captured } = makeDb();
    await repo.findOpenPostingsForFeed(WORKER, 50, filters);
    return compile(captured.where);
  }

  it("(1)+(2) open AND published — status is bound, published_at must be non-null", async () => {
    const { sql: text, params } = await whereOf({ wantedSkillIds: [] });
    expect(text).toMatch(/"job_postings"\."status" = \$\d/);
    expect(params).toContain("open");
    expect(text).toMatch(/"job_postings"\."published_at" is not null/i);
  });

  it("(3a)(3b)(4) are THREE separate NOT EXISTS — the applied anti-joins and the twin guard", async () => {
    const { sql: text, params } = await whereOf({ wantedSkillIds: [] });
    // Split at each NOT EXISTS: [prefix, (3a), (3b), (4)].
    const [, a3 = "", b3 = "", twin = ""] = text.split(/not exists/i);
    expect(text.match(/not exists/gi)).toHaveLength(3);

    // (3a) applied on THIS posting.
    expect(a3).toContain('"applications"."job_posting_id" = "job_postings"."id"');
    expect(a3).toContain("'applied'");
    expect(a3).not.toContain("source_job_id");
    // (3b) applied on its D4 SOURCE job.
    expect(b3).toContain('"applications"."job_id" = "job_postings"."source_job_id"');
    expect(b3).toContain("'applied'");
    // (4) the twin guard reads `jobs`, not `applications`, and only an OPEN source hides it.
    expect(twin).toMatch(/from "jobs"/i);
    expect(twin).toContain('"jobs"."id" = "job_postings"."source_job_id"');
    expect(twin).toContain(`"jobs"."status" = 'open'`);
    expect(twin).not.toContain('"applications"');

    // Both anti-joins scope to THIS worker, bound — never interpolated.
    expect(a3).toMatch(/"applications"\."worker_id" = \$\d/);
    expect(b3).toMatch(/"applications"\."worker_id" = \$\d/);
    expect(params.filter((p) => p === WORKER)).toHaveLength(2);
  });

  it("excludes only APPLIED — a skipped posting is re-served (TD73, O4)", async () => {
    const { sql: text } = await whereOf({ wantedSkillIds: [] });
    expect(text).toContain("'applied'");
    expect(text).not.toContain("'skipped'");
  });

  it("(5) the #1240 `?|` gate binds the wanted ids as ONE text[] parameter", async () => {
    const { sql: text, params } = await whereOf({ wantedSkillIds: [MSKILL_A, MSKILL_B] });
    expect(text).toMatch(/"job_postings"\."reach_skill_ids" \?\| \$\d+::text\[\]/);
    // ONE array param — a bare JS array would expand to a RECORD and 42846 at runtime.
    expect(params).toContainEqual([MSKILL_A, MSKILL_B]);
    expect(params).not.toContain(MSKILL_A);
    expect(text).not.toContain(MSKILL_A);
    // ANY overlap, never ALL.
    expect(text).not.toContain("?&");
  });

  it("(5) with NO wanted skills there is no `?|` at all — every posting passes (#1240)", async () => {
    const { sql: text } = await whereOf({ wantedSkillIds: [] });
    expect(text).not.toContain("?|");
    expect(text).not.toContain("reach_skill_ids");
  });

  it("(6) city is NULL-tolerant and case-insensitive, and only when supplied", async () => {
    const withCity = await whereOf({ wantedSkillIds: [], city: "Pune" });
    expect(withCity.sql).toMatch(
      /\(\s*"job_postings"\."city" is null or lower\("job_postings"\."city"\) = lower\(\$\d+::text\)\s*\)/i,
    );
    expect(withCity.params).toContain("Pune");
    expect(withCity.sql).not.toContain("'Pune'");

    const without = await whereOf({ wantedSkillIds: [] });
    expect(without.sql).not.toContain("lower(");
    expect(without.sql).not.toContain('"job_postings"."city"');
  });

  it("never filters by trade or role (O7) — not even when every other filter is sent", async () => {
    const { sql: text } = await whereOf({
      wantedSkillIds: [MSKILL_A],
      city: "Pune",
      shift: "night",
      payMin: 20000,
    });
    for (const column of ["trade_key", "role_kind"]) {
      expect(text).not.toContain(column);
    }
  });

  it("(7) shift + pay floor: the jobs arm's NULL-tolerant predicates, bound, only when sent (#1905)", async () => {
    const withBoth = await whereOf({ wantedSkillIds: [], shift: "night", payMin: 20000 });
    expect(withBoth.sql).toMatch(
      /\("job_postings"\."shift" is null or "job_postings"\."shift" = \$\d+\)/,
    );
    expect(withBoth.sql).toMatch(
      /\("job_postings"\."pay_max" is null or "job_postings"\."pay_max" >= \$\d+\)/,
    );
    expect(withBoth.params).toEqual(expect.arrayContaining(["night", 20000]));
    // The floor is compared to the TOP of the band, never its bottom.
    expect(withBoth.sql).not.toContain('"job_postings"."pay_min"');

    const without = await whereOf({ wantedSkillIds: [] });
    expect(without.sql).not.toContain('"job_postings"."shift"');
    expect(without.sql).not.toContain('"job_postings"."pay_max"');
  });

  it("orders published_at DESC, then id ASC, and pages by `limit`", async () => {
    const { repo, captured } = makeDb();
    await repo.findOpenPostingsForFeed(WORKER, 37, { wantedSkillIds: [] });
    const order = (captured.orderBy ?? []).map(render);
    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/"published_at" desc/i);
    expect(order[1]).toMatch(/"job_postings"\."id" asc/i);
    expect(captured.limit).toBe(37);
  });
});

describe("#1823 findOpenPostingRef — existence of an OPEN posting, id only", () => {
  it("projects the id alone and requires status = 'open'", async () => {
    const { repo, captured } = makeDb([{ id: "p-1" }]);
    const out = await repo.findOpenPostingRef("p-1");

    expect(out).toEqual({ id: "p-1" });
    expect(Object.keys(captured.selection ?? {})).toEqual(["id"]);
    expect(render(captured.from)).toContain('"job_postings"');
    const { sql: text, params } = compile(captured.where);
    expect(text).toMatch(/"job_postings"\."id" = \$\d/);
    expect(text).toMatch(/"job_postings"\."status" = \$\d/);
    expect(params).toEqual(["p-1", "open"]);
    expect(captured.limit).toBe(1);
  });

  it("returns undefined on a miss", async () => {
    const { repo } = makeDb([]);
    await expect(repo.findOpenPostingRef("p-404")).resolves.toBeUndefined();
  });
});

/**
 * #1823 — the ops applicants read covers both id spaces as TWO single-column reads the
 * service chooses between, never one `job_id = $1 OR job_posting_id = $1`: the OR cannot be
 * served by `applications_job_id_idx` alone, so it would move every legacy read off its
 * index. Each WHERE is pinned to exactly one column.
 */
describe("#1823 the ops applicants reads — one id space each, never an OR", () => {
  it("findApplicantsByJob matches job_id ONLY, with the cap kept", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicantsByJob("id-1");
    const { sql: text, params } = compile(captured.where);
    expect(text).toMatch(/^"applications"\."job_id" = \$1$/);
    expect(text).not.toContain("job_posting_id");
    expect(text).not.toMatch(/ or /i);
    expect(params).toEqual(["id-1"]);
    expect(captured.limit).toBeGreaterThan(0);
  });

  it("findApplicantsByPosting matches job_posting_id ONLY, same order and cap", async () => {
    const { repo, captured } = makeDb();
    await repo.findApplicantsByPosting("p-1");
    const { sql: text, params } = compile(captured.where);
    expect(text).toMatch(/^"applications"\."job_posting_id" = \$1$/);
    expect(text).not.toMatch(/"job_id"/);
    expect(params).toEqual(["p-1"]);
    expect(render(captured.orderBy![0])).toMatch(/"applications"\."created_at" asc/i);

    const legacy = makeDb();
    await legacy.repo.findApplicantsByJob("id-1");
    expect(captured.limit).toBe(legacy.captured.limit);
  });

  it("legacyJobExists reads `jobs` by id ONLY — no status predicate (a closed job has applicants), id-only projection", async () => {
    const hit = makeDb([{ id: "j-1" }]);
    await expect(hit.repo.legacyJobExists("j-1")).resolves.toBe(true);
    expect(Object.keys(hit.captured.selection!)).toEqual(["id"]);
    expect(render(hit.captured.from)).toContain('"jobs"');
    const { sql: text, params } = compile(hit.captured.where);
    expect(text).toMatch(/^"jobs"\."id" = \$1$/);
    expect(text).not.toContain("status");
    expect(params).toEqual(["j-1"]);
    expect(hit.captured.limit).toBe(1);

    const miss = makeDb([]);
    await expect(miss.repo.legacyJobExists("j-404")).resolves.toBe(false);
  });
});
