import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import {
  getSkillDiscoveryMetrics,
  listSkillDiscovery,
  type AdminSkillDiscoverySort,
  type SkillDiscoveryFilters,
  type SkillDiscoveryListItem,
  type SkillDiscoveryMetrics,
} from "../../../../lib/skill-discovery";
import {
  ADMIN_SKILL_REVIEW_TIER_LABELS,
  DERIVED_TIER_SEQUENCING_REASON,
  SKILL_CANDIDATE_ACTION_LABELS,
  SKILL_CANDIDATE_STATUS_LABELS,
  SKILL_CANDIDATE_STATUS_TONE,
  SKILL_CANDIDATE_TERMINAL_STATUSES,
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
 * ── GROUPED IS THE DEFAULT, AND WHAT "GROUP" HONESTLY MEANS HERE ────────────────────────
 * The owner's brief describes a group as candidates sharing a trade family AND an anchor term
 * (`packages/db/src/skill-discovery-groups.ts`'s `anchorToken`) — but `anchorToken` needs a
 * GLOBAL count across the whole 6,673-row table to pick the highest-weight token, and none of
 * the four API routes exposes it (list rows carry `trade_family`, not `evidence_tokens`, and
 * there is no group-listing endpoint). Reimplementing that algorithm client-side, over a
 * single page, would silently drift from the real one and is exactly the "second copy of a
 * server authority" CLAUDE.md invariant #9 forbids — so this view groups by `trade_family`
 * alone, which `anchorToken`'s own module names as the CORRECT FALLBACK for a candidate with
 * no usable anchor token. It groups WITHIN one server page (never the whole table), which is
 * what keeps AC#2 honest: the page never claims a count this contract cannot support, and a
 * card's copy says explicitly that it is scoped to the page, not the corpus. Handed back to
 * Backend as a contract-gap finding — see the PR description.
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

  const [pageRes, metricsRes] = await Promise.allSettled([
    listSkillDiscovery(query),
    getSkillDiscoveryMetrics(),
  ]);

  const badRequest =
    pageRes.status === "rejected" &&
    isAdminRequestError(pageRes.reason) &&
    pageRes.reason.status === 400;
  const page = pageRes.status === "fulfilled" ? pageRes.value : null;
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
                ? "Grouped by trade family, within this page of the keyset-ordered queue — a lens, not a merge. Every member still gets its own decision."
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
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/skills/discovery">
                Reset filters
              </Link>
            </div>
          </div>
        ) : page === null ? (
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
        ) : page.items.length === 0 ? (
          <EmptyQueueState
            filtered={filtered}
            noRunEver={metrics !== null && metrics.total === 0}
            statusScope={statusScope}
          />
        ) : view === "grouped" ? (
          <GroupedQueue items={page.items} />
        ) : (
          <FlatQueue items={page.items} />
        )}

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
// grouped view — a lens over ONE page, grouped by trade_family (see page header)
// ---------------------------------------------------------------------------

function GroupedQueue({ items }: { items: SkillDiscoveryListItem[] }) {
  const groups = new Map<string, SkillDiscoveryListItem[]>();
  for (const item of items) {
    const key = item.trade_family ?? "Unspecified trade";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <ul className="reviewgroups">
      {sorted.map(([tradeFamily, members]) => (
        <li key={tradeFamily} className="panel">
          <details className="reviewgroup">
            <summary>
              <strong>{tradeFamily}</strong> · {members.length}{" "}
              {members.length === 1 ? "candidate" : "candidates"} on this page
            </summary>
            <div className="tablewrap">
              <table className="table">
                <caption className="sr-only">{tradeFamily} candidates</caption>
                <thead>
                  <tr>
                    <th scope="col">Phrase</th>
                    <th scope="col">Proposed</th>
                    <th scope="col">Suggested action</th>
                    <th scope="col">Status</th>
                    <th scope="col">Tier</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <QueueRow key={m.id} item={m} />
                  ))}
                </tbody>
              </table>
            </div>
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

function QueueRow({ item }: { item: SkillDiscoveryListItem }) {
  return (
    <tr>
      <td>
        <Link className="link" href={`/skills/discovery/${item.id}`}>
          {item.normalized_phrase}
        </Link>
      </td>
      <td className="table__meta">{item.proposed_skill_name ?? "—"}</td>
      <td className="table__meta">{SKILL_CANDIDATE_ACTION_LABELS[item.proposed_action]}</td>
      <td>
        <StatusPill
          value={item.status}
          label={SKILL_CANDIDATE_STATUS_LABELS[item.status]}
          tone={SKILL_CANDIDATE_STATUS_TONE[item.status]}
        />
      </td>
      <td className="table__meta">{ADMIN_SKILL_REVIEW_TIER_LABELS[item.review_tier]}</td>
    </tr>
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
