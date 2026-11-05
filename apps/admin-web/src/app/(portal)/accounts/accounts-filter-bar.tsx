"use client";

import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  ACCOUNT_PASSWORD_STATES,
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  PASSWORD_STATE_LABELS,
} from "../../../lib/account-labels";

/**
 * The User accounts filters (#2578). Same contract as the other list bars: a plain form that
 * writes the filters into the URL and lets the Server Component re-render. Submitting always
 * drops any existing cursor. Empty values are omitted — the API's query is `.strict()`, and
 * `?status=` would be a 400.
 *
 * There is deliberately NO free-text search field: `GET /admin/accounts` does not offer one
 * (the login identifier is ciphertext), so the bar shows only filters the API truly serves.
 */
export function AccountsFilterBar({
  role,
  status,
  passwordState,
  orgId,
}: {
  role: string;
  status: string;
  passwordState: string;
  orgId: string;
}) {
  const [pending, push] = usePendingPush();
  const [values, setValues] = useUrlState({ role, status, passwordState, orgId });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    if (values.role) q.set("role", values.role);
    if (values.status) q.set("status", values.status);
    if (values.passwordState) q.set("password_state", values.passwordState);
    if (values.orgId.trim()) q.set("org_id", values.orgId.trim());
    const qs = q.toString();
    push(qs ? `/accounts?${qs}` : "/accounts");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Role</span>
        <select
          className="field__input"
          value={values.role}
          onChange={(e) => setValues((v) => ({ ...v, role: e.target.value }))}
        >
          <option value="">Any</option>
          {ACCOUNT_ROLES.map((r) => (
            <option key={r} value={r}>
              {r === "employer" ? "Company" : "Agency"}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Status</span>
        <select
          className="field__input"
          value={values.status}
          onChange={(e) => setValues((v) => ({ ...v, status: e.target.value }))}
        >
          <option value="">Any</option>
          {ACCOUNT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Password</span>
        <select
          className="field__input"
          value={values.passwordState}
          onChange={(e) => setValues((v) => ({ ...v, passwordState: e.target.value }))}
        >
          <option value="">Any</option>
          {ACCOUNT_PASSWORD_STATES.map((s) => (
            <option key={s} value={s}>
              {PASSWORD_STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Organisation id</span>
        <input
          className="field__input mono"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={values.orgId}
          onChange={(e) => setValues((v) => ({ ...v, orgId: e.target.value }))}
          placeholder="e.g. 00000000-0000-4000-8000-000000000000"
        />
      </label>

      <div className="filters__actions">
        <button className="btn btn--primary" type="submit">
          <Icon name={ACTION_ICON.filter} />
          Apply
          <SubmitPendingCue pending={pending} message="Applying the filters…" />
        </button>
      </div>
    </form>
  );
}
