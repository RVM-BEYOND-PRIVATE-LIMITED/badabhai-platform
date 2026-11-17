import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, workforceUuid, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { AdminEventsRepository } from "../admin-events.repository";
import { AdminNumbersWeeklyQuerySchema } from "./admin-numbers.dto";
import { AdminNumbersWeeklyService } from "./admin-numbers-weekly.service";
import { NUMBERS_SNAPSHOT_METRICS } from "./definitions";
import { NUMBERS_CITY_GROUP_MEMBERS, NUMBERS_TRADE_GROUP_MEMBERS } from "./groups";
import { NumbersSnapshotService } from "./numbers-snapshot.service";
import { NumbersWeeklyRepository } from "./numbers-weekly.repository";
import { recomputeNumbers } from "./recompute-numbers";

/**
 * #2755 part B against a real Postgres — THE PARITY TEST the issue asks for: every figure the
 * sweep stores equals a HAND-WRITTEN SQL query over the same tables (written here from the rule
 * in words, not from the repository), and:
 *  - test, sample and linked rows never count (a company marked test changes no company figure,
 *    a linked RVM identity changes no worker total), mock-ish rows (an unpaid order) neither;
 *  - a worker cell under the floor is stored suppressed, never a number;
 *  - the route reads the snapshot and nothing else;
 *  - a FROZEN week does not change on the next sweep, a recompute changes it and writes ONE log
 *    row, and a dry run writes nothing;
 *  - two sweeps racing on two connections leave one set of rows.
 *
 * Fixtures carry no real PII: synthetic ids, opaque tokens for the encrypted columns. The figures
 * cover the WHOLE database (as production's do), so every expectation is a hand-written query run
 * now, never a constant that another suite's rows could falsify; the fixtures make each query
 * non-vacuous.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run numbers-weekly.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`numbers-weekly.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const CORR = randomUUID();

/** Two past weeks: WA is due to freeze at NOW, WB is the week NOW falls in. */
const WA = "2026-09-07";
const WB = "2026-09-14";
const WA_FROM = "2026-09-06T18:30:00.000Z"; // Monday 7 Sep 00:00 IST
const WA_TO = "2026-09-13T18:30:00.000Z"; // Monday 14 Sep 00:00 IST
const WB_FROM = WA_TO;
const WB_TO = "2026-09-20T18:30:00.000Z";
const NOW = new Date("2026-09-19T06:00:00.000Z"); // Saturday 19 Sep, IST
const at = (iso: string) => new Date(iso);
const minus1ms = (iso: string) => new Date(at(iso).getTime() - 1);

const id = () => randomUUID();
const CO_A = id(); // Pune, CNC turner postings
const CO_B = id(); // NCR, 3D CAD posting
const CO_C = id(); // no posting: unknown × unknown
const CO_TEST = id(); // marked as a test company
const CO_SAMPLE = workforceUuid("payer", 0x7e0000000000 + Math.floor(Math.random() * 0xffff));
const PAYERS = [CO_A, CO_B, CO_C, CO_TEST, CO_SAMPLE];

const PUNE_WORKERS = Array.from({ length: 6 }, () => id());
const [WK1, WK2, WK3, WK4] = PUNE_WORKERS as [string, string, string, string, ...string[]];
const WK7 = id(); // NCR, CAM programmer
const WK8 = id(); // Pune: finished the form, no profile
const WK_RECONF = id(); // confirmed once, then re-interviewed: current profile not confirmed
const WK_TEST = id();
const WK_SAMPLE = workforceUuid("worker", 0x7e0000000000 + Math.floor(Math.random() * 0xffff));
const WK_LINKED = id(); // a Campus row that never signed in
const WORKERS = [...PUNE_WORKERS, WK7, WK8, WK_RECONF, WK_TEST, WK_SAMPLE, WK_LINKED];

const SAMPLE_POSTING = workforceUuid(
  "posting",
  0x7e0000000000 + Math.floor(Math.random() * 0xffff),
);

const CONFIG = { ADMIN_NUMBERS_ENABLED: true, NUMBERS_FREEZE_AFTER_DAYS: 3 } as ServerConfig;

/** The countable-worker rule, hand-written over `w`. */
const COUNTABLE_W = `NOT w.is_test_account
  AND w.id::text NOT LIKE 'face2000-0000-4000-8000-%'
  AND w.id::text NOT LIKE 'be162000-0000-4000-8000-%'
  AND NOT (w.status = 'pending' AND EXISTS (
    SELECT 1 FROM worker_origins o WHERE o.worker_id = w.id AND o.kind = 'institute'))`;
/** The countable-company rule, hand-written over a payer id expression. */
const countableCo = (col: string) =>
  `${col} NOT IN (SELECT p.id FROM payers p WHERE p.is_test_account)
   AND ${col}::text NOT LIKE 'face1000-0000-4000-8000-%'`;
