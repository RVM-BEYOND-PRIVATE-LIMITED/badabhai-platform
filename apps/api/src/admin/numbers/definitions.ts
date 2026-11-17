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
  /** Where the figure is read from. */
  readonly source: string;
  /** How it is counted, in words a reviewer can check against a hand-written query. */
  readonly rule: string;
  readonly availability: NumbersAvailability;
}

export interface NumbersMetricGroupDefinition {
  /** 1..10, brief section 8's order. */
  readonly number: number;
  readonly id: string;
  readonly title: string;
  readonly metrics: readonly NumbersMetricDefinition[];
}

const LIVE: NumbersAvailability = { status: "live" };

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
        source:
          "payment_orders with status paid. The mock purchase route writes no order row, so no " +
          "mock purchase can count. Never credit_ledger.price_inr or payment.captured events: the " +
          "mock route writes both with no money taken.",
        rule:
          "Distinct companies (test companies left out) with at least one paid order settled in " +
          "the week, counted once each however many orders they paid. The settle time is the " +
          "order's updated_at at its move to paid.",
        availability: LIVE,
      },
      ...([30, 60, 90] as const).map(
        (days): NumbersMetricDefinition => ({
          id: `repeat_purchase_${days}d`,
          title: `Paid again within ${days} days`,
          unit: "share",
          source: "payment_orders with status paid, as above.",
          rule:
            "Cohort: the companies whose FIRST paid order settled in the week. The share of that " +
            `cohort with another paid order settled within ${days} days after the first. A cohort ` +
            `younger than ${days} days is reported as still open, not as a share.`,
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
        source: "job_postings.published_at, the first publish per company.",
        rule:
          "Companies (test companies left out) whose first published posting was published in " +
          "the week. Owner question 3 default: a company has posted when its job is first " +
          "published; a test company's postings never count.",
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
        source:
          "worker_profiles: the current row per worker (CURRENT_PROFILE_ORDER), the onboarding " +
          "funnel's profile_confirmed step.",
        rule:
          "Workers whose current profile is confirmed, counted in the week of its confirmed_at. " +
          "The same rule as the onboarding funnel's profile_confirmed step (owner question 2 " +
          "default), so the two admin screens cannot disagree. Test accounts, sample workers and " +
          "linked RVM identities that never signed in are left out. A trade-form worker counts " +
          "only once the app's résumé step has confirmed his profile (see 'Completed profile' " +
          "in docs/api/admin-numbers-api-reference.md).",
        availability: LIVE,
      },
      {
        id: "active_workers_30d",
        title: "Workers active in the last 30 days",
        unit: "count",
        source:
          "worker_activity (#2753, one row per worker per India day) and the device sighting " +
          "lastActiveDayOf merges with it.",
        rule:
          "Workers (exclusions as above) with an active day in the 30 days ending on the week's " +
          "Sunday, as of that Sunday. Past weeks can be rebuilt only from worker_activity rows: " +
          "a device sighting keeps only its newest time.",
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
        source: "hires (#2753), status confirmed only.",
        rule:
          "Hire records with status confirmed whose hired_on falls in the week. A reported or " +
          "rejected record never counts; test companies' records are left out.",
        availability: LIVE,
      },
      {
        id: "contacts_per_hire",
        title: "Contacts opened per hire",
        unit: "ratio",
        source:
          "granted unlocks, leaving out the opens carried over by the company-move import of " +
          "#2754, over the confirmed hires above.",
        rule:
          "Granted unlocks in the week divided by confirmed hires in the week, both for the same " +
          "companies (test companies left out). Reported as not computable when the week has no " +
          "confirmed hire, never as zero.",
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
        source: "the posting-button tap record of #2751.",
        rule: "Taps on the free button over all taps on the two buttons in the week.",
        availability: waitsOn("#2751", "the posting-button tap record does not exist yet"),
      },
      {
        id: "posting_choice_starter_share",
        title: "Tapped 'Post free + Starter ₹999 (20 contacts)'",
        unit: "share",
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
        source: "the welcome credit lot of #2750.",
        rule: "Companies whose welcome lot reached zero in the week.",
        availability: waitsOn("#2750", "the welcome credit lot does not exist yet"),
      },
      {
        id: "welcome_then_bought",
        title: "Then bought a pack",
        unit: "count",
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
        source: "the couldn't-reach claim record of #2750.",
        rule: "Claims made in the week.",
        availability: waitsOn("#2750", "the couldn't-reach claim does not exist yet"),
      },
      {
        id: "couldnt_reach_credits_returned",
        title: "Credits returned",
        unit: "count",
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
        source: "payment_orders with status paid: amount_inr (whole rupees today) and pack_code.",
        rule:
          "The sum of amount_inr × 100 over paid orders settled in the week, by pack_code (test " +
          "companies left out). Real money only: the payments mode travels with the figure, and " +
          "a week before real payments is marked, never shown as revenue.",
        availability: LIVE,
      },
      {
        id: "revenue_gst_split",
        title: "Revenue before GST, and the GST",
        unit: "paise",
        source: "the GST split of #2749 (part 3).",
        rule: "The same orders, split into the price before GST and the GST, in paise.",
        availability: waitsOn("#2749", "orders carry no GST split until #2749 part 3 lands"),
      },
      {
        id: "revenue_managed_hiring",
        title: "Managed Hiring revenue",
        unit: "paise",
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
        title: "Companies whose credits ran out",
        unit: "count",
        source:
          "the company's usable balance (zero after a spend or an expiry); payer.credits_exhausted " +
          "gives the moment of the last spend.",
        rule:
          "Companies (test companies left out) whose usable balance reached zero in the week and " +
          "is still zero at its end. The call list itself is GET /admin/numbers/out-of-credits " +
          "(part C), newest first.",
        availability: LIVE,
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
