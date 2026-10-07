# Worker Feed API — Card Reference

> Scope: the worker job **card** wire shape — `GET /feed` and the job detail a card opens,
> `GET /jobs/:jobId`. Source of truth is the code: `apps/api/src/applications/applications.service.ts`
> (`FeedItem`), `apps/api/src/match/match-feed.service.ts` (`MatchFeedItem`) and
> `apps/api/src/jobs/jobs.service.ts` (`WorkerVisibleJob`). Field rulings: [ADR-0024](../decisions/0024-worker-visible-job-fields-pii.md).
> Consumer: the worker app (`apps/worker-app`). Owner: Backend Platform.

Both routes are worker-authed: `Authorization: Bearer <worker token>`, guard chain
`WorkerAuthGuard` → `ConsentGuard`. The worker id always comes from the token.

## `GET /feed`

Query (all optional): `limit` (1–50, default 50), `trade_key`, `city`, `shift`
(`day`|`night`|`rotational`), `pay_min` (₹/month floor, compared to the band's top), `cursor`
(the previous page's `next_cursor`). Response: `{ "jobs": [Card, …], "next_cursor": string | null }`,
ordered, `rank` = 1-based position in the deck. One `feed.shown` (legacy) or `feed.shown_v2`
(`MATCH_V1_ENABLED`) per card served on that page.

### Pagination (`cursor` / `next_cursor`, added 2026-10-06, #1961, [ADR-0052](../decisions/0052-feed-cursor-pagination.md))

Additive: a client that never sends `cursor` gets today's first page, unchanged, and can ignore `next_cursor`.

```ts
// request
GET /feed?limit=50                      // first page
GET /feed?limit=50&cursor=<next_cursor> // next page; keep the SAME filters for one scroll
// response
{ jobs: Card[]; next_cursor: string | null }
```

- `next_cursor` is **opaque** (base64url). Pass it back byte-for-byte; never build or edit one.
- `null` means the end of the deck. A short page always comes with `null`. A full page comes with a cursor,
  and that cursor may lead to one empty page with `null`.
- `rank` continues across pages: page 2 of a 50-card page starts at 51. Send that `rank` on apply as today.
- Each page is a separate scroll position, not a snapshot. Cards applied to in the meantime drop out without
  shifting the rest. A skipped card is not shown again in the same scroll. It comes back on the next first page
  (TD73). On the V1 path, a card whose paid boost expired between pages can appear a second time. Deduplicate
  by `job_id` client-side if needed.
- Errors (`400`, body `{ message: "Validation failed", issues: [{ path: "cursor", message }] }`):
  - `cursor is malformed`: not a value the server minted (bad encoding, forged, wrong version, too long,
    or a timestamp that is not a real instant such as 30 February or year 0000 — a `500` before 2026-10-07).
  - `cursor was issued for a different feed order; refetch without a cursor`: the feed source flag changed
    mid-scroll.

  On either error, drop the cursor and refetch the first page. Do not retry the same cursor.
- `?cursor=` (empty) is treated as no cursor. A repeated `cursor` param is a 400.

`MATCH_V1_ENABLED` selects the source; the envelope and every key below are the same on both
paths. The V1 card adds `via_related` and `matched_skill_label`.

| Key                                             | Type                                         | Notes                                                                                        |
| ----------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `job_id`                                        | uuid                                         | `jobs.id` or `job_postings.id`. Opaque — post it back to `/applications/:jobId/apply\|skip`. |
| `trade_key`                                     | string                                       | Legacy jobs: the trade slug. Postings: `""`. V1: the matched `mskill_*` id.                  |
| `title`                                         | string                                       |                                                                                              |
| `city`                                          | string                                       | `""` when unknown.                                                                           |
| `area`                                          | string \| null                               | Coarse locality bucket, never an address.                                                    |
| `min_experience_years` / `max_experience_years` | int \| null                                  | Null = unbounded on that side.                                                               |
| `pay_min` / `pay_max`                           | int \| null                                  | The band as stored (₹/month).                                                                |
| `pay_type`                                      | `in_hand`\|`gross`\|`ctc` \| null            | Null = not stated; draw no pill.                                                             |
| `shift`                                         | `day`\|`night`\|`rotational` \| null         |                                                                                              |
| `description`                                   | string \| null                               |                                                                                              |
| `benefits` / `requirements`                     | string[] \| null                             | Chip text.                                                                                   |
| `needed_by`                                     | `immediate`\|`soon`\|`flexible` \| null      |                                                                                              |
| `posted_at`                                     | ISO-8601 \| null                             | `jobs.created_at` / `job_postings.published_at`.                                             |
| `role_kind`                                     | one of the 21 `TRADE_FORM_KINDS_ALL` \| null | **Added 2026-10-05.** See below.                                                             |
| `rank`                                          | int                                          | 1-based.                                                                                     |
| `via_related`                                   | boolean                                      | V1 only.                                                                                     |
| `matched_skill_label`                           | string \| null                               | V1 only.                                                                                     |

## `GET /jobs/:jobId`

The worker-visible detail of ONE open job (legacy `jobs` first, then the open `job_postings`
row). Neutral 404 for unknown and closed ids alike. No event. Keys: `job_id`, `trade_key`
(null for a posting), `title`, `city` (null when unknown), `area`, `pay_min`, `pay_max`,
`pay_type`, `min_experience_years`, `max_experience_years`, `needed_by`, `shift`,
`description`, `benefits`, `requirements`, `role_kind`.

## `role_kind` — the card's role illustration

Owner ruling 2026-10-05 ([ADR-0024 addendum](../decisions/0024-worker-visible-job-fields-pii.md)).
This supersedes the earlier position (ADR-0024 addendum 2026-09-29, ADR-0049 O6) that `role_kind`
was deliberately kept off the worker card.

- **Values:** `cnc_turner`, `vmc_milling`, `cnc_grinding`, `cam_programmer`, `cad_draughtsman`,
  `conventional_machinist`, `tool_die_maker`, `welder`, `sheet_metal_worker`, `press_operator`,
  `painter_coating`, `fitter`, `maintenance_technician`, `industrial_electrician`,
  `assembly_line_worker`, `quality_inspector`, `injection_moulding_operator`, `mould_die_maker`,
  `blow_moulding_operator`, `rubber_moulding_operator`, `plastic_process_technician` — or `null`.
- **`null` = no role picked** (every pre-0131 and chat-published job). Draw the generic card.
- **Fail closed:** the API emits only a declared kind or `null`; a client must still treat an
  unrecognised value as `null` (a 22nd kind can be added later, additively).
- **Art, not text.** Key an illustration on it; never print the slug. The shared card fixture
  (`packages/types/fixtures/job-card-contract.json`) records that it adds no text slot (documented; consumer enforcement is a Frontend follow-up).
- **Additive.** Clients that do not read it are unaffected. It is not on `feed.shown` /
  `feed.shown_v2`, and it is never a filter, rank or match input.
- **Not on `GET /jobs/search`.**
