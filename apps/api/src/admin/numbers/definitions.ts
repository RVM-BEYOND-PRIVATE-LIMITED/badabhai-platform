import { NUMBERS_DEFINITION_VERSION } from "./groups";

/**
 * #2755 item 1 — THE CATALOGUE of the numbers screen: the ten metric groups of brief section 8,
 * each figure with its unit, its source and its rule, written ONCE. Part B's snapshot, the read
 * routes and the parity tests read their rule from here; `GET /admin/numbers/definitions` serves it.
 *
 * ── A METRIC WITH NO LIVE SOURCE IS `not_available`, NEVER ZERO ────────────────────────────
 * Five groups wait on work that has not shipped (#2749 part 3, #2750, #2751). Their figures are
 * listed with the reason and the issue they wait on, so the screen can say "not yet measured"
 * instead of drawing a zero that reads as "nobody did this". A zero is a measurement.
 *
 * ── A LIST IS NOT A WEEKLY FIGURE ────────────────────────────────────────────────────────────
 * Group 10 (the telecaller list) is live as a LIST, not a number per week: its one entry names the
 * route that serves it (`list_route`), and the weekly snapshot never stores it.
 *
 * ── COMMON RULES (every figure) ─────────────────────────────────────────────────────────────
 *   - Weeks are `week.ts`'s: Monday to Sunday, India time. A "week" figure counts what happened
 *     inside the week; an "as of the week's end" figure is a state on its last day.
 *   - Company figures leave out test companies (`payers.is_test_account`, `exclusions.ts`).
 *   - Worker figures leave out test accounts, sample workers and linked RVM identities that never
 *     signed in (`exclusions.ts`), and worker cells under the small-cell floor are suppressed.
 *   - Money is real money only, in integer paise, and the payments mode travels with it.
 *
 * The version of every rule here is {@link NUMBERS_DEFINITION_VERSION} (`groups.ts`).
 */

/** How a figure is counted. */
export const NUMBERS_METRIC_UNITS = ["count", "paise", "share", "ratio"] as const;
export type NumbersMetricUnit = (typeof NUMBERS_METRIC_UNITS)[number];

/**
 * A HEADLINE figure is one of the brief's numbers; a DIAGNOSTIC one is not a headline: it measures
 * a known gap in a headline's rule so the owner can see its size (today: trade-form workers who
 * finished the form but whose profile was never confirmed, the gap in "completed profiles").
 */
export const NUMBERS_METRIC_KINDS = ["headline", "diagnostic"] as const;
export type NumbersMetricKind = (typeof NUMBERS_METRIC_KINDS)[number];

/** The issues a not-yet-measured figure waits on. */
export const NUMBERS_WAITS_ON = ["#2749", "#2750", "#2751"] as const;
export type NumbersWaitsOn = (typeof NUMBERS_WAITS_ON)[number];

export type NumbersAvailability =
  | { readonly status: "live" }
  | {
      readonly status: "not_available";
      /** Plain words: what is missing. */
      readonly reason: string;
      /** The issue whose shipped work makes it measurable. */
      readonly waits_on: NumbersWaitsOn;
    };

export interface NumbersMetricDefinition {
  /** Stable id: part B's `numbers_weekly.metric`. Never renamed; a new rule is a new version. */
  readonly id: string;
  readonly title: string;
  /**
   * `count` integers; `paise` integer money; `share` a fraction 0..1 of a stated base; `ratio` a
   * non-negative quotient of two counts (contacts per hire), not bounded by 1.
   */
  readonly unit: NumbersMetricUnit;
  /** A headline figure, or a diagnostic of a headline's known gap. */
  readonly kind: NumbersMetricKind;
  /** Where the figure is read from. */
  readonly source: string;
  /** How it is counted, in words a reviewer can check against a hand-written query. */
  readonly rule: string;
  readonly availability: NumbersAvailability;
  /**
   * A live figure served as a LIST by its own route rather than as a weekly number (group 10, the
   * call list): the route, e.g. `GET /admin/numbers/out-of-credits`. Absent on every weekly figure.
   */
  readonly list_route?: string;
}

