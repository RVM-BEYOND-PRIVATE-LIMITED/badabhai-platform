# Admin API — company payment history (`GET /admin/payers/:id/payment-history`)

Issue #2565 (plan B11) · code: `apps/api/src/admin/admin-payment-history.*` · migration `0155_company_payment_history` · backfill `pnpm db:backfill:payment-prices`

One company's timeline answering "what have we paid for": payment orders, credit purchases, admin credit grants, credit spending (unlocks), posting plans, boosts, capacity purchases and quota top-ups — in date order, with totals. Read-only.

## Request

|               |                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------- |
| Method / path | `GET /admin/payers/:id/payment-history`                                                  |
| `:id`         | ANY payer in the company (founder or team member uuid, zod `uuid`) — anything else is `400` |
| Query         | `cursor` (opaque keyset), `limit` (1–100, default 50)                                    |
| Auth          | admin session (`AdminAuthGuard`) + `AdminRolesGuard`                                     |
| Capability    | `read_entities` — super_admin, ops_admin, support, analyst                               |

## Org rollup

`:id` resolves to the org (the founder's solo org, or the team org the payer is an
active member of) and EVERY source predicate runs over ALL member payer_ids in
it — so a teammate's purchase rolls up to the company. A payer with no org
resolves to themselves alone. The response echoes the resolution:

```ts
{ payer_id: string; /* the org anchor (or the solo payer) */ member_payer_ids: string[]; }
```

## Response

```ts
{
  payer_id: string;
  member_payer_ids: string[];
  items: {
    id: string;              // `<type>:<source row id>` — unique across the union
    date: string;            // ISO — the timeline sorts on this DESC (then id DESC)
    type: "payment_order" | "credit_purchase" | "credit_grant"
        | "credit_refund" | "credit_spend"
        | "posting_plan" | "boost" | "capacity_purchase" | "quota_topup";
    item: string;            // pack code / tier / reason — never PII
    credits: number | null;  // signed movement where one exists; else null
    amount_inr: number | null;// whole ₹ stamped AT PURCHASE; null = "not recorded"
    status: string;          // the receipt's own word (paid / active / …)
    provider_reference: string | null; // OPAQUE gateway order id (orders/ledger); else null
    simulated: boolean;      // true while real payments are off
  }[];
  nextCursor: string | null;
  totals: { inr_spent: number; credits_bought: number; credits_used: number; balance: number; };
  payments: { mode: "real" | "mock"; blocked_reason: string | null; };
}
```

### Totals

Computed over the WHOLE timeline, never the page:

- `inr_spent` — stamped ₹ on ledger purchases + plans + boosts + capacity + top-ups,
  plus orders with NO ledger twin. A pack purchase appears twice (the `payment_orders`
  intent row AND the `credit_ledger` purchase row); the ledger is the money source
  of record and the order is counted only when no `(pack, amount, credits)` twin
  exists — so one purchase is never two rupees.
- `credits_bought` — same rule on the credits leg.
- `credits_used` — abs of `unlock_debit` deltas.
- `balance` — live `payer_credits` sum across the org's wallets.

### Null ₹ ("not recorded")

A null `amount_inr` is a pre-#2565 receipt (or a manual grant) with no stamped
price. It contributes 0 to `inr_spent` and renders as "Not recorded" — it is
NEVER back-guessed from the current catalog. The `db:backfill:payment-prices`
runner fills what the event spine can prove and reports the rest.

### Simulated flag

Every row carries `simulated`, and the response repeats the posture. While
`PAYMENTS_ENABLE_REAL` is false (the default, the state today) NO rupee here was
ever charged to anyone. The Companies page renders the "Simulated" tag from the
row flag, never from a separate lookup.

## Errors

| Status | When                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| `400`  | `:id` is not a uuid; bad `cursor`/`limit`                                     |
| `401`  | no / expired admin session                                                    |
| `403`  | role without `read_entities` (none of the four today)                         |
| `404`  | no such payer — body `{"message":"Payer not found"}`                          |

## Audit

None — a read is not a state change. Purchases keep emitting their own events
(`payment.authorized/captured`, `job_posting.purchased/boosted`,
`posting_plan.quota_topped`, `capacity.purchased`) at purchase time; this
surface emits nothing.

## Deploy order

1. Apply migration `0155_company_payment_history` BEFORE the deploy (the purchase
   writers name `price_inr` and the read names the new table — a new build on an
   unmigrated database 500s purchases).
2. Merge + deploy.
3. Run `pnpm db:backfill:payment-prices` (dry run first) to stamp history from
   the event spine. Idempotent — re-runs report counts with zero writes.
