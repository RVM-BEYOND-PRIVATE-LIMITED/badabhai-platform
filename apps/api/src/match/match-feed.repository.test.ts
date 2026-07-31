import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { MatchFeedRepository } from "./match-feed.repository";

/**
 * MOMENTS ④ AND ⑥ — the two READ paths of Matching V1 (ADR-0036 §2/§4/§7).
 *
 * WHY THIS FILE EXISTS AT ALL. The rank tuple lives in exactly two places in the
 * codebase: `rankKeyCompare` in `@badabhai/match-engine`, and the `ORDER BY` in
 * {@link MatchFeedRepository.listCandidates}. The service layer above it deliberately
 * does NOT re-sort (asserted in `match-candidates.service.test.ts`), which means the
 * SQL below is the ONLY thing that decides who a company sees first after paying ₹40.
 * A swapped key or a lost `COALESCE` there produces a list that renders perfectly and
 * is ordered by a rule nobody ratified — the exact failure ADR-0036 §2 was written to
 * make impossible ("no future config change can silently violate them").
 *
 * WHAT IS AND IS NOT PROVEN HERE. These are STRUCTURAL tests: the raw `sql` template is
 * captured, compiled with the real `PgDialect`, and asserted on its TEXT and its BOUND
 * PARAMETERS — the `reach.repository.test.ts` / `worker-skills.repository.test.ts`
 * house pattern. Nothing here proves Postgres AGREES: that `applications_rank_idx` is
 * actually chosen, or that this ORDER BY and `rankKeyCompare` produce the same
 * permutation over real rows. That equivalence is `rank-parity.test.ts`, which skips
 * without `RUN_DB_TESTS=1` — a disclosed gap. What IS provable without a database is
 * that the statement SAYS the right thing, and that is where the silent bugs live.
 */

const dialect = new PgDialect();
const WORKER = "11111111-1111-4111-8111-111111111111";
const POSTING = "22222222-2222-4222-8222-222222222222";

interface Executed {
  sql: string;
  params: unknown[];
}

/**
 * Capture every `db.execute()` and compile it. `rows` is what the statement returns,
 * so the row-mapping half can be driven with the shapes `pg` really hands back
 * (dates as strings over the wire, integers as numbers).
 */
function makeDb(rows: unknown[] = []) {
  const statements: Executed[] = [];
  const db = {
    execute: (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as SQL);
      statements.push({ sql: q.sql.replace(/\s+/g, " "), params: q.params });
      return Promise.resolve(rows);
    },
  } as unknown as Database;
  return { repo: new MatchFeedRepository(db), statements };
}

/**
 * The ORDER BY clause, normalised to one line, without the trailing LIMIT.
 *
 * `lastIndexOf`, not `indexOf`: `listCandidates` carries a doc comment containing the
 * words "ORDER BY below", and slicing from THAT would fold the SELECT list into the
 * "clause" and make every assertion below vacuously true.
 */
function orderByOf(sql: string): string {
  const from = sql.lastIndexOf("ORDER BY");
  expect(from, "statement has an ORDER BY").toBeGreaterThan(-1);
  const to = sql.indexOf("LIMIT", from);
  return sql.slice(from, to === -1 ? undefined : to).trim();
}