export interface NumbersMetricGroupDefinition {
  /** 1..10, brief section 8's order. */
  readonly number: number;
  readonly id: string;
  readonly title: string;
  readonly metrics: readonly NumbersMetricDefinition[];
}

const LIVE: NumbersAvailability = { status: "live" };

/** #2755 item 7 — the repeat-buying windows, in days after a company's first payment. */
export const NUMBERS_REPEAT_WINDOWS_DAYS = [30, 60, 90] as const;
export type NumbersRepeatWindowDays = (typeof NUMBERS_REPEAT_WINDOWS_DAYS)[number];

/** The longest window: a cohort week's repeat rows stay open until it has elapsed. */
export const NUMBERS_REPEAT_LONGEST_WINDOW_DAYS = 90;

/** The metric id of one repeat-buying window: `repeat_purchase_30d`. Never renamed. */
export function repeatPurchaseMetricId(days: NumbersRepeatWindowDays): string {
  return `repeat_purchase_${days}d`;
}

function waitsOn(waits_on: NumbersWaitsOn, reason: string): NumbersAvailability {
  return { status: "not_available", reason, waits_on };
}

/** The ten metric groups, in the brief's order. */
export const NUMBERS_METRIC_GROUPS: readonly NumbersMetricGroupDefinition[] = [
  {
    number: 1,
    id: "paying_companies",
    title: "Companies that paid, and how many paid again",
    metrics: [
      {
        id: "paying_companies",
        title: "Companies that paid",
        unit: "count",
        kind: "headline",
        source:
          "payment_orders with status paid. The mock purchase route writes no order row, so no " +
          "mock purchase can count. Never credit_ledger.price_inr or payment.captured events: the " +
          "mock route writes both with no money taken.",
        rule:
          "Distinct companies (test and sample companies left out) with at least one paid order " +
          "settled in the week, counted once each however many orders they paid. The settle time " +
          "is the order's updated_at at its move to paid. Split by the company's city and trade " +
          "(the city and role_kind of its latest posting).",
        availability: LIVE,
      },
      {
        id: "paying_companies_cumulative",
        title: "Companies that have ever paid",
        unit: "count",
        kind: "headline",
        source: "payment_orders with status paid, as above.",
        rule:
          "Distinct companies (test and sample companies left out) with at least one paid order " +
          "settled before the week's end, as of that end. Its all-cities, all-trades value is " +
          "also what marks a week as before real payments: zero means no real payment yet.",
        availability: LIVE,
      },
      ...NUMBERS_REPEAT_WINDOWS_DAYS.map(
        (days): NumbersMetricDefinition => ({
          id: repeatPurchaseMetricId(days),
          title: `Paid again within ${days} days`,
          unit: "share",
          kind: "headline",
          source:
            "payment_orders with status paid, as above (the same paid, real-money rule: the mock " +
            "route writes no order row).",
          rule:
            "A COHORT per week: the companies (test and sample companies left out) whose FIRST " +
            "paid order ever settled in the week. The denominator is the cohort's size; the " +
            "numerator is how many of them have a second paid order settled within " +
            `${days} days of their first (second settle time minus first settle time, ${days} × 24 ` +
            "hours at most). The value is the share in hundredths, rounded half up. PENDING " +
            `until the window has fully elapsed for every company in the cohort, i.e. until ${days} ` +
            "days after the week ends: a pending cell holds the cohort size only (value and " +
            "numerator null), never a partial share. Stored under the COHORT week, split by the " +
            "company's city and trade (the city and role_kind of its latest posting). THE FREEZE " +
            `IS KEYED ON THE LONGEST WINDOW: a cohort week's three rows stay open until ` +
            `${NUMBERS_REPEAT_LONGEST_WINDOW_DAYS} days after the week ends, then freeze ` +
            "NUMBERS_FREEZE_AFTER_DAYS later like any week, and a frozen row never changes.",
          availability: LIVE,
        }),
      ),
    ],
  },
  {
    number: 2,
    id: "companies_posted",
    title: "Companies that posted a job",
    metrics: [
      {
        id: "companies_posted",
        title: "Companies that posted their first job",
        unit: "count",
        kind: "headline",
        source: "job_postings.published_at, the first publish per company.",
        rule:
          "Companies (test and sample companies left out) whose first published posting was " +
          "published in the week. Owner question 3 default: a company has posted when its job is " +
          "first published; a test company's postings and the seed's sample postings never count.",
        availability: LIVE,
      },
      {
        id: "companies_posted_cumulative",
        title: "Companies that have ever posted a job",
        unit: "count",
        kind: "headline",
        source: "job_postings.published_at, the first publish per company.",
        rule:
          "Companies (exclusions as above) whose first published posting was published before " +
          "the week's end, as of that end.",
        availability: LIVE,
      },
    ],
  },
  {
    number: 3,
    id: "worker_profiles",
    title: "Completed worker profiles, and workers active in the last 30 days",
    metrics: [
      {
        id: "completed_profiles",
        title: "Completed worker profiles",
        unit: "count",
        kind: "headline",
        source:
          "worker_profiles: the current row per worker (CURRENT_PROFILE_ORDER), the onboarding " +
          "funnel's profile_confirmed step.",
        rule:
          "Workers whose current profile is confirmed, counted in the week of its confirmed_at. " +
          "The same rule as the onboarding funnel's profile_confirmed step (owner question 2 " +
          "default), so the two admin screens cannot disagree. Test accounts, sample workers and " +
          "linked RVM identities that never signed in are left out. A trade-form worker counts " +
          "only once the app's résumé step has confirmed his profile (see 'Completed profile' " +
          "in docs/api/admin-numbers-api-reference.md). Split by the worker's current_city and " +
          "primary trade (the onboarding funnel's lowest-sort_order occupation). A worker cell " +
          "under the small-cell floor is suppressed, except the all-cities, all-trades total.",
        availability: LIVE,
      },
      {
        id: "completed_profiles_cumulative",
        title: "Completed worker profiles, in total",
        unit: "count",
        kind: "headline",
        source: "worker_profiles, as above.",
        rule:
          "Workers (exclusions as above) whose current profile is confirmed with a confirmed_at " +
          "before the week's end, as of that end. Small cells suppressed as above.",
        availability: LIVE,
      },
      {
        id: "active_workers_30d",
        title: "Workers active in the last 30 days",
        unit: "count",
        kind: "headline",
        source:
          "worker_activity (#2753, one row per worker per India day) and the device sighting " +
          "lastActiveDayOf merges with it.",
        rule:
          "Workers (exclusions as above) whose last active day, as of the week's Sunday, falls in " +
          "the 30 days ending on that Sunday. The last active day is #2753's one definition " +
          "(lastActiveDayOf: the later of his newest worker_activity day and the India day of his " +
          "newest device sighting), read as of the Sunday: only worker_activity days up to it, " +
          "and only device sightings before the week's end. A device keeps only its newest " +
          "sighting, so a past week rests on worker_activity and on the devices not seen since. " +
          "Small cells suppressed as above.",
        availability: LIVE,
      },
      {
        id: "form_completed_unconfirmed",
        title: "Finished the trade form, profile not confirmed (diagnostic)",
        unit: "count",
        kind: "diagnostic",
        source:
          "the profile.form_completed events (the trade form's completion, once per worker and " +
          "pack) and worker_profiles, as above.",
        rule:
          "NOT A HEADLINE: the size of the gap in 'completed profiles'. Workers (exclusions as " +
          "above) whose FIRST profile.form_completed is in the week and whose current profile is " +
          "not confirmed when the week is computed (the last computation is at its freeze). The " +
          "numerator is that count; the denominator is every such worker who finished the form " +
          "in the week, so the share left uncounted is numerator / denominator. Small cells " +
          "suppressed as above.",
        availability: LIVE,
      },
    ],
  },
  {
    number: 4,
    id: "hires",
    title: "Confirmed hires, and contacts opened per hire",
    metrics: [
      {
        id: "confirmed_hires",
        title: "Confirmed hires",
        unit: "count",
        kind: "headline",
        source: "hires (#2753), status confirmed only.",
        rule:
          "Hire records with status confirmed whose hired_on (the India day of the first " +
          "confirming source) falls in the week. A reported or rejected record never counts; the " +
          "records of test and sample companies, and of test-account and sample workers, are " +
          "left out. Split by the company's city and trade, as for paying companies.",
        availability: LIVE,
      },
      {
        id: "confirmed_hires_cumulative",
        title: "Confirmed hires, in total",
        unit: "count",
        kind: "headline",
        source: "hires (#2753), status confirmed only.",
        rule:
          "Confirmed hire records (exclusions as above) whose hired_on is on or before the week's " +
          "Sunday, as of that Sunday.",
        availability: LIVE,
      },
      {
        id: "contacts_per_hire",
        title: "Contacts opened per hire",
        unit: "ratio",
        kind: "headline",
        source:
          "granted unlocks, leaving out the opens carried over by the company-move import of " +
          "#2754, over the confirmed hires above.",
        rule:
          "Contacts opened in the week (unlocks granted in it: status granted, revealed or " +
          "expired) divided by confirmed hires in the week, both for the same companies (test and " +
          "sample companies, and test-account and sample workers, left out). The numerator and " +
          "denominator are kept; the value is the quotient in hundredths, rounded half up. Not " +
          "computable (null) when the week has no confirmed hire, never zero.",
        availability: LIVE,
      },
    ],
  },
  {
    number: 5,
    id: "posting_choice",
    title: "Posting screen: the share tapping each button",
    metrics: [
      {
        id: "posting_choice_free_share",
        title: "Tapped 'Post free (5 contacts)'",
        unit: "share",
        kind: "headline",
        source: "the posting-button tap record of #2751.",
        rule: "Taps on the free button over all taps on the two buttons in the week.",
        availability: waitsOn("#2751", "the posting-button tap record does not exist yet"),
      },
      {
        id: "posting_choice_starter_share",
        title: "Tapped 'Post free + Starter ₹999 (20 contacts)'",
        unit: "share",
        kind: "headline",
        source: "the posting-button tap record of #2751.",
        rule: "Taps on the Starter button over all taps on the two buttons in the week.",
        availability: waitsOn("#2751", "the posting-button tap record does not exist yet"),
      },
    ],
  },
  {
    number: 6,
    id: "welcome_credits",
    title: "Companies that used up their welcome credits, and how many then bought",
    metrics: [
      {
        id: "welcome_credits_used_up",
        title: "Used up the 5 welcome credits",
        unit: "count",
        kind: "headline",
        source: "the welcome credit lot of #2750.",
        rule: "Companies whose welcome lot reached zero in the week.",
        availability: waitsOn("#2750", "the welcome credit lot does not exist yet"),
      },
      {
        id: "welcome_then_bought",
        title: "Then bought a pack",
        unit: "count",
        kind: "headline",
        source: "the welcome lot of #2750 and the pack lots of #2749.",
        rule: "Of those companies, the ones with a paid pack after the welcome lot ran out.",
        availability: waitsOn("#2750", "the welcome credit lot does not exist yet"),
      },
    ],
  },
  {
    number: 7,
    id: "couldnt_reach",
    title: "'Couldn't reach' claims, and credits returned",
    metrics: [
      {
        id: "couldnt_reach_claims",
        title: "'Couldn't reach' claims",
        unit: "count",
        kind: "headline",
        source: "the couldn't-reach claim record of #2750.",
        rule: "Claims made in the week.",
        availability: waitsOn("#2750", "the couldn't-reach claim does not exist yet"),
      },
      {
        id: "couldnt_reach_credits_returned",
        title: "Credits returned",
        unit: "count",
        kind: "headline",
        source: "the credit returns of #2750.",
        rule: "Credits returned on accepted claims in the week.",
        availability: waitsOn("#2750", "the couldn't-reach claim does not exist yet"),
      },
    ],
  },
  {
    number: 8,
    id: "waivers",
    title: "Credits waived by the placement team",
    metrics: [
      {
        id: "credits_waived",
        title: "Credits waived",
        unit: "count",
        kind: "headline",
        source: "the waiver ledger rows of #2750.",
        rule: "Credits waived in the week.",
        availability: waitsOn("#2750", "the waiver ledger rows do not exist yet"),
      },
    ],
  },
  {
    number: 9,
    id: "revenue",
    title: "Revenue by pack and by Managed Hiring",
    metrics: [
      {
        id: "revenue_by_pack",
        title: "Revenue by pack, as charged",
        unit: "paise",
        kind: "headline",
        source: "payment_orders with status paid: amount_inr (whole rupees today) and pack_code.",
        rule:
          "The sum of amount_inr × 100 over paid orders settled in the week (test and sample " +
          "companies left out): the total, and one figure per pack_code (revenue_by_pack:<code>, " +
          "every pack paid for up to the week's end). Real money only: the mock purchase route " +
          "writes no order row, the payments mode travels with the figure, and a week before " +
          "real payments is marked, never shown as revenue. Split by the company's city and " +
          "trade, as for paying companies.",
        availability: LIVE,
      },
      {
        id: "revenue_gst_split",
        title: "Revenue before GST, and the GST",
        unit: "paise",
        kind: "headline",
        source: "the GST split of #2749 (part 3).",
        rule: "The same orders, split into the price before GST and the GST, in paise.",
        availability: waitsOn("#2749", "orders carry no GST split until #2749 part 3 lands"),
      },
      {
        id: "revenue_managed_hiring",
        title: "Managed Hiring revenue",
        unit: "paise",
        kind: "headline",
        source: "the Managed Hiring orders of #2751 (₹4,000 and ₹8,000).",
        rule: "Paid Managed Hiring orders settled in the week, by price, in paise.",
        availability: waitsOn("#2751", "Managed Hiring has no order record yet"),
      },
    ],
  },
  {
    number: 10,
    id: "telecaller",
    title: "Telecaller list: companies whose credits ran out",
    metrics: [
      {
        id: "out_of_credits_companies",
        title: "Companies whose credits ran out (the call list)",
        unit: "count",
        kind: "headline",
        source:
          "the company's USABLE balance: payer_credits.balance minus what its credit_lots past " +
          "expires_at still hold, never below zero (the unlock path's readSpendableCredits " +
          "rule); payer.credits_exhausted gives the moment of the last spend, and credit_lots " +
          "the moment a lot expired.",
        rule:
          "A LIST, served live by GET /admin/numbers/out-of-credits, not a weekly figure. The " +
          "companies (test, sample and archived companies left out) whose usable balance is zero " +
          "now and that ran out: the moment they ran out is the later of their last " +
          "payer.credits_exhausted and the expires_at of the last lot that expired holding " +
          "credits; a company that never held a credit is not on it. Newest first by that " +
          "moment, keyset paged. Each row: the last real paid order (time and pack), the last " +
          "contact opened (an unlock granted) and the latest call logged (time, result, admin). " +
          "The name only through AdminIdentityService (read_identity); never the phone.",
        availability: LIVE,
        list_route: "GET /admin/numbers/out-of-credits",
      },
    ],
  },
];