/** A worker reference that is not a test or sample worker (NULL kept). */
const okWorkerRef = (col: string) =>
  `(${col} IS NULL OR (${col} NOT IN (SELECT t.id FROM workers t WHERE t.is_test_account)
     AND ${col}::text NOT LIKE 'face2000-0000-4000-8000-%'
     AND ${col}::text NOT LIKE 'be162000-0000-4000-8000-%'))`;

describe.skipIf(!RUN)("#2755 part B against Postgres (the weekly snapshot)", () => {
  let client!: DbClient;
  let client2!: DbClient;
  let repo!: NumbersWeeklyRepository;
  let snapshot!: NumbersSnapshotService;
  const logIds: string[] = [];

  /** One hand-written integer. */
  async function one(query: string, params: unknown[] = []): Promise<number> {
    const rows = (await client.sql.unsafe(query, params as never[])) as unknown as Array<{
      n: string | number | null;
    }>;
    return Number(rows[0]?.n ?? 0);
  }

  /** The stored all × all cell (or any cell) of a metric. */
  async function stored(
    week: string,
    metric: string,
    city = "all",
    trade = "all",
  ): Promise<
    | {
        value: number | null;
        suppressed: boolean;
        numerator: number | null;
        denominator: number | null;
        frozen: boolean;
      }
    | undefined
  > {
    const rows = await client.sql<
      Array<{
        value: string | null;
        suppressed: boolean;
        numerator: string | null;
        denominator: string | null;
        frozen_at: string | null;
      }>
    >`SELECT value, suppressed, numerator, denominator, frozen_at FROM numbers_weekly
      WHERE week_start = ${week}::date AND metric = ${metric}
        AND city_group = ${city} AND trade_group = ${trade}`;
    const r = rows[0];
    if (r === undefined) return undefined;
    const n = (v: string | null) => (v === null ? null : Number(v));
    return {
      value: n(r.value),
      suppressed: r.suppressed,
      numerator: n(r.numerator),
      denominator: n(r.denominator),
      frozen: r.frozen_at !== null,
    };
  }

  /** A WORKER cell: equal to the hand count, or suppressed when that count is under the floor. */
  async function expectWorkerCell(
    week: string,
    metric: string,
    city: string,
    trade: string,
    hand: number,
  ): Promise<void> {
    const cell = await stored(week, metric, city, trade);
    const total = city === "all" && trade === "all";
    if (!total && hand < 5) {
      expect(cell, `${metric} ${city}×${trade}`).toMatchObject({ value: null, suppressed: true });
    } else {
      expect(cell, `${metric} ${city}×${trade}`).toMatchObject({ value: hand, suppressed: false });
    }
  }

  // -- the hand-written queries, one per rule ---------------------------------------------

  const paying = (from: string | null, to: string) =>
    one(
      `SELECT count(DISTINCT po.payer_id) AS n FROM payment_orders po
        WHERE po.status = 'paid' AND po.updated_at < $1::timestamptz
          AND ($2::timestamptz IS NULL OR po.updated_at >= $2::timestamptz)
          AND ${countableCo("po.payer_id")}`,
      [to, from],
    );

  /** The SQL twin of `normalizeCityName` + a launch group's members. */
  const cityIs = (col: string, group: keyof typeof NUMBERS_CITY_GROUP_MEMBERS) =>
    `trim(regexp_replace(regexp_replace(lower(split_part(${col}, ',', 1)), '[-_.]+', ' ', 'g'),
       '[[:space:]]+', ' ', 'g')) IN (${NUMBERS_CITY_GROUP_MEMBERS[group]
         .map((m) => `'${m}'`)
         .join(",")})`;
  const tradeIs = (col: string, group: keyof typeof NUMBERS_TRADE_GROUP_MEMBERS) =>
    `${col} IN (${NUMBERS_TRADE_GROUP_MEMBERS[group].roleKinds.map((k) => `'${k}'`).join(",")})`;
  const LATEST_POSTING = `(SELECT DISTINCT ON (jp.payer_id) jp.payer_id, jp.city, jp.role_kind
     FROM job_postings jp WHERE jp.payer_id IS NOT NULL
     ORDER BY jp.payer_id, jp.created_at DESC, jp.id DESC)`;

  const payingIn = (
    from: string,
    to: string,
    city: "pune" | "ncr",
    trade: "cnc_operator" | "cad_3d_designer",
  ) =>
    one(
      `SELECT count(DISTINCT po.payer_id) AS n FROM payment_orders po
        JOIN ${LATEST_POSTING} l ON l.payer_id = po.payer_id
        WHERE po.status = 'paid' AND po.updated_at >= $1::timestamptz AND po.updated_at < $2::timestamptz
          AND ${countableCo("po.payer_id")} AND ${cityIs("l.city", city)} AND ${tradeIs("l.role_kind", trade)}`,
      [from, to],
    );

  const posted = (from: string | null, to: string) =>
    one(
      `SELECT count(*) AS n FROM (
         SELECT jp.payer_id, min(jp.published_at) AS first FROM job_postings jp
          WHERE jp.published_at IS NOT NULL AND jp.payer_id IS NOT NULL
            AND ${countableCo("jp.payer_id")} AND jp.id::text NOT LIKE 'face3000-0000-4000-8000-%'
          GROUP BY jp.payer_id) f
        WHERE f.first < $1::timestamptz AND ($2::timestamptz IS NULL OR f.first >= $2::timestamptz)`,
      [to, from],
    );

  const CURRENT_PROFILES = `(SELECT DISTINCT ON (wp.worker_id) wp.worker_id, wp.profile_status, wp.confirmed_at
     FROM worker_profiles wp JOIN workers w ON w.id = wp.worker_id
     WHERE ${COUNTABLE_W}
     ORDER BY wp.worker_id, (wp.profile_status <> 'draft') DESC, wp.created_at DESC, wp.id DESC)`;

  const completed = (from: string | null, to: string) =>
    one(
      `SELECT count(*) AS n FROM ${CURRENT_PROFILES} cur
        WHERE cur.profile_status = 'confirmed' AND cur.confirmed_at < $1::timestamptz
          AND ($2::timestamptz IS NULL OR cur.confirmed_at >= $2::timestamptz)`,
      [to, from],
    );

  const completedPuneCnc = (from: string, to: string) =>
    one(
      `SELECT count(*) AS n FROM ${CURRENT_PROFILES} cur JOIN workers w ON w.id = cur.worker_id
        WHERE cur.profile_status = 'confirmed' AND cur.confirmed_at >= $1::timestamptz
          AND cur.confirmed_at < $2::timestamptz AND ${cityIs("w.current_city", "pune")}
          AND (SELECT o.role_id FROM worker_occupation o WHERE o.worker_id = w.id
                ORDER BY o.sort_order LIMIT 1) IN (${NUMBERS_TRADE_GROUP_MEMBERS.cnc_operator.taxonomyRoles
                  .map((r) => `'${r}'`)
                  .join(",")})`,
      [from, to],
    );

  const active = (sunday: string, to: string) =>
    one(
      `SELECT count(*) AS n FROM workers w WHERE ${COUNTABLE_W} AND greatest(
         (SELECT max(wa.active_on) FROM worker_activity wa WHERE wa.worker_id = w.id AND wa.active_on <= $1::date),
         (SELECT (max(wd.last_seen_at) AT TIME ZONE 'Asia/Kolkata')::date FROM worker_devices wd
           WHERE wd.worker_id = w.id AND wd.last_seen_at < $2::timestamptz)
       ) BETWEEN $1::date - 29 AND $1::date`,
      [sunday, to],
    );

  const hires = (monday: string | null, sunday: string) =>
    one(
      `SELECT count(*) AS n FROM hires h
        WHERE h.status = 'confirmed' AND h.hired_on <= $1::date
          AND ($2::date IS NULL OR h.hired_on >= $2::date)
          AND ${countableCo("h.tenant_payer_id")} AND ${okWorkerRef("h.worker_id")}`,
      [sunday, monday],
    );

  const opened = (from: string, to: string) =>
    one(
      `SELECT count(*) AS n FROM unlocks u
        WHERE u.status IN ('granted', 'revealed', 'expired')
          AND u.granted_at >= $1::timestamptz AND u.granted_at < $2::timestamptz
          AND ${countableCo("u.payer_id")} AND ${okWorkerRef("u.worker_id")}`,
      [from, to],
    );

  const revenue = (from: string, to: string, pack: string | null) =>
    one(
      `SELECT coalesce(sum(po.amount_inr * 100), 0) AS n FROM payment_orders po
        WHERE po.status = 'paid' AND po.updated_at >= $1::timestamptz AND po.updated_at < $2::timestamptz
          AND ($3::text IS NULL OR po.pack_code = $3::text) AND ${countableCo("po.payer_id")}`,
      [from, to, pack],
    );

  const formGap = (from: string, to: string) =>
    client.sql.unsafe(
      `WITH f AS (
         SELECT e.subject_id AS worker_id, min(e.occurred_at) AS first FROM events e
          WHERE e.event_name = 'profile.form_completed' AND e.subject_type = 'worker'
          GROUP BY e.subject_id)
       SELECT count(*) FILTER (WHERE cur.profile_status IS DISTINCT FROM 'confirmed') AS unconfirmed,
              count(*) AS finished
         FROM f JOIN workers w ON w.id = f.worker_id
         LEFT JOIN LATERAL (
           SELECT wp.profile_status FROM worker_profiles wp WHERE wp.worker_id = w.id
            ORDER BY (wp.profile_status <> 'draft') DESC, wp.created_at DESC, wp.id DESC LIMIT 1
         ) cur ON true
        WHERE f.first >= $1::timestamptz AND f.first < $2::timestamptz AND ${COUNTABLE_W}`,
      [from, to],
    ) as unknown as Promise<Array<{ unconfirmed: string; finished: string }>>;

  // -- fixtures ----------------------------------------------------------------------------

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    client2 = createDbClient(DATABASE_URL, { max: 4 });
    repo = new NumbersWeeklyRepository(client.db, new AdminEventsRepository(client.db));
    snapshot = new NumbersSnapshotService(repo, CONFIG);
    const { sql } = client;
    await sql`DELETE FROM numbers_weekly WHERE week_start IN (${WA}::date, ${WB}::date)`;

    for (const [i, p] of PAYERS.entries()) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status, is_test_account)
        VALUES (${p}::uuid, 'employer', ${`enc:nw-${TAG}-${i}`}, ${`hash:nw-${TAG}-${i}`},
                ${`enc:nw-org-${TAG}-${i}`}, 'active', ${p === CO_TEST})`;
    }
    const posting = async (
      payerId: string,
      city: string,
      roleKind: string,
      createdAt: string,
      publishedAt: string | null,
      postingId: string = id(),
    ) => sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                city, role_kind, created_at, published_at)
      VALUES (${postingId}::uuid, ${id()}::uuid, ${payerId}::uuid, 'Numbers Fixture',
              ${`Numbers posting ${TAG}`}, '1', 'open', ${city}, ${roleKind},
              ${createdAt}::timestamptz, ${publishedAt}::timestamptz)`;
    // A: an older NCR draft, then its LATEST posting in Pune (CNC turner), first published in WA.
    await posting(CO_A, "Delhi", "cad_designer_3d", "2026-08-01T00:00:00Z", null);
    await posting(CO_A, "Pimpri-Chinchwad, MH", "cnc_turner", "2026-09-01T00:00:00Z", WA_FROM);
    // B: Gurugram, 3D CAD, first published in WB.
    await posting(
      CO_B,
      "Gurugram",
      "cad_designer_3d",
      "2026-09-10T00:00:00Z",
      "2026-09-15T10:00:00Z",
    );
    // Test and sample companies publish in WA: never counted.
    await posting(CO_TEST, "Pune", "cnc_turner", "2026-09-01T00:00:00Z", "2026-09-08T10:00:00Z");
    await posting(
      CO_SAMPLE,
      "Pune",
      "cnc_turner",
      "2026-09-01T00:00:00Z",
      "2026-09-08T10:00:00Z",
      SAMPLE_POSTING,
    );

    const order = async (
      payerId: string,
      pack: string,
      inr: number,
      status: string,
      when: Date,
    ) => sql`
      INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider,
                                  provider_order_id, status, created_at, updated_at)
      VALUES (${payerId}::uuid, ${pack}, ${inr}, 10, 'razorpay', ${`order_nw_${TAG}_${id()}`},
              ${status}, ${when.toISOString()}::timestamptz, ${when.toISOString()}::timestamptz)`;
    await order(CO_A, "pack_50", 2000, "paid", at(WA_FROM)); // WA's first instant
    await order(CO_A, "pack_200", 8000, "paid", at("2026-09-10T08:00:00Z"));
    await order(CO_A, "pack_50", 2000, "created", at("2026-09-10T08:00:00Z")); // never paid
    await order(CO_B, "pack_50", 2000, "paid", minus1ms(WA_FROM)); // the week before WA
    await order(CO_B, "pack_50", 2000, "paid", at("2026-09-16T08:00:00Z"));
    await order(CO_C, "pack_200", 8000, "paid", minus1ms(WB_TO)); // WB's last instant
    await order(CO_TEST, "pack_50", 2000, "paid", at("2026-09-10T08:00:00Z"));
    await order(CO_SAMPLE, "pack_50", 2000, "paid", at("2026-09-10T08:00:00Z"));

    for (const [k, w] of WORKERS.entries()) {
      const city = w === WK7 ? "New Delhi" : "Pune";
      const status = w === WK_LINKED ? "pending" : "active";
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status, current_city, is_test_account)
        VALUES (${w}::uuid, ${`enc:nw-${TAG}-${k}`}, ${`hash:nw-${TAG}-${k}`}, ${status}, ${city},
                ${w === WK_TEST})`;
      await sql`
        INSERT INTO worker_occupation (worker_id, role_id, sort_order)
        VALUES (${w}::uuid, ${w === WK7 ? "role_cam_programmer" : "role_cnc_turner_operator"}, 0)`;
    }
    await sql`INSERT INTO worker_origins (worker_id, kind) VALUES (${WK_LINKED}::uuid, 'institute')`;

    const profile = async (
      w: string,
      status: string,
      confirmedAt: string | null,
      createdAt: string,
    ) => sql`
      INSERT INTO worker_profiles (worker_id, profile_status, confirmed_at, created_at)
      VALUES (${w}::uuid, ${status}, ${confirmedAt}::timestamptz, ${createdAt}::timestamptz)`;
    for (const w of PUNE_WORKERS)
      await profile(w, "confirmed", "2026-09-09T05:00:00Z", "2026-09-08T00:00:00Z");
    await profile(WK7, "confirmed", "2026-09-15T05:00:00Z", "2026-09-14T00:00:00Z");
    for (const w of [WK_TEST, WK_SAMPLE, WK_LINKED]) {
      await profile(w, "confirmed", "2026-09-09T05:00:00Z", "2026-09-08T00:00:00Z");
    }
    // Confirmed in WA, then a newer extracted interview: his CURRENT profile is not confirmed.
    await profile(WK_RECONF, "confirmed", "2026-09-09T05:00:00Z", "2026-09-08T00:00:00Z");
    await profile(WK_RECONF, "extracted", null, "2026-09-12T00:00:00Z");

    // Activity: WK1 active in WA; WK2 only 40 days before WA's Sunday; WK3 a device seen in WA;
    // WK4 a device seen only after WB (never read for these weeks); the test worker active.
    await sql`INSERT INTO worker_activity (worker_id, active_on) VALUES
      (${WK1}::uuid, '2026-09-09'), (${WK2}::uuid, '2026-08-04'), (${WK_TEST}::uuid, '2026-09-09')`;
    await sql`INSERT INTO worker_devices (worker_id, device_hash, last_seen_at) VALUES
      (${WK3}::uuid, ${`nw-dev-${TAG}-3`}, '2026-09-08T12:00:00Z'),
      (${WK4}::uuid, ${`nw-dev-${TAG}-4`}, '2026-10-01T12:00:00Z')`;

    // Hires: A confirms two in WA (Monday and Sunday), B only reported, the test company one, and
    // A one of a test worker; WK7 by B confirmed in WB.
    const hire = async (payerId: string, w: string, status: string, hiredOn: string | null) => sql`
      INSERT INTO hires (tenant_payer_id, worker_id, posting_kind, posting_id, status, hired_on)
      VALUES (${payerId}::uuid, ${w}::uuid, 'company_posting', ${id()}::uuid, ${status}, ${hiredOn}::date)`;
    await hire(CO_A, WK1, "confirmed", WA);
    await hire(CO_A, WK2, "confirmed", "2026-09-13");
    await hire(CO_B, WK3, "reported", null);
    await hire(CO_TEST, WK3, "confirmed", WA);
    await hire(CO_A, WK_TEST, "confirmed", WA);
    await hire(CO_B, WK7, "confirmed", "2026-09-16");

    // Contacts opened in WA: A five granted + one expired, a denied one, B one; the test company
    // one, and A one of the test worker.
    const unlock = async (
      payerId: string,
      w: string,
      status: string,
      grantedAt: string | null,
    ) => sql`
      INSERT INTO unlocks (payer_id, worker_id, status, granted_at)
      VALUES (${payerId}::uuid, ${w}::uuid, ${status}, ${grantedAt}::timestamptz)`;
    for (const w of PUNE_WORKERS.slice(0, 5))
      await unlock(CO_A, w, "granted", "2026-09-08T09:00:00Z");
    await unlock(CO_A, WK7, "expired", "2026-09-08T09:00:00Z");
    await unlock(CO_A, PUNE_WORKERS[5]!, "denied", null);
    await unlock(CO_B, WK1, "granted", "2026-09-10T09:00:00Z");
    await unlock(CO_TEST, WK1, "granted", "2026-09-10T09:00:00Z");
    await unlock(CO_A, WK_TEST, "granted", "2026-09-10T09:00:00Z");

    // Form completions in WA: WK8 (no profile), WK1 (confirmed), the test worker (out).
    for (const w of [WK8, WK1, WK_TEST]) {
      await sql`
        INSERT INTO events (event_name, event_version, occurred_at, actor_type, actor_id,
                            subject_type, subject_id, correlation_id, payload)
        VALUES ('profile.form_completed', 1, '2026-09-10T09:00:00Z', 'worker', ${w}::uuid,
                'worker', ${w}::uuid, ${CORR}::uuid, ${JSON.stringify({ worker_id: w })}::jsonb)`;
    }
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    await sql`DELETE FROM numbers_weekly WHERE week_start IN (${WA}::date, ${WB}::date)`;
    if (logIds.length > 0)
      await sql`DELETE FROM numbers_recompute_log WHERE id = ANY(${logIds}::uuid[])`;
    await sql`DELETE FROM events WHERE correlation_id = ${CORR}::uuid`;
    await sql`DELETE FROM unlocks WHERE payer_id = ANY(${PAYERS}::uuid[])`;
    await sql`DELETE FROM hires WHERE tenant_payer_id = ANY(${PAYERS}::uuid[])`;
    await sql`DELETE FROM payment_orders WHERE payer_id = ANY(${PAYERS}::uuid[])`;
    await sql`DELETE FROM job_postings WHERE payer_id = ANY(${PAYERS}::uuid[])`;
    await sql`DELETE FROM worker_activity WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM worker_devices WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM worker_occupation WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM worker_origins WHERE worker_id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    await sql`DELETE FROM payers WHERE id = ANY(${PAYERS}::uuid[])`;
    await client.sql.end({ timeout: 5 });
    await client2.sql.end({ timeout: 5 });
  });

  // -- the sweep -----------------------------------------------------------------------------

  it("the sweep stores every metric × 42 cells for both weeks; WA is frozen, WB stays open", async () => {
    const out = await snapshot.sweep(NOW, [WA, WB]);
    expect(out).toEqual({ armed: true, computed: 1, frozen: 1, skipped: 0 });
    for (const week of [WA, WB]) {
      const metrics = await client.sql<Array<{ metric: string; n: string }>>`
        SELECT metric, count(*) AS n FROM numbers_weekly WHERE week_start = ${week}::date GROUP BY metric`;
      const ids = metrics.map((m) => m.metric);
      for (const m of Object.keys(NUMBERS_SNAPSHOT_METRICS))
        expect(ids, `${week} ${m}`).toContain(m);
      for (const m of metrics) expect(Number(m.n), `${week} ${m.metric}`).toBe(42);
    }
    expect((await stored(WA, "paying_companies"))?.frozen).toBe(true);
    expect((await stored(WB, "paying_companies"))?.frozen).toBe(false);
  });

  // -- parity: each figure equals its hand-written query ----------------------------------

  it("paying companies: once each, paid orders only, test and sample companies out", async () => {
    expect(await paying(WA_FROM, WA_TO)).toBeGreaterThanOrEqual(1); // A (twice, and an unpaid one)
    expect((await stored(WA, "paying_companies"))?.value).toBe(await paying(WA_FROM, WA_TO));
    expect((await stored(WB, "paying_companies"))?.value).toBe(await paying(WB_FROM, WB_TO));
    expect((await stored(WA, "paying_companies_cumulative"))?.value).toBe(
      await paying(null, WA_TO),
    );
    expect((await stored(WB, "paying_companies_cumulative"))?.value).toBe(
      await paying(null, WB_TO),
    );
  });

  it("company cells: the city and trade of the company's LATEST posting", async () => {
    expect(await payingIn(WA_FROM, WA_TO, "pune", "cnc_operator")).toBeGreaterThanOrEqual(1);
    expect((await stored(WA, "paying_companies", "pune", "cnc_operator"))?.value).toBe(
      await payingIn(WA_FROM, WA_TO, "pune", "cnc_operator"),
    );
    expect((await stored(WB, "paying_companies", "ncr", "cad_3d_designer"))?.value).toBe(
      await payingIn(WB_FROM, WB_TO, "ncr", "cad_3d_designer"),
    );
    // A's older NCR posting is not its latest: A never sits in NCR.
    expect((await stored(WA, "paying_companies", "ncr", "all"))?.value).toBe(0);
  });

  it("companies that posted: the first publish per company, sample postings and test companies out", async () => {
    expect((await stored(WA, "companies_posted"))?.value).toBe(await posted(WA_FROM, WA_TO));
    expect((await stored(WB, "companies_posted"))?.value).toBe(await posted(WB_FROM, WB_TO));
    expect((await stored(WB, "companies_posted_cumulative"))?.value).toBe(
      await posted(null, WB_TO),
    );
    expect(await posted(WB_FROM, WB_TO)).toBeGreaterThanOrEqual(1); // B
  });

  it("completed profiles: the funnel's current-confirmed rule; test, sample, linked and re-interviewed out", async () => {
    expect(await completed(WA_FROM, WA_TO)).toBeGreaterThanOrEqual(6);
    await expectWorkerCell(WA, "completed_profiles", "all", "all", await completed(WA_FROM, WA_TO));
    await expectWorkerCell(WB, "completed_profiles", "all", "all", await completed(WB_FROM, WB_TO));
    await expectWorkerCell(
      WB,
      "completed_profiles_cumulative",
      "all",
      "all",
      await completed(null, WB_TO),
    );
    await expectWorkerCell(
      WA,
      "completed_profiles",
      "pune",
      "cnc_operator",
      await completedPuneCnc(WA_FROM, WA_TO),
    );
  });

  it("a worker cell under the floor is stored suppressed, with no number at all", async () => {
    // WK7 is NCR's only confirmation in WB (unless another suite left more): under 5 → hidden.
    const ncr = await stored(WB, "completed_profiles", "ncr", "all");
    expect(ncr?.suppressed).toBe(true);
    expect(ncr).toMatchObject({ value: null, numerator: null, denominator: null });
  });

  it("active workers in the 30 days to the Sunday: #2753's last active day as of that Sunday", async () => {
    expect(await active("2026-09-13", WA_TO)).toBeGreaterThanOrEqual(2); // WK1 (activity), WK3 (device)
    await expectWorkerCell(
      WA,
      "active_workers_30d",
      "all",
      "all",
      await active("2026-09-13", WA_TO),
    );
    await expectWorkerCell(
      WB,
      "active_workers_30d",
      "all",
      "all",
      await active("2026-09-20", WB_TO),
    );
  });

  it("confirmed hires: confirmed records only, by hired_on; test companies and test workers out", async () => {
    expect(await hires(WA, "2026-09-13")).toBeGreaterThanOrEqual(2);
    expect((await stored(WA, "confirmed_hires"))?.value).toBe(await hires(WA, "2026-09-13"));
    expect((await stored(WB, "confirmed_hires"))?.value).toBe(await hires(WB, "2026-09-20"));
    expect((await stored(WB, "confirmed_hires_cumulative"))?.value).toBe(
      await hires(null, "2026-09-20"),
    );
  });

  it("contacts per hire: granted opens over confirmed hires, both terms kept, hundredths half up", async () => {
    const num = await opened(WA_FROM, WA_TO);
    const den = await hires(WA, "2026-09-13");
    expect(num).toBeGreaterThanOrEqual(7);
    const cell = await stored(WA, "contacts_per_hire");
    expect(cell).toMatchObject({ numerator: num, denominator: den, suppressed: false });
    expect(cell?.value).toBe(Math.floor((num * 200 + den) / (2 * den)));
  });

  it("revenue by pack, in paise, as charged: the total and one figure per pack", async () => {
    expect(await revenue(WA_FROM, WA_TO, null)).toBeGreaterThanOrEqual(1_000_000);
    expect((await stored(WA, "revenue_by_pack"))?.value).toBe(await revenue(WA_FROM, WA_TO, null));
    for (const pack of ["pack_50", "pack_200"]) {
      expect((await stored(WA, `revenue_by_pack:${pack}`))?.value, pack).toBe(
        await revenue(WA_FROM, WA_TO, pack),
      );
      expect((await stored(WB, `revenue_by_pack:${pack}`))?.value, pack).toBe(
        await revenue(WB_FROM, WB_TO, pack),
      );
    }
  });

  it("the form-worker gap: first form completion in the week, current profile not confirmed", async () => {
    const [row] = await formGap(WA_FROM, WA_TO);
    const unconfirmed = Number(row?.unconfirmed ?? 0);
    const finished = Number(row?.finished ?? 0);
    expect(finished).toBeGreaterThanOrEqual(2); // WK8 and WK1; the test worker out
    expect(await stored(WA, "form_completed_unconfirmed")).toMatchObject({
      value: unconfirmed,
      numerator: unconfirmed,
      denominator: finished,
    });
  });

  // -- the exclusions, end to end -----------------------------------------------------------

  it("a company marked as test changes no company figure; a linked identity no worker total", async () => {
    const total = async (metric: string, week: string) => {
      const rows = await repo.withTransaction((tx) =>
        snapshot.computeWeekRows(tx, week, true, NOW),
      );
      return rows.find(
        (r) => r.metric === metric && r.cityGroup === "all" && r.tradeGroup === "all",
      )!.value;
    };
    const before = await total("paying_companies", WB);
    await client.sql`UPDATE payers SET is_test_account = true WHERE id = ${CO_C}::uuid`;
    expect(await total("paying_companies", WB)).toBe((before ?? 0) - 1);
    await client.sql`UPDATE payers SET is_test_account = false WHERE id = ${CO_C}::uuid`;
    expect(await total("paying_companies", WB)).toBe(before);

    const confirmed = await total("completed_profiles", WB);
    // WK7 becomes a Campus row that never signed in.
    await client.sql`UPDATE workers SET status = 'pending' WHERE id = ${WK7}::uuid`;
    await client.sql`INSERT INTO worker_origins (worker_id, kind) VALUES (${WK7}::uuid, 'institute')`;
    expect(await total("completed_profiles", WB)).toBe((confirmed ?? 0) - 1);
    await client.sql`DELETE FROM worker_origins WHERE worker_id = ${WK7}::uuid`;
    await client.sql`UPDATE workers SET status = 'active' WHERE id = ${WK7}::uuid`;
    expect(await total("completed_profiles", WB)).toBe(confirmed);
  });

  // -- the route ----------------------------------------------------------------------------

  it("GET /admin/numbers/weekly answers from the snapshot: WB this week, WA last week", async () => {
    const service = new AdminNumbersWeeklyService(repo, CONFIG);
    const out = await service.weekly(AdminNumbersWeeklyQuerySchema.parse({ weeks: "2" }), NOW);
    expect(out.weeks).toEqual([WA, WB]);
    const m = out.metrics.find((x) => x.id === "paying_companies")!;
    expect(m.this_week).toBe((await stored(WB, "paying_companies"))?.value);
    expect(m.last_week).toBe((await stored(WA, "paying_companies"))?.value);
    expect(m.series.map((p) => p.frozen)).toEqual([true, false]);
    // A real payment settled by WA's end (the cumulative is above zero), so neither is "before".
    expect(m.series.map((p) => p.before_real_payments)).toEqual([false, false]);
    const filtered = await service.weekly(
      AdminNumbersWeeklyQuerySchema.parse({ city: "pune", trade: "cnc_operator", weeks: "2" }),
      NOW,
    );
    expect(filtered.metrics.find((x) => x.id === "paying_companies")!.last_week).toBe(
      (await stored(WA, "paying_companies", "pune", "cnc_operator"))?.value,
    );
  });

  // -- freeze, recompute, race --------------------------------------------------------------

  it("a FROZEN week does not change on the next sweep; the open week does", async () => {
    const frozenBefore = await stored(WA, "paying_companies");
    const cumulativeBefore = await stored(WB, "paying_companies_cumulative");
    // A new company pays inside WA, after the freeze.
    const late = id();
    await client.sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
      VALUES (${late}::uuid, 'employer', ${`enc:nw-${TAG}-late`}, ${`hash:nw-${TAG}-late`},
              ${`enc:nw-org-${TAG}-late`}, 'active')`;
    PAYERS.push(late);
    await client.sql`
      INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider,
                                  provider_order_id, status, created_at, updated_at)
      VALUES (${late}::uuid, 'pack_50', 2000, 10, 'razorpay', ${`order_nw_${TAG}_late`}, 'paid',
              '2026-09-11T08:00:00Z', '2026-09-11T08:00:00Z')`;
    const cohortBefore = await stored(WA, "repeat_purchase_30d");
    const out = await snapshot.sweep(NOW, [WA, WB]);
    // Part C: WA's repeat-buying (cohort) rows stay open until 90 days after the week, so the
    // sweep recomputes them (WA counts as computed, not skipped); its frozen rows never move.
    expect(out).toEqual({ armed: true, computed: 2, frozen: 0, skipped: 0 });
    expect(await stored(WA, "paying_companies")).toEqual(frozenBefore);
    expect(cohortBefore?.frozen).toBe(false);
    expect(await stored(WA, "repeat_purchase_30d")).toMatchObject({
      value: null,
      numerator: null,
      denominator: (cohortBefore?.denominator ?? 0) + 1,
      frozen: false,
    });
    expect((await stored(WB, "paying_companies_cumulative"))?.value).toBe(
      (cumulativeBefore?.value ?? 0) + 1,
    );
    expect(await paying(WA_FROM, WA_TO)).toBe((frozenBefore?.value ?? 0) + 1);
  });

  it("a DRY-RUN recompute writes nothing; the APPLIED one rewrites the frozen week, re-freezes it, and logs ONE row", async () => {
    const lines: string[] = [];
    const reason = `numbers-db ${TAG}: a late payment in WA`;
    const logRows = async () =>
      Number(
        (
          await client.sql<Array<{ n: string }>>`
            SELECT count(*) AS n FROM numbers_recompute_log WHERE reason = ${reason}`
        )[0]?.n ?? 0,
      );
    const args = { fromWeek: WA, toWeek: WA, reason, apply: false };
    const dry = await recomputeNumbers({ repo, snapshot, log: (l) => lines.push(l) }, args, NOW);
    expect(dry.rowsChanged).toBeGreaterThanOrEqual(1);
    expect(dry.perMetric.get("paying_companies")?.changed).toBeGreaterThanOrEqual(1);
    expect(await logRows()).toBe(0);
    expect((await stored(WA, "paying_companies"))?.value).toBe((await paying(WA_FROM, WA_TO)) - 1);

    const applied = await recomputeNumbers(
      { repo, snapshot, log: (l) => lines.push(l) },
      { ...args, apply: true },
      NOW,
    );
    expect(applied.logId).not.toBeNull();
    logIds.push(applied.logId!);
    expect(await logRows()).toBe(1);
    expect(await stored(WA, "paying_companies")).toMatchObject({
      value: await paying(WA_FROM, WA_TO),
      frozen: true,
    });
    const [log] = await client.sql<
      Array<{
        actor: string;
        from_week: string;
        to_week: string;
        definition_version: number;
        rows_changed: number;
      }>
    >`SELECT actor, from_week::text, to_week::text, definition_version, rows_changed
        FROM numbers_recompute_log WHERE id = ${applied.logId!}::uuid`;
    expect(log).toEqual({
      actor: "cli",
      from_week: WA,
      to_week: WA,
      definition_version: 1,
      rows_changed: applied.rowsChanged,
    });
    // The reason is stored, never printed.
    expect(lines.join("\n")).not.toContain(reason);
    // And the next sweep leaves the recomputed week alone.
    await snapshot.sweep(NOW, [WA]);
    expect((await stored(WA, "paying_companies"))?.value).toBe(await paying(WA_FROM, WA_TO));
  });

  it("two sweeps racing on two connections leave ONE set of rows", async () => {
    const repo2 = new NumbersWeeklyRepository(client2.db, new AdminEventsRepository(client2.db));
    const snapshot2 = new NumbersSnapshotService(repo2, CONFIG);
    const [a, b] = await Promise.all([snapshot.sweep(NOW, [WB]), snapshot2.sweep(NOW, [WB])]);
    expect(a).toMatchObject({ armed: true, computed: 1 });
    expect(b).toMatchObject({ armed: true, computed: 1 });
    const rows = await client.sql<Array<{ n: string; metrics: string }>>`
      SELECT count(*) AS n, count(DISTINCT metric) AS metrics FROM numbers_weekly WHERE week_start = ${WB}::date`;
    expect(Number(rows[0]!.n)).toBe(Number(rows[0]!.metrics) * 42);
    expect((await stored(WB, "paying_companies"))?.value).toBe(await paying(WB_FROM, WB_TO));
  });
});
