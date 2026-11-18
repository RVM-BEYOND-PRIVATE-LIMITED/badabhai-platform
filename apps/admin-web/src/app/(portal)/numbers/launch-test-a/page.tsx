import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import {
  listLaunchCohort,
  type LaunchCohortPage,
  type LaunchFactory,
} from "../../../../lib/numbers";
import { isAdminRequestError, isAdminUnauthorized } from "../../../../lib/admin-http";
import { displayName } from "../../../../lib/identity";
import {
  formatDate,
  formatRelative,
  shortId,
  timestampTitle,
} from "../../../../lib/format";
import {
  LAUNCH_TEST_RESULT_LABELS,
  NUMBERS_CITY_LABELS,
  NUMBERS_TRADE_LABELS,
  type NumbersCityGroup,
  type NumbersTradeGroup,
} from "../../../../lib/numbers-vocabulary";
import { PageHeader } from "../../../../components/page-header";
import { DataGrid, type GridColumn } from "../../../../components/data-grid";
import { Pager } from "../../../../components/pager";
import { StatusPill } from "../../../../components/status-pill";
import { CopyId } from "../../../../components/copy-id";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { NumbersTabs } from "../numbers-tabs";
import { RecordFactoryForm } from "./record-factory-form";
import { UpdateFactory } from "./update-factory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Launch test A" };

/**
 * Launch test A (#2884; API #2755 part D) — the factories the desk sent profiles to.
 *
 * The desk records by hand what it did by hand: nothing here sends a profile, creates a payment
 * link or charges anyone. A factory's name is shown only when the route disclosed it; otherwise
 * the id is shown. The phone is never returned at all, only whether one is on file.
 */
