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
export const metadata = { title: "Companies" };

/**
 * Companies — payer accounts with `role = employer`.
 *
 * Companies and Agencies are the same table split by role, which is why they share a list
 * component and a detail view. They are separate NAV sections because they are separate
 * operational populations: an employer hires, an agency supplies, and the questions an
 * operator asks about each are different.
 *
 * The organisation name is served behind `read_identity` since the 2026-08-18 ruling; the
 * posture is computed here and handed to the shared list, so both sections make the same
 * decision from the same rule rather than each deciding for itself.
 */
export default async function CompaniesPage({
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
    page = await listPayers({ role: "employer", status, cursor });
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
          <h1 className="page__title">Companies</h1>
          <p className="page__sub">
            {posture === "faceless"
              ? "Employer accounts, identified by id — your role does not include name access, so find an account through its job postings."
              : "Employer accounts, named by the organisation they registered as — self-declared at signup, not a verified legal name."}{" "}
            Email and phone stay encrypted at rest and are served to no one.
          </p>
        </div>
      </header>

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see them, so this is a limit on the read: this admin account has spent
          its hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="panel" aria-labelledby="cf-heading">
        <h2 className="sr-only" id="cf-heading">
          Filter companies
        </h2>
        <PayerFilterBar basePath="/companies" status={status ?? ""} />
      </section>

      <section className="panel" aria-labelledby="cr-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="cr-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? "That filter was rejected."
                : `${page?.items.length ?? 0} compan${page?.items.length === 1 ? "y" : "ies"} on this page.`}
            </p>
          </div>
          {status && (
            <Link className="btn btn--ghost" href="/companies">
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
              <Link className="btn btn--ghost" href="/companies">
                Clear filter
              </Link>
            </div>
          </div>
        ) : (
          <PayerList
            payers={page?.items ?? []}
            basePath="/companies"
            posture={posture}
            emptyMessage={
              status ? "No companies match this filter." : "No company accounts registered yet."
            }
          />
        )}

        <Pager basePath="/companies" params={{ status }} nextCursor={page?.nextCursor} />
      </section>
    </div>
  );
}