/** Every metric, flattened, in catalogue order. */
export function allNumbersMetrics(): readonly NumbersMetricDefinition[] {
  return NUMBERS_METRIC_GROUPS.flatMap((g) => g.metrics);
}

/** One metric by id, or `undefined`. */
export function numbersMetric(id: string): NumbersMetricDefinition | undefined {
  return allNumbersMetrics().find((m) => m.id === id);
}

/** The version every rule above is written under (re-exported for one import). */
export { NUMBERS_DEFINITION_VERSION };

// ---------------------------------------------------------------------------------------------
// The weekly snapshot (part B)
// ---------------------------------------------------------------------------------------------

/**
 * #2755 item 11 — THE BASELINE: the first week the sweep ever computes. Its first run computes
 * every week from here (or from the week of the earliest source row, whichever is LATER: a week
 * with no source row anywhere before it is not a measurement of anything) to the current week,
 * from history, so the first screen already shows a change. 2026-06-01 is a Monday, before the
 * platform's first company or worker. Under {@link NUMBERS_DEFINITION_VERSION}: moving it is a
 * version bump and a recompute of the weeks it adds.
 */
export const NUMBERS_BASELINE_FROM = "2026-06-01";

/** Whose figure a snapshot metric is: a worker figure's small cells are suppressed. */
export type NumbersSnapshotSubject = "worker" | "company";

