/**
 * #2565 B11 — payment-price backfill: stamp `price_inr` from the event spine.
 *
 * Fills the three `price_inr` columns migration 0155 added, plus the per-top-up
 * receipt rows it created — all from the events the purchases already emitted:
 *
 *   * `posting_plans.price_inr`      ← `job_posting.purchased` (by plan_id)
 *   * `posting_boosts.price_inr`     ← `job_posting.boosted` (by boost_id)
 *   * `payer_capacity.price_inr`     ← latest `capacity.purchased` (by payer_id)
 *   * `plan_quota_topups` rows       ← `posting_plan.quota_topped` events
 *
 * IDEMPOTENT: only NULL prices are written; top-up rows are inserted only when no
 * matching receipt exists (same plan + tier + quota_added within 5 minutes of the
 * event). Re-running reports the same counts with zero writes. DRY-RUN IS THE
 * DEFAULT; `--apply` writes.
 *
 * Rows that cannot be backfilled (no purchase event — e.g. a manually-granted
 * allowance, or a pre-event receipt) keep NULL, which the API renders as
 * "not recorded" — never a guess from the current catalog.
 *
 * PRIVACY: opaque ids + integer ₹ only. No PII is read or printed.
 *
 *   pnpm db:backfill:payment-prices            # dry run + counts
 *   pnpm db:backfill:payment-prices --apply    # write
 */
import { config } from "dotenv";
import { and, eq, isNull, sql as dsql } from "drizzle-orm";

import { createDbClient, type Database } from "./client";
import {
  events,
  payerCapacity,
  planQuotaTopups,
  postingBoosts,
  postingPlans,
} from "./schema";

config({ path: "../../.env" });

const NAME = "backfill:payment-prices";

