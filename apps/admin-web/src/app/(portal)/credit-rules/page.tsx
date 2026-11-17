import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireCapability } from "../../../lib/auth";
import { isAdminRequestError } from "../../../lib/admin-http";
import { getCreditRules } from "../../../lib/credit-rules";
import type { CreditRulesSnapshot } from "../../../lib/credit-rules-model";
import { PageHeader } from "../../../components/page-header";
import { CreditRulesForm } from "./credit-rules-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Credit rules" };

/**
 * Credit rules (#2878) — the brief's money settings, editable without a deploy.
 *
 * Only a session holding `manage_credit_rules` may open this page (super_admin on the API).
 * The read is server-side and fresh: the revision shown is the one a save will be checked
 * against. A 404 means the `CREDIT_RULES_ROLLOUT` switch is off — that is "not switched on
 * yet", not an error — and a 503 means the switch is on before its migration, so it offers
 * a retry instead of pretending the screen is broken.
 */
export default async function CreditRulesPage() {
  await requireCapability("manage_credit_rules");

  let snapshot: CreditRulesSnapshot;
  try {
    snapshot = await getCreditRules();
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            title="Credit rules"
            description="The numbers every company's contact opens, welcome credits and refunds use."
          />
          <section className="panel" aria-labelledby="credit-rules-off">
            <div className="state">
              <h2 className="state__title" id="credit-rules-off">
                Credit rules are not switched on yet
              </h2>
              <p className="state__body">
                Until the credit-rules switch is turned on for this environment, the brief's
                starting values apply and there is nothing to edit here.
              </p>
            </div>
          </section>
        </div>
      );
    }

    if (isAdminRequestError(err) && err.status === 503) {
      return (
        <div className="page page--reading">
          <PageHeader
            title="Credit rules"
            description="The numbers every company's contact opens, welcome credits and refunds use."
          />
          <section className="panel" aria-labelledby="credit-rules-unavailable">
            <div className="state state--error">
              <h2 className="state__title" id="credit-rules-unavailable">
                Credit rules are not available yet
              </h2>
              <p className="state__body">
                The credit-rules switch is on, but its table is not ready. This clears once the
                migration has been applied; retry after it lands.
              </p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/credit-rules">
                  <Icon name={ACTION_ICON.retry} />
                  Retry
                </Link>
              </div>
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
        title="Credit rules"
        description="The numbers every company's contact opens, welcome credits and refunds use."
      />
      <section className="panel" aria-labelledby="credit-rules-editor">
        <div className="panel__head">
          <h2 className="panel__title" id="credit-rules-editor">
            Credit rules
          </h2>
          <p className="panel__sub">
            Each save writes a new revision and an audit record. Only a written reason can
            change the rules.
          </p>
        </div>
        <CreditRulesForm initial={snapshot} />
      </section>
    </div>
  );
}
