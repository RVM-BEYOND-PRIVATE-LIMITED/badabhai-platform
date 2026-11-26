import Link from "next/link";
import { TRADE_LEVEL_LABELS, postingTradeFor } from "@badabhai/taxonomy";
import { requireCapability } from "../../../../../lib/auth";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import { listNarrowQueue } from "../../../../../lib/campus-narrow";
import {
  NARROWABLE_ROLE_KINDS,
  type NarrowLevels,
  type NarrowableRoleKind,
} from "../../../../../lib/campus-narrow-view";
import { PageHeader } from "../../../../../components/page-header";
import { CampusNarrowTable } from "./campus-narrow-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campus narrow queue" };

/** Build the six trades' ladder rungs from the catalogue the posting form uses. */
function levelOptions(): NarrowLevels {
  const out = {} as Record<NarrowableRoleKind, { value: string; label: string }[]>;
  for (const kind of NARROWABLE_ROLE_KINDS) {
    const ladder = postingTradeFor(kind)?.ladder ?? [];
    out[kind] = ladder.map((rung) => ({
      value: rung.rung,
      label: TRADE_LEVEL_LABELS[rung.rung] ?? rung.rung,
    }));
  }
  return out as NarrowLevels;
}

/**
 * #3033 / #3050 — old Campus jobs whose role was "Machine Operator" or "CNC Operator". They
 * arrived on the general CNC skill and wait for an admin to narrow each to one of six machine
 * trades from its description.
 *
 * Gated on `manage_postings`, like the API. The default read is the oldest first; a failed read
 * is an honest error state, never an empty queue that says "all clear".
 */
export default async function CampusNarrowQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("manage_postings");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listNarrowQueue>>;
  try {
    page = await listNarrowQueue(cursor);
  } catch (err) {
    if (!isAdminRequestError(err)) throw err;
    return (
      <div className="page page--reading">
        <PageHeader
          back={{ href: "/jobs/campus", label: "Campus jobs" }}
          title="Campus narrow queue"
          description="Old Campus jobs waiting for an admin to choose their machine trade."
        />
        <section className="panel">
          <div className="state state--error">
            <h2 className="state__title">The queue is unavailable</h2>
            <p className="state__body">
              The queue did not load. That is a fault on our side, not an empty queue.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/jobs/campus/narrow">
                Retry
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const nextHref = page.next_cursor
    ? `/jobs/campus/narrow?cursor=${encodeURIComponent(page.next_cursor)}`
    : null;

  return (
    <div className="page page--reading">
      <PageHeader
        back={{ href: "/jobs/campus", label: "Campus jobs" }}
        title="Campus narrow queue"
        description="Old Campus jobs waiting for an admin to choose their machine trade."
        info={
          <p>
            Narrowing runs the same trade rules a company edit runs. A trade that is not switched
            on yet is refused, and the job stays in the queue.
          </p>
        }
      />

      {page.postings.length === 0 ? (
        <section className="panel">
          <div className="state">
            <h2 className="state__title">Nothing is waiting</h2>
            <p className="state__body">
              Every old Campus job on the general CNC skill has a machine trade.
            </p>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Waiting for a trade</h2>
            <p className="panel__sub">
              {page.postings.length} job{page.postings.length === 1 ? "" : "s"} on this page.
            </p>
          </div>
          <CampusNarrowTable postings={page.postings} levels={levelOptions()} />
          {nextHref ? (
            <div className="state__actions">
              <Link className="btn btn--ghost" href={nextHref}>
                Next page
              </Link>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