interface Counts {
  plansUpdated: number;
  plansNotFound: number;
  boostsUpdated: number;
  boostsNotFound: number;
  capacitiesUpdated: number;
  capacitiesNotFound: number;
  topupsInserted: number;
  topupsSkipped: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asFiniteInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(`[${NAME}] DATABASE_URL must be set. Refusing to run against an unknown database.`);
    process.exit(1);
  }
  const { db, sql } = createDbClient(databaseUrl, { max: 1 });
  try {
    const counts: Counts = {
      plansUpdated: 0,
      plansNotFound: 0,
      boostsUpdated: 0,
      boostsNotFound: 0,
      capacitiesUpdated: 0,
      capacitiesNotFound: 0,
      topupsInserted: 0,
      topupsSkipped: 0,
    };
    await backfillPlans(db, apply, counts);
    await backfillBoosts(db, apply, counts);
    await backfillCapacities(db, apply, counts);
    await backfillTopups(db, apply, counts);

    console.log(`[${NAME}] ${apply ? "APPLIED" : "DRY RUN (no writes). Re-run with --apply to write."}`);
    console.log(`  plans: updated=${counts.plansUpdated} not_found=${counts.plansNotFound}`);
    console.log(`  boosts: updated=${counts.boostsUpdated} not_found=${counts.boostsNotFound}`);
    console.log(
      `  capacities: updated=${counts.capacitiesUpdated} not_found=${counts.capacitiesNotFound}`,
    );
    console.log(
      `  topups: inserted=${counts.topupsInserted} skipped=${counts.topupsSkipped}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** posting_plans.price_inr ← job_posting.purchased.payload.price_inr, matched by plan_id. */
async function backfillPlans(db: Database, apply: boolean, counts: Counts): Promise<void> {
  const rows = await db
    .select({ id: postingPlans.id })
    .from(postingPlans)
    .where(isNull(postingPlans.priceInr))
    .limit(5000);
  for (const row of rows) {
    const evts = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.eventName, "job_posting.purchased"))
      .limit(5000);
    // Filter in JS (payload is jsonb; the plan_id match is exact, volume is tiny).
    const match = evts
      .map((e) => asRecord(e.payload))
      .find((p) => p && asString(p["plan_id"]) === row.id);
    const price = match ? asFiniteInt(match["price_inr"]) : null;
    if (price === null) {
      counts.plansNotFound += 1;
      continue;
    }
    if (apply) {
      await db
        .update(postingPlans)
        .set({ priceInr: price, updatedAt: dsql`now()` })
        .where(and(eq(postingPlans.id, row.id), isNull(postingPlans.priceInr)));
    }
    counts.plansUpdated += 1;
  }
}

/** posting_boosts.price_inr ← job_posting.boosted.payload.price_inr, matched by boost_id. */
async function backfillBoosts(db: Database, apply: boolean, counts: Counts): Promise<void> {
  const rows = await db
    .select({ id: postingBoosts.id })
    .from(postingBoosts)
    .where(isNull(postingBoosts.priceInr))
    .limit(5000);
  if (rows.length === 0) return;
  const evts = await db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.eventName, "job_posting.boosted"))
    .limit(5000);
  const byBoost = new Map<string, number>();
  for (const e of evts) {
    const p = asRecord(e.payload);
    const bid = p ? asString(p["boost_id"]) : null;
    const price = p ? asFiniteInt(p["price_inr"]) : null;
    if (bid && price !== null && !byBoost.has(bid)) byBoost.set(bid, price);
  }
  for (const row of rows) {
    const price = byBoost.get(row.id);
    if (price === undefined) {
      counts.boostsNotFound += 1;
      continue;
    }
    if (apply) {
      await db
        .update(postingBoosts)
        .set({ priceInr: price, updatedAt: dsql`now()` })
        .where(and(eq(postingBoosts.id, row.id), isNull(postingBoosts.priceInr)));
    }
    counts.boostsUpdated += 1;
  }
}

/** payer_capacity.price_inr ← latest capacity.purchased.payload.price_inr for that payer. */
async function backfillCapacities(db: Database, apply: boolean, counts: Counts): Promise<void> {
  const rows = await db
    .select({ payerId: payerCapacity.payerId })
    .from(payerCapacity)
    .where(isNull(payerCapacity.priceInr))
    .limit(5000);
  if (rows.length === 0) return;
  const evts = await db
    .select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(eq(events.eventName, "capacity.purchased"))
    .limit(5000);
  // Latest event per payer wins (a later purchase's price is the current allowance's).
  const latest = new Map<string, { price: number; at: number }>();
  for (const e of evts) {
    const p = asRecord(e.payload);
    const pid = p ? asString(p["payer_id"]) : null;
    const price = p ? asFiniteInt(p["price_inr"]) : null;
    if (!pid || price === null) continue;
    const at = new Date(e.createdAt as unknown as string).getTime();
    const cur = latest.get(pid);
    if (!cur || at > cur.at) latest.set(pid, { price, at });
  }
  for (const row of rows) {
    const hit = latest.get(row.payerId);
    if (!hit) {
      counts.capacitiesNotFound += 1;
      continue;
    }
    if (apply) {
      await db
        .update(payerCapacity)
        .set({ priceInr: hit.price, updatedAt: dsql`now()` })
        .where(and(eq(payerCapacity.payerId, row.payerId), isNull(payerCapacity.priceInr)));
    }
    counts.capacitiesUpdated += 1;
  }
}

/**
 * plan_quota_topups rows ← posting_plan.quota_topped events. One row per event;
 * skipped when a matching receipt already exists (same plan + tier + quota_added
 * within 5 minutes of the event) so re-runs insert nothing.
 */
async function backfillTopups(db: Database, apply: boolean, counts: Counts): Promise<void> {
  const evts = await db
    .select({
      payload: events.payload,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.eventName, "posting_plan.quota_topped"))
    .limit(5000);
  for (const e of evts) {
    const p = asRecord(e.payload);
    const planId = p ? asString(p["plan_id"]) : null;
    const jobPostingId = p ? asString(p["job_posting_id"]) : null;
    const payerId = p ? asString(p["payer_id"]) : null;
    const tier = p ? asString(p["tier"]) : null;
    const quotaAdded = p ? asFiniteInt(p["quota_added"]) : null;
    const price = p ? asFiniteInt(p["price_inr"]) : null;
    if (!planId || !payerId || !tier || quotaAdded === null) {
      counts.topupsSkipped += 1;
      continue;
    }
    const eventAt = new Date(e.createdAt as unknown as string);
    const existing = await db
      .select({ id: planQuotaTopups.id })
      .from(planQuotaTopups)
      .where(eq(planQuotaTopups.planId, planId))
      .limit(50);
    // JS-side match (tier + quota + time window) — volume is tiny.
    const full = existing.length
      ? await db
          .select({
            tier: planQuotaTopups.tier,
            quotaAdded: planQuotaTopups.quotaAdded,
            createdAt: planQuotaTopups.createdAt,
          })
          .from(planQuotaTopups)
          .where(eq(planQuotaTopups.planId, planId))
          .limit(50)
      : [];
    const dup = full.some(
      (r) =>
        r.tier === tier &&
        r.quotaAdded === quotaAdded &&
        Math.abs(new Date(r.createdAt as unknown as string).getTime() - eventAt.getTime()) <
          5 * 60 * 1000,
    );
    if (dup) {
      counts.topupsSkipped += 1;
      continue;
    }
    if (apply) {
      await db.insert(planQuotaTopups).values({
        planId,
        jobPostingId,
        payerId,
        tier,
        quotaAdded,
        priceInr: price,
        createdAt: eventAt,
      });
    }
    counts.topupsInserted += 1;
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
