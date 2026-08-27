import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import {
  getSkillDiscoveryMetrics,
  listSkillDiscovery,
  listSkillDiscoveryGroups,
  type AdminSkillDiscoverySort,
  type SkillDiscoveryGroups,
  type SkillDiscoveryGroupsFilters,
  type SkillDiscoveryListItem,
  type SkillDiscoveryMetrics,
  type SkillDiscoveryPage,
  type SkillReviewGroup,
} from "../../../../lib/skill-discovery";
import {
  ADMIN_SKILL_REVIEW_TIER_LABELS,
  DERIVED_TIER_SEQUENCING_REASON,
  SKILL_CANDIDATE_ACTION_LABELS,
  SKILL_CANDIDATE_STATUS_LABELS,
  SKILL_CANDIDATE_STATUS_TONE,
  SKILL_CANDIDATE_TERMINAL_STATUSES,
  basisMarkerLabel,
  type AdminSkillReviewTier,
} from "../../../../lib/skill-discovery-vocabulary";
import { formatCount, formatRelative, formatTimestamp, shortId } from "../../../../lib/format";
import { StatusPill } from "../../../../components/status-pill";
import { Pager } from "../../../../components/pager";
import { SkillDiscoveryFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Skill Discovery" };

/**
 * Skill Discovery — the review queue (#1260, extended #1280).
 *
 * ── GROUPED IS THE DEFAULT, AND IT IS NOW THE REAL BATCHES ──────────────────────────────
 * #1260 shipped this view grouping by `trade_family` ALONE, within one server page — its own
 * header explained why: `anchorToken` needs a token count taken across the whole 6,673-row
 * table, no route exposed it, and reimplementing that algorithm client-side over 50 rows would
 * have been exactly the "second copy of a server authority" CLAUDE.md invariant #9 forbids.
 * `GET /admin/skill-discovery/groups` (#1257) is what that finding was waiting for: it groups
 * the WHOLE filtered population server-side and returns ~3,009 review batches over the full
 * 6,673 candidates, never a family split within one page. This view now calls THAT route, not
 * `listSkillDiscovery`, and takes NO `cursor`/`limit`/`sort` — a group's contract is that its
 * member list is complete for the filters, and the anchor is computed over the whole matching
 * set, so a page would hand the same candidate a different batch on every turn. An over-broad
 * filter 400s naming the count instead of truncating; that message is rendered verbatim below,
 * never folded into the generic error copy.
 *
 * A GROUP RESPONSE HAS NO PER-MEMBER SUMMARY — only `candidate_ids[]`, counts and a display-only
 * `label`. So each card links every member id straight to its own decision screen rather than
 * trying to re-render a phrase/status this response does not carry.
 *
 * ── SORT ORDER: THE SERVER'S, BY DEFAULT (contract correction #2) ──────────────────────────
 * The server sorts `candidates` DESCENDING, tie-broken by group key — NOT by `undecided`. A
 * 35-candidate, fully-decided batch outranks a 10-candidate, entirely-unreviewed one. Whether
 * `undecided`-first is the better default is an OPEN PRODUCT QUESTION, not settled here — so
 * this view does not silently assume the server already does it. It offers an explicit,
 * labelled `?groupSort=undecided` toggle that re-orders the ALREADY-FETCHED groups client-side
 * (a display re-order, not a re-computation of what a group IS — the grouping itself stays
 * entirely server-side) and defaults to the server's own order.
 *
 * ── "FLAT" IS NOT A PRIORITY SORT ────────────────────────────────────────────────────────
 * `AdminSkillDiscoveryQuerySchema`'s own comment refuses a priority order outright: a computed
 * `reviewPriority` sorted within a single page "would be worse than not offering it" — a
 * priority queue that is only priority-ordered within an arbitrary time slice. The honest
 * substitute the DTO names is filtering by tier/band and reading newest/oldest — which is what
 * the tier tabs and the sort control below already are. This view is the ordinary keyset-paged
 * queue, unaffected by the grouped view's own endpoint and filters identically.
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
  const groupSort: "candidates" | "undecided" = one(sp.groupSort) === "undecided" ? "undecided" : "candidates";

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

  // The filters common to BOTH the queue and the groups route — everything but the queue's
  // own paging concerns (`cursor`/`limit`/`sort`), which `AdminSkillDiscoveryGroupsQuerySchema`
  // does not accept at all.
  const sharedFilters: SkillDiscoveryGroupsFilters = {
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
  };

  const [primaryRes, metricsRes] = await Promise.allSettled([
    view === "flat"
      ? listSkillDiscovery({ ...sharedFilters, sort, cursor, limit: FLAT_LIMIT })
      : listSkillDiscoveryGroups(sharedFilters),
    getSkillDiscoveryMetrics(),
  ]);

  const primaryError =
    primaryRes.status === "rejected" && isAdminRequestError(primaryRes.reason)
      ? primaryRes.reason
      : null;
  const badRequest = primaryError !== null && primaryError.status === 400;
  // The GROUPS route's 400 names the exact count and how to narrow it — rendered verbatim
  // rather than folded into the generic filter-refusal copy below, per the API's own contract:
  // "render the message; it tells the reviewer what to narrow".
  const badRequestMessage = primaryError?.status === 400 ? primaryError.message : null;

  const page = view === "flat" && primaryRes.status === "fulfilled"
    ? (primaryRes.value as SkillDiscoveryPage)
    : null;
  const groupsResult = view === "grouped" && primaryRes.status === "fulfilled"
    ? (primaryRes.value as SkillDiscoveryGroups)
    : null;
  const metrics = metricsRes.status === "fulfilled" ? metricsRes.value : null;

  const primaryFailed = primaryRes.status === "rejected";
  const itemCount = view === "flat" ? (page?.items.length ?? 0) : (groupsResult?.groups.length ?? 0);

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
    groupSort: groupSort === "candidates" ? undefined : groupSort,
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
            AI-surfaced claims that the canonical skill taxonomy may be missing something. Each
            row is a claim, never a skill — an approval only records a decision; the corpus write
            stays in the offline, gated chain.
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
                ? "Real review batches over the full filtered population, exhaustive and server-computed — a lens, not a merge. Every member still gets its own decision."
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
            <Link aria-current="true" className="btn btn--sm btn--primary" href={tierTabHref("derived")}>
              Derived
            </Link>
          ) : (
            <Link className="btn btn--sm btn--ghost" href={derivedViewAnywayHref}>
              Derived (sequenced behind Direct) — view anyway
            </Link>
          )}
        </div>
        <p className="field__help">{DERIVED_TIER_SEQUENCING_REASON}</p>

        {/* ── group sort — an explicit, labelled client re-order, never a silent one ──────
            The server's real order (`candidates` descending) is the default; `undecided`-first
            is offered because the issue's own rationale argued for it, but that argument is not
            settled — see the page header. Only meaningful in the grouped view. */}
        {view === "grouped" && (
          <div className="filters--inline" role="group" aria-label="Batch order">
            <Link
              aria-current={groupSort === "candidates" ? "true" : undefined}
              className={`btn btn--sm ${groupSort === "candidates" ? "btn--primary" : "btn--ghost"}`}
              href={listHref({ groupSort: undefined })}
            >
              Biggest batch first (server order)
            </Link>
            <Link
              aria-current={groupSort === "undecided" ? "true" : undefined}
              className={`btn btn--sm ${groupSort === "undecided" ? "btn--primary" : "btn--ghost"}`}
              href={listHref({ groupSort: "undecided" })}
            >
              Most work remaining first
            </Link>
          </div>
        )}

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
              {view === "grouped" && badRequestMessage
                ? badRequestMessage
                : "Nothing was fetched. One of the filters, as it stands in the address bar, is not a value this queue accepts — a hand-edited status, tier, band or run id."}
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/skills/discovery">
                Reset filters
              </Link>
            </div>
          </div>
        ) : primaryFailed ? (
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
        ) : itemCount === 0 ? (
          <EmptyQueueState
            filtered={filtered}
            noRunEver={metrics !== null && metrics.total === 0}
            statusScope={statusScope}
          />
        ) : view === "grouped" && groupsResult ? (
          <GroupedQueue groups={groupsResult.groups} sort={groupSort} />
        ) : view === "flat" && page ? (
          <FlatQueue items={page.items} />
        ) : null}

        {view === "flat" && page && (
          <Pager
            basePath="/skills/discovery"
            params={carry}
            nextCursor={page.nextCursor}
            note="Server-paged with a keyset cursor — this view never loads the whole queue at once."
          />
        )}

        {view === "grouped" && groupsResult && (
          <>
            <p className="field__help">
              {formatCount(groupsResult.total_groups)} batches over {formatCount(groupsResult.total_candidates)}{" "}
              candidates, {formatCount(groupsResult.total_undecided)} still undecided — exhaustive for
              these filters, no cursor, nothing more is hiding off-screen.
            </p>
            {/*
             * `grouping_basis`, RENDERED rather than merely parsed (#1280, correction 3). The
             * response has always carried it and the mirror has always typed it; nothing showed
             * it, which left the console holding a disclaimer the reviewer never sees on a screen
             * that otherwise looks like a list of records.
             */}
            <p className="field__help">{basisMarkerLabel(groupsResult.grouping_basis)}</p>
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// constants + pure helpers
// ---------------------------------------------------------------------------

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
       * `tier_basis`, rendered beside the three tier counts it qualifies (#1280, correction 3).
       * The tiles look like counts of a stored column and are not — the tier is recomputed on
       * every read from the phrase class and whether a strong match exists.
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
          This is an operations state, not an empty result: the `skill_candidate` table itself
          has nothing in it. A discovery run is an offline `packages/db` CLI step, outside this
          console — see `docs/operations/skill-discovery-activation-plan.md` for how to run one.
        </p>
      </div>
    );
  }
  if (!filtered && statusScope === "awaiting") {
    return (
      <div className="state">
        <h3 className="state__title">Nothing is awaiting a decision right now</h3>
        <p className="state__body">
          Every candidate has either been decided or is on hold. Check the Held or Decided
          scopes above to see them.
        </p>
      </div>
    );
  }
  return (
    <div className="state">
      <h3 className="state__title">No candidates match these filters</h3>
      <p className="state__body">
        Nothing in the queue satisfies this combination of status, tier and filters. Widen or
        clear a filter above to see more.
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
// grouped view — real review batches from GET /admin/skill-discovery/groups (#1280)
// ---------------------------------------------------------------------------

/**
 * Re-orders the ALREADY-FETCHED groups for display. The grouping itself — which candidates
 * belong together, at all — stays entirely server-side; this only changes which batch a
 * reviewer sees first. `"candidates"` returns the array unchanged (the server's own order,
 * `candidates` descending tie-broken by key); `"undecided"` is a stable client sort by
 * `undecided` descending, tie-broken by `candidates` then `key` so the order is deterministic.
 *
 * ── THE FINAL TIE-BREAK IS A CODE-UNIT COMPARISON, NOT `localeCompare` ─────────────────
 * It was `a.key.localeCompare(b.key)`, which is the exact comparator `packages/db` REMOVED from
 * `groupFacts` in this same contract correction, for two failures its own docblock measures
 * rather than assumes:
 *
 *   "direct|craft|weld".localeCompare("direct|craft|बढ़ई")   ->  -1 under en-US/en-IN/de/sv
 *                                                           ->  +1 under hi/hi-IN
 *   "direct|Craft|co\u200Bop".localeCompare("direct|Craft|coop")  ->  0   (escaped: it is invisible)
 *
 * The first makes the order depend on the HOST's ICU default locale — and Devanagari anchors are
 * a supported case with a backend test of their own, so this is a live input, not a hypothetical.
 * The second is worse: a 0 for two DISTINCT keys means the comparator abstained, and since
 * `Array.prototype.sort` is stable the order then falls back to arrival order — which here is the
 * server's `candidates` order, so two batches would silently swap places depending on a character
 * nobody can see.
 *
 * Either way the docblock's promise above ("so the order is deterministic") was false on exactly
 * the inputs the server had just been fixed for. `<`/`>` on strings is UTF-16 code-unit order:
 * total, host-independent, and identical to the comparator the server now uses — so the toggled
 * order is a re-ranking of the server's list rather than a second, differently-behaved one.
 */
function sortedGroups(
  groups: readonly SkillReviewGroup[],
  sort: "candidates" | "undecided",
): readonly SkillReviewGroup[] {
  if (sort === "candidates") return groups;
  return [...groups].sort(
    (a, b) =>
      b.undecided - a.undecided ||
      b.candidates - a.candidates ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

function GroupedQueue({
  groups,
  sort,
}: {
  groups: readonly SkillReviewGroup[];
  sort: "candidates" | "undecided";
}) {
  const ordered = sortedGroups(groups, sort);
  return (
    <ul className="reviewgroups">
      {ordered.map((g) => (
        <li key={g.key} className="panel">
          <details className="reviewgroup">
            <summary>
              <strong>{g.label}</strong> · {formatCount(g.candidates)}{" "}
              {g.candidates === 1 ? "candidate" : "candidates"} · {formatCount(g.undecided)} undecided
              {g.trade_family && <> · {g.trade_family}</>}
            </summary>
            <p className="field__help">
              {formatCount(g.source_rows)} source row{g.source_rows === 1 ? "" : "s"} across{" "}
              {formatCount(g.source_domains)} job domain{g.source_domains === 1 ? "" : "s"}.{" "}
              {g.unanimous_action
                ? `Every member suggests the same action: ${
                    SKILL_CANDIDATE_ACTION_LABELS[g.unanimous_action as keyof typeof SKILL_CANDIDATE_ACTION_LABELS] ??
                    g.unanimous_action
                  }.`
                : "Members do not all suggest the same action."}
            </p>
            {/* A GROUP IS A LENS, NOT A MERGE — no group-level decide control exists, and never
                will: every member gets its own decision, its own reason, its own audit row. */}
            <ul className="chips">
              {g.candidate_ids.map((id) => (
                <li className="chip" key={id}>
                  <Link className="mono link" href={`/skills/discovery/${id}`} title={id}>
                    {shortId(id)}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
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