export default async function LaunchTestAPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_business_numbers");

  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  const cursor = one(sp.cursor);

  let page: LaunchCohortPage | null = null;
  let problem: "off" | "unavailable" | "cursor" | "error" | null = null;

  try {
    page = await listLaunchCohort({ cursor });
  } catch (err) {
    if (isAdminUnauthorized(err)) throw err;
    if (isAdminRequestError(err)) {
      if (err.status === 404) problem = "off";
      else if (err.status === 503) problem = "unavailable";
      else if (err.status === 400 && cursor) problem = "cursor";
      else problem = "error";
    } else {
      problem = "error";
    }
  }

  return (
    <div className="page">
      <PageHeader
        back={{ href: "/numbers", label: "Numbers" }}
        title="Launch test A"
        description="The factories the desk sent worker profiles to, and what each did with its link."
        info={
          <>
            <p>
              This screen records the desk's own work. It never sends a profile, creates a
              payment link or charges anyone.
            </p>
            <p>
              A factory's phone is never returned. The record carries whether one is on file; the
              desk keeps its call sheet elsewhere.
            </p>
          </>
        }
        filters={<NumbersTabs active="launch-test-a" />}
      />

      <section className="panel" aria-labelledby="lta-add">
        <div className="panel__head">
          <h2 className="panel__title" id="lta-add">
            Add factory
          </h2>
          <p className="panel__sub">
            Record one factory and the 1–5 workers whose profiles were sent to it.
          </p>
        </div>
        <RecordFactoryForm />
      </section>

      <section className="panel" aria-labelledby="lta-list" aria-live="polite">
        <div className="panel__head">
          <h2 className="panel__title" id="lta-list">
            Factories
          </h2>
          <p className="panel__sub">
            {page
              ? `${page.rows.length} factor${page.rows.length === 1 ? "y" : "ies"} on this page.`
              : "Nothing was fetched."}
          </p>
        </div>

        {problem ? (
          <Problem problem={problem} />
        ) : page && page.rows.length > 0 ? (
          <DataGrid
            id="launch-test-a"
            caption="Launch test A factories, newest first"
            columns={COLUMNS}
            rows={page.rows}
            rowKey={(row) => row.id}
            pager={
              <Pager
                basePath="/numbers/launch-test-a"
                params={{}}
                cursor={cursor}
                nextCursor={page.next_cursor}
                note="The cohort is keyset paged, so recording a factory mid-scan cannot skip or repeat one."
              />
            }
          />
        ) : (
          <div className="state">
            <h3 className="state__title">No factory recorded yet</h3>
            <p className="state__body">
              Record the first factory above once the desk has sent its profiles.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Problem({ problem }: { problem: "off" | "unavailable" | "cursor" | "error" }) {
  if (problem === "off") {
    return (
      <div className="state">
        <h3 className="state__title">Not switched on yet</h3>
        <p className="state__body">
          This deployment has not turned the numbers screen on. Nothing is wrong with your
          access.
        </p>
      </div>
    );
  }
  if (problem === "unavailable") {
    return (
      <div className="state state--error">
        <h3 className="state__title">Try again later</h3>
        <p className="state__body">
          A migration the launch tests read has not been applied, so nothing was fetched.
        </p>
      </div>
    );
  }
  if (problem === "cursor") {
    return (
      <div className="state state--error">
        <h3 className="state__title">The page cursor was refused</h3>
        <p className="state__body">Nothing was fetched. Start from the first page.</p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/numbers/launch-test-a">
            <Icon name={ACTION_ICON.back} />
            First page
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="state state--error">
      <h3 className="state__title">The factories did not load</h3>
      <p className="state__body">This is a fault on our side. Retry reads the same page again.</p>
      <div className="state__actions">
        <Link className="btn btn--ghost" href="/numbers/launch-test-a">
          <Icon name={ACTION_ICON.retry} />
          Retry
        </Link>
      </div>
    </div>
  );
}

const COLUMNS: readonly GridColumn<LaunchFactory>[] = [
  {
    id: "factory",
    header: "Factory",
    text: "truncate",
    rowHeader: true,
    cell: (row) => {
      const name = row.factory_name === undefined ? null : displayName(row.factory_name);
      return name ? (
        <span>{name}</span>
      ) : (
        <span className="mono" title={row.id}>
          {shortId(row.id)}
        </span>
      );
    },
    trail: (row) => <CopyId id={row.id} label="factory id" />,
    title: (row) => row.factory_name ?? row.id,
  },
  {
    id: "phone",
    header: "Phone",
    width: "short",
    cell: (row) => (
      <span className="table__meta">{row.has_phone ? "Phone on file" : "No phone"}</span>
    ),
  },
  {
    id: "city",
    header: "City group",
    width: "short",
    cell: (row) =>
      NUMBERS_CITY_LABELS[row.city_group as NumbersCityGroup] ?? row.city_group,
  },
  {
    id: "trade",
    header: "Trade group",
    width: "short",
    cell: (row) =>
      NUMBERS_TRADE_LABELS[row.trade_group as NumbersTradeGroup] ?? row.trade_group,
  },
  {
    id: "sent",
    header: "Profiles sent",
    width: "date",
    cell: (row) => (
      <span title={timestampTitle(row.sent_at)}>
        {formatRelative(row.sent_at)} ·{" "}
        <span className="mono">{shortId(row.sent_by_admin_id)}</span>
      </span>
    ),
  },
  {
    id: "link",
    header: "Payment link",
    text: "truncate",
    cell: (row) =>
      row.payment_link_ref ? (
        <span title={row.payment_link_ref}>
          {row.payment_link_ref.length > 32
            ? `${row.payment_link_ref.slice(0, 31)}…`
            : row.payment_link_ref}
          {row.link_created_at ? ` · ${formatDate(row.link_created_at)}` : ""}
        </span>
      ) : (
        <span className="table__meta">No link</span>
      ),
  },
  {
    id: "result",
    header: "Result",
    width: "status",
    cell: (row) => (
      <StatusPill
        value={row.result}
        label={LAUNCH_TEST_RESULT_LABELS[row.result]}
        tone={row.result === "paid" ? "ok" : row.result === "declined" ? "bad" : "warn"}
      />
    ),
  },
  {
    id: "paid",
    header: "Paid",
    width: "date",
    cell: (row) =>
      row.paid_at ? (
        <time dateTime={row.paid_at} title={timestampTitle(row.paid_at)}>
          {formatDate(row.paid_at)}
        </time>
      ) : (
        <span className="table__meta">—</span>
      ),
  },
  {
    id: "workers",
    header: "Workers sent",
    text: "wrap",
    cell: (row) => (
      <span title={row.worker_ids.join(", ")}>
        {row.worker_ids.map((workerId) => shortId(workerId)).join(", ")}
      </span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    width: "actions",
    cell: (row) => <UpdateFactory factory={row} />,
  },
];
