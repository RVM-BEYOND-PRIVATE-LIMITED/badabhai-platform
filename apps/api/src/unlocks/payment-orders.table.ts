import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * `payment_orders` — the REAL-money order ledger for Razorpay credit-pack purchases.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * ⚠️ TEMPORARY LOCATION. This table belongs in `packages/db/src/schema.ts` and is owned by
 * the database architect; the migration is authored there, NOT here. It is mirrored in
 * apps/api ONLY because the schema landed in a parallel workstream. When
 * `@badabhai/db` exports `paymentOrders`, DELETE this file and switch the two importers
 * (`unlocks.repository.ts`, `payment-gateway.ts`) to the package export — the column set
 * below is byte-for-byte the agreed shape, so that swap is mechanical.
 * ────────────────────────────────────────────────────────────────────────────────────
 *
 * PII-FREE BY CONSTRUCTION (CLAUDE.md §2 #2). Every column is an opaque id, a catalog
 * CODE, an integer ₹ amount, or an enum. There is deliberately NO card number, NO UPI
 * handle, NO email/phone, NO cardholder name, NO provider "contact" blob — Razorpay
 * collects those and they must never cross into our database. `provider_payment_ref`
 * is the opaque `pay_*` id only.
 *
 * THE IDEMPOTENCY KEY IS THE UNIQUE (provider, provider_order_id) INDEX. Razorpay retries
 * webhooks, and the browser fallback (`POST /payer/credits/verify`) races those retries.
 * One order id ⇒ one row ⇒ one compare-and-set `created → paid` transition ⇒ exactly one
 * credit grant, no matter how many deliveries arrive or in what order.
 */
export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Opaque payer ref (faceless rails — no FK, no PII), the SESSION payer at order time. */
    payerId: uuid("payer_id").notNull(),
    /** Catalog credit-pack code (e.g. `pack_50`) — resolved server-side, never client-supplied. */
    packCode: text("pack_code").notNull(),
    /**
     * The ₹ amount CHARGED, whole rupees (integer, never paise — paise is a provider-wire
     * concern converted at the edge). Stamped from the pricing catalog at order creation:
     * this row is the receipt, immune to a later ops price edit.
     */
    amountInr: integer("amount_inr").notNull(),
    /** Payment provider. Part of the uniqueness key so a second provider can be added additively. */
    provider: text("provider").notNull().default("razorpay"),
    /** The provider's order id (`order_*`). Unique per provider — THE payment idempotency key. */
    providerOrderId: text("provider_order_id").notNull(),
    /** Order lifecycle: 'created' → 'paid' | 'failed'. Only 'created' → 'paid' grants credits. */
    status: text("status").$type<PaymentOrderStatus>().notNull().default("created"),
    /** Opaque provider payment id (`pay_*`) once captured. NEVER a card/UPI/contact value. */
    providerPaymentRef: text("provider_payment_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE money idempotency key. A duplicate/replayed webhook and a racing client verify
    // both resolve to this ONE row; the conditional status flip decides which one grants.
    uniqueIndex("payment_orders_provider_order_uq").on(t.provider, t.providerOrderId),
  ],
);

/** Order lifecycle. Additive-only (invariant #8): never remove or repurpose a value. */
export type PaymentOrderStatus = "created" | "paid" | "failed";

export type PaymentOrder = typeof paymentOrders.$inferSelect;

/** The one provider this stream supports. A second provider is an additive value, never a rename. */
export const RAZORPAY_PROVIDER = "razorpay";

/** `now()` for the tx-scoped `updated_at` bumps (keeps the DB clock authoritative, not the app's). */
export const dbNow = sql`now()`;
