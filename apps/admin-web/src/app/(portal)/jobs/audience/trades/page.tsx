import { jobRoleLabel } from "@badabhai/types";
import { requireCapability } from "../../../../../lib/auth";
import { can } from "../../../../../lib/auth/capabilities";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import { getCampusTrades } from "../../../../../lib/job-audience";
import { PageHeader } from "../../../../../components/page-header";
import { TradesForm } from "./trades-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trades RVM trains" };

const DESCRIPTION =
  "Only jobs in these trades can be sent to Campus. A job in any other trade, a painter's for example, can only show on BadaBhai.";

/**
 * #2957 — the trades RVM trains. Every role may read the list; only a super admin
 * (`manage_campus_trades`) may change it. A 404 means `ADMIN_JOB_AUDIENCE_ENABLED` is off.
 */
export default async function CampusTradesPage() {
  const session = await requireCapability("read_entities");

  let trades: Awaited<ReturnType<typeof getCampusTrades>>;
  try {
    trades = await getCampusTrades();
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            title="Trades RVM trains"
            description={DESCRIPTION}
            back={{ href: "/jobs/audience", label: "Where jobs show" }}
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Not switched on yet</h2>
              <p className="state__body">
                The owner turns this on with ADMIN_JOB_AUDIENCE_ENABLED.
              </p>
            </div>
          </section>
        </div>
      );
    }
    throw err;
  }

  const mayEdit = can(session.capabilities, "manage_campus_trades");
  const taught = trades.filter((t) => t.taught_at_campus);

  return (
    <div className="page page--reading">
      <PageHeader
        title="Trades RVM trains"
        description={DESCRIPTION}
        back={{ href: "/jobs/audience", label: "Where jobs show" }}
      />
      {mayEdit ? (
        <TradesForm trades={trades.map((t) => ({ key: t.trade_key, taught: t.taught_at_campus }))} />
      ) : (
        <section className="panel">
          <div className="panel__body">
            {taught.length === 0 ? (
              <p className="state__body">
                No trade is on the list yet, so every company job can only show on BadaBhai. A
                super admin enters the list.
              </p>
            ) : (
              <ul className="chips">
                {taught.map((t) => (
                  <li className="chip" key={t.trade_key}>
                    {jobRoleLabel(t.trade_key) ?? t.trade_key}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
