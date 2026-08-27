import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import {
  getSkillDiscoveryMetrics,
  listSkillDiscovery,
  listSkillDiscoveryGroups,
  type AdminSkillDiscoverySort,
  type SkillDiscoveryFilters,
  type SkillDiscoveryGroups,
  type SkillDiscoveryListItem,
  type SkillDiscoveryMetrics,
  type SkillReviewGroup,
} from "../../../../lib/skill-discovery";
import {
  ADMIN_SKILL_REVIEW_TIER_LABELS,
  DERIVED_TIER_SEQUENCING_REASON,
  SKILL_CANDIDATE_ACTION_LABELS,
  SKILL_CANDIDATE_STATUS_LABELS,
  SKILL_CANDIDATE_STATUS_TONE,
  SKILL_CANDIDATE_TERMINAL_STATUSES,
  SKILL_GROUP_ORDER_NOTE,
  basisMarkerLabel,
  type AdminSkillReviewTier,
} from "../../../../lib/skill-discovery-vocabulary";
import { formatCount, formatRelative, formatTimestamp } from "../../../../lib/format";
import { StatusPill } from "../../../../components/status-pill";
import { Pager } from "../../../../components/pager";
import { SkillDiscoveryFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Skill Discovery" };

/**
 * Skill Discovery — the review queue (#1260).
 *
 * ── GROUPED IS THE DEFAULT, AND THE SERVER IS NOW THE ONE GROUPING ──────────────────────
 * This view used to bucket ONE PAGE by `trade_family` in the browser, because no grouping route
 * existed and the real anchor rule needs a token count taken across the whole filtered set. That
 * gap was handed back to Backend and is CLOSED: `GET /admin/skill-discovery/groups` now returns
 * the batches, exhaustively for the applied filters, ordered by `candidates` descending and
 * tie-broken on the group key in code-unit order. NOT by `undecided` — so a large finished batch
 * sits above a small untouched one, which the screen states rather than silently re-sorting away
 * (#1280, correction 2).
 *
 * The browser-side version is DELETED rather than kept as a fallback, and the deletion is the
 * point. A page-local grouping is a second copy of a server authority (CLAUDE.md invariant #9)
 * that cannot agree with the first: `anchor` is chosen from a global token count, so the same
 * candidate would land in a different batch on every page-turn. `key`, `anchor`, `label`, the
 * membership and the ordering are all read from the response now, and nothing here recomputes
 * any of them.
 *
 * The grouped view therefore takes NO cursor and NO pager: a group promises its member list is
 * complete for the filters, and a paged answer cannot. An over-broad filter is refused by the
 * route with a 400 naming the count, which this page renders as a refusal rather than silently
 * showing a truncated set.
 *
 * ── "FLAT" IS NOT A PRIORITY SORT ────────────────────────────────────────────────────────
 * `AdminSkillDiscoveryQuerySchema`'s own comment refuses a priority order outright: a computed
 * `reviewPriority` sorted within a single page "would be worse than not offering it" — a
 * priority queue that is only priority-ordered within an arbitrary time slice. The honest
 * substitute the DTO names is filtering by tier/band and reading newest/oldest — which is what
 * the tier tabs and the sort control below already are. This view is a flat, unbatched read of
 * the SAME rows the grouped view shows, nothing more.
 *
 * ── TIER SEQUENCING IS A NUDGE, NEVER A HARD BLOCK ───────────────────────────────────────
 * `derived` sits on the same `read_entities` floor as every other tier — nothing on the API
 * refuses reading it, so this screen must not invent a client-side permission that does. It is
 * sequenced behind one extra, clearly-labelled click instead (`DERIVED_TIER_SEQUENCING_REASON`).
 */
export default async function SkillDiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Page-level gate. Decision controls (a stricter capability) live only on the detail
  // screen, which checks for itself before offering the five buttons — this page is a read.
  await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const many = (v: string | string[] | undefined): string[] | undefined => {
    const arr = (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  };

  const view: "grouped" | "flat" = one(sp.view) === "flat" ? "flat" : "grouped";
  const tierParam = one(sp.tier);
  const derivedAck = one(sp.ack) === "1";
  /**
   * `tierParam` is the RAW url value, including the "all" sentinel — a real, persistable
   * value distinct from "absent", which is what makes clicking "All tiers" stick rather than
   * bouncing back to the default the moment the param would otherwise be dropped as falsy.
   *
   * `effectiveTier` is what actually reaches the server, and this is where the sequencing
   * NUDGE becomes real rather than cosmetic: `?tier=derived` with no `ack=1` still requests
   * `direct` — a shared or guessed link cannot skip the acknowledgement click, which would
   * otherwise leave the tab reading "not applied" while the table quietly showed derived rows
   * anyway. "all" (or nothing typed yet) omits the filter; any other value is forwarded as-is
   * so an unrecognised one still earns an honest 400 rather than being silently dropped.
   */
  const effectiveTier =
    tierParam === "all"
      ? undefined
      : tierParam === "derived" && !derivedAck
        ? "direct"
        : (tierParam ?? "direct");
  const runId = one(sp.runId);
  const clusterKey = one(sp.clusterKey);
  const phrase = one(sp.phrase);
  const tradeFamily = one(sp.tradeFamily);
  const band = one(sp.band);
  const proposedAction = one(sp.proposedAction);
  const sourceType = one(sp.sourceType);
  const createdFrom = one(sp.createdFrom);
  const createdTo = one(sp.createdTo);
  const sort = (one(sp.sort) === "oldest" ? "oldest" : "newest") as AdminSkillDiscoverySort;
  const cursor = one(sp.cursor);

  // ── status: an explicit scope, never a hidden server default ──────────────────────────
  const rawStatus = many(sp.status);
  const statusScopeParam = one(sp.statusScope);
  const { scope: statusScope, status: effectiveStatus } = resolveStatusScope(
    rawStatus,
    statusScopeParam,
  );

  const filtered = Boolean(
    rawStatus ||
    (statusScopeParam && statusScopeParam !== "awaiting") ||
    (tierParam && tierParam !== "direct") ||
    runId ||
    clusterKey ||
    phrase ||
    tradeFamily ||
    band ||
    proposedAction ||
    sourceType ||
    createdFrom ||
    createdTo,
  );

  const limit = view === "grouped" ? GROUPED_LIMIT : FLAT_LIMIT;

  const query: SkillDiscoveryFilters = {
    status: effectiveStatus,
    tier: effectiveTier,
    runId,
    clusterKey,
    phrase,
    tradeFamily,
    band,
    proposedAction,
    sourceType,
    createdFrom,
    createdTo,
    sort,
    cursor,
    limit,
  };

  /*
   * The grouping route's own query type OMITS cursor/limit/sort, so they are stripped by
   * destructuring rather than by passing `undefined` — the type refuses the key outright, which
   * is the point: a paged or sorted grouping is not a thing this route can answer.
   */
  const { cursor: _cursor, limit: _limit, sort: _sort, ...groupQuery } = query;

  /*
   * TWO DIFFERENT READS BEHIND ONE TOGGLE, and they are not interchangeable.
   *
   * FLAT pages the queue with a keyset cursor. GROUPED calls the grouping route, which takes no
   * cursor and no limit because a group's contract is that its member list is COMPLETE for the
   * filters — so the grouped view has no pager, and asking for one would be asking the server to
   * break that promise. Only the read the current view needs is issued; the other would be a
   * round trip nobody reads.
   */
  const [dataRes, metricsRes] = await Promise.allSettled([
    view === "grouped" ? listSkillDiscoveryGroups(groupQuery) : listSkillDiscovery(query),
    getSkillDiscoveryMetrics(),
  ]);

  /*
   * A 400 IS THE OPERATOR'S FILTERS, and on the grouped route it is ALSO how "your filter matches
   * too much to group exhaustively" arrives — the route refuses with a count rather than
   * truncating. Both render as a refusal carrying the server's own words, which is why the
   * message is surfaced rather than replaced with generic copy.
   */
  const badRequest =
    dataRes.status === "rejected" &&
    isAdminRequestError(dataRes.reason) &&
    dataRes.reason.status === 400;
  const refusal =
    badRequest && dataRes.status === "rejected" ? (dataRes.reason as Error).message : null;

  const page =
    view === "flat" && dataRes.status === "fulfilled"
      ? (dataRes.value as Awaited<ReturnType<typeof listSkillDiscovery>>)
      : null;
  const groups =
    view === "grouped" && dataRes.status === "fulfilled"
      ? (dataRes.value as SkillDiscoveryGroups)
      : null;
  /** True when the read this view needed failed for any reason other than a refusal. */
  const readFailed = dataRes.status === "rejected" && !badRequest;
  const metrics = metricsRes.status === "fulfilled" ? metricsRes.value : null;

  const activeTier = tierParam ?? "direct";

  // ── the "current query" rebuilt, so every link/retry/pager preserves it ───────────────
  // `status` is carried as a single comma-joined value (a "custom", hand-edited combination
  // only — every chip this page renders sets `statusScope` instead) and re-expanded into
  // repeated `status=` params by `queryString`. `<Pager>` builds its OWN href from `carry`
  // with a plain `.set()`, so a "Next page" click on a custom combination round-trips the
  // comma literally rather than repeated keys — which the server's enum then refuses as an
  // honest 400 (rendered below), never silently misreads. Accepted rather than widening the
  // shared `Pager` primitive for an edge case none of this page's own controls can produce.
  const carry: Record<string, string | undefined> = {
    view,
    tier: tierParam,
    ack: derivedAck ? "1" : undefined,
    statusScope: statusScope === "custom" ? undefined : statusScope,
    status: statusScope === "custom" && rawStatus ? rawStatus.join(",") : undefined,
    runId,
    clusterKey,
    phrase,
    tradeFamily,
    band,
    proposedAction,
    sourceType,
    createdFrom,
    createdTo,
    sort: sort === "newest" ? undefined : sort,
  };
  const queryString = (over: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams();
    const merged = { ...carry, ...over };
    for (const [k, v] of Object.entries(merged)) {
      if (!v) continue;
      if (k === "status") {
        for (const s of v.split(",")) if (s) q.append("status", s);
        continue;
      }
      q.set(k, v);
    }
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  const listHref = (over: Record<string, string | undefined> = {}) =>
    `/skills/discovery${queryString(over)}`;
  const retryHref = listHref({});

  const tierTabHref = (tier: AdminSkillReviewTier | "all") =>
    listHref({ tier, ack: undefined, cursor: undefined });
  const derivedViewAnywayHref = listHref({ tier: "derived", ack: "1", cursor: undefined });

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">Skills</p>
          <h1 className="page__title">Skill Discovery</h1>
          <p className="page__sub">
            AI-surfaced claims that the canonical skill taxonomy may be missing something. Each row
            is a claim, never a skill — an approval only records a decision; the corpus write stays
            in the offline, gated chain.
          </p>
        </div>
      </header>

      <MetricsTiles metrics={metrics} />

      <section className="panel" aria-labelledby="sd-queue" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="sd-queue">
              Review queue
            </h2>
            <p className="panel__sub">
              {view === "grouped"
                ? "Batched by the server across every candidate these filters match — a lens, not a merge. Every member still gets its own decision, its own reason and its own audit row."
                : "One row per candidate, newest or oldest first within the selected tier and band — there is no computed priority order."}
            </p>
          </div>
          <div className="page__actions">
            <Link
              aria-current={view === "grouped" ? "true" : undefined}
              className={`btn btn--sm ${view === "grouped" ? "btn--primary" : "btn--ghost"}`}
              href={listHref({ view: undefined, cursor: undefined })}
            >
              Grouped
            </Link>
            <Link
              aria-current={view === "flat" ? "true" : undefined}
              className={`btn btn--sm ${view === "flat" ? "btn--primary" : "btn--ghost"}`}
              href={listHref({ view: "flat", cursor: undefined })}
            >
              Flat
            </Link>
          </div>
        </div>

        {/* ── status scope chips ──────────────────────────────────────────────────────── */}
        <div className="filters--inline" role="group" aria-label="Status">
          {(["awaiting", "held", "decided", "all"] as const).map((s) => (
            <Link
              key={s}
              aria-current={statusScope === s ? "true" : undefined}
              className={`btn btn--sm ${statusScope === s ? "btn--primary" : "btn--ghost"}`}
              href={listHref({ statusScope: s, cursor: undefined })}
            >
              {STATUS_SCOPE_LABELS[s]}
            </Link>
          ))}
        </div>

        {/* ── tier tabs — sequencing is VISIBLE, never a silent default filter ──────────── */}
        <div className="filters--inline" role="group" aria-label="Review tier">
          <Link
            aria-current={activeTier === "all" ? "true" : undefined}
            className={`btn btn--sm ${activeTier === "all" ? "btn--primary" : "btn--ghost"}`}
            href={tierTabHref("all")}
          >
            All tiers
          </Link>
          <Link
            aria-current={activeTier === "direct" ? "true" : undefined}
            className={`btn btn--sm ${activeTier === "direct" ? "btn--primary" : "btn--ghost"}`}
            href={tierTabHref("direct")}
          >
            Direct (default)
          </Link>
          <Link
            aria-current={activeTier === "ambiguous" ? "true" : undefined}
            className={`btn btn--sm ${activeTier === "ambiguous" ? "btn--primary" : "btn--ghost"}`}
            href={tierTabHref("ambiguous")}
          >
            Ambiguous
          </Link>
          {activeTier === "derived" && derivedAck ? (
            <Link
              aria-current="true"
              className="btn btn--sm btn--primary"
              href={tierTabHref("derived")}
            >
              Derived
            </Link>
          ) : (
            <Link className="btn btn--sm btn--ghost" href={derivedViewAnywayHref}>
              Derived (sequenced behind Direct) — view anyway
            </Link>
          )}
        </div>
        <p className="field__help">{DERIVED_TIER_SEQUENCING_REASON}</p>

        <SkillDiscoveryFilterBar
          basePath="/skills/discovery"
          carry={carry}
          initial={{
            band: band ?? "",
            proposedAction: proposedAction ?? "",
            tradeFamily: tradeFamily ?? "",
            sourceType: sourceType ?? "",
            runId: runId ?? "",
            clusterKey: clusterKey ?? "",
            phrase: phrase ?? "",
            createdFrom: createdFrom ?? "",
            createdTo: createdTo ?? "",
            sort,
          }}
        />

        {badRequest ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected this request</h3>
            <p className="state__body">
              Nothing was fetched. One of the filters, as it stands in the address bar, is not a
              value this queue accepts — a hand-edited status, tier, band or run id.
            </p>
            {/* The server's OWN sentence, not a paraphrase. On the grouping route this is also
                how "your filter matches too much to group exhaustively" arrives — the route
                refuses with the count rather than truncating, and the count is the actionable
                part. Replacing it with generic copy would hide the one number that says how much
                to narrow by. */}
            {refusal ? <p className="state__body">{refusal}</p> : null}
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/skills/discovery">
                Reset filters
              </Link>
            </div>
          </div>
        ) : readFailed ? (
          <div className="state state--error">
            <h3 className="state__title">The queue is unavailable</h3>
            <p className="state__body">
              The read failed — a fault on our side, not the filters. Reload to try again.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={retryHref}>
                Retry
              </Link>
            </div>
          </div>
        ) : groups !== null ? (
          groups.groups.length === 0 ? (
            <EmptyQueueState
              filtered={filtered}
              noRunEver={metrics !== null && metrics.total === 0}
              statusScope={statusScope}
            />
          ) : (
            <ServerGroupedQueue groups={groups} groupHref={listHref} />
          )
        ) : page === null || page.items.length === 0 ? (
          <EmptyQueueState
            filtered={filtered}
            noRunEver={metrics !== null && metrics.total === 0}
            statusScope={statusScope}
          />
        ) : (
          <FlatQueue items={page.items} />
        )}

        {/* Only the FLAT view pages. The grouped route is exhaustive for its filters and takes
            no cursor, so a pager under it would imply there is more to fetch when there is not. */}
        {page && (
          <Pager
            basePath="/skills/discovery"
            params={carry}
            nextCursor={page.nextCursor}
            note="Server-paged with a keyset cursor — this view never loads the whole queue at once."
          />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// constants + pure helpers
// ---------------------------------------------------------------------------

const GROUPED_LIMIT = 100; // ADMIN_SKILL_DISCOVERY_PAGE_MAX
const FLAT_LIMIT = 50; // ADMIN_SKILL_DISCOVERY_PAGE_DEFAULT

const STATUS_SCOPE_LABELS: Record<"awaiting" | "held" | "decided" | "all", string> = {
  awaiting: "Awaiting decision",
  held: "Held",
  decided: "Decided",
  all: "All statuses",
};

const SCOPE_STATUSES: Record<"awaiting" | "held" | "decided", readonly string[]> = {
  awaiting: ["pending", "needs_review"],
  held: ["deferred"],
  decided: SKILL_CANDIDATE_TERMINAL_STATUSES,
};

function resolveStatusScope(
  raw: string[] | undefined,
  scopeParam: string | undefined,
): { scope: "awaiting" | "held" | "decided" | "all" | "custom"; status: string[] | undefined } {
  if (raw && raw.length > 0) {
    const sorted = [...raw].sort().join(",");
    for (const scope of ["awaiting", "held", "decided"] as const) {
      if ([...SCOPE_STATUSES[scope]].sort().join(",") === sorted) return { scope, status: raw };
    }
    return { scope: "custom", status: raw };
  }
  if (scopeParam === "all") return { scope: "all", status: undefined };
  if (scopeParam === "held") return { scope: "held", status: [...SCOPE_STATUSES.held] };
  if (scopeParam === "decided") return { scope: "decided", status: [...SCOPE_STATUSES.decided] };
  return { scope: "awaiting", status: [...SCOPE_STATUSES.awaiting] };
}

// ---------------------------------------------------------------------------
// dashboard tiles — AC#1: one request, no client-side aggregation
// ---------------------------------------------------------------------------

function MetricsTiles({ metrics }: { metrics: SkillDiscoveryMetrics | null }) {
  if (metrics === null) {
    return (
      <div className="state state--error">
        <h3 className="state__title">Dashboard tiles are unavailable</h3>
        <p className="state__body">
          The metrics read failed. The queue below is a separate read and may still work.
        </p>
      </div>
    );
  }

  const byStatus = (key: string) => metrics.by_status.find((b) => b.key === key)?.count ?? 0;
  const byTier = (key: string) => metrics.by_tier.find((b) => b.key === key)?.count ?? 0;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="stat__value">{formatCount(metrics.awaiting_decision)}</span>
          <span className="stat__label">Pending review</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatCount(byTier("direct"))}</span>
          <span className="stat__label">{ADMIN_SKILL_REVIEW_TIER_LABELS.direct}</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatCount(byTier("ambiguous"))}</span>
          <span className="stat__label">{ADMIN_SKILL_REVIEW_TIER_LABELS.ambiguous}</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatCount(byTier("derived"))}</span>
          <span className="stat__label">{ADMIN_SKILL_REVIEW_TIER_LABELS.derived}</span>
        </div>
      </div>
      <div className="stats stats--compact">
        <div className="stat">
          <span className="stat__value">{formatCount(byStatus("approved_create"))}</span>
          <span className="stat__label">Created</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatCount(byStatus("approved_map"))}</span>
          <span className="stat__label">Mapped</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatCount(byStatus("approved_merge"))}</span>
          <span className="stat__label">Merged</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatCount(byStatus("rejected"))}</span>
          <span className="stat__label">Rejected</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatCount(metrics.deferred)}</span>
          <span className="stat__label">Held</span>
        </div>
      </div>
      <p className="field__help">
        {formatCount(metrics.total)} candidates in total.{" "}
        {metrics.oldest_awaiting_created_at
          ? `Oldest still awaiting a decision: ${formatRelative(metrics.oldest_awaiting_created_at)} (${formatTimestamp(metrics.oldest_awaiting_created_at)}).`
          : "Nothing is currently awaiting a decision."}
      </p>
      {/*
       * `tier_basis`, rendered next to the three tier counts it qualifies. The tiles look like
       * counts of a stored column and are not — the tier is recomputed per read from the phrase
       * class and whether a strong match exists. Parsing that marker and not showing it would leave
       * the console holding a disclaimer the reviewer never sees (#1280, correction 3).
       */}
      <p className="field__help">{basisMarkerLabel(metrics.tier_basis)}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// empty states — three different claims
