import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { applications, createDbClient, jobPostings, workers, type DbClient } from "@badabhai/db";

import { JobsRepository, type JobSearchRow } from "./jobs.repository";

/**
 * #982 — `GET /jobs/search` is EXECUTED against Postgres, not merely compiled and read.
 *
 * ── WHY THIS FILE HAD TO EXIST ────────────────────────────────────────────────
 * #974: every search with no job title — the whole location-only case, "jobs in Jaipur" —
 * returned HTTP 500. `JobsRepository.searchOpenPostings` built its relevance sort key as a
 * Drizzle template holding a BARE `0` on the no-`q` path, which rendered as
 *
 *     ORDER BY 0, published_at DESC NULLS LAST, id
 *
 * and in Postgres a lone integer constant in `ORDER BY` is an OUTPUT-COLUMN ORDINAL, not a
 * value to sort by. Postgres raised `ORDER BY position 0 is not in select list` and the
 * screen died. PR #979 (4676b147) fixed it by DROPPING the key from the sort when there is
 * no `q`, and this file is the follow-up the ticket asked for: the gate that would have
 * caught it.
 *
 * ── WHY THIS CANNOT BE A UNIT TEST ────────────────────────────────────────────
 * The defect was invisible to every oracle the repo had. `jobs.repository.test.ts` compiles
 * the Drizzle node through `PgDialect().sqlToQuery` and asserts on the rendered STRING;
 * `jobs.service.test.ts` mocks the repository outright. The broken statement was valid
 * TypeScript, valid Drizzle, and valid TEXT — it rendered exactly the characters its author
 * intended. It was invalid only to POSTGRES, and only at plan time. A statement-level test
 * cannot fail on that, structurally: its oracle is "the string looks right to us", never
 * "the server accepts it". That is precisely how #974 shipped with CI fully green.
 *
 * So the claim this file pins is the one no mock can make: the statements this repository
 * builds PARSE, PLAN and RETURN, and the predicates and the sort EVALUATE the way their
 * comments say they do.
 *
 * ── WHAT IS AND IS NOT COVERED ────────────────────────────────────────────────
 * The DTO can produce eight (`q`, `city`, `state`) combinations. SIX are executed here:
 * none, city, state, city+state, q, q+city. The two left out are q+state and q+city+state.
 * Both merely re-compose predicates already exercised independently above — the `q`
 * predicate database-wide, the `state` predicate on its own, and the `city`+`state`
 * conjunction — and neither reaches a repository branch the six do not. That is a stated
 * boundary, not a claim of completeness; add a case here rather than widen this paragraph
 * if the repository grows a branch the six miss.
 *
 * ── WHAT MAKES EACH ASSERTION NON-VACUOUS ─────────────────────────────────────
 * For the no-`q` cases the bar is simply "it executes at all": the pre-#979 statement did
 * not mis-order rows, it THREW, so an `await` that resolves is already the whole guard.
 * Everything else is a semantic claim, and those are laid out adversarially instead —
 * `published_at` runs OPPOSITE to relevance, the two tie rows share an instant to the
 * millisecond, the unpublished row would lead under Postgres's default `DESC NULLS FIRST`,
 * the already-decided postings are the NEWEST in their city so a dead anti-join puts them
 * first, and the draft is newer still. Each wrong implementation therefore produces a
 * visibly different list, not a coincidentally equal one.
 *
 * ── ISOLATION ─────────────────────────────────────────────────────────────────
 * `searchOpenPostings` has NO tenant scoping — it searches EVERY open posting in the
 * database, and this gate shares one CI database with THREE sibling gates that insert their
 * own open postings concurrently: `match/rank-parity.test.ts`, `match/boost-fences.test.ts`
 * and `match/apply-freeze.test.ts`. (The fourth file in the same CI step,
 * `profiles/current-profile-order.test.ts`, inserts only `workers` and `worker_profiles` —
 * verified by grepping all four for `job_postings`. Re-check that list, do not trust this
 * sentence, when a gate is added to the step.) So almost nothing here asserts an absolute
 * result count or "the first row overall". Every fixture carries a city/state token no seed
 * and no other gate could plausibly write, and every order assertion filters the returned ids
 * down to this file's own fixture set first, then asserts RELATIVE order. An assertion that
 * would change meaning when someone seeds one more posting is not a gate.
 *
 * TWO PLACES TOUCH A RAW COUNT, disclosed rather than hidden.
 *
 * The PAGING case asserts absolute page lengths, `hasMore`, and raw positional ids WITHOUT
 * filtering through `mine()`. It has to. The `limit + 1` has_more probe is a claim about the
 * SIZE of a result set, and the size of a set is unprovable unless the set is closed. It is
 * closed here because that search is narrowed to {@link CITY}, a token this file invents and
 * nothing else writes. To stop that premise from failing as a baffling order diff, the case
 * first asserts that the UNPAGED city search returns exactly this file's six rows, so a
 * foreign row reddens on a message that names the real cause.
 *
 * The NO-FILTERS case touches a raw count in the opposite direction: it asserts only an upper
 * BOUND (`rows.length < UNFILTERED_LIMIT`), so that a saturated page 1 fails saying so instead
 * of as an `arrayContaining` diff that points at the sort. That is a headroom guard, not a
 * claim about which rows came back — but it does mean this file fails if the shared database
 * ever holds {@link UNFILTERED_LIMIT} open postings newer than these fixtures.
 *
 * ── PII (CLAUDE.md §2) ────────────────────────────────────────────────────────
 * No fixture holds personal data of any kind. `org_label` is an obviously synthetic marker,
 * `location_label` is left NULL rather than filled with anything address-shaped, and the two
 * `workers` rows carry `enc:`/`hash:` markers where the encrypted phone and its HMAC live in
 * production. None of it can leak or resemble PII even in a shared database.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test jobs-search-sql
 *
 * SKIPS by default so `pnpm --filter @badabhai/api test` stays DB-free. In CI it runs in the
 * `e2e` job's DB-backed gates step, which asserts per file that it EXECUTED rather than
 * skipped — a skipped gate is a disclosed gap, not a pass.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** A deterministic uuid so the fixtures are reproducible and cleanable. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// 94xx–97xx. A band no other gate file uses (apply-freeze 71xx–73xx, boost-fences 81xx–84xx,
// current-profile-order 87xx–89xx, rank-parity 1–16 and 90xx): the five gates share one
// database in one vitest invocation, so a reused id is a cross-file fixture collision.
const P_PREFIX = uuid(9401); // role_title STARTS WITH the term → relevance tier 0
const P_SUBSTRING = uuid(9402); // role_title CONTAINS the term → tier 1
const P_SKILL_ONLY = uuid(9403); // matches only via a skill phrase → tier 2 (the ELSE)
const P_TIE_A = uuid(9404); // same published_at as P_TIE_B; lower id
const P_TIE_B = uuid(9405); // same published_at as P_TIE_A; higher id
const P_UNPUBLISHED = uuid(9406); // status='open' AND published_at IS NULL — the NULLS LAST probe
const P_APPLIED = uuid(9407); // WORKER_MAIN applied → must never come back to him
const P_SKIPPED = uuid(9408); // WORKER_MAIN skipped → same
const P_DRAFT = uuid(9409); // status='draft' → invisible to every search
const P_OTHER_CITY = uuid(9410); // same state, different city
const P_NULL_CITY = uuid(9411); // city IS NULL — a city filter must never match it
const P_OTHER_STATE = uuid(9412); // different state entirely
// Migration 0089 fixtures — the full-text `search_vec` probe. Own ids, own city token,
// so the closed-set premises above are untouched by anything this block adds.
const P_FTS_PHRASE = uuid(9413); // reachable ONLY through a skill_phrase token (weight B)
const P_FTS_TITLE = uuid(9414); // reachable through its role_title tokens (weight A)

// #1240 fixtures — the empty-box PROFILE fallback (`reach_skill_ids ?| $ids::text[]`). Own
// ids and own city token, for the same reason the 0089 block above has them: the closed-set
// premises of every assertion written before this block must stay exactly as true.
const P_REACH_MINE = uuid(9415); // reach set CONTAINS the worker's skill → he must see it
const P_REACH_OTHER = uuid(9416); // same city, DISJOINT reach set → he must NOT see it

/** The worker every search below runs as. He has already decided on two postings. */
const WORKER_MAIN = uuid(9501);
/** No decisions at all — the control that proves the anti-join is WORKER-scoped. */
const WORKER_OTHER = uuid(9502);

