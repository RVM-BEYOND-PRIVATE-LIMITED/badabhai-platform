import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { getOnboardingFunnel, describeFunnelStop, describeSplitCell } from "../../../lib/funnel";
import { PageHeader } from "../../../components/page-header";
import { Stat } from "../../../components/stat";
import { SegmentedControl } from "../../../components/segmented-control";
import { OnboardingFunnel } from "../../../components/onboarding-funnel";
import { CaveatList } from "../../../components/caveat-list";
import { formatCount } from "../../../lib/format";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Onboarding funnel" };

/**
 * All-workers onboarding funnel (A10, #2580) — the 7 journey steps counted across the
 * whole base (#2568), split by trade / city / language / app version.
 *
 * READ-ONLY on `read_entities` (the API's own guard). Every block is scoped to the same
 * cohort, echoed back on the response — the UI renders the echoed bound, never the
 * address bar's. Split cells below the k-anon floor report nothing (suppressed), so a
 * rare trade/city can never single a worker out.
 */
export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");
  void can(session.capabilities, "read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const testAccounts = one(sp.testAccounts) ?? "exclude";

  let funnel: Awaited<ReturnType<typeof getOnboardingFunnel>> | null = null;
  let failed = false;
  try {
    funnel = await getOnboardingFunnel(testAccounts === "exclude" ? undefined : { testAccounts });
  } catch {
    failed = true;
  }

  const hrefFor = (ta: string) => (ta === "exclude" ? "/funnel" : `/funnel?testAccounts=${ta}`);

  const topStop = (funnel?.stopped_at ?? [])
    .filter((b) => b.key !== "completed")
    .sort((a, b) => b.count - a.count)[0];

  return (
    <div className="page">
      <PageHeader
        title="Onboarding funnel"
        description="Where workers drop out of onboarding across the whole base."
        secondaryActions={
          <>
            <Link className="btn btn--ghost btn--sm" href="/alerts">
              <Icon name="warning-octagon" />
              AI alerts
            </Link>
            <Link className="btn btn--ghost btn--sm" href="/empty-feed">
              <Icon name="funnel-x" />
              Empty feed
            </Link>
          </>
        }
        info={
          <>
            <p>
              One read of <code className="code">GET /admin/funnel/onboarding</code>. Step rules
              mirror the per-worker journey; the counts here equal that page summed over the cohort.
              Test accounts are excluded by default.
            </p>
            <p>
              Interview-kit downloads carry a worker id only from migration 0079 — a zero there is
              no ATTRIBUTED download, never no kit.
            </p>
          </>
        }
        filters={
          <SegmentedControl
            label="Test accounts"
            selectedIndex={["exclude", "include", "only"].indexOf(testAccounts)}
            options={["exclude", "include", "only"].map((ta) => ({
              label:
                ta === "exclude" ? "Exclude tests" : ta === "include" ? "Include" : "Only tests",
              href: hrefFor(ta),
            }))}
          />
        }
      />

      {failed || !funnel ? (
        <section className="panel">
          <div className="state state--error">
            <h3 className="state__title" id="funnel-error-heading">
              The funnel could not be loaded
            </h3>
            <p className="state__body">
              The funnel read failed, so this screen is MISSING rather than empty — do not read its
              absence as zero drop-off.
            </p>
            <div className="state__actions">
              <Link
                className="btn btn--ghost"
                href={testAccounts === "exclude" ? "/funnel" : hrefFor(testAccounts)}
              >
                <Icon name={ACTION_ICON.retry} />
                Retry
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section aria-labelledby="funnel-stats-heading">
            <h2 className="sr-only" id="funnel-stats-heading">
              Key figures
            </h2>
            <div className="stats">
              <Stat
                label="Workers in cohort"
                value={formatCount(funnel.total_workers)}
                countUp={{ to: funnel.total_workers, kind: "count" }}
              />
              <Stat
                label="Finished every step"
                value={formatCount(
                  funnel.stopped_at.find((b) => b.key === "completed")?.count ?? 0,
                )}
                countUp={{
                  to: funnel.stopped_at.find((b) => b.key === "completed")?.count ?? 0,
                  kind: "count",
                }}
              />
              <Stat
                label="Held at the top stop"
                value={topStop ? `${formatCount(topStop.count)} · ${topStop.key}` : "No holds"}
                tone={topStop && topStop.count > 0 ? "warn" : undefined}
              />
            </div>
            {topStop && funnel.total_workers > 0 ? (
              <p className="field__help">{describeFunnelStop(topStop, funnel.total_workers)}</p>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="funnel-heading">
            <div className="panel__head">
              <h2 className="panel__title" id="funnel-heading">
                The seven steps
              </h2>
              <p className="panel__sub">
                Cohort: {formatCount(funnel.total_workers)} workers
                {funnel.signup_from || funnel.signup_to
                  ? ` · signed up ${funnel.signup_from ?? "…"} to ${funnel.signup_to ?? "…"}`
                  : ""}
                {" · "}test accounts: {funnel.test_accounts}.
              </p>
            </div>
            <OnboardingFunnel steps={funnel.steps} total={funnel.total_workers} />
          </section>

          {(
            [
              ["trade", "By trade"],
              ["city", "By city"],
              ["language", "By language"],
              ["app_version", "By app version"],
            ] as const
          ).map(([dim, title]) => (
            <section className="panel" aria-labelledby={`split-${dim}-heading`} key={dim}>
              <div className="panel__head">
                <h2 className="panel__title" id={`split-${dim}-heading`}>
                  {title}
                </h2>
                <p className="panel__sub">
                  Where each group is held. Cells below the k-anonymity floor report nothing.
                </p>
              </div>
              {funnel.splits[dim].length > 0 ? (
                <ul className="funnel">
                  {funnel.splits[dim].map((cell) => (
                    <li className="funnel__row" key={cell.value}>
                      <span className="funnel__label">
                        <strong>{cell.value}</strong>
                        <br />
                        <span className="funnel__events">{describeSplitCell(cell)}</span>
                      </span>
                      <span className="funnel__nums">
                        <span
                          className={`funnel__distinct${cell.suppressed ? " is-suppressed" : ""}`}
                          title={
                            cell.suppressed
                              ? "Withheld: fewer workers than the k-anonymity floor"
                              : undefined
                          }
                        >
                          {cell.suppressed ? "withheld" : formatCount(cell.total)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No {title.toLowerCase()} breakdown for this cohort.</p>
              )}
            </section>
          ))}

          <CaveatList caveats={funnel.caveats} headingId="funnel-caveats-heading" />
        </>
      )}
    </div>
  );
}