// ---------------------------------------------------------------------------

function EmptyQueueState({
  filtered,
  noRunEver,
  statusScope,
}: {
  filtered: boolean;
  noRunEver: boolean;
  statusScope: "awaiting" | "held" | "decided" | "all" | "custom";
}) {
  if (!filtered && noRunEver) {
    return (
      <div className="state">
        <h3 className="state__title">No discovery run has ever been persisted</h3>
        <p className="state__body">
          This is an operations state, not an empty result: the `skill_candidate` table itself has
          nothing in it. A discovery run is an offline `packages/db` CLI step, outside this console
          — see `docs/operations/skill-discovery-activation-plan.md` for how to run one.
        </p>
      </div>
    );
  }
  if (!filtered && statusScope === "awaiting") {
    return (
      <div className="state">
        <h3 className="state__title">Nothing is awaiting a decision right now</h3>
        <p className="state__body">
          Every candidate has either been decided or is on hold. Check the Held or Decided scopes
          above to see them.
        </p>
      </div>
    );
  }
  return (
    <div className="state">
      <h3 className="state__title">No candidates match these filters</h3>
      <p className="state__body">
        Nothing in the queue satisfies this combination of status, tier and filters. Widen or clear
        a filter above to see more.
      </p>
      <div className="state__actions">
        <Link className="btn btn--ghost" href="/skills/discovery">
          Reset filters
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// grouped view — rendered STRAIGHT FROM THE SERVER'S grouping route
// ---------------------------------------------------------------------------

/**
 * The batches, as the server computed them.
 *
 * ⚠ THERE IS NO GROUPING LOGIC IN THIS FILE, AND THERE MUST NOT BE ONE AGAIN. Order, membership,
 * labels, anchors and every count come off the response untouched. The browser cannot reproduce
 * them even in principle — the anchor is picked from a token count taken across the whole filtered
 * set — so a local version could only ever be a second algorithm quietly disagreeing with the
 * real one.
 *
 * ── WHY A GROUP CARD OFFERS TWO DIFFERENT DOORS ────────────────────────────────────────
 * `candidate_ids` is the EXACT membership, so each member gets a direct link — that list is
 * precise and complete. The "open in the flat view" link filters by tier and trade family, which
 * for an ANCHORED batch is a SUPERSET of the batch, and the card says so rather than implying the
 * two are the same set. Anchor is not a queue filter, so no link can reproduce an anchored batch
 * exactly; pretending otherwise would be the same lie the page-local grouping used to tell.
 *
 * ── AND THERE IS NO GROUP-LEVEL DECISION ───────────────────────────────────────────────
 * `grouping_basis` says in band that a group has no row anywhere. Every member is decided on its
 * own screen, with its own reason and its own audit row. A "decide all" control would have to
 * issue N individual calls, and a single wrong judgement would then create N wrong rows with one
 * reason attached to all of them.
 */
function ServerGroupedQueue({
  groups,
  groupHref,
}: {
  groups: SkillDiscoveryGroups;
  groupHref: (over: Record<string, string | undefined>) => string;
}) {
  return (
    <>
      <p className="panel__sub">
        {formatCount(groups.total_candidates)}{" "}
        {groups.total_candidates === 1 ? "candidate" : "candidates"} in{" "}
        {formatCount(groups.total_groups)}{" "}
        {groups.total_groups === 1 ? "review screen" : "review screens"} —{" "}
        {formatCount(groups.total_undecided)} still awaiting a human. Exhaustive for the filters
        above: batches are recomputed on every read and are not stored anywhere, so there is nothing
        to reconcile these counts against.
      </p>
      {/*
       * The ordering rule, said out loud. It is `candidates` descending and NOT `undecided`, which
       * is the opposite of what a queue implies, so a reviewer working top-down would otherwise
       * spend their first screens on batches that are already finished. The console does not
       * re-sort — see `SKILL_GROUP_ORDER_NOTE` for why a second order is the same defect as a
       * second grouping — it says what the order is and marks the finished batches.
       */}
      <p className="field__help">{SKILL_GROUP_ORDER_NOTE}</p>
      {/*
       * `grouping_basis`, rendered rather than merely parsed. The server saying "a batch is derived
       * and stored nowhere" is exactly the claim a reviewer would otherwise have to take on trust
       * from a screen that looks like it is listing records (#1280, correction 3).
       */}
      <p className="field__help">{basisMarkerLabel(groups.grouping_basis)}</p>
      <ul className="reviewgroups">
        {groups.groups.map((g) => (
          <ReviewGroupCard key={g.key} group={g} groupHref={groupHref} />
        ))}
      </ul>
    </>
  );
}

function ReviewGroupCard({
  group,
  groupHref,
}: {
  group: SkillReviewGroup;
  groupHref: (over: Record<string, string | undefined>) => string;
}) {
  const flatHref = groupHref({
    view: "flat",
    tier: group.tier,
    tradeFamily: group.trade_family ?? undefined,
    cursor: undefined,
  });

  return (
    <li className="panel">
      <details className="reviewgroup">
        {/*
         * `undecided === 0` gets a marker rather than a re-sort. The server orders by batch SIZE,
         * so a finished batch can outrank an untouched one; the reviewer needs to skip it by eye,
         * and moving it in the list would mean this screen publishes an order the server does not
         * (#1280, correction 2). "Nothing left to decide" is also not "approved" — a batch counts
         * `deferred` as decided, because somebody looked.
         */}
        <summary>
          <strong>{group.label}</strong> · {formatCount(group.candidates)}{" "}
          {group.candidates === 1 ? "candidate" : "candidates"} ·{" "}
          {group.undecided === 0 ? (
            <span className="table__meta">nothing left to decide</span>
          ) : (
            <>{formatCount(group.undecided)} still to decide</>
          )}
        </summary>

        <dl className="kv">
          <dt className="kv__k">Tier</dt>
          <dd className="kv__v">
            <StatusPill
              value={group.tier}
              label={ADMIN_SKILL_REVIEW_TIER_LABELS[group.tier]}
              tone={group.tier === "direct" ? "ok" : group.tier === "ambiguous" ? "warn" : "muted"}
            />
          </dd>
          <dt className="kv__k">Trade family</dt>
          <dd className="kv__v">{group.trade_family ?? "Unspecified"}</dd>
          <dt className="kv__k">Shared term</dt>
          <dd className="kv__v">{group.anchor ?? "None — batched on the trade family alone"}</dd>
          <dt className="kv__k">Evidence behind it</dt>
          <dd className="kv__v">
            {formatCount(group.source_rows)} source {group.source_rows === 1 ? "phrase" : "phrases"}{" "}
            across {formatCount(group.source_domains)}{" "}
            {group.source_domains === 1 ? "trade" : "trades"}
          </dd>
          <dt className="kv__k">Pipeline suggestion</dt>
          <dd className="kv__v">
            {group.unanimous_action
              ? `Every member suggests: ${
                  SKILL_CANDIDATE_ACTION_LABELS[
                    group.unanimous_action as keyof typeof SKILL_CANDIDATE_ACTION_LABELS
                  ] ?? group.unanimous_action
                } — a suggestion, not a decision`
              : "Members disagree — there is no single machine reading of this batch"}
          </dd>
        </dl>

        <details className="reviewgroup__members">
          <summary>
            Show the {formatCount(group.candidates)} exact{" "}
            {group.candidates === 1 ? "member" : "members"}
          </summary>
          <ul className="chips">
            {group.candidate_ids.map((id) => (
              <li key={id}>
                <Link className="link mono" href={`/skills/discovery/${id}`}>
                  {id.slice(0, 8)}…
                </Link>
              </li>
            ))}
          </ul>
          <p className="field__help">
            These ids are the batch, exactly. Each opens its own review screen, where it is decided
            on its own — a batch is a way of forming the judgement once, never a way of recording it
            once.
          </p>
        </details>

        <div className="page__actions">
          <Link className="btn btn--sm btn--ghost" href={flatHref}>
            Open this trade and tier in the flat view
          </Link>
        </div>
        {group.anchor ? (
          <p className="field__help">
            That view filters by tier and trade family only. This batch is narrower — it also shares
            the term “{group.anchor}” — so the flat view will show these candidates and others
            alongside them.
          </p>
        ) : null}
      </details>
    </li>
  );
}

function FlatQueue({ items }: { items: SkillDiscoveryListItem[] }) {
  return (
    <div className="tablewrap">
      <table className="table">
        <caption className="sr-only">Skill discovery candidates</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Phrase</th>
            <th scope="col">Proposed</th>
            <th scope="col">Suggested action</th>
            <th scope="col">Trade family</th>
            <th scope="col">Tier</th>
            <th scope="col">Band</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <FlatRow key={item.id} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlatRow({ item }: { item: SkillDiscoveryListItem }) {
  return (
    <tr>
      <td>
        <time dateTime={item.created_at} title={formatTimestamp(item.created_at)}>
          {formatRelative(item.created_at)}
        </time>
      </td>
      <td>
        <Link className="link" href={`/skills/discovery/${item.id}`}>
          {item.normalized_phrase}
        </Link>
      </td>
      <td className="table__meta">{item.proposed_skill_name ?? "—"}</td>
      <td className="table__meta">{SKILL_CANDIDATE_ACTION_LABELS[item.proposed_action]}</td>
      <td className="table__meta">{item.trade_family ?? "—"}</td>
      <td className="table__meta">{ADMIN_SKILL_REVIEW_TIER_LABELS[item.review_tier]}</td>
      <td className="table__meta">{item.confidence_band}</td>
      <td>
        <StatusPill
          value={item.status}
          label={SKILL_CANDIDATE_STATUS_LABELS[item.status]}
          tone={SKILL_CANDIDATE_STATUS_TONE[item.status]}
        />
      </td>
    </tr>
  );
}