/**
 * Every metric the nightly sweep writes to `numbers_weekly`, with whose figure it is. The live
 * WEEKLY catalogue entries above, exactly (a test pins the two lists together: every live entry
 * but the one served as a list, `list_route`); a `not_available` metric is never stored, so the
 * screen can never draw it as a zero. `revenue_by_pack` is stored as the all-packs total under its
 * own id AND once per pack under `revenue_by_pack:<pack_code>`. The three repeat-buying windows
 * are stored under their COHORT week (the week of the first payment).
 */
export const NUMBERS_SNAPSHOT_METRICS: Readonly<Record<string, NumbersSnapshotSubject>> = {
  paying_companies: "company",
  paying_companies_cumulative: "company",
  companies_posted: "company",
  companies_posted_cumulative: "company",
  completed_profiles: "worker",
  completed_profiles_cumulative: "worker",
  active_workers_30d: "worker",
  form_completed_unconfirmed: "worker",
  confirmed_hires: "company",
  confirmed_hires_cumulative: "company",
  contacts_per_hire: "company",
  revenue_by_pack: "company",
  repeat_purchase_30d: "company",
  repeat_purchase_60d: "company",
  repeat_purchase_90d: "company",
};

// ---------------------------------------------------------------------------------------------
// The freeze of a cohort metric (part C)
// ---------------------------------------------------------------------------------------------

