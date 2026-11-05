import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listAccounts } from "../../../lib/accounts";
import {
  ACCOUNT_PASSWORD_STATES,
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPE_LABELS,
  PASSWORD_STATE_LABELS,
  type AccountPasswordState,
  type AccountRole,
  type AccountStatus,
} from "../../../lib/account-labels";
import {
  isMalformedUuid,
  isUnknownValue,
  readRefusal,
  type ReadRefusal,
} from "../../../lib/read-refusal";
import { queryHref } from "../../../lib/query-href";
import { formatRelative, timestampTitle } from "../../../lib/format";
import { PageHeader } from "../../../components/page-header";
import { FilterPanel } from "../../../components/filter-panel";
import { DataGrid, type GridColumn } from "../../../components/data-grid";
import { Pager } from "../../../components/pager";
import { StatusPill } from "../../../components/status-pill";
import {
  ALL_ADMIN_ACTIONS_LINK,
} from "../../../components/admin-action-result-banner";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { AccountsFilterBar } from "./accounts-filter-bar";
import { CreateLoginDialog } from "./create-login-dialog";
import { AccountRowActions } from "./account-row-actions";
import type { AccountListItem, AccountsPage } from "../../../lib/accounts";

export const dynamic = "force-dynamic";
export const metadata = { title: "User accounts" };

