import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { listWorkers } from "../../../lib/entities";
import { formatRelative, formatTimestamp, shortId } from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";
import { Pager } from "../../../components/pager";
import { WorkerFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workers" };

/**
 * Workers — the faceless supply-side roster.
 *
 * There is NO name, phone or photo here, and there is no search-by-phone box, because the
 * server does not serve any of it. That is the design, not a gap: a bulk-readable roster
 * of contactable workers is the single most sensitive thing this platform could expose,
 * and the reveal path is deliberately a separate, reason-gated, audited, single-subject
 * capability (`reveal_pii`) rather than a column on a list.
 *
 * So this screen answers operational questions — how many, in what state, how far through
 * profiling, who is pending deletion — and hands off to the event timeline for the rest.
 */
export default async function WorkersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const status = one(sp.status);
  const pendingDeletion = one(sp.pendingDeletion) === "true";
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listWorkers>> | null = null;
  let failed = false;
  try {
    page = await listWorkers({ status, pendingDeletion: pendingDeletion || undefined, cursor });
  } catch {
    // A rejected filter is a user error, not a broken portal — render it inline rather
    // than tripping the error boundary and losing the whole screen.
    failed = true;
  }

  const filtered = Boolean(status) || pendingDeletion;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Workers</h1>
          <p className="page__sub">
            Faceless roster. Contact details are never listed — revealing one worker&apos;s
            contact is a separate, reason-gated action.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="wf-heading">
        <h2 className="sr-only" id="wf-heading">
          Filter workers
        </h2>
        <WorkerFilterBar status={status ?? ""} pendingDeletion={pendingDeletion} />
      </section>

      <section className="panel" aria-labelledby="wr-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="wr-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? "That filter combination was rejected."
                : `${page?.items.length ?? 0} worker${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtered && (
            <Link className="btn btn--ghost" href="/workers">
              Clear filters
            </Link>
          )}
        </div>

        {failed ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected these filters</h3>
            <p className="state__body">
              One of the values is not a worker status this portal recognises, so nothing was
              fetched. Check the values in the filter bar above, or clear them and start
              again.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/workers">
                Clear filters
              </Link>
            </div>
          </div>
        ) : page && page.items.length > 0 ? (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Workers, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Worker</th>
                  <th scope="col">Status</th>
                  <th scope="col">Language</th>
                  <th scope="col">Resume prefs</th>
                  <th scope="col">Deletion</th>
                  <th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <Link className="link mono" href={`/workers/${w.id}`} title={w.id}>
                        {shortId(w.id)}
                      </Link>
                    </td>
                    <td>
                      <StatusPill value={w.status} />
                    </td>
                    <td>{w.preferred_language ?? "—"}</td>
                    <td className="table__meta">
                      {w.has_photo ? "photo" : "no photo"}
                      {w.resume_night_shift_ready ? " · night shift" : ""}
                    </td>
                    <td>
                      {w.deletion_scheduled_at ? (
                        // A scheduled hard delete is the highest-urgency thing on this row:
                        // it is reversible, but only until it runs.
                        <span
                          className="pill pill--bad"
                          title={`Hard delete due ${formatTimestamp(w.deletion_scheduled_at)}`}
                        >
                          due {formatRelative(w.deletion_scheduled_at)}
                        </span>
                      ) : (
                        <span className="table__meta">—</span>
                      )}
                    </td>
                    <td>
                      <time dateTime={w.created_at} title={formatTimestamp(w.created_at)}>
                        {formatRelative(w.created_at)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No workers match these filters</h3>
            <p className="state__body">
              Nobody on the roster is in this state right now. Widen the filter, or clear it
              to see every registered worker.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/workers">
                Clear filters
              </Link>
            </div>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No workers registered yet</h3>
            <p className="state__body">
              Workers appear here as soon as they finish signing up in the app. Until one
              does, the event timeline is where you confirm the sign-up path is running at
              all.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/events">
                Open the event timeline
              </Link>
            </div>
          </div>
        )}

        <Pager
          basePath="/workers"
          params={{ status, pendingDeletion: pendingDeletion ? "true" : undefined }}
          nextCursor={page?.nextCursor}
        />
      </section>
    </div>
  );
}