const APP_APPLIED = uuid(9601);
const APP_SKIPPED = uuid(9602);

/** Opaque ops-actor id. `job_postings.created_by` is NOT NULL and has no FK to anything. */
const OPS_ACTOR = uuid(9701);

// THE ISOLATION TOKENS. Real city buckets ("Jaipur", "Rajasthan") would be matched by any
// posting a seed script, a sibling gate or a developer's local database happens to hold, and
// then "is my row in the result?" would still pass while "is ONLY my row?" quietly stopped
// being true. These are shaped like a place name — the `ILIKE '%…%'` behaviour under test is
// the same either way — but suffixed so that nothing but this file's fixtures can satisfy the
// predicate. That is what lets the paging case below reason about a closed set of six rows.
const CITY = "Jaipurgate";
const CITY_OTHER = "Kotagate";
const CITY_FOREIGN = "Suratgate";
const STATE = "Rajasthangate";
const STATE_FOREIGN = "Gujaratgate";
/** Isolation token for the 0089 FTS block — a city no seed and no sibling gate writes. */
const CITY_FTS = "Nagpurgate";
// #1240 — the profile-fallback block's own city, so a location-only search inside it sees
// exactly two postings and the "did the reach filter narrow it?" claim cannot be satisfied
// by an unrelated row drifting in from another block.
const CITY_REACH = "Indoregate";
// Opaque closed-vocabulary `mskill_*` ids. These do NOT need rows in `skill`: `reach_skill_ids`
// is a denormalized jsonb array with no FK, which is exactly what makes the GIN probe a single
// index lookup and what lets this fixture stay inside `job_postings`.
const MSKILL_MINE = "mskill_jobsearchgate_mine";
const MSKILL_THEIRS = "mskill_jobsearchgate_theirs";

/** The term every `q` search uses. Lower case on purpose — the titles are not. */
const TERM = "welderzz";

const TITLE_PREFIX = "Welderzz Fabricator";
const TITLE_SUBSTRING = "Senior Welderzz Operator";
const TITLE_SKILL_ONLY = "Fitterzz Assistant";
/** The only place `TERM` appears for P_SKILL_ONLY — the `jsonb_array_elements_text` branch. */
const SKILL_PHRASE = "welderzz helper";

// RELEVANCE AND RECENCY RUN OPPOSITE, deliberately. The tier-0 row is the OLDEST and the
// tier-2 row is the NEWEST, so a sort that lost the relevance key — which is exactly what the
// no-`q` path does, by design, and what a careless edit would do to the `q` path — returns the
// ladder precisely backwards rather than coincidentally right.
const PUB_DECIDED = new Date("2026-06-01T00:00:00.000Z");
const PUB_SKILL_ONLY = new Date("2026-05-01T00:00:00.000Z");
const PUB_SUBSTRING = new Date("2026-04-01T00:00:00.000Z");
const PUB_PREFIX = new Date("2026-03-01T00:00:00.000Z");
/** One instant, two postings — `published_at DESC` alone cannot separate these. */
const PUB_TIE = new Date("2026-02-01T00:00:00.000Z");
/** Newer than everything, so a broken `status='open'` gate is maximally visible. */
const PUB_DRAFT = new Date("2026-07-01T00:00:00.000Z");