/**
 * User accounts (#2578) — every payer login an admin can create, recover or disable.
 *
 * The list is `GET /admin/accounts` (#2563): keyset-paged, filtered by closed enums, with the
 * login identifier and organisation name ADDITIVE behind `read_identity`. It is deliberately
 * unpaged by number and has no free-text search, so this screen offers exactly what the API
 * serves — filters and a keyset pager, never a page number or a search box it cannot honour.
 *
 * Every write is a governed action: create, issue a one-time password and revoke all carry a
 * reason, emit `admin.action_performed`, and return a temporary password exactly once.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("manage_payer_credentials");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const role = one(sp.role);
  const status = one(sp.status);
  const passwordState = one(sp.password_state);
  const orgId = one(sp.org_id);
  const cursor = one(sp.cursor);

  const filtered = Boolean(role || status || passwordState || orgId);
  let page: AccountsPage | null = null;
  let failed = false;
  let refusal: ReadRefusal = null;
  const refusable =
    isUnknownValue(role, ACCOUNT_ROLES) ||
    isUnknownValue(status, ACCOUNT_STATUSES) ||
    isUnknownValue(passwordState, ACCOUNT_PASSWORD_STATES) ||
    isMalformedUuid(orgId);

  try {
    page = await listAccounts({
      cursor,
      // Unknown values are sent through on purpose: the API's `.strict()` enums reject them,
      // and the refusal state above is the honest answer ("that filter is not one we know").
      role: role as AccountRole | undefined,
      status: status as AccountStatus | undefined,
      passwordState: passwordState as AccountPasswordState | undefined,
      orgId,
    });
  } catch (err) {
    failed = true;
    refusal = readRefusal(err, { filtered: refusable, cursor });
  }

  const listHref = queryHref("/accounts", { role, status, password_state: passwordState, org_id: orgId });
  const filtersRefused = refusal === "filters";
  const refused = refusal !== null;
  const mayReadEvents = can(session.capabilities, "read_events");

  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/accounts">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
    </Link>
  ) : null;

  const columns: GridColumn<AccountListItem>[] = [
    {
      id: "login",
      header: "Login ID",
      width: "id",
      text: "truncate",
      cell: (a) =>
        a.login_id === undefined ? (
          <span className="table__meta">Hidden for your role</span>
        ) : (
          <span className="mono">{a.login_id ?? "—"}</span>
        ),
      title: (a) => a.login_id ?? undefined,
    },
    {
      id: "type",
      header: "Type",
      width: "short",
      cell: (a) => ACCOUNT_TYPE_LABELS[a.type],
    },
    {
      id: "organisation",
      header: "Organisation",
      text: "truncate",
      cell: (a) =>
        a.organisation === undefined ? (
          <span className="table__meta">Hidden for your role</span>
        ) : (
          (a.organisation ?? "—")
        ),
      title: (a) => a.organisation ?? undefined,
    },
    {
      id: "status",
      header: "Status",
      width: "status",
      cell: (a) => <StatusPill value={a.status} />,
    },
    {
      id: "last-sign-in",
      header: "Last sign-in",
      width: "date",
      cell: (a) =>
        a.last_login_at ? (
          <time dateTime={a.last_login_at} title={timestampTitle(a.last_login_at)}>
            {formatRelative(a.last_login_at)}
          </time>
        ) : (
          <span className="table__meta">Never</span>
        ),
    },
    {
      id: "password",
      header: "Password",
      width: "short",
      cell: (a) => (
        <span
          title={
            a.password_set_at ? `Set ${timestampTitle(a.password_set_at)}` : undefined
          }
        >
          {PASSWORD_STATE_LABELS[a.password_state]}
          {a.password_state === "set" && a.password_set_at
            ? ` · ${formatRelative(a.password_set_at)}`
            : ""}
          {/* `null` is "the lock-state read failed", not "unlocked" — only `true` is a claim. */}
          {a.locked === true ? " · Locked" : ""}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      width: "short",
      cell: (a) => (
        <AccountRowActions
          account={{
            id: a.id,
            type: a.type,
            status: a.status,
            password_state: a.password_state,
            login_id: a.login_id,
            organisation: a.organisation,
          }}
          mayReadEvents={mayReadEvents}
        />
      ),
    },
  ];

  return (
    <div className="page page--list">
      <PageHeader
        title="User accounts"
        description="Create customer logins, issue a one-time password, or revoke password sign-in."
        info={
          <>
            <p>
              A temporary password is shown once and cannot be retrieved again. Every write needs
              a reason and is recorded in the admin action log.
            </p>
            <p>
              Login IDs and organisation names are shown only to a role with name access; every
              such read is audited.
            </p>
          </>
        }
        primaryAction={<CreateLoginDialog mayReadEvents={mayReadEvents} />}
        secondaryActions={
          mayReadEvents ? (
            <Link className="btn btn--ghost" href={ALL_ADMIN_ACTIONS_LINK.href}>
              <Icon name={ACTION_ICON.timeline} />
              {ALL_ADMIN_ACTIONS_LINK.label}
            </Link>
          ) : null
        }
        filters={
          <FilterPanel
            headingId="accounts-filter-heading"
            heading="Filter accounts"
            filters={{ role, status, passwordState, orgId }}
          >
            <AccountsFilterBar
              role={role ?? ""}
              status={status ?? ""}
              passwordState={passwordState ?? ""}
              orgId={orgId ?? ""}
            />
          </FilterPanel>
        }
      />

      <section className="panel" aria-labelledby="accounts-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="accounts-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? filtersRefused
                  ? "That filter combination was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} account${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtersRefused ? null : clearFilters}
        </div>

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">
              {filtersRefused ? "The server rejected these filters" : CURSOR_REFUSAL.title}
            </h3>
            <p className="state__body">
              {filtersRefused
                ? "One of the values is not one this portal recognises, so nothing was fetched. Check the filter bar above, or clear the filters and start again."
                : CURSOR_REFUSAL.body}
            </p>
            {filtersRefused ? (
              <div className="state__actions">{clearFilters}</div>
            ) : (
              <FirstPageAction href={listHref} cursor={cursor} />
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">User accounts are unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filters.
            </p>
            <RetryActions href={listHref} cursor={cursor} />
          </div>
        ) : page && page.items.length > 0 ? (
          <DataGrid
            id="payer-accounts"
            caption="Customer logins, newest first"
            columns={columns}
            rows={page.items}
            rowKey={(a) => a.id}
            pager={
              <Pager
                basePath="/accounts"
                params={{
                  role,
                  status,
                  password_state: passwordState,
                  org_id: orgId,
                }}
                cursor={cursor}
                nextCursor={page.nextCursor}
              />
            }
          />
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No logins match these filters</h3>
            <p className="state__body">
              No customer login is in this state right now. Widen the filter, or clear it to see
              every account.
            </p>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No customer logins yet</h3>
            <p className="state__body">
              Customer logins appear here when a customer signs up, or when an admin creates one with
              “Create a login”.
            </p>
            <div className="state__actions">
              <span className="table__meta">
                Accounts are listed newest first; use “Create a login” above.
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
