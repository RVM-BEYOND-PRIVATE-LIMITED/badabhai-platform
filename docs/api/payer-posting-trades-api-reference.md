# Payer API — posting trades (`/payer/posting-trades`)

Issues #3006, #3005 · code: `apps/api/src/posting-trades/*` · release switch `trade_release.posting_enabled` (#3002, migration `0198`)

The trade catalogue a company picks from when it posts a job, and each trade's posting form. Read-only, the same for every company. The web reads these server-side, so the Bearer never reaches the browser. The company app reads them through its own client. Contracts: `apps/payer-web/src/lib/contracts.ts` (`postingTradeListWireSchema`, `postingTradeCatalogueWireSchema`, `postingTradeDetailWireSchema`) and `apps/payer-app/lib/core/data/models.dart` (`PostingTradeCatalogueRow`, `PostingTradeForm`). `posting-trades.contract.test.ts` parses every reply with the web's schemas.

| Route                                 | Answers                                                                               | Follows the release switch |
| ------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| `GET /payer/posting-trades`           | every trade's whole form, for the **16 live trades only** (`LEGACY_LIST_TRADE_KINDS`) | **no**                     |
| `GET /payer/posting-trades/catalogue` | one light row per trade whose posting switch is on                                    | yes                        |
| `GET /payer/posting-trades/:roleKind` | one trade's form with its `department`; `404` for an unknown kind or one switched off | yes                        |

**Auth:** `PayerAuthGuard` on all three. No session is `401`. There is no payer scoping and no query parameters.

## Why the old route does not follow the switch

The installed company apps read `GET /payer/posting-trades` and have no "update required" check. They must keep receiving exactly the 16 trades they receive today, whatever the release table says: a 17th trade switched on is not added, and a live trade switched off is not removed. Lift this once the company app enforces a minimum build (server #3048, app #3049) and that minimum is past every build that reads this route.

## `GET /payer/posting-trades`

```ts
{ trades: PostingTradeForm[] } // the 16, in catalogue order
```

## `GET /payer/posting-trades/catalogue`

Department order (`JOB_ROLE_DEPARTMENTS`, #2999), then pack order (T01..T60). No ladder, no questions.

```ts
{
  trades: {
    role_kind: string; // e.g. "cnc_turner"
    role_label: string; // the server's label; the client never writes its own
    department: string; // JOB_ROLE_DEPARTMENTS id, e.g. "machining"
    department_label: string; // e.g. "Machining"
    kind: "shop_floor" | "desk";
  }
  [];
}
```

## `GET /payer/posting-trades/:roleKind`

The same shape as one element of the old route's `trades`, with `department` added. A `roleKind` that is not a lower-case slug (`^[a-z0-9_]{1,64}$`) is also a `404`.

```ts
{
  role_kind: string;
  role_label: string;
  pack_id: string;
  match_skill_id: string; // the trade's own mskill_*, always in a posting's match set
  ladder: { rung: string; monthsFloor: string; evidence: string; confirmed: boolean; priceTier: "lower" | "higher" }[];
  questions: {
    question_key: string;
    prompt: string;
    answer_type: "single_select" | "multi_select";
    options: { option_key: string; value: string; label: string; match: boolean; match_skill_ids: string[] }[];
  }[];
  department: string;
}
```

A posting that stores a trade which has since been switched off still saves (`normalizeSelection` lets a posting keep its own stored trade). This route answers `404` for that trade, and the web's edit page then shows the stored label and rung read-only.

## Before migration 0198 is applied

While the `trade_release` table is missing (SQLSTATE 42P01), the switch reads as the migration's seed: the 16 live trades are on and nothing else is. `/catalogue` and `/:roleKind` then answer the 16, just as they will after the migration. No new trade can appear until the table exists and the owner switches that trade on.
