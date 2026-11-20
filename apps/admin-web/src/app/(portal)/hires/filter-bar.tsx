"use client";

import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { HIRE_STATUSES, HIRE_STATUS_LABELS } from "../../../lib/hires-vocabulary";

/**
 * The Hire records status filter (#2753 item 9). A plain GET form that writes the filter into
 * the address; submitting drops the page cursor, and an empty status is omitted because the
 * API's query is strict.
 */
export function HireFilterBar({ status }: { status: string }) {
  const [pending, push] = usePendingPush();
  const [values, setValues] = useUrlState({ status });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = new URLSearchParams();
    const chosen = values.status.trim();
    if (chosen) q.set("status", chosen);
    const query = q.toString();
    push(query ? `/hires?${query}` : "/hires");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Status</span>
        <select
          className="field__input"
          value={values.status}
          onChange={(event) => setValues((v) => ({ ...v, status: event.target.value }))}
        >
          <option value="">Any</option>
          {HIRE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {HIRE_STATUS_LABELS[value]}
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