/* ════════════════════════════════════════════════════════════════════════════
 * listFeed — MOMENT ④.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("listFeed — the order is boost, then recency, then a STABLE tiebreak", () => {
  it("orders by boosted DESC, published_at DESC NULLS LAST, id ASC — in that sequence", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, {});

    // ADR-0036 §7: boost "permutes order within what the worker already qualified for"
    // and does NOTHING else. Recency second. The `id ASC` tail is not decoration — it
    // is what makes this a TOTAL order, and without it two postings published in the
    // same transaction swap places on every fetch (E11/Policy 7: "a feed that reorders
    // between page loads is a bug"). Asserted as a SEQUENCE, because getting the three
    // keys present but in the wrong order is the failure that still looks plausible.
    const order = orderByOf(statements[0]!.sql);
    const boostAt = order.indexOf("boosted_until");
    const publishedAt = order.indexOf("jp.published_at DESC NULLS LAST");
    const idAt = order.indexOf("jp.id ASC");

    expect(publishedAt, "published_at DESC NULLS LAST must be in the ORDER BY").toBeGreaterThan(-1);
    expect(idAt, "the id ASC total-order tiebreak must be in the ORDER BY").toBeGreaterThan(-1);
    expect(boostAt).toBeLessThan(publishedAt);
    expect(publishedAt).toBeLessThan(idAt);
  });

  it("ranks by boost EXPIRY, never by a boolean column that could go stale", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, {});
    // `boosted_until > now()` self-expires. A stored `is_boosted` flag would keep
    // lifting a posting after the ₹999 window closed, and nothing would ever clear it.
    expect(orderByOf(statements[0]!.sql)).toContain("boosted_until > now()");
  });

  it("serves ONLY open postings — a paused posting leaves the worker's feed", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, {});
    const { sql } = statements[0]!;

    expect(sql).toContain("jp.status = 'open'");
    // Deliberately asymmetric with `reconcileReachForWorker`, which keeps `job_reach`
    // rows for BOTH open and paused so a resume is instant. Serving a paused posting
    // here would show a worker a vacancy the company has switched off.
    expect(sql).not.toContain("'paused'");
  });

  it("excludes any posting the worker has ALREADY decided on (applied OR skipped)", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, {});
    const { sql } = statements[0]!;

    // Spec moment ④ is `NOT EXISTS (applied / passed)`, and "passed" is a skip. The
    // NOT EXISTS is unqualified by action ON PURPOSE — narrowing it to `action =
    // 'applied'` would re-serve every job the worker already swiped away, which is the
    // legacy `/feed` behaviour V1 replaces.
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("FROM applications a");
    expect(sql).toContain("a.job_posting_id = jp.id");
    expect(sql).not.toContain("a.action");
  });

  it("scopes the reach join to the worker and binds his id, never inlines it", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, {});
    const { sql, params } = statements[0]!;

    expect(sql).toContain("FROM job_reach jr");
    expect(sql).toContain("jr.worker_id = $1::uuid");
    // Bound twice: the reach scope and the NOT EXISTS. An inlined uuid would be a
    // string-concatenated identifier on the hottest path in the product.
    expect(params[0]).toBe(WORKER);
    expect(params[1]).toBe(WORKER);
  });

  it("binds the limit as a parameter", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 42, {});
    expect(statements[0]!.params.at(-1)).toBe(42);
  });
});

describe("listFeed — the company NAME is not in the projection (ADR-0036's open question)", () => {
  it("selects an opaque company KEY and never org_label / verification_status", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, {});
    const { sql } = statements[0]!;

    // The max-2-consecutive-cards rule needs a key to group by, not a name to show.
    // ADR-0036 leaves "whether org_label renders on a worker card" open pending
    // security sign-off; if it is ever added to this projection it must be a decision,
    // not a mapper edit that nobody reviewed.
    expect(sql).toContain("COALESCE(jp.payer_id, jp.created_by)::text AS payer_key");
    expect(sql).not.toContain("org_label");
    expect(sql).not.toContain("verification_status");
  });
});

describe("listFeed — every filter is INERT unless the worker set it (Part 3)", () => {
  it("binds NULL for each unset filter, so the predicate short-circuits", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, {});
    // params: worker, worker, city, city, shift, shift, payMin, payMin, limit
    const { params } = statements[0]!;
    expect(params).toEqual([WORKER, WORKER, null, null, null, null, null, null, 10]);
  });

  it("binds the values the worker DID set, and leaves the rest null", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, { city: "Pune", payMin: 20000 });
    const { params } = statements[0]!;
    expect(params).toEqual([WORKER, WORKER, "Pune", "Pune", null, null, 20000, 20000, 10]);
  });

  it("a posting with a NULL city/shift/pay band survives EVERY filter", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, { city: "Pune", shift: "night", payMin: 20000 });
    const { sql } = statements[0]!;

    // "Every default is wide or off. Defaults that narrow are a volume leak." A job
    // whose city was never filled in must not vanish from a feed it belongs in — drop
    // these three escapes and a filter silently deletes supply instead of narrowing it.
    expect(sql).toContain("jp.city IS NULL");
    expect(sql).toContain("jp.shift IS NULL");
    expect(sql).toContain("jp.pay_max IS NULL");
  });

  it("matches city case-insensitively (a worker typing 'pune' is the same worker)", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, { city: "Pune" });
    expect(statements[0]!.sql).toContain("lower(jp.city) = lower($4::text)");
  });

  it("compares a pay floor against the TOP of the band, never the bottom", async () => {
    const { repo, statements } = makeDb();
    await repo.listFeed(WORKER, 10, { payMin: 20000 });
    const { sql } = statements[0]!;

    // A worker asking for >= 20000 must still see an 18000-25000 job: it CAN pay him
    // what he asked. Comparing against `jp.pay_min` instead would hide most of the
    // board from exactly the workers who set a floor, and the feed would just look thin.
    expect(sql).toContain("jp.pay_max >= $8::int");
    expect(sql).not.toContain("jp.pay_min >=");
  });
});

describe("listFeed — row mapping", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    job_posting_id: POSTING,
    payer_key: "aaaaaaaa-0000-4000-8000-00000000000a",
    match_tier: 1,
    matched_skill_id: "mskill_vmc_operator",
    boosted: false,
    published_at: "2026-07-30T10:00:00.000Z",
    role_title: "VMC Operator",
    city: "Pune",
    pay_min: 18000,
    pay_max: 25000,
    shift: "day",
    needed_by: null,
    ...over,
  });

  it("normalises the tier to {1,2} — only an exact 1 is an exact-skill match", async () => {
    // The column is a plain integer. A stray 0 or 3 handed on as-is would sort ABOVE
    // the posted-skill workers in the comparator and badge as neither tier.
    for (const [stored, expected] of [
      [1, 1],
      [2, 2],
      [3, 2],
      [0, 2],
    ] as const) {
      const { repo } = makeDb([raw({ match_tier: stored })]);
      const [row] = await repo.listFeed(WORKER, 10, {});
      expect(row!.matchTier, `stored ${stored}`).toBe(expected);
    }
  });

  it("turns the wire's published_at string into a Date, and keeps a null null", async () => {
    const { repo } = makeDb([raw()]);
    const [row] = await repo.listFeed(WORKER, 10, {});
    expect(row!.publishedAt).toBeInstanceOf(Date);
    expect(row!.publishedAt!.toISOString()).toBe("2026-07-30T10:00:00.000Z");

    const { repo: r2 } = makeDb([raw({ published_at: null })]);
    // `new Date(null)` is the epoch, not null — an unpublished posting must not read
    // as "published in 1970" and win the recency key outright.
    expect((await r2.listFeed(WORKER, 10, {}))[0]!.publishedAt).toBeNull();
  });

  it("carries the reach row's skill and the posting's display fields through", async () => {
    const { repo } = makeDb([raw({ boosted: true, needed_by: "immediate" })]);
    const [row] = await repo.listFeed(WORKER, 10, {});
    expect(row).toEqual({
      jobPostingId: POSTING,
      payerKey: "aaaaaaaa-0000-4000-8000-00000000000a",
      matchTier: 1,
      matchedSkillId: "mskill_vmc_operator",
      boosted: true,
      publishedAt: new Date("2026-07-30T10:00:00.000Z"),
      roleTitle: "VMC Operator",
      city: "Pune",
      payMin: 18000,
      payMax: 25000,
      shift: "day",
      neededBy: "immediate",
    });
  });

  it("returns [] for a worker no posting reaches (never undefined into the interleave)", async () => {
    const { repo } = makeDb([]);
    expect(await repo.listFeed(WORKER, 10, {})).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * listCandidates — MOMENT ⑥. The rank tuple's SQL half.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("listCandidates — the ORDER BY *is* the ratified rank key (ADR-0036 §2)", () => {
  it("sorts on the six keys in the spec's exact lexicographic sequence", async () => {
    const { repo, statements } = makeDb();
    await repo.listCandidates(POSTING, 36, 500);
    const order = orderByOf(statements[0]!.sql);

    // RANK KEY = ( effective_tier ASC, skill_months DESC, industry_months DESC,
    //              last_worked_at DESC NULLS LAST, created_at DESC, stable_hash ASC )
    //
    // The ORDER of these is the whole design. Swap keys 2 and 3 and invariant B —
    // "industry months can never promote a worker above another with more months in
    // the matched skill" — is broken, silently: the list still renders, still paginates,
    // still looks ranked, and a man with ten years in the factory but six months on the
    // machine outranks the machinist. Positions, not mere presence.
    const at = (needle: string) => {
      const i = order.indexOf(needle);
      expect(i, `${needle} must appear in the ORDER BY`).toBeGreaterThan(-1);
      return i;
    };
    const positions = [
      at("CASE"), // effective_tier
      at("COALESCE(a.skill_months, -1) DESC"),
      at("COALESCE(a.industry_months, -1) DESC"),
      at("a.last_worked_at DESC NULLS LAST"),
      at("a.created_at DESC"),
      at("a.id ASC"),
    ];
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it("reads UNKNOWN months as -1, so 'we never learned it' sorts BELOW a measured 0", async () => {
    const { repo, statements } = makeDb();
    await repo.listCandidates(POSTING, 36, 500);
    const order = orderByOf(statements[0]!.sql);

    // This mirrors `MatchCandidatesService.toRankInputs` (which maps null -> -1) and the
    // comparator. `COALESCE(x, 0)` in either place makes an unknown tie with a real zero
    // and the two halves of the rank tuple stop agreeing — which is precisely what
    // rank-parity.test.ts exists to catch, and what this catches without a database.
    expect(order).toContain("COALESCE(a.skill_months, -1)");
    expect(order).toContain("COALESCE(a.industry_months, -1)");
    expect(order).not.toContain("COALESCE(a.skill_months, 0) DESC");
  });

  it("promotes with `>=` the CONFIGURED floor, bound as a parameter (never a literal 36)", async () => {
    const { repo, statements } = makeDb();
    await repo.listCandidates(POSTING, 24, 500);
    const { sql, params } = statements[0]!;

    // effective_tier = (match_tier > 1 AND skill_months >= tier_floor_months) ? 1 : match_tier
    // `>` instead of `>=` moves the owner's E3 boundary by one month in the direction
    // that demotes a man who has exactly cleared three years.
    expect(sql).toContain("a.match_tier > 1 AND COALESCE(a.skill_months, 0) >= $2::int");
    expect(params).toEqual([POSTING, 24, 500]);
  });

  it("defaults a NULL stored tier to 2 — an unsnapshotted row never leads the list", async () => {
    const { repo, statements } = makeDb();
    await repo.listCandidates(POSTING, 36, 500);
    // A legacy/half-written application with no `match_tier` must sort as a related
    // match, not ahead of every exact-skill candidate the company actually wants.
    expect(orderByOf(statements[0]!.sql)).toContain("ELSE COALESCE(a.match_tier, 2)");
  });

  it("ranks ONLY applied rows — a skip is never a candidate", async () => {
    const { repo, statements } = makeDb();
    await repo.listCandidates(POSTING, 36, 500);
    const { sql } = statements[0]!;
    // `applications_rank_idx` is a PARTIAL index on exactly this predicate; losing it
    // both breaks the index and puts men who swiped a job away into the list a company
    // paid to read.
    expect(sql).toContain("a.action = 'applied'");
    expect(sql).toContain("a.job_posting_id = $1::uuid");
  });

  it("LEFT joins job_reach, so a pruned reach row cannot delete a real applicant", async () => {
    const { repo, statements } = makeDb();
    await repo.listCandidates(POSTING, 36, 500);
    const { sql } = statements[0]!;

    // The join exists only for the E18 badge. An INNER join would silently drop every
    // candidate whose reach row was pruned by a later profile re-derivation or a
    // posting edit — men who genuinely applied, vanishing from the list the company
    // bought, in the name of a display label. "Ranking never removes anyone" (Policy 6).
    expect(sql).toContain("LEFT JOIN job_reach jr");
    // ...and no OTHER join to job_reach sneaks in: every `JOIN job_reach` occurrence
    // must be preceded by LEFT. A plain/INNER one added later would reintroduce the
    // drop while the assertion above still passed.
    expect([...sql.matchAll(/(\w+)\s+JOIN\s+job_reach/g)].map((m) => m[1])).toEqual(["LEFT"]);
  });

  it("does NOT let the live badge column into the ORDER BY", async () => {
    const { repo, statements } = makeDb();
    await repo.listCandidates(POSTING, 36, 500);
    // `matched_skill_id` can drift when a worker's skills are re-derived. If it ever
    // entered the sort, a paid list would reorder between page loads for reasons
    // outside the frozen snapshot — E16/Policy 7 breakage.
    expect(orderByOf(statements[0]!.sql)).not.toContain("matched_skill_id");
  });
});

describe("listCandidates — row mapping", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: "33333333-3333-4333-8333-333333333333",
    worker_id: "44444444-4444-4444-8444-444444444444",
    match_tier: 2,
    skill_months: 42,
    industry_months: 60,
    last_worked_at: "2026-05-15",
    created_at: "2026-07-20T08:00:00.000Z",
    engine_version: "v1.0",
    matched_skill_id: "mskill_cnc_turner",
    ...over,
  });

  it("maps the frozen snapshot through WITHOUT coercing a null to a number", async () => {
    const { repo } = makeDb([raw({ match_tier: null, skill_months: null, industry_months: null, engine_version: null })]);
    const [row] = await repo.listCandidates(POSTING, 36, 500);
    // "No decision was ranked" and "ranked at zero months" are different facts, and the
    // service's `effectiveTier` relies on the difference to refuse to promote an
    // unknown. Zero-filling here would promote every coarse row past the floor.
    expect(row).toMatchObject({
      matchTier: null,
      skillMonths: null,
      industryMonths: null,
      engineVersion: null,
    });
  });

  it("renders last_worked_at as a bare YYYY-MM-DD from either a Date or a string", async () => {
    const { repo: fromDate } = makeDb([raw({ last_worked_at: new Date("2024-03-01T00:00:00.000Z") })]);
    expect((await fromDate.listCandidates(POSTING, 36, 500))[0]!.lastWorkedAt).toBe("2024-03-01");

    const { repo: fromString } = makeDb([raw({ last_worked_at: "2024-03-01T00:00:00.000Z" })]);
    expect((await fromString.listCandidates(POSTING, 36, 500))[0]!.lastWorkedAt).toBe("2024-03-01");

    const { repo: fromNull } = makeDb([raw({ last_worked_at: null })]);
    expect((await fromNull.listCandidates(POSTING, 36, 500))[0]!.lastWorkedAt).toBeNull();
  });

  it("gives createdAt back as a real Date whichever way the driver returned it", async () => {
    const { repo: asString } = makeDb([raw()]);
    const fromString = (await asString.listCandidates(POSTING, 36, 500))[0]!.createdAt;
    expect(fromString).toBeInstanceOf(Date);
    expect(fromString.toISOString()).toBe("2026-07-20T08:00:00.000Z");

    const asDate = new Date("2026-07-20T08:00:00.000Z");
    const { repo: passthrough } = makeDb([raw({ created_at: asDate })]);
    // `createdAt` is the rank key's `last_active_at`; the service calls `.toISOString()`
    // on it, which throws on a string. Same value in, same type out, either way.
    expect((await passthrough.listCandidates(POSTING, 36, 500))[0]!.createdAt).toBe(asDate);
  });

  it("returns the full faceless row — an id and integers, never a name", async () => {
    const { repo } = makeDb([raw()]);
    const [row] = await repo.listCandidates(POSTING, 36, 500);
    expect(row).toEqual({
      applicationId: "33333333-3333-4333-8333-333333333333",
      workerId: "44444444-4444-4444-8444-444444444444",
      matchTier: 2,
      skillMonths: 42,
      industryMonths: 60,
      lastWorkedAt: "2026-05-15",
      createdAt: new Date("2026-07-20T08:00:00.000Z"),
      engineVersion: "v1.0",
      matchedSkillId: "mskill_cnc_turner",
    });
  });
});
