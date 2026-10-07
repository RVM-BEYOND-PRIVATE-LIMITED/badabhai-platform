# ADR-0052: Cursor pagination for the worker `GET /feed`

- **Status:** **Proposed.** Owner (Prakash) approved starting the build on 2026-10-06. Not yet signed. The
  union arm part (§3.2) needs Divyanshu's review, because ADR-0049 is his.
- **Date:** 2026-10-06
- **Owner:** Prakash (Backend Platform)
- **Tracking:** #1961, split out of #1905 (items 1–2 shipped in #1909)
- **Relates:** [ADR-0009](0009-alpha-swipe-to-apply-seeded-jobs.md) (the feed and `feed.shown`) ·
  [ADR-0036](0036-matching-algorithm-v1.md) (the V1 deck, E14 interleave, `feed.shown_v2`) ·
  [ADR-0049](0049-interim-union-feed.md) (the union; its merge is unchanged) · TD73 (skips are re-served)
- **Contract:** additive. An optional `cursor` query param and a `next_cursor` response key. No migration, no
  new event, no event schema change, no new env var.

---

## 1. Context

`GET /feed` returns one page of at most `limit` (default and max 50) cards. There is no way to reach card 51.
Skips are re-served (TD73), so as inventory grows the older cards starve. This does not bind at today's ~25
eligible cards, but it will.

Three paths serve the feed, each with its own total order:

| Path                                | Order                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `jobs` only (both flags off)        | `created_at DESC, id ASC`                                                     |
| Union (`FEED_POSTINGS_UNION_ENABLED`) | each arm `posted_at DESC, id ASC`, merged by head comparison (ADR-0049)     |
| V1 (`MATCH_V1_ENABLED`)             | `(boosted_until > now()) DESC, match_tier ASC, published_at DESC NULLS LAST, id ASC`, overfetched 3× and permuted by the E14 company interleave |

## 2. Decision

A **keyset** cursor over each path's own served order, not an offset. An offset shifts whenever a card leaves
the deck (an apply, a close) or arrives (a publish), so it skips or repeats cards. A keyset does not.

### 2.1 Wire form

`next_cursor` is base64url (no padding) of a small versioned JSON object. Clients treat it as opaque and pass
it back unchanged as `?cursor=`. It is decoded and validated with Zod in the DTO (`FeedQuerySchema`), so any
value the server did not mint is a **400** (`issues[0].path = "cursor"`), never a 500. That covers bad base64,
bad JSON, an unknown version `v`, an unknown mode `m`, a missing or extra key, a non-uuid id, a timestamp
without microseconds, and an out-of-range count. An empty `?cursor=` is treated as absent. The value is capped
at 4096 characters.

```jsonc
{ "v": 1, "m": "jobs",  "o": 50, "j": { "t": "2099-01-05T00:00:00.123456Z", "id": "<uuid>" } }
{ "v": 1, "m": "union", "o": 50, "j": { "t": "…", "id": "…" } | null, "p": { "t": "…", "id": "…" } | null }
{ "v": 1, "m": "v1",    "o": 50, "k": { "b": true, "r": 1, "t": "…" | null, "id": "…" }, "a": ["<uuid>", …] }
```

- `o` is the number of cards this scroll has already served. `rank` on the card, and on `feed.shown` /
  `feed.shown_v2`, stays the 1-based position **in the deck**, so page 2 starts at `limit + 1`.
