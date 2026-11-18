import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, readSpendableCredits, workforceUuid, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminEventsRepository } from "../admin-events.repository";
import type { AdminIdentityService } from "../admin-identity.service";
import type { RequestContext } from "../../common/request-context";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { AdminNumbersOutOfCreditsQuerySchema } from "./admin-numbers.dto";
import { AdminNumbersCallsService } from "./admin-numbers-calls.service";
import { NUMBERS_CITY_GROUP_MEMBERS, NUMBERS_TRADE_GROUP_MEMBERS } from "./groups";
import { NumbersCallsRepository } from "./numbers-calls.repository";
import { NumbersSnapshotService } from "./numbers-snapshot.service";
import { NumbersWeeklyRepository } from "./numbers-weekly.repository";

/**
 * #2755 part C against a real Postgres — THE PARITY TEST of repeat buying and the call list:
 *  - every stored repeat-buying cell equals a HAND-WRITTEN SQL query over `payment_orders` (the
 *    first paid order per company, the second, the 30/60/90-day gap), pending cohorts store no
 *    share, unpaid orders and the mock route's ledger rows never count, test and sample companies
 *    are out;
 *  - the freeze keyed on the longest window: a week's frozen rows never move while its cohort rows
 *    are still recomputed, and a cohort frozen at its time does not change on the next sweep;
 *  - the call list equals a hand-written SQL in the SAME ORDER, walked page by page; the usable
 *    balance read agrees with the app's `readSpendableCredits` wallet by wallet; a company that
 *    spends its last credit is at the top;
 *  - the call log: the POST writes one row and its events, a retry writes nothing, an unknown or
 *    test company is a 404, the result CHECK refuses free text, the rows cascade with the company,
 *    and RLS is forced with no client grant.
 *
 * Fixtures carry no real PII: synthetic ids, opaque tokens for the encrypted columns. The figures
 * cover the WHOLE database (as production's do), so every expectation is a hand-written query run
 * now, never a constant another suite's rows could falsify; the fixtures make each query
 * non-vacuous.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run numbers-repeat-calls.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`numbers-repeat-calls.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const CORR = randomUUID();
const ADMIN_ID = randomUUID();
const ADMIN: AuthenticatedAdmin = { id: ADMIN_ID, role: "ops_admin", sid: "s" };
const CTX = { correlationId: CORR, requestId: randomUUID() } as RequestContext;
const id = () => randomUUID();

/** W1: a cohort whose three windows have all closed at NOW. W2: one whose windows are all open. */
const W1 = "2026-06-08";
const W1_FROM = "2026-06-07T18:30:00.000Z";
const W1_TO = "2026-06-14T18:30:00.000Z";
const W2 = "2026-10-26";
const W2_FROM = "2026-10-25T18:30:00.000Z";
const W2_TO = "2026-11-01T18:30:00.000Z";
const NOW = new Date("2026-11-17T06:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const plusDays = (iso: string, days: number) => new Date(at(iso).getTime() + days * DAY);

const CONFIG = { ADMIN_NUMBERS_ENABLED: true, NUMBERS_FREEZE_AFTER_DAYS: 3 } as ServerConfig;

// -- repeat-buying companies -------------------------------------------------------------------
const R_A = id(); // Pune CNC: paid again after 10 days
const R_B = id(); // Pune CNC: paid again after 45 days
const R_C = id(); // no posting: first on W1's last instant, again after 91 days
const R_D = id(); // one paid order; a created, a failed order and a mock ledger purchase
const R_E = id(); // first paid BEFORE W1, again inside it: never in W1's cohort
const R_F = id(); // two paid orders settled at the same instant
const R_TEST = id(); // a test company that repeats
const R_SAMPLE = workforceUuid("payer", 0x7c0000000000 + Math.floor(Math.random() * 0xffff));
const R_G = id(); // W2: paid again inside its open window
const R_PAYERS = [R_A, R_B, R_C, R_D, R_E, R_F, R_TEST, R_SAMPLE, R_G];

// -- call-list companies ----------------------------------------------------------------------
const CO_SPENT = id(); // spent its last credit: exhausted event, an empty lot
const CO_EXPIRED = id(); // its only lot is past its date, not yet swept: usable 0
const CO_SWEPT = id(); // its lot expired and was swept; an older spend
const CO_PARTIAL = id(); // one lot expired, another still open: usable > 0
const CO_TOPPED = id(); // ran out, then bought again: usable > 0
const CO_NEVER = id(); // a zero wallet that never held a credit: never ran out
const CO_SPENT_EARLY = id(); // a lot spent to zero BEFORE its date: the date is not an expiry
const CO_TEST = id(); // a test company that ran out
const CO_ARCHIVED = id(); // an archived company that ran out
const CO_SAMPLE = workforceUuid("payer", 0x7d0000000000 + Math.floor(Math.random() * 0xffff));
const [TIE_1, TIE_2] = [id(), id()]; // ran out at the same instant
const CO_NOW = id(); // spends its last credit during the test
const CO_CASCADE = id(); // deleted to prove the cascade
const C_PAYERS = [
  CO_SPENT,
  CO_EXPIRED,
  CO_SWEPT,
  CO_PARTIAL,
  CO_TOPPED,
  CO_NEVER,
  CO_SPENT_EARLY,
  CO_TEST,
  CO_ARCHIVED,
  CO_SAMPLE,
  TIE_1,
  TIE_2,
  CO_NOW,
  CO_CASCADE,
];
const PAYERS = [...R_PAYERS, ...C_PAYERS];

/** The countable-company rule, hand-written over a payer id expression. */
const countableCo = (col: string) =>
  `${col} NOT IN (SELECT p.id FROM payers p WHERE p.is_test_account)
   AND ${col}::text NOT LIKE 'face1000-0000-4000-8000-%'`;
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

/** `numerator / denominator` in hundredths, rounded half up — the stored share. */
const hundredths = (n: number, d: number) => Math.floor((n * 200 + d) / (2 * d));

describe.skipIf(!RUN)(
  "#2755 part C against Postgres (repeat buying, the call list, the call log)",
  () => {
    let client!: DbClient;
    let weekly!: NumbersWeeklyRepository;
    let snapshot!: NumbersSnapshotService;
    let calls!: NumbersCallsRepository;
    let service!: AdminNumbersCallsService;

    /** The stored all × all cell (or any cell) of a metric. */
    async function stored(week: string, metric: string, city = "all", trade = "all") {
      const rows = await client.sql<
        Array<{
          value: string | null;
          numerator: string | null;
          denominator: string | null;
          suppressed: boolean;
          frozen_at: Date | null;
          computed_at: Date;
        }>
      >`SELECT value, numerator, denominator, suppressed, frozen_at, computed_at FROM numbers_weekly
      WHERE week_start = ${week}::date AND metric = ${metric}
        AND city_group = ${city} AND trade_group = ${trade}`;
      const r = rows[0];
      if (r === undefined) return undefined;
      const n = (v: string | null) => (v === null ? null : Number(v));
      return {
        value: n(r.value),
        numerator: n(r.numerator),
        denominator: n(r.denominator),
        suppressed: r.suppressed,
        frozen: r.frozen_at !== null,
        computedAt: new Date(r.computed_at).getTime(),
      };
    }

    /**
     * THE HAND-WRITTEN REPEAT RULE: per company its FIRST and SECOND paid order (row_number over
     * the settle time), the cohort = first settled in [from, to), and how many have a second within
     * `days` days of their first. Optionally restricted to the Pune × CNC operator cell.
     */
    async function repeatHand(
      from: string,
      to: string,
      days: number,
      puneCnc = false,
    ): Promise<{ num: number; den: number }> {
      const rows = (await client.sql.unsafe(
        `WITH paid AS (
         SELECT po.payer_id, po.updated_at FROM payment_orders po
          WHERE po.status = 'paid' AND ${countableCo("po.payer_id")}),
       ranked AS (
         SELECT payer_id, updated_at,
                row_number() OVER (PARTITION BY payer_id ORDER BY updated_at) AS n FROM paid),
       cohort AS (
         SELECT f.payer_id, f.updated_at AS first, s.updated_at AS second
           FROM ranked f LEFT JOIN ranked s ON s.payer_id = f.payer_id AND s.n = 2
          WHERE f.n = 1 AND f.updated_at >= $1::timestamptz AND f.updated_at < $2::timestamptz)
       SELECT count(*) AS den,
              count(*) FILTER (WHERE c.second IS NOT NULL
                               AND c.second <= c.first + make_interval(days => $3::int)) AS num
         FROM cohort c
         ${puneCnc ? `JOIN ${LATEST_POSTING} l ON l.payer_id = c.payer_id` : ""}
        ${puneCnc ? `WHERE ${cityIs("l.city", "pune")} AND ${tradeIs("l.role_kind", "cnc_operator")}` : ""}`,
        [from, to, days] as never[],
      )) as unknown as Array<{ den: string; num: string }>;
      return { num: Number(rows[0]!.num), den: Number(rows[0]!.den) };
    }

    /**
     * THE HAND-WRITTEN CALL LIST, in order: the countable, non-archived wallets whose usable balance
     * is zero (balance minus the credits of lots past their date, floored at 0), with the later of
     * their last `payer.credits_exhausted` and the date of their newest lot that expired holding
     * credits; none → not on the list. Newest first (to the millisecond), then the id descending.
     */
    async function listHand(): Promise<Array<{ payer_id: string; ran_out_ms: number }>> {
      const rows = (await client.sql.unsafe(
        `WITH usable AS (
         SELECT pc.payer_id, greatest(0, pc.balance - coalesce((
                  SELECT sum(l.credits_remaining) FROM credit_lots l
                   WHERE l.payer_id = pc.payer_id AND l.credits_remaining > 0
                     AND l.expires_at <= now()), 0)) AS usable
           FROM payer_credits pc),
       spent AS (
         SELECT e.subject_id AS payer_id, max(e.occurred_at) AS at FROM events e
          WHERE e.event_name = 'payer.credits_exhausted' AND e.subject_type = 'payer'
          GROUP BY e.subject_id),
       expired AS (
         SELECT l.payer_id, max(l.expires_at) AS at FROM credit_lots l
          WHERE l.expires_at <= now() AND (l.credits_remaining > 0 OR l.expired_at IS NOT NULL)
          GROUP BY l.payer_id)
       SELECT u.payer_id::text AS payer_id,
              (extract(epoch from date_trunc('milliseconds', greatest(s.at, x.at))) * 1000)::float8 AS ran_out_ms
         FROM usable u
         JOIN payers p ON p.id = u.payer_id
         LEFT JOIN spent s ON s.payer_id = u.payer_id
         LEFT JOIN expired x ON x.payer_id = u.payer_id
        WHERE u.usable = 0 AND p.status <> 'archived' AND ${countableCo("u.payer_id")}
          AND greatest(s.at, x.at) IS NOT NULL
        ORDER BY date_trunc('milliseconds', greatest(s.at, x.at)) DESC, u.payer_id DESC`,
      )) as unknown as Array<{ payer_id: string; ran_out_ms: number | string }>;
      return rows.map((r) => ({ payer_id: r.payer_id, ran_out_ms: Number(r.ran_out_ms) }));
    }

    /** The whole list as the route serves it, walked page by page. */
    async function listServed(limit: number) {
      const out: Array<Awaited<ReturnType<typeof service.outOfCredits>>["rows"][number]> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 500; page += 1) {
        const res = await service.outOfCredits(
          ADMIN,
          AdminNumbersOutOfCreditsQuerySchema.parse({ limit: String(limit), cursor }),
          CTX,
        );
        out.push(...res.rows);
        if (res.next_cursor === null) return out;
        cursor = res.next_cursor;
      }
      throw new Error("the list never ended");
    }

    // -- fixtures ----------------------------------------------------------------------------

    beforeAll(async () => {
      assertLocalDatabase(DATABASE_URL);
      client = createDbClient(DATABASE_URL, { max: 4 });
      weekly = new NumbersWeeklyRepository(client.db, new AdminEventsRepository(client.db));
      snapshot = new NumbersSnapshotService(weekly, CONFIG);
      calls = new NumbersCallsRepository(client.db);
      const identity = {
        isPermitted: () => false,
        resolve: async () => null,
      } as unknown as AdminIdentityService;
      const events = new EventsService(new EventsRepository(client.db), {
        NODE_ENV: "test",
      } as never);
      service = new AdminNumbersCallsService(
        calls,
        new AdminEventsRepository(client.db),
        identity,
        events,
      );
      const { sql } = client;
      await sql`DELETE FROM numbers_weekly WHERE week_start IN (${W1}::date, ${W2}::date)`;

      for (const [i, p] of PAYERS.entries()) {
        await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status, is_test_account)
        VALUES (${p}::uuid, 'employer', ${`enc:rc-${TAG}-${i}`}, ${`hash:rc-${TAG}-${i}`},
                ${`enc:rc-org-${TAG}-${i}`}, ${p === CO_ARCHIVED ? "archived" : "active"},
                ${p === R_TEST || p === CO_TEST})`;
      }
      // A and B sit in Pune × CNC operator (their latest posting); C has none (unknown).
      for (const p of [R_A, R_B]) {
        await sql`
        INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                  status, city, role_kind, created_at, published_at)
        VALUES (${id()}::uuid, ${id()}::uuid, ${p}::uuid, 'Repeat Fixture', ${`Repeat ${TAG}`},
                '1', 'open', 'Pune', 'cnc_turner', '2026-06-01T00:00:00Z', NULL)`;
      }

      const order = async (payerId: string, status: string, when: Date) => sql`
      INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider,
                                  provider_order_id, status, created_at, updated_at)
      VALUES (${payerId}::uuid, 'pack_50', 2000, 10, 'razorpay', ${`order_rc_${TAG}_${id()}`},
              ${status}, ${when.toISOString()}::timestamptz, ${when.toISOString()}::timestamptz)`;
      await order(R_A, "paid", at("2026-06-08T05:00:00.000Z"));
      await order(R_A, "paid", plusDays("2026-06-08T05:00:00.000Z", 10));
      await order(R_B, "paid", at("2026-06-10T05:00:00.000Z"));
      await order(R_B, "paid", plusDays("2026-06-10T05:00:00.000Z", 45));
      await order(R_C, "paid", at("2026-06-14T18:29:59.999Z")); // W1's last instant
      await order(R_C, "paid", plusDays("2026-06-14T18:29:59.999Z", 91));
      await order(R_D, "paid", at("2026-06-09T05:00:00.000Z"));
      await order(R_D, "created", at("2026-06-10T05:00:00.000Z")); // never paid
      await order(R_D, "failed", at("2026-06-11T05:00:00.000Z"));
      // The mock purchase route writes ledger rows and NO order row: never a payment.
      await sql`
      INSERT INTO credit_ledger (payer_id, delta, reason, pack_code, price_inr, created_at)
      VALUES (${R_D}::uuid, 10, 'pack_purchase', 'pack_50', 2000, '2026-06-12T05:00:00Z')`;
      await order(R_E, "paid", at("2026-06-07T18:29:59.999Z")); // W1's eve (Sunday, India time)
      await order(R_E, "paid", at("2026-06-09T05:00:00.000Z"));
      await order(R_F, "paid", at("2026-06-11T05:00:00.000Z"));
      await order(R_F, "paid", at("2026-06-11T05:00:00.000Z")); // the same instant: 0 ms apart
      await order(R_TEST, "paid", at("2026-06-09T05:00:00.000Z"));
      await order(R_TEST, "paid", at("2026-06-10T05:00:00.000Z"));
      await order(R_SAMPLE, "paid", at("2026-06-09T05:00:00.000Z"));
      await order(R_SAMPLE, "paid", at("2026-06-10T05:00:00.000Z"));
      await order(R_G, "paid", at("2026-10-27T05:00:00.000Z")); // W2
      await order(R_G, "paid", at("2026-10-30T05:00:00.000Z"));

      // -- wallets, lots and spends of the call list -------------------------------------------
      const wallet = async (payerId: string, balance: number) => sql`
      INSERT INTO payer_credits (payer_id, balance) VALUES (${payerId}::uuid, ${balance})`;
      const lot = async (
        payerId: string,
        granted: number,
        remaining: number,
        expiresAt: string | null,
        expiredAt: string | null = null,
      ) => sql`
      INSERT INTO credit_lots (payer_id, source, credits_granted, credits_remaining, expires_at,
                               expired_at)
      VALUES (${payerId}::uuid, 'goodwill', ${granted}, ${remaining}, ${expiresAt}::timestamptz,
              ${expiredAt}::timestamptz)`;
      const spent = async (payerId: string, when: Date) => sql`
      INSERT INTO events (event_name, event_version, occurred_at, actor_type, actor_id,
                          subject_type, subject_id, correlation_id, payload)
      VALUES ('payer.credits_exhausted', 1, ${when.toISOString()}::timestamptz, 'payer',
              ${payerId}::uuid, 'payer', ${payerId}::uuid, ${CORR}::uuid,
              ${JSON.stringify({ payer_id: payerId, unlock_id: id(), free_tier_credits: 5 })}::jsonb)`;

      await wallet(CO_SPENT, 0);
      await lot(CO_SPENT, 10, 0, null);
      await spent(CO_SPENT, at("2026-11-10T10:00:00.000Z"));
      await order(CO_SPENT, "paid", at("2026-11-04T05:00:00.000Z"));
      await order(CO_SPENT, "created", at("2026-11-09T05:00:00.000Z")); // not a purchase
      await sql`INSERT INTO unlocks (payer_id, worker_id, status, granted_at)
              VALUES (${CO_SPENT}::uuid, NULL, 'granted', '2026-11-09T09:00:00Z')`;
      await sql`INSERT INTO unlocks (payer_id, worker_id, status, granted_at)
              VALUES (${CO_SPENT}::uuid, NULL, 'denied', NULL)`;

      await wallet(CO_EXPIRED, 3);
      await lot(CO_EXPIRED, 3, 3, "2026-11-12T00:00:00.000Z"); // past its date, not swept

      await wallet(CO_SWEPT, 0);
      await lot(CO_SWEPT, 5, 0, "2026-11-08T00:00:00.000Z", "2026-11-08T01:00:00.000Z");
      await spent(CO_SWEPT, at("2026-11-01T00:00:00.000Z"));

      await wallet(CO_PARTIAL, 2);
      await lot(CO_PARTIAL, 2, 2, "2099-01-01T00:00:00.000Z");
      await lot(CO_PARTIAL, 4, 0, "2026-11-05T00:00:00.000Z", "2026-11-05T01:00:00.000Z");

      await wallet(CO_TOPPED, 5);
      await lot(CO_TOPPED, 5, 5, null);
      await spent(CO_TOPPED, at("2026-11-03T00:00:00.000Z"));

      await wallet(CO_NEVER, 0);

      await wallet(CO_SPENT_EARLY, 0);
      await lot(CO_SPENT_EARLY, 5, 0, "2026-11-02T00:00:00.000Z"); // spent to zero before its date
      await spent(CO_SPENT_EARLY, at("2026-10-20T00:00:00.000Z"));

      for (const p of [CO_TEST, CO_ARCHIVED, CO_SAMPLE]) {
        await wallet(p, 0);
        await spent(p, at("2026-11-11T00:00:00.000Z"));
      }
      for (const p of [TIE_1, TIE_2]) {
        await wallet(p, 0);
        await spent(p, at("2026-11-06T06:00:00.000Z"));
      }
      await wallet(CO_NOW, 0);
      await wallet(CO_CASCADE, 0);
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const { sql } = client;
      await sql`DELETE FROM numbers_weekly WHERE week_start IN (${W1}::date, ${W2}::date)`;
      await sql`DELETE FROM credit_call_log WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM events WHERE correlation_id = ${CORR}::uuid`;
      await sql`DELETE FROM unlocks WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM credit_lots WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM payment_orders WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${PAYERS}::uuid[])`;
      await client.sql.end({ timeout: 5 });
    });

    // -- repeat buying -------------------------------------------------------------------------

    describe("repeat buying", () => {
      it("the sweep stores each window under the cohort week, equal to the hand-written rule", async () => {
        await snapshot.sweep(NOW, [W1, W2]);
        const hand30 = await repeatHand(W1_FROM, W1_TO, 30);
        // A, B, C, D and F at least (E first paid before W1; the test and sample companies out).
        expect(hand30.den).toBeGreaterThanOrEqual(5);
        for (const days of [30, 60, 90]) {
          const hand = await repeatHand(W1_FROM, W1_TO, days);
          expect(hand.num, `${days}d`).toBeGreaterThanOrEqual(days === 30 ? 2 : 3); // A, F (+B)
          expect(await stored(W1, `repeat_purchase_${days}d`), `${days}d`).toMatchObject({
            value: hundredths(hand.num, hand.den),
            numerator: hand.num,
            denominator: hand.den,
            suppressed: false,
          });
          const cell = await repeatHand(W1_FROM, W1_TO, days, true);
          expect(cell.den, `${days}d pune`).toBeGreaterThanOrEqual(2); // A and B
          expect(
            await stored(W1, `repeat_purchase_${days}d`, "pune", "cnc_operator"),
          ).toMatchObject({
            value: hundredths(cell.num, cell.den),
            numerator: cell.num,
            denominator: cell.den,
          });
        }
      });

      it("unpaid orders and the mock route's ledger rows never count; test and sample companies are out", async () => {
        const withAll = await repeatHand(W1_FROM, W1_TO, 30);
        const dRepeated = (
          await client.sql<Array<{ n: string }>>`
        SELECT count(*) AS n FROM payment_orders WHERE payer_id = ${R_D}::uuid AND status = 'paid'`
        )[0]!.n;
        expect(Number(dRepeated)).toBe(1);
        // The test company repeats: unmarking it would add one company and one repeat.
        await client.sql`UPDATE payers SET is_test_account = false WHERE id = ${R_TEST}::uuid`;
        const unmarked = await repeatHand(W1_FROM, W1_TO, 30);
        expect(unmarked).toEqual({ num: withAll.num + 1, den: withAll.den + 1 });
        await client.sql`UPDATE payers SET is_test_account = true WHERE id = ${R_TEST}::uuid`;
        expect(await stored(W1, "repeat_purchase_30d")).toMatchObject({
          numerator: withAll.num,
          denominator: withAll.den,
        });
      });

      it("an open window is PENDING: no share and no numerator, the cohort size kept", async () => {
        const hand = await repeatHand(W2_FROM, W2_TO, 30);
        expect(hand.den).toBeGreaterThanOrEqual(1); // G
        for (const days of [30, 60, 90]) {
          expect(await stored(W2, `repeat_purchase_${days}d`), `${days}d`).toMatchObject({
            value: null,
            numerator: null,
            denominator: hand.den,
            frozen: false,
          });
        }
      });

      it("the freeze is keyed on the longest window: W1's rows are all frozen, W2's cohort rows stay open", async () => {
        for (const metric of ["paying_companies", "repeat_purchase_30d", "repeat_purchase_90d"]) {
          expect((await stored(W1, metric))?.frozen, metric).toBe(true);
        }
        expect((await stored(W2, "paying_companies"))?.frozen).toBe(true);
        expect((await stored(W2, "repeat_purchase_90d"))?.frozen).toBe(false);
      });

      it("a FROZEN row never changes; an open cohort row does, on the next sweep", async () => {
        const w1Before = await stored(W1, "repeat_purchase_30d");
        const w2PayingBefore = await stored(W2, "paying_companies");
        const w2CohortBefore = await stored(W2, "repeat_purchase_30d");
        // D pays again inside W1's 30-day window (W1 is frozen), and a new company H first pays in
        // W2 (W2's week rows are frozen, its cohort rows open).
        await client.sql`
        INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider,
                                    provider_order_id, status, created_at, updated_at)
        VALUES (${R_D}::uuid, 'pack_50', 2000, 10, 'razorpay', ${`order_rc_${TAG}_late_d`}, 'paid',
                '2026-06-15T05:00:00Z', '2026-06-15T05:00:00Z')`;
        const R_H = id();
        PAYERS.push(R_H);
        await client.sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${R_H}::uuid, 'employer', ${`enc:rc-${TAG}-h`}, ${`hash:rc-${TAG}-h`},
                ${`enc:rc-org-${TAG}-h`}, 'active')`;
        await client.sql`
        INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider,
                                    provider_order_id, status, created_at, updated_at)
        VALUES (${R_H}::uuid, 'pack_50', 2000, 10, 'razorpay', ${`order_rc_${TAG}_h`}, 'paid',
                '2026-10-29T05:00:00Z', '2026-10-29T05:00:00Z')`;

        const later = new Date(NOW.getTime() + DAY);
        const out = await snapshot.sweep(later, [W1, W2]);
        expect(out).toEqual({ armed: true, computed: 1, frozen: 0, skipped: 1 });
        // W1 is skipped whole: its stored share is now stale against the source, and stays so.
        expect(await stored(W1, "repeat_purchase_30d")).toEqual(w1Before);
        expect((await repeatHand(W1_FROM, W1_TO, 30)).num).toBe((w1Before?.numerator ?? 0) + 1);
        // W2: the frozen week row did not move (H's payment is not in it), the cohort grew.
        expect(await stored(W2, "paying_companies")).toEqual(w2PayingBefore);
        const hand = await repeatHand(W2_FROM, W2_TO, 30);
        expect(hand.den).toBe((w2CohortBefore?.denominator ?? 0) + 1);
        expect(await stored(W2, "repeat_purchase_30d")).toMatchObject({
          value: null,
          numerator: null,
          denominator: hand.den,
          frozen: false,
        });
      });
    });

    // -- the call list -------------------------------------------------------------------------

    describe("the call list", () => {
      it("the usable-balance read agrees with the app's readSpendableCredits, wallet by wallet", async () => {
        const zero = new Set((await calls.zeroBalanceCompanies()).map((z) => z.payerId));
        const wallets = await client.sql<Array<{ payer_id: string; listable: boolean }>>`
        SELECT pc.payer_id::text AS payer_id,
               (p.status <> 'archived' AND NOT p.is_test_account
                AND pc.payer_id::text NOT LIKE 'face1000-0000-4000-8000-%') AS listable
          FROM payer_credits pc JOIN payers p ON p.id = pc.payer_id
         ORDER BY pc.payer_id LIMIT 5000`;
        expect(wallets.length).toBeGreaterThanOrEqual(C_PAYERS.length);
        for (const w of wallets) {
          const spendable = await readSpendableCredits(client.db, w.payer_id);
          expect(zero.has(w.payer_id), w.payer_id).toBe(w.listable && spendable === 0);
        }
        // The fixtures exercise both sides of it.
        expect(await readSpendableCredits(client.db, CO_EXPIRED)).toBe(0);
        expect(await readSpendableCredits(client.db, CO_PARTIAL)).toBe(2);
        expect(zero.has(CO_EXPIRED)).toBe(true);
        expect(zero.has(CO_PARTIAL)).toBe(false);
      });

      it("equals the hand-written SQL in the SAME ORDER, walked page by page", async () => {
        const hand = await listHand();
        for (const limit of [1, 3, 100]) {
          const served = await listServed(limit);
          expect(
            served.map((r) => [r.payer_id, Date.parse(r.ran_out_at)]),
            `limit ${limit}`,
          ).toEqual(hand.map((r) => [r.payer_id, r.ran_out_ms]));
        }
        const ids = hand.map((r) => r.payer_id);
        // Who is on it, who is not, and why.
        for (const p of [CO_SPENT, CO_EXPIRED, CO_SWEPT, CO_SPENT_EARLY, TIE_1, TIE_2]) {
          expect(ids, p).toContain(p);
        }
        for (const p of [CO_PARTIAL, CO_TOPPED, CO_NEVER, CO_TEST, CO_ARCHIVED, CO_SAMPLE]) {
          expect(ids, p).not.toContain(p);
        }
        const ranOut = new Map(hand.map((r) => [r.payer_id, r.ran_out_ms]));
        expect(ranOut.get(CO_EXPIRED)).toBe(Date.parse("2026-11-12T00:00:00.000Z"));
        expect(ranOut.get(CO_SWEPT)).toBe(Date.parse("2026-11-08T00:00:00.000Z"));
        expect(ranOut.get(CO_SPENT_EARLY)).toBe(Date.parse("2026-10-20T00:00:00.000Z"));
        // A tie is broken by the id, descending.
        const [hi, lo] = [TIE_1, TIE_2].sort().reverse();
        expect(ids.indexOf(hi!)).toBe(ids.indexOf(lo!) - 1);
      });

      it("each row carries the last real paid order, the last open and (none yet) no call", async () => {
        const row = (await listServed(100)).find((r) => r.payer_id === CO_SPENT)!;
        expect(row).toEqual({
          payer_id: CO_SPENT,
          ran_out_at: "2026-11-10T10:00:00.000Z",
          last_purchase: { at: "2026-11-04T05:00:00.000Z", pack_code: "pack_50" },
          last_open_at: "2026-11-09T09:00:00.000Z",
          last_call: null,
        });
        expect(JSON.stringify(row)).not.toMatch(/phone|org_name|email/);
      });

      it("a company that spends its last credit NOW is at the top", async () => {
        await client.sql`
        INSERT INTO events (event_name, event_version, occurred_at, actor_type, actor_id,
                            subject_type, subject_id, correlation_id, payload)
        VALUES ('payer.credits_exhausted', 1, now(), 'payer', ${CO_NOW}::uuid, 'payer',
                ${CO_NOW}::uuid, ${CORR}::uuid, '{}'::jsonb)`;
        const page = await service.outOfCredits(
          ADMIN,
          AdminNumbersOutOfCreditsQuerySchema.parse({ limit: "5" }),
          CTX,
        );
        expect(page.rows[0]?.payer_id).toBe(CO_NOW);
        expect(page.accounts_link_hint).toBe(true);
      });
    });

    // -- the call log --------------------------------------------------------------------------

    describe("the call log", () => {
      const KEY = `rc-call-${TAG}`;

      it("the POST writes ONE row and its two events; a retry writes nothing; the list shows it", async () => {
        const first = await service.logCreditCall(
          ADMIN,
          CO_SPENT,
          { result: "no_answer" },
          KEY,
          CTX,
        );
        expect(first).toMatchObject({
          created: true,
          call: { payer_id: CO_SPENT, result: "no_answer" },
        });
        const again = await service.logCreditCall(
          ADMIN,
          CO_SPENT,
          { result: "no_answer" },
          KEY,
          CTX,
        );
        expect(again).toEqual({ ...first, created: false });
        const rows = await client.sql<Array<{ n: string }>>`
        SELECT count(*) AS n FROM credit_call_log WHERE payer_id = ${CO_SPENT}::uuid`;
        expect(Number(rows[0]!.n)).toBe(1);
        const emitted = await client.sql<Array<{ event_name: string; payload: unknown }>>`
        SELECT event_name, payload FROM events
         WHERE correlation_id = ${CORR}::uuid
           AND event_name IN ('admin.credit_call_logged', 'admin.action_performed')
         ORDER BY event_name`;
        expect(emitted.map((e) => e.event_name)).toEqual([
          "admin.action_performed",
          "admin.credit_call_logged",
        ]);
        expect(emitted[1]!.payload).toEqual({
          payer_id: CO_SPENT,
          call_id: first.call.id,
          admin_id: ADMIN_ID,
          result: "no_answer",
        });
        const row = (await listServed(100)).find((r) => r.payer_id === CO_SPENT)!;
        expect(row.last_call).toEqual({
          called_at: first.call.called_at,
          result: "no_answer",
          admin_id: ADMIN_ID,
        });
      });

      it("an unknown, test or sample company is a 404, and nothing is written", async () => {
        for (const p of [id(), CO_TEST, CO_SAMPLE]) {
          await expect(
            service.logCreditCall(ADMIN, p, { result: "wrong_number" }, `rc-404-${TAG}-${p}`, CTX),
          ).rejects.toBeInstanceOf(NotFoundException);
        }
        const rows = await client.sql<Array<{ n: string }>>`
        SELECT count(*) AS n FROM credit_call_log WHERE payer_id = ANY(${[CO_TEST, CO_SAMPLE]}::uuid[])`;
        expect(Number(rows[0]!.n)).toBe(0);
      });

      it("the result CHECK refuses anything but the five closed codes", async () => {
        const err = await client.sql`
        INSERT INTO credit_call_log (payer_id, called_by_admin_id, result)
        VALUES (${CO_SPENT}::uuid, ${ADMIN_ID}::uuid, 'call back Monday')`.catch((e: unknown) => e);
        expect((err as { code?: string }).code).toBe("23514");
        expect(String((err as { constraint_name?: string }).constraint_name)).toBe(
          "credit_call_log_result_chk",
        );
      });

      it("the calls cascade with the company", async () => {
        await client.sql`
        INSERT INTO credit_call_log (payer_id, called_by_admin_id, result)
        VALUES (${CO_CASCADE}::uuid, ${ADMIN_ID}::uuid, 'reached_not_now')`;
        await client.sql`DELETE FROM payer_credits WHERE payer_id = ${CO_CASCADE}::uuid`;
        await client.sql`DELETE FROM payers WHERE id = ${CO_CASCADE}::uuid`;
        const rows = await client.sql<Array<{ n: string }>>`
        SELECT count(*) AS n FROM credit_call_log WHERE payer_id = ${CO_CASCADE}::uuid`;
        expect(Number(rows[0]!.n)).toBe(0);
      });

      it("RLS is enabled AND forced, and no client role holds a privilege", async () => {
        const [rls] = await client.sql<Array<{ on: boolean; forced: boolean }>>`
        SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class
         WHERE oid = 'public.credit_call_log'::regclass`;
        expect(rls).toEqual({ on: true, forced: true });
        const roles = await client.sql<Array<{ rolname: string }>>`
        SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`;
        for (const { rolname } of roles) {
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            const [row] = await client.sql<Array<{ has: boolean }>>`
            SELECT has_table_privilege(${rolname}, 'public.credit_call_log', ${privilege}) AS has`;
            expect(row?.has, `${rolname} ${privilege}`).toBe(false);
          }
        }
      });
    });
  },
);
