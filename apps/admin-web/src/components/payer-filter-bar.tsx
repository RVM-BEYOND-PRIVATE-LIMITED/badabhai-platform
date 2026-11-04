"use client";

import { SubmitPendingCue, usePendingPush } from "./nav-pending";
import { useUrlState } from "./use-url-state";
import { queryHref } from "../lib/query-href";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * Account status filter on Companies — Companies and Agencies are one list since A6 (#2576).
 *
 * `kind` is the Kind filter in the address (`?kind=`, its chips sit outside this form): Apply
 * keeps it, so narrowing Agencies by status stays on Agencies. Submitting drops any existing
 * cursor, since page three's cursor applied to a new filter returns an arbitrary slice of it.
 */
export function PayerFilterBar({
  basePath,
  status,
  kind,
}: {
  basePath: string;
  status: string;
  kind?: string;
}) {
  // Navigates in a transition, so Apply can show that the new list is on its way — the same
  // signal a link gives, with no loading boundary (components/nav-pending.tsx).
  const [pending, push] = usePendingPush();
  const [value, setValue] = useUrlState(status);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    push(queryHref(basePath, { kind, status: value }));
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Status</span>
        <select
          className="field__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">Any</option>
          <option value="pending">Pending — registered, not yet verified</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
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