const POSTING_IDS = [
  P_PREFIX,
  P_SUBSTRING,
  P_SKILL_ONLY,
  P_TIE_A,
  P_TIE_B,
  P_UNPUBLISHED,
  P_APPLIED,
  P_SKIPPED,
  P_DRAFT,
  P_OTHER_CITY,
  P_NULL_CITY,
  P_OTHER_STATE,
  P_FTS_PHRASE,
  P_FTS_TITLE,
  P_REACH_MINE,
  P_REACH_OTHER,
];
const FIXTURE_IDS = new Set(POSTING_IDS);

/**
 * The six open postings in {@link CITY}, in the order the no-`q` search MUST return them:
 * `published_at DESC NULLS LAST, id ASC`. The two already-decided ones are absent because
 * WORKER_MAIN decided on them; the draft is absent because it is a draft.
 */
const CITY_ORDER = [P_SKILL_ONLY, P_SUBSTRING, P_PREFIX, P_TIE_A, P_TIE_B, P_UNPUBLISHED];

describe.skipIf(!RUN)("#982 — GET /jobs/search, executed against Postgres (#974)", () => {
  let client: DbClient;
  let repo: JobsRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    // The REAL production reader, not a re-implementation of its query. It takes only the
    // Drizzle handle, so constructing it directly exercises the SHIPPED SQL — which is the
    // entire point: a re-implementation here would reproduce the author's intent, and the
    // author's intent was never what #974 was about.
    repo = new JobsRepository(client.db);
    await seed();
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup();
      await client.sql.end({ timeout: 5 });
    }
  });

  async function cleanup(): Promise<void> {
    // CHILDREN BEFORE PARENTS. `applications` FKs both `job_postings` and `workers` with
    // ON DELETE CASCADE, so this is belt and braces — but it keeps the teardown readable in
    // the order a human would reason about it, and it means a partially-seeded run from a
    // previous crash still tears down cleanly.
    await client.db.delete(applications).where(inArray(applications.jobPostingId, POSTING_IDS));
    await client.db.delete(jobPostings).where(inArray(jobPostings.id, POSTING_IDS));
    await client.db.delete(workers).where(inArray(workers.id, [WORKER_MAIN, WORKER_OTHER]));
  }

  async function seed(): Promise<void> {
    // Cleanup FIRST. A previous run that crashed between seed and teardown leaves these ids
    // behind, and the primary keys would then reject the insert below.
    await cleanup();

    // NO PII: an id and the bare minimum the NOT NULLs demand. `phone_e164` holds the
    // ENCRYPTED phone in production and `phone_hash` its HMAC (UNIQUE); these are synthetic
    // markers, so no real phone number exists anywhere in this fixture.
    await client.db.insert(workers).values([
      {
        id: WORKER_MAIN,
        phoneE164: "enc:jobs-search-gate-main",
        phoneHash: "hash:jobs-search-gate-main",
        status: "active" as const,
      },
      {
        id: WORKER_OTHER,
        phoneE164: "enc:jobs-search-gate-other",
        phoneHash: "hash:jobs-search-gate-other",
        status: "active" as const,
      },
    ]);

    // INSERT ORDER IS PART OF THE FIXTURE, not incidental — the discipline
    // current-profile-order.test.ts established. A multi-row INSERT lays its rows down in
    // VALUES order, and on a table this small Postgres hands them back in that physical order
    // for any read whose sort does not decide otherwise. So the layout is chosen to be WRONG
    // for every order this file asserts, and reaching that takes TWO statements rather than
    // one. Statement 1 below writes [P_UNPUBLISHED, P_TIE_B, P_TIE_A] and then the rows that
    // must stay invisible plus the location discriminators; statement 2 writes
    // [P_SUBSTRING, P_SKILL_ONLY, P_PREFIX]. The six {@link CITY} rows therefore sit in the
    // heap as
    //
    //     UNPUBLISHED, TIE_B, TIE_A, SUBSTRING, SKILL_ONLY, PREFIX
    //
    // and that sequence is:
    //   * NOT {@link CITY_ORDER} — a no-`q` search that lost its ORDER BY reddens;
    //   * NOT the reverse of {@link CITY_ORDER} either, so the heap cannot be read in either
    //     direction to satisfy a no-`q` assertion by accident of layout;
    //   * NOT [P_PREFIX, P_SUBSTRING, P_SKILL_ONLY] (nor its reverse) — a `q` search that lost
    //     its ORDER BY reddens on the relevance ladder;
    //   * TIE_B before TIE_A, so the `id ASC` tiebreak has to actually run.
    //
    // The third bullet is precisely why one statement was not enough. A single VALUES list
    // forces the three `q` rows into ONE physical order, and with relevance and recency
    // deliberately opposed that order had to coincide with the relevance ladder — which made
    // the ladder assertion satisfiable by heap order alone. A refactor that dropped the sort
    // on the `q` branch only (`const orderBy = args.q ? [] : [...]`) would then have left
    // every test in this file green while making the shipped `q` path silently
    // non-deterministic — the exact class of bug the id tiebreak exists to prevent. Splitting
    // the seed puts SUBSTRING physically ahead of PREFIX, so that mutation now fails.
    //
    // HOW MUCH OF THAT IS GUARANTEED, honestly. The heap sequence above is what Postgres
    // returns for a sequential scan of a small, freshly-inserted table — it is an ASSUMPTION,
    // not a contract, and splitting one VALUES list into two statements makes it weaker than
    // it was: `seed()` DELETEs these same ids first, and in CI three sibling gates insert and
    // delete their own postings in the same run, so the free-space map may place statement 2's
    // rows in pages freed earlier — ahead of statement 1's. NOTHING GOES RED IF THAT HAPPENS:
    // every query here carries a total ORDER BY, so all the assertions stay correct. What
    // weakens is only the mutation-detection argument above — the layout stops being a
    // reliable adversary. Treat this block as "the fixture is arranged to be wrong for every
    // asserted order, as far as physical layout can be steered", not as a proof.
    //
    // Recency stays adversarial in its own right: the NULL-`published_at` row is written
    // first, so a lost `NULLS LAST` is equally visible.
    //
    // `org_label` is a synthetic marker and `location_label` is left NULL throughout: neither
    // may carry anything resembling a real employer or a real address (CLAUDE.md §2), and the
    // search's projection deliberately selects neither.
    //
    // ── STATEMENT 1: the backdrop — ties, the unpublished row, and everything a search must
    //    NOT return to WORKER_MAIN ──
    await client.db.insert(jobPostings).values([
      {
        id: P_UNPUBLISHED,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Loaderzz Helper (unpublished)",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY,
        state: STATE,
        // OPEN AND NEVER PUBLISHED — the schema allows it ("NULL = never published") and
        // nothing couples the two columns. Postgres's default for DESC is NULLS FIRST, so
        // without the explicit `NULLS LAST` this row LEADS every location search.
        publishedAt: null,
      },
      {
        id: P_TIE_B,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Loaderzz Helper B",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY,
        state: STATE,
        publishedAt: PUB_TIE,
      },
      {
        id: P_TIE_A,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Loaderzz Helper A",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY,
        state: STATE,
        publishedAt: PUB_TIE,
      },
      // ── rows that must be INVISIBLE to WORKER_MAIN, each newer than every other CITY row ──
      {
        id: P_APPLIED,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Welderzz Already Applied",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY,
        state: STATE,
        publishedAt: PUB_DECIDED,
      },
      {
        id: P_SKIPPED,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Welderzz Already Skipped",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY,
        state: STATE,
        publishedAt: PUB_DECIDED,
      },
      {
        id: P_DRAFT,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Welderzz Draft",
        vacancyBand: "1" as const,
        // The column DEFAULTS to 'draft', so this is also the default-shaped row: any fixture
        // that forgets `status` is invisible, and this one proves the gate is real.
        status: "draft" as const,
        city: CITY,
        state: STATE,
        publishedAt: PUB_DRAFT,
      },
      // ── location discriminators ──
      {
        id: P_OTHER_CITY,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Loaderzz Helper (other city)",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY_OTHER,
        state: STATE,
        publishedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
      {
        id: P_NULL_CITY,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Loaderzz Helper (no city bucket)",
        vacancyBand: "1" as const,
        status: "open" as const,
        // `NULL ILIKE '%…%'` is NULL, not false — the row is dropped by the WHERE. That is a
        // Postgres three-valued-logic fact, which is the sort of thing a rendered-string
        // oracle has no opinion about at all.
        city: null,
        state: STATE,
        publishedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      {
        id: P_OTHER_STATE,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Loaderzz Helper (other state)",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY_FOREIGN,
        state: STATE_FOREIGN,
        publishedAt: new Date("2026-04-25T00:00:00.000Z"),
      },
    ]);

    // ── STATEMENT 2: the three rows the `q` term can reach, laid down in an order that is
    //    neither the relevance ladder nor the recency order ──
    // SUBSTRING, SKILL_ONLY, PREFIX. The ladder is [PREFIX, SUBSTRING, SKILL_ONLY] and recency
    // alone gives [SKILL_ONLY, SUBSTRING, PREFIX]; this is neither, so the ladder assertion
    // fails both against a dropped sort AND against a sort that lost only the relevance key.
    await client.db.insert(jobPostings).values([
      {
        id: P_SUBSTRING,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: TITLE_SUBSTRING,
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY,
        state: STATE,
        publishedAt: PUB_SUBSTRING,
      },
      {
        id: P_SKILL_ONLY,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: TITLE_SKILL_ONLY,
        vacancyBand: "1" as const,
        status: "open" as const,
        // The term appears ONLY here. `skill_phrases` must be a jsonb array of STRINGS —
        // `jsonb_array_elements_text` errors on anything else — and this is the only fixture
        // that exercises the `q` predicate's second branch at all.
        skillPhrases: [SKILL_PHRASE, "grinding"],
        city: CITY,
        state: STATE,
        publishedAt: PUB_SKILL_ONLY,
      },
      {
        id: P_PREFIX,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: TITLE_PREFIX,
        vacancyBand: "2-5" as const,
        status: "open" as const,
        city: CITY,
        state: STATE,
        payMin: 18000,
        payMax: 26000,
        shift: "night" as const,
        neededBy: "immediate" as const,
        publishedAt: PUB_PREFIX,
      },
    ]);

    // ── STATEMENT 3 (migration 0089): the full-text probe fixtures, under their OWN city
    // token so no closed-set assertion above can see them. P_FTS_PHRASE is reachable only
    // through a skill_phrase token (the weight-B half of `search_vec`); its title shares a
    // stem with neither {@link TERM} nor the FTS queries below. P_FTS_TITLE exists so an
    // operator-laden query has something to find.
    await client.db.insert(jobPostings).values([
      {
        id: P_FTS_PHRASE,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Mistrizz Work (fts)",
        vacancyBand: "1" as const,
        status: "open" as const,
        // Hinglish vernacular phrase — "kharadzz master". The query token below ("kharad")
        // matches it through the vector's PREFIX path (`kharad:*`), which is exactly how
        // Roman-script Hindi inflection behaves and why config 'simple' was chosen over
        // any stemming dictionary.
        skillPhrases: ["kharadzz master"],
        city: CITY_FTS,
        state: STATE,
        publishedAt: PUB_SKILL_ONLY,
      },
      {
        id: P_FTS_TITLE,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        // NOT "Welderzz…": the q-only ladder case below runs DATABASE-WIDE with
        // {@link TERM} and pins EXACT equality — a second welderzz-tokened row here
        // (tier 0, no less) would break it. This token belongs to this block alone.
        roleTitle: "Operatorzz FTS Probe",
        vacancyBand: "1" as const,
        status: "open" as const,
        city: CITY_FTS,
        state: STATE,
        publishedAt: PUB_SKILL_ONLY,
      },
      // ── #1240 — two postings that differ ONLY in their reach set ──────────────────────
      // Same city, same state, same published_at, and role titles that share no token with
      // anything else here. The ONLY thing that can separate them is `reach_skill_ids`, so a
      // fallback that silently matched everything (or nothing) cannot produce the expected
      // one-row answer by luck.
      {
        id: P_REACH_MINE,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Reachzz Alpha",
        vacancyBand: "1" as const,
        status: "open" as const,
        reachSkillIds: [MSKILL_MINE],
        city: CITY_REACH,
        state: STATE,
        publishedAt: PUB_SKILL_ONLY,
      },
      {
        id: P_REACH_OTHER,
        createdBy: OPS_ACTOR,
        orgLabel: "Search Gate Fixture Co",
        roleTitle: "Reachzz Beta",
        vacancyBand: "1" as const,
        status: "open" as const,
        reachSkillIds: [MSKILL_THEIRS],
        city: CITY_REACH,
        state: STATE,
        publishedAt: PUB_SKILL_ONLY,
      },
    ]);

    // The two decisions. Keyed on `job_posting_id` — a V1 decision leaves `job_id` NULL, and
    // the search's anti-join reads the posting side only. `reason` MUST stay NULL on an apply
    // (`applications_reason_chk`).
    await client.db.insert(applications).values([
      {
        id: APP_APPLIED,
        workerId: WORKER_MAIN,
        jobPostingId: P_APPLIED,
        action: "applied" as const,
        sourceSurface: "search" as const,
      },
      {
        id: APP_SKIPPED,
        workerId: WORKER_MAIN,
        jobPostingId: P_SKIPPED,
        action: "skipped" as const,
        sourceSurface: "search" as const,
      },
    ]);
  }

  type SearchArgs = Parameters<JobsRepository["searchOpenPostings"]>[0];

  /** Every field the DTO normalises to `null` when absent is `null` here too, never `undefined`. */
  function search(overrides: Partial<SearchArgs> = {}) {
    return repo.searchOpenPostings({
      workerId: WORKER_MAIN,
      q: null,
      // #1240 — default to the unprofiled worker, so every case written before the profile
      // fallback existed keeps executing the statement it was written to execute.
      profileSkillIds: [],
      city: null,
      state: null,
      limit: 50,
      offset: 0,
      ...overrides,
    });
  }

  /**
   * Ids of THIS FILE's fixtures only, in the order the database returned them. Every order
   * assertion goes through here: the search is database-wide and the sibling gates insert
   * their own open postings while this one runs, so an assertion on the raw list would be
   * asserting something about them too.
   */
  function mine(rows: JobSearchRow[]): string[] {
    return rows.map((r) => r.id).filter((id) => FIXTURE_IDS.has(id));
  }

  it("PREMISE: the fixture really does oppose relevance to recency, and the tie ids really are ordered", () => {
    // No database. These are the assumptions every assertion below is built on, and if one of
    // them silently flips — a renamed title, a re-numbered uuid — the tests would keep passing
    // while proving something else. Pin them here rather than trust the comments.

    // The relevance ladder reads `role_title` ONLY: prefix beats substring beats neither.
    expect(TITLE_PREFIX.toLowerCase().startsWith(TERM)).toBe(true);
    expect(TITLE_SUBSTRING.toLowerCase().startsWith(TERM)).toBe(false);
    expect(TITLE_SUBSTRING.toLowerCase()).toContain(TERM);
    // …and the tier-2 row's title does not contain the term at all — only its skill phrase
    // does, so it can only enter the result set through the `jsonb_array_elements_text` branch.
    expect(TITLE_SKILL_ONLY.toLowerCase()).not.toContain(TERM);
    expect(SKILL_PHRASE.toLowerCase()).toContain(TERM);

    // OPPOSED, which is what makes the ladder assertion non-vacuous: sorted by recency alone
    // the three come back in exactly the reverse order.
    expect(PUB_SKILL_ONLY.getTime()).toBeGreaterThan(PUB_SUBSTRING.getTime());
    expect(PUB_SUBSTRING.getTime()).toBeGreaterThan(PUB_PREFIX.getTime());

    // The id tiebreak is `id ASC`. Postgres compares uuids bytewise, which for this fixed
    // shape agrees with JS string order — so this comparison is the same one the database
    // makes, and P_TIE_A must lead.
    expect(P_TIE_A < P_TIE_B).toBe(true);
  });

  it("CITY ONLY, no q — the exact shape that returned HTTP 500 (#974)", async () => {
    // THE LOAD-BEARING CASE. Against the pre-#979 statement this did not return the wrong
    // rows: Postgres refused to plan it and raised `ORDER BY position 0 is not in select
    // list`, so the request 500'd. The guard here is therefore "it EXECUTES at all" — an
    // `await` that resolves is already the whole proof, and no amount of asserting on the
    // rendered SQL string could ever have produced it.
    const { rows } = await search({ city: CITY });

    expect(mine(rows)).toEqual(CITY_ORDER);
    // Explicitly: the row a title-less search is FOR is present.
    expect(mine(rows)).toContain(P_PREFIX);
  });

  it("STATE ONLY, no q — the same no-relevance-key path through a different filter", async () => {
    const { rows } = await search({ state: STATE });
    const got = mine(rows);

    // Everything in the state, including the row with no city bucket at all, and excluding
    // the posting whose state is a different one.
    expect(got).toContain(P_OTHER_CITY);
    expect(got).toContain(P_NULL_CITY);
    expect(got).not.toContain(P_OTHER_STATE);
    // The two rows the worker already decided on stay out on this path too — the anti-join is
    // composed with every filter combination, not just the one it was first written under.
    expect(got).not.toContain(P_APPLIED);
    expect(got).not.toContain(P_SKIPPED);
  });

  it("CITY AND STATE together, no q — two independent predicates, both applied", async () => {
    const { rows } = await search({ city: CITY, state: STATE });

    // Same six as the city-only search: the state filter narrows nothing further here …
    expect(mine(rows)).toEqual(CITY_ORDER);

    // … and that is only meaningful because it DOES discriminate when the two disagree.
    // Without this half, the assertion above would pass against a state filter that was
    // silently dropped on the floor.
    const crossed = await search({ city: CITY, state: STATE_FOREIGN });
    expect(mine(crossed.rows)).toEqual([]);
  });

  it("NO FILTERS AT ALL — the other no-q shape, and a legal request (#822)", async () => {
    // `GET /jobs/search` with no query string is valid: q/city/state all arrive as null and the
    // worker gets page 1 of every open posting. It is the same relevance-key-free sort as the
    // city-only case, with the WHERE reduced to the status gate plus the anti-join.
    //
    // The limit is deliberately far above the DTO's ceiling of 50: that ceiling is a WIRE
    // rule enforced in `jobs.dto.ts`, and this test calls the repository directly. The search
    // is database-wide, so headroom is what keeps the assertion from depending on how many
    // postings the sibling gates happen to be holding open at this instant.
    const UNFILTERED_LIMIT = 500;
    const { rows } = await search({ limit: UNFILTERED_LIMIT });
    const got = mine(rows);

    // HEADROOM, CHECKED RATHER THAN ASSUMED. Everything below is an `arrayContaining` claim
    // about page 1, which is only meaningful while page 1 is NOT saturated: let the database
    // hold 500 open postings newer than these fixtures and the fixtures fall off the page,
    // and the failure would read as "the search lost my rows" while pointing at nothing.
    // The margin is enormous today (~15 open postings in CI) — but "enormous" is a belief,
    // and this turns it into an assertion that names its own cause when it breaks.
    expect(
      rows.length,
      `page 1 came back FULL at limit=${UNFILTERED_LIMIT}: the database now holds at least that many open postings, so this test's fixtures may simply be off the page. The sort is not what failed — raise the limit or narrow the search.`,
    ).toBeLessThan(UNFILTERED_LIMIT);

    expect(got).toEqual(
      expect.arrayContaining([P_PREFIX, P_OTHER_CITY, P_OTHER_STATE, P_NULL_CITY]),
    );
    // The unfiltered search is still a search: drafts and already-decided postings stay out.
    expect(got).not.toContain(P_DRAFT);
    expect(got).not.toContain(P_APPLIED);
    expect(got).not.toContain(P_SKIPPED);
  });

  it("q ONLY — the relevance ladder sorts DATABASE-WIDE, with no location predicate narrowing it", async () => {
    // `GET /jobs/search?q=welder` with no location is the commonest real shape on the screen,
    // and the only one where the relevance CASE is evaluated over every open posting in the
    // database rather than over a handful a city filter already reduced to nothing. It is
    // isolation-safe for the same reason the rest of the file is: {@link TERM} is a synthetic
    // token no seed and no sibling gate writes, and `mine()` narrows the result to this file's
    // fixtures regardless of what else the shared database happens to hold.
    const { rows } = await search({ q: TERM });
    const got = mine(rows);

    // The same three rows in the same ladder order as the `q + city` case below — which is the
    // point: the location filter was never what produced that order.
    expect(got).toEqual([P_PREFIX, P_SUBSTRING, P_SKILL_ONLY]);

    // The three OTHER postings whose titles contain the term are held out by the predicates
    // `q` composes WITH rather than replaces: two the worker has already decided on, and a
    // draft. Without this half, "the ladder came back" would be equally consistent with `q`
    // having quietly become the only condition in the WHERE.
    expect(got).not.toContain(P_APPLIED);
    expect(got).not.toContain(P_SKIPPED);
    expect(got).not.toContain(P_DRAFT);
  });

  it("q + city — the relevance ladder EVALUATES: prefix, then substring, then skill-phrase only", async () => {
    const { rows } = await search({ q: TERM, city: CITY });

    // Exactly the three rows the term can reach, in ladder order. Sorted by `published_at`
    // alone — i.e. with the relevance key gone — this list is [SKILL_ONLY, SUBSTRING, PREFIX],
    // the precise reverse, so the assertion cannot pass without the CASE being evaluated.
    expect(mine(rows)).toEqual([P_PREFIX, P_SUBSTRING, P_SKILL_ONLY]);

    // The tier-2 row is in the result set at all only because of the
    // `jsonb_array_elements_text(skill_phrases)` branch — its title does not contain the term
    // (pinned in the PREMISE above). That branch is real SQL against real jsonb; a rendered
    // string cannot say whether it returns rows.
    expect(rows.find((r) => r.id === P_SKILL_ONLY)?.title).toBe(TITLE_SKILL_ONLY);

    // `q` is lower case and the titles are NOT, so every row above was reached through
    // ILIKE rather than LIKE. Case-folding a search box is not optional for a worker
    // typing on a phone keyboard.
    expect(TERM).toBe(TERM.toLowerCase());
    expect(TITLE_PREFIX).not.toBe(TITLE_PREFIX.toLowerCase());
  });

  // ── Migration 0089: membership moved from ILIKE to the `search_vec @@ to_tsquery`
  // probe. These cases execute the SHIPPED predicate against real Postgres: they are
  // what proves the vector actually contains both halves and that worker-typed tsquery
  // operators cannot break the endpoint. Isolation rides {@link CITY_FTS}.

  it("FTS weight B — a term reaching only a skill_phrase token still finds the posting", async () => {
    const { rows } = await search({ q: "kharad", city: CITY_FTS });

    // The title carries no kharad token; only the phrase does. Under the pre-0089 ILIKE
    // this was the EXISTS(jsonb) branch; under FTS it is the weight-B half of the same
    // vector — if the generated column had dropped phrases, this would return nothing.
    expect(mine(rows)).toEqual([P_FTS_PHRASE]);
  });

  it("FTS PREFIX — 'mistr' matches the 'Mistrizz' title token (Hinglish suffix inflection)", async () => {
    const { rows } = await search({ q: "mistr", city: CITY_FTS });

    // Whole-word ILIKE would have missed ("mistr" is not a substring of the TOKEN list
    // under word semantics); prefix matching is the deliberate semantic that keeps Hindi
    // pluralization/suffix drift reachable without a stemmer.
    expect(mine(rows)).toEqual([P_FTS_PHRASE]);
  });

  it("FTS OPERATOR SAFETY — tsquery metacharacters typed by a worker are inert", async () => {
    // Pre-sanitization this string is a guaranteed to_tsquery syntax error ("&" with an
    // empty left side, bare parens) — a 500 on the search screen from a typed "&". The
    // sanitizer strips it to three plain tokens ANDed together, so the query must EXECUTE
    // and match only the row holding all three tokens.
    const { rows } = await search({ q: "Operatorzz & (FTS) | !probe", city: CITY_FTS });
    expect(mine(rows)).toEqual([P_FTS_TITLE]);
  });

  it("published_at DESC is NULLS LAST — an open-but-unpublished posting sorts to the end", async () => {
    const { rows } = await search({ city: CITY });
    const got = mine(rows);

    // Postgres's default for DESC is NULLS FIRST. Drop the explicit `NULLS LAST` and this row
    // leads every location search — the newest thing on the screen would be the one thing that
    // was never published.
    expect(got[got.length - 1]).toBe(P_UNPUBLISHED);
    expect(rows.find((r) => r.id === P_UNPUBLISHED)?.publishedAt).toBeNull();
  });

  it("PAGING — page 1 then page 2 drop nothing, repeat nothing, and the id tiebreak breaks the tie", async () => {
    // Six known rows in a city no other fixture can name, paged two at a time. Because the
    // city token is unique to this file the pages are a closed set, which is what makes a
    // "nothing dropped, nothing repeated" claim checkable at all.
    //
    // THE CLOSED-SET PREMISE, PINNED FIRST. This is the one case in the file whose assertions
    // do NOT all go through `mine()` — a `limit + 1` has_more probe is a claim about the SIZE
    // of a result set, and size is unprovable on an open set (see ISOLATION in the header).
    // So check the premise explicitly: a foreign row matching {@link CITY} must fail HERE,
    // naming the cause, rather than three lines down as an inscrutable positional diff.
    const unpaged = await search({ city: CITY });
    expect(
      unpaged.rows.map((r) => r.id),
      `the city=${CITY} search returned a row outside this file's fixtures. The absolute page-length and positional assertions below assume a CLOSED set of ${CITY_ORDER.length} rows; something else in the database now matches this token.`,
    ).toEqual(CITY_ORDER);

    const page1 = await search({ city: CITY, limit: 2, offset: 0 });
    const page2 = await search({ city: CITY, limit: 2, offset: 2 });
    const page3 = await search({ city: CITY, limit: 2, offset: 4 });

    // THE limit + 1 PROBE. The statement fetches `limit + 1` and the extra row exists only to
    // answer `has_more`; it must never be returned. Exactly `limit` rows come back while more
    // remain, and `hasMore` flips off on the last page.
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page2.rows).toHaveLength(2);
    expect(page2.hasMore).toBe(true);
    expect(page3.rows).toHaveLength(2);
    expect(page3.hasMore).toBe(false);

    const walked = [...mine(page1.rows), ...mine(page2.rows), ...mine(page3.rows)];
    // The concatenation of the pages IS the single-page order — no row moved across a
    // boundary, none was seen twice, none vanished between requests.
    expect(walked).toEqual(CITY_ORDER);
    expect(new Set(walked).size).toBe(walked.length);

    // THE TIE. P_TIE_A and P_TIE_B share `published_at` to the millisecond, and they straddle
    // the page-2/page-3 boundary on purpose: without the trailing `id`, `ORDER BY published_at
    // DESC` alone leaves Postgres free to return either one at offset 3, and the same row can
    // appear on both pages while the other is never shown at all. They were also inserted B
    // first, so physical order disagrees with the required one.
    expect(walked.indexOf(P_TIE_A)).toBeLessThan(walked.indexOf(P_TIE_B));
    expect(page2.rows[1]?.id).toBe(P_TIE_A);
    expect(page3.rows[0]?.id).toBe(P_TIE_B);
  });

  it("EXCLUSION — a posting this worker applied to, and one he skipped, are both gone", async () => {
    const { rows } = await search({ city: CITY });
    const got = mine(rows);

    // Both are `status='open'`, both are in the searched city, and both are the NEWEST rows
    // there — so a `NOT EXISTS` that parsed but selected nothing (wrong column, wrong action
    // list, wrong join key) would put them at the TOP of this list rather than merely
    // somewhere in it. Their absence is the anti-join EVALUATING, not its text being present.
    expect(got).not.toContain(P_APPLIED);
    expect(got).not.toContain(P_SKIPPED);
    expect(got[0]).toBe(P_SKILL_ONLY);
  });

  it("EXCLUSION is WORKER-scoped — the same two postings are visible to a worker who has not decided", async () => {
    // The vacuity guard for the case above. Without it, "absent" would be equally consistent
    // with the fixture being wrong — a typo'd city, a draft status, a failed insert — and the
    // test would be green for a reason that has nothing to do with the anti-join.
    const { rows } = await search({ workerId: WORKER_OTHER, city: CITY });
    const got = mine(rows);

    expect(got).toContain(P_APPLIED);
    expect(got).toContain(P_SKIPPED);
    // Still not the draft: `status='open'` is not worker-scoped and never was.
    expect(got).not.toContain(P_DRAFT);
  });

  it("CITY matching is PARTIAL and case-insensitive against real data — 'aipurga' finds 'Jaipurgate'", async () => {
    // Deliberately neither a prefix nor the same case nor the whole string, so exact equality
    // (what the FEED does) and a case-sensitive LIKE both return nothing. The search box's
    // entire premise is that a worker types three letters of a place name.
    const { rows } = await search({ city: "AIPURGA" });

    expect(mine(rows)).toEqual(CITY_ORDER);
    // And a city filter never matches a posting whose city bucket is NULL — `NULL ILIKE …`
    // is NULL, so the row is dropped rather than kept.
    expect(mine(rows)).not.toContain(P_NULL_CITY);
  });

  it("the projection Postgres returns carries no employer identity, and published_at is a Date (structural)", async () => {
    const { rows } = await search({ city: CITY });
    const row = rows.find((r) => r.id === P_PREFIX);

    // EXACTLY the eight worker-visible columns. `org_label`, `payer_id`, `created_by`,
    // `status` and `location_label` are never selected (ADR-0024 — employer identity stays
    // off the worker path), and this asserts it against what the driver actually handed back
    // rather than against the SELECT list we wrote.
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "city",
      "id",
      "payMax",
      "payMin",
      "publishedAt",
      "shift",
      "state",
      "title",
    ]);
    expect(row?.title).toBe(TITLE_PREFIX);
    expect(row?.city).toBe(CITY);
    expect(row?.payMin).toBe(18000);
    expect(row?.shift).toBe("night");
    // `JobSearchRow.publishedAt` is typed `Date`, and it is postgres.js — not the type
    // annotation — that decides whether a timestamptz arrives as a Date or as a string. The
    // service formats this field; a string here would ship a wrong wire value.
    expect(row?.publishedAt).toBeInstanceOf(Date);
    expect(row?.publishedAt?.toISOString()).toBe(PUB_PREFIX.toISOString());
  });

  // ── #1240 — the empty-box PROFILE fallback, EXECUTED ────────────────────────────────────
  //
  // WHY THIS BELONGS IN THIS FILE AND NOT ONLY IN THE STATEMENT TEST. The fallback introduces
  // an operator the repository had never emitted: `?|`, the jsonb key-existence-any operator,
  // with an explicit `::text[]` cast on a bound parameter. `?` is also the placeholder
  // character in several drivers' dialects, so "does this render" and "does this reach
  // Postgres as an OPERATOR rather than as a parameter marker" are different questions, and
  // only one of them is answerable by asserting on a compiled string. This file answers the
  // other. The same argument the header makes about #974 applies verbatim.

  it("EMPTY BOX + a profile — only the postings whose reach set contains the worker's skill", async () => {
    const { rows } = await search({ profileSkillIds: [MSKILL_MINE], city: CITY_REACH });

    // Two postings share this city, this state and this published_at, and neither is
    // reachable by any term. `reach_skill_ids` is the ONLY thing that separates them, so a
    // fallback that matched everything would return both and one that matched nothing would
    // return neither — the expected answer is unreachable by accident.
    expect(mine(rows)).toEqual([P_REACH_MINE]);
  });

  it("EMPTY BOX + NO profile — the whole city comes back, exactly as before #1240", async () => {
    const { rows } = await search({ profileSkillIds: [], city: CITY_REACH });

    // The owner ruling: an unprofiled worker keeps today's behaviour rather than being shown
    // an empty page. This is the regression guard on that decision — and it is also what
    // proves the test above is measuring the FILTER and not merely the fixture.
    expect(mine(rows).sort()).toEqual([P_REACH_MINE, P_REACH_OTHER].sort());
  });

  it("EMPTY BOX + a profile matching NOTHING — an honest empty page, not a silent match-all", async () => {
    const { rows } = await search({ profileSkillIds: ["mskill_jobsearchgate_absent"], city: CITY_REACH });

    // The failure mode this pins is the dangerous one: if `?|` were mis-rendered such that the
    // predicate collapsed to TRUE, every test above would still pass and search would quietly
    // stop filtering. Only a query whose correct answer is EMPTY can catch that.
    expect(mine(rows)).toEqual([]);
  });

  it("a TYPED q overrides the profile in the database, not just in the builder", async () => {
    // The worker's profile says MSKILL_MINE, but he typed a term that only the OTHER posting
    // answers to. He must get what he asked for: the profile is an override, never an
    // additional AND that quietly narrows an explicit search.
    const { rows } = await search({ q: "beta", profileSkillIds: [MSKILL_MINE], city: CITY_REACH });

    expect(mine(rows)).toEqual([P_REACH_OTHER]);
  });

  it("the fallback still EXCLUDES what the worker already decided on", async () => {
    // Every existing clause must survive the new one. The anti-join is the easiest to lose,
    // because the fallback sits in the same conditions array it does.
    const { rows } = await search({ profileSkillIds: [MSKILL_MINE] });

    expect(mine(rows)).not.toContain(P_APPLIED);
    expect(mine(rows)).not.toContain(P_SKIPPED);
    // And the draft stays invisible — status='open' is unaffected too.
    expect(mine(rows)).not.toContain(P_DRAFT);
  });

  it("ALL-INDIA — an empty location does not narrow the profile fallback", async () => {
    // Scenario 1 of #1240: profile role, no location typed. The reach filter must apply
    // WITHOUT a city predicate, which is the combination the feed cannot express at all
    // (it is city-equality gated) and the reason search could not simply reuse `job_reach`.
    const { rows } = await search({ profileSkillIds: [MSKILL_MINE] });

    expect(mine(rows)).toContain(P_REACH_MINE);
    expect(mine(rows)).not.toContain(P_REACH_OTHER);
  });
});
