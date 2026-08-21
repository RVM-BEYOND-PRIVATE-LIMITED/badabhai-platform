import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listPayers } from "../../../lib/entities";
import { identityPosture } from "../../../lib/identity";
import { PayerList } from "../../../components/payer-list";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { Pager } from "../../../components/pager";
import { PayerFilterBar } from "../../../components/payer-filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agencies" };

/**
 * Agencies — payer accounts with `role = agent`.
 *
 * The same table and the same projection as Companies; the split is `role`, decided by the
 * server. Agency-specific surfaces (KYC state, the payout ledger) are NOT here: that loop
 * is launch-gated OFF behind `AGENCY_PAYOUTS_ENABLED`, and rendering a KYC panel that can
 * never be true would misrepresent what the platform currently does.
 *
 * The organisation name shown since the 2026-08-18 ruling is `payers.org_name_enc` — the name
 * the agency registered under. It is emphatically NOT `agency_kyc.account_holder_name_enc`,
 * which sits behind the same ADR-0022 gate as the payout loop above and is not this ruling's to
 * disclose.
 */
export default async function AgenciesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const status = one(sp.status);
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listPayers>> | null = null;
  let failed = false;
  try {
    page = await listPayers({ role: "agent", status, cursor });
  } catch {
    failed = true;
  }

  const posture = identityPosture(
    page?.items ?? [],
    "org_name",
    can(session.capabilities, "read_identity"),
  );

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Agencies</h1>
          <p className="page__sub">
            {posture === "faceless"
              ? "Supply-side partner accounts, identified by id — your role does not include name access."
              : "Supply-side partner accounts, named by the organisation they registered as — self-declared at signup, not a verified legal name."}{" "}
            Email, phone and KYC details stay encrypted at rest and are served to no one.
          </p>
        </div>
      </header>

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see them, so this is a limit on the read: this admin account has spent
          its hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="panel" aria-labelledby="af-heading">
        <h2 className="sr-only" id="af-heading">
          Filter agencies
        </h2>
        <PayerFilterBar basePath="/agencies" status={status ?? ""} />
      </section>

      <section className="panel" aria-labelledby="ar-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="ar-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? "That filter was rejected."
                : `${page?.items.length ?? 0} agenc${page?.items.length === 1 ? "y" : "ies"} on this page.`}
            </p>
          </div>
          {status && (
            <Link className="btn btn--ghost" href="/agencies">
              Clear filter
            </Link>
          )}
        </div>

        {failed ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected that filter</h3>
            <p className="state__body">
              That is not an account status this portal recognises, so nothing was fetched.
              Pick a status from the list above, or clear the filter and start again.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/agencies">
                Clear filter
              </Link>
            </div>
          </div>
        ) : (
          <PayerList
            payers={page?.items ?? []}
            basePath="/agencies"
            posture={posture}
            emptyMessage={
              status ? "No agencies match this filter." : "No agency accounts registered yet."
            }
          />
        )}

        <Pager basePath="/agencies" params={{ status }} nextCursor={page?.nextCursor} />
      </section>
    </div>
  );
}