/**
 * The COHORT metrics: stored under the week a cohort was formed in (the week of its first
 * payment), and complete only once their window has elapsed. Today: the three repeat-buying
 * windows.
 */
export const NUMBERS_COHORT_METRICS: readonly string[] =
  NUMBERS_REPEAT_WINDOWS_DAYS.map(repeatPurchaseMetricId);

/**
 * When a stored row freezes. A `week` row (every metric but the cohort ones) freezes
 * NUMBERS_FREEZE_AFTER_DAYS after its week ends. A `cohort` row freezes that many days after its
 * LONGEST window has elapsed for every company of the cohort
 * ({@link NUMBERS_REPEAT_LONGEST_WINDOW_DAYS} days after the week ends): until then the sweep keeps
 * recomputing it, so a window that has not closed is never frozen as pending. Either way a FROZEN
 * ROW NEVER CHANGES: the sweep skips it, and only the logged recompute rewrites it.
 */
export type NumbersFreezeClass = "week" | "cohort";
export const NUMBERS_FREEZE_CLASSES: readonly NumbersFreezeClass[] = ["week", "cohort"];

/** The freeze class of a stored metric id (a per-pack revenue id is a `week` row). */
export function numbersFreezeClassOf(metric: string): NumbersFreezeClass {
  return NUMBERS_COHORT_METRICS.includes(metric) ? "cohort" : "week";
}

/** How many days after its week ends a row of `cls` stops changing (before the freeze delay). */
export function numbersFreezeWindowDays(cls: NumbersFreezeClass): number {
  return cls === "cohort" ? NUMBERS_REPEAT_LONGEST_WINDOW_DAYS : 0;
}

/** The id prefix of one pack's revenue: `revenue_by_pack:pack_50`. */
export const NUMBERS_REVENUE_PACK_PREFIX = "revenue_by_pack:";

/** A pack code as stored ids carry it; anything else is folded into `revenue_by_pack:other`. */
const PACK_CODE = /^[a-z0-9_]{1,64}$/;

/** The snapshot metric id of one pack's revenue (a malformed code folds into `other`). */
export function revenuePackMetricId(packCode: string): string {
  return `${NUMBERS_REVENUE_PACK_PREFIX}${PACK_CODE.test(packCode) ? packCode : "other"}`;
}

/** Is `id` a stored per-pack revenue id? */
export function isRevenuePackMetricId(id: string): boolean {
  return (
    id.startsWith(NUMBERS_REVENUE_PACK_PREFIX) &&
    PACK_CODE.test(id.slice(NUMBERS_REVENUE_PACK_PREFIX.length))
  );
}
