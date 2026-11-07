"use client";

import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  COMPANY_KIND_FILTERS,
  COMPANY_KIND_FILTER_ROLES,
  COMPANY_KIND_LABELS,
  COMPANY_PAGE_SIZES,
  COMPANY_STATUSES,
  COMPANY_VERIFICATION_STATUSES,
} from "../../../lib/company-vocabulary";

/**
 * The Companies filters (A9, #2579) — the fields `GET /admin/companies` actually serves:
 * whole-word name, city, GSTIN, kind, status, verification, order and page size.
 *
 * A plain form that writes the filters into the URL and lets the Server Component re-render.
 * Submitting drops the page number (a filter change restarts at page one) and omits empty
 * values — the API's query is `.strict()`, and `?status=` would be a 400.
 */
export function CompanyFilterBar({
  name,
  kind,
  status,
  verification,
  city,
  gst,
  sort,
  size,
  nameSearchAvailable,
}: {
  name: string;
  kind: string;
  status: string;
  verification: string;
  city: string;
  gst: string;
  sort: string;
  size: string;
  /** False when the API's name-token keys are unset — the field is refused, so do not offer it. */
  nameSearchAvailable: boolean;
}) {
  const [pending, push] = usePendingPush();
  const [values, setValues] = useUrlState({ name, kind, status, verification, city, gst, sort, size });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      const trimmed = value.trim();
      // A disabled name field is not a filter this deployment can serve.
      if (key === "name" && !nameSearchAvailable) continue;
      // 25 is the default page size; keep it out of the address unless it was chosen.
      if (trimmed && !(key === "size" && trimmed === "25")) q.set(key, trimmed);
    }
    const qs = q.toString();
    push(qs ? `/companies?${qs}` : "/companies");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Name</span>
        <input
          className="field__input"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          placeholder={nameSearchAvailable ? "e.g. Acme Fabrication" : "Name search unavailable"}
          autoComplete="off"
          disabled={!nameSearchAvailable}
        />
        {!nameSearchAvailable ? (
          <span className="field__help">The name index is not configured on this deployment.</span>
        ) : null}
      </label>

      <label className="field">
        <span className="field__label">Kind</span>
        <select
          className="field__input"
          value={values.kind}
          onChange={(e) => setValues((v) => ({ ...v, kind: e.target.value }))}
        >
          <option value="">Any</option>
          {COMPANY_KIND_FILTERS.map((kindValue) => (
            <option key={kindValue} value={kindValue}>
              {COMPANY_KIND_LABELS[COMPANY_KIND_FILTER_ROLES[kindValue]]}
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
          {COMPANY_STATUSES.map((statusValue) => (
            <option key={statusValue} value={statusValue}>
              {statusValue.charAt(0).toUpperCase() + statusValue.slice(1)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Verification</span>
        <select
          className="field__input"
          value={values.verification}
          onChange={(e) => setValues((v) => ({ ...v, verification: e.target.value }))}
        >
          <option value="">Any</option>
          {COMPANY_VERIFICATION_STATUSES.map((verificationValue) => (
            <option key={verificationValue} value={verificationValue}>
              {verificationValue.charAt(0).toUpperCase() + verificationValue.slice(1)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">City</span>
        <input
          className="field__input"
          value={values.city}
          onChange={(e) => setValues((v) => ({ ...v, city: e.target.value }))}
          placeholder="e.g. Pune"
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">GSTIN</span>
        <input
          className="field__input mono"
          value={values.gst}
          onChange={(e) => setValues((v) => ({ ...v, gst: e.target.value.toUpperCase() }))}
          placeholder="e.g. 27AAPFU0939F1ZV"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span className="field__label">Order</span>
        <select
          className="field__input"
          value={values.sort}
          onChange={(e) => setValues((v) => ({ ...v, sort: e.target.value }))}
        >
          <option value="">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Per page</span>
        <select
          className="field__input"
          value={values.size}
          onChange={(e) => setValues((v) => ({ ...v, size: e.target.value }))}
        >
          {COMPANY_PAGE_SIZES.map((pageSize) => (
            <option key={pageSize} value={String(pageSize)}>
              {pageSize}
            </option>
          ))}
        </select>
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
