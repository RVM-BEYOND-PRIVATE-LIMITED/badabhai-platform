import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { isAdminRequestError } from "../../../lib/admin-http";
import { getWaivers, type Waiver } from "../../../lib/waivers";
import { PageHeader } from "../../../components/page-header";
import { StatusPill } from "../../../components/status-pill";
import { formatRelative, shortId } from "../../../lib/format";
import { customerHref } from "../../../lib/customer";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Waivers" };

/**
 * #2750 part C — RVM placement-team waivers of the contact cost.
 *
 * The list is read server-side. A 404 means the credit-rules switch is off (no waiver can
 * exist yet); a 503 means its tables are missing. Neither is a broken screen.
 */
export default async function WaiversPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("manage_waivers");
  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  const companyId = one(sp.company_id);
  const includeCleared = one(sp.include_cleared) === "true";
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof getWaivers>>;
  try {
    page = await getWaivers({
      ...(companyId ? { companyId } : {}),
      includeCleared,
      ...(cursor ? { cursor } : {}),
      limit: 50,
    });
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader title="Waivers" description="RVM applicants the placement team has made free to open." />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Waivers are not switched on yet</h2>
              <p className="state__body">
                They arrive with the credit rules. Until that switch is on, no waiver can be set.
              </p>
            </div>
          </section>
        </div>
      );
    }
    if (isAdminRequestError(err) && err.status === 503) {
      return (
        <div className="page page--reading">
          <PageHeader title="Waivers" description="RVM applicants the placement team has made free to open." />
          <section className="panel">
            <div className="state state--error">
              <h2 className="state__title">Waivers are not available yet</h2>
              <p className="state__body">Their tables are not ready. Retry after the migration lands.</p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/waivers">
                  <Icon name={ACTION_ICON.retry} /> Retry
                </Link>
              </div>
            </div>
          </section>
        </div>
      );
    }
    throw err;
  }

  const href = (next: { cleared?: boolean; cursor?: string | null }) => {
    const qs = new URLSearchParams();
    if (companyId) qs.set("company_id", companyId);
    if (next.cleared ?? includeCleared) qs.set("include_cleared", "true");
    if (next.cursor) qs.set("cursor", next.cursor);
    const query = qs.toString();
    return `/waivers${query ? `?${query}` : ""}`;
  };

  return (
    <div className="page">
      <PageHeader
        title="Waivers"
        description="RVM applicants the placement team has made free to open, for one company or one job."
        filters={
          <form className="filters--inline" action="/waivers" method="get">
            <label className="field">
              <span className="field__label">Company id</span>
              <input className="input" name="company_id" defaultValue={companyId ?? ""} placeholder="uuid" />
            </label>
            {includeCleared ? <input type="hidden" name="include_cleared" value="true" /> : null}
            <button className="btn btn--ghost" type="submit">Filter</button>
          </form>
        }
        secondaryActions={
          <Link className="btn btn--ghost" href={href({ cleared: !includeCleared })}>
            {includeCleared ? "Hide cleared" : "Show cleared"}
          </Link>
        }
      />

      {page.waivers.length === 0 ? (
        <section className="panel">
          <div className="state">
            <h2 className="state__title">No waivers {includeCleared ? "on record" : "in force"}</h2>
            <p className="state__body">
              Set one from a company or a posting: “RVM applicants free for this company/job”.
            </p>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">RVM contact-cost waivers</caption>
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Company / job</th>
                  <th scope="col">Set by</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Source</th>
                  <th scope="col">Opens</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {page.waivers.map((waiver) => (
                  <WaiverRow key={waiver.waiver_id} waiver={waiver} />
                ))}
              </tbody>
            </table>
          </div>
          {page.next_cursor ? (
            <div className="state__actions">
              <Link className="btn btn--ghost" href={href({ cursor: page.next_cursor })}>
                Next page
              </Link>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

function WaiverRow({ waiver }: { waiver: Waiver }) {
  return (
    <tr>
      <td>{waiver.scope === "company" ? "Company" : "Job"}</td>
      <td>
        <Link className="table__link" href={customerHref(waiver.company_id)}>
          {shortId(waiver.company_id)}
        </Link>
        {waiver.posting_id ? (
          <>
            {" · "}
            <Link className="table__link" href={`/jobs/${waiver.posting_id}`}>
              {shortId(waiver.posting_id)}
            </Link>
          </>
        ) : null}
      </td>
      <td>
        {waiver.set_by_label ?? waiver.set_by_ref ?? "—"}
        <span className="table__meta">{formatRelative(waiver.set_at)}</span>
      </td>
      <td>{waiver.reason}</td>
      <td>{waiver.source === "campus" ? "Campus" : "Admin"}</td>
      <td>{waiver.waived_opens}</td>
      <td>
        <StatusPill
          value={waiver.active ? "in force" : "cleared"}
          tone={waiver.active ? "ok" : "muted"}
        />
        {!waiver.active && waiver.clear_reason ? (
          <span className="table__meta">{waiver.clear_reason}</span>
        ) : null}
      </td>
    </tr>
  );
}