- `t` is the timestamp at Postgres's **microsecond** precision, read with
  `to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and bound back as `::timestamptz`. A JS
  `Date` truncates to milliseconds, so two rows inside one millisecond would be skipped or repeated at a page
  boundary.
- The cursor carries no worker id (the worker always comes from the session) and no payer key (the interleave
  key never leaves the server, ADR-0036). It is decodable, but it reveals only sort keys of cards the worker
  was already served.

### 2.2 Paging rules

- **No cursor gives the first page, byte-identical to today.** Every first-page read is the pre-cursor call
  with the same arguments and no keyset clause, then the same merge, interleave, ranking and events. Only one
  thing is added: the `next_cursor` key in the envelope.
- **Page size is unchanged**: `limit`, default 50.
- **End of the deck:** `next_cursor` is `null` when a page comes back short. A deck of exactly `limit × n`
  cards ends with one empty page whose `next_cursor` is `null`. No look-ahead row is read, so the first page's
  SQL `LIMIT` is unchanged. V1 also returns `null` once its overfetch window is fully served and was not full.
- **Mode mismatch:** if a flag flips mid-scroll, the old cursor's position means nothing in the new order. The
  server returns a 400 (`path: "cursor"`) and does not guess. The client drops the cursor and refetches page 1.

## 3. Per path

### 3.1 `jobs` only

The keyset is `(created_at, id)` after the last served card:
`created_at <= :t AND (created_at < :t OR id > :id)`. The leading conjunct is a plain range on the sort column
under `status = 'open'`, which `jobs_status_created_at_idx (status, created_at)` serves.

### 3.2 Union (ADR-0049)

The merge (`mergeNewestFirst`) is **not changed**. Both arms take the same keyset predicate, each resumed after
**its own** last served card. The cursor holds one key per arm (`j`, `p`). An arm that served nothing yet is
`null` and is read from its head. An arm that served nothing on this page keeps its previous key.

The key is per arm, not one merged key, for this reason: the merge compares heads on a millisecond JS `Date`,
while each arm is in microsecond SQL order. Take two cards from different arms inside one millisecond. The
merge can serve the older one first (its id tiebreak wins), and a single keyset at that older card's key would
then put the newer card behind the cursor, so it would be lost. The merge consumes each arm as a prefix, so
resuming each arm after its own last served card is gap-free and duplicate-free whatever the comparator does.
The unit suite includes exactly that pair, and a single-key mutation fails it.

The posting arm's predicate is served by `job_postings_feed_idx (status, published_at DESC)`.

### 3.3 V1 deck

**Keyset.** The keyset is the deck's exact ORDER BY, in this precedence:

1. boost bucket
2. `match_tier` ASC
3. `published_at` DESC NULLS LAST
4. `id` ASC

The cursor stores the bucket the row was served in (`b`). The next read compares that against the live
`boosted_until > now()`.

**Boost flips between pages.** The rule is to re-serve, never to error:

- A card that **lost** its boost after being served (the common case, because boosts expire) now sorts in the
  unboosted bucket, after the cursor. It is **re-served** once.
- A card that **gained** a boost while the cursor sits in the unboosted bucket now sorts before the cursor. It
  is **not reached on this scroll**. It heads the next first page (pull-to-refresh). Avoiding this would need
  per-scroll server state.

**The E14 interleave.** The interleave permutes the overfetched window, so a page is not a prefix of the SQL
order. A row can be **deferred** (held back to break a company run) while a later row is **pulled forward**.
Two choices would each break:

- Resuming after the last served card skips the deferred row.
- Resuming after the last card of the served prefix repeats the pulled-forward row.

So the cursor carries two things:

- `k`, the **frontier**: the last row of the longest fully-served prefix of the window.
- `a`, the **ahead set**: the ids served beyond the frontier.

The next read starts after `k`, and the service drops the `a` ids before interleaving. Carried ids that the
new window places at or before the new frontier fall out of `a`. Ids not in the window stay carried. `a` is
capped at 50 (the page cap). Past the cap, the ids furthest down the deck are dropped, which can only re-serve
a card, never skip one.

**Run limit across pages.** The interleave starts each page with no open run. The max-N-in-a-row rule
therefore holds within a page, but up to 2N cards from one company can sit either side of a page boundary.
Carrying the run across pages would put the company key in a client-held cursor.

**Index.** The read is the same per-worker `job_reach_worker_idx` join and sort. The keyset clause narrows it
and adds no new access path.

### 3.4 Skips (TD73) and applies between pages

- **Legacy and union:** skipped cards are not excluded, but the keyset moves past them. A skip is therefore
  not re-served later in the same scroll. It is re-served on the next first page, as today.
- **V1:** skipped cards are excluded by its anti-join, as today.
- **Applies on all paths:** an applied card drops out of the SQL. A keyset has no offset to shift, so no other
  card moves.

## 4. Events

Events are unchanged and no schemas are touched. Each page is one fetch: one `feed.shown` (legacy and union)
or one `feed.shown_v2` (V1) per card served on that page, emitted once the page is composed, with `rank` = the
deck position. An empty page emits nothing. A re-served card (after a boost expiry, or an ahead id dropped by
the cap) is a second impression, as it would be on a refetch today.

## 5. Consequences

- Clients get the whole deck by following `next_cursor`. A client that ignores it is unaffected.
- A mode-mismatch 400 is the one new client-visible failure. It happens only when a flag flips mid-scroll.
- The keyset index use is reasoned from the existing indexes (§3). It was not confirmed with `EXPLAIN` on
  production-sized data. If a plan regresses, the fix is an additive index in its own migration.

## 6. Tests

- `apps/api/src/applications/feed-cursor.test.ts`: codec, DTO, and the 400 via the real pipe.
- `apps/api/src/applications/applications.feed-cursor.service.test.ts`: jobs-only and union paging over
  in-memory SQL models, including the same-millisecond cross-arm pair. Also mode mismatch and the V1 hand-off.
- `apps/api/src/match/match-feed-cursor.service.test.ts`: V1 paging through the interleave (frontier and ahead
  set), boost expiry, and applies between pages.
- `apps/api/src/applications/feed-cursor.db.test.ts`: all three paths against Postgres, through the DTO. This
  is a CI DB gate.
