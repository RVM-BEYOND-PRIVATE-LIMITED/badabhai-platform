import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import { listAdminCallbackRequests } from "../../../../lib/managed-hiring";
import { PageHeader } from "../../../../components/page-header";
import { formatTimestamp, shortId } from "../../../../lib/format";
import { customerHref } from "../../../../lib/customer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Managed Hiring callbacks" };

/** #2751 — jobs above the largest tier that asked for a call. */
export default async function ManagedCallbacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("work_managed_hiring");
  const sp = await searchParams;
  const cursor = Array.isArray(sp.cursor) ? sp.cursor[0] : sp.cursor;
  let page;
  try {
    page = await listAdminCallbackRequests(cursor);
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            back={{ href: "/managed-hiring", label: "Managed Hiring" }}
            title="Callback requests"
            description="Jobs above the largest tier that asked for a call."
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Managed Hiring is not switched on</h2>
            </div>
          </section>
        </div>
      );
    }
    throw err;
  }

  return (
    <div className="page page--reading">
      <PageHeader
        back={{ href: "/managed-hiring", label: "Managed Hiring" }}
        title="Callback requests"
        description="Jobs above the largest tier that asked for a call."
      />
      {page.requests.length === 0 ? (
        <section className="panel">
          <div className="state">
            <h2 className="state__title">No callback requests</h2>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Callback requests</caption>
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Job</th>
                  <th scope="col">Vacancies</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {page.requests.map((r) => (
                  <tr key={r.request_id}>
                    <td>
                      <Link href={customerHref(r.payer_id)}>{shortId(r.payer_id)}</Link>
                    </td>
                    <td>
                      <Link href={`/jobs/${r.job_posting_id}`}>{shortId(r.job_posting_id)}</Link>
                    </td>
                    <td>{r.vacancy_band}</td>
                    <td>{r.reason}</td>
                    <td>{formatTimestamp(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.next_cursor ? (
            <div className="state__actions">
              <Link className="btn btn--ghost" href={`/managed-hiring/callbacks?cursor=${encodeURIComponent(page.next_cursor)}`}>
                Next page
              </Link>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
