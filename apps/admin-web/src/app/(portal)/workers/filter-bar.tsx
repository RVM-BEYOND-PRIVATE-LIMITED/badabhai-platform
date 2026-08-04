"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Worker filters. Same contract as the events bar: a plain form that writes the filters
 * into the URL and lets the Server Component re-render, so there is no second copy of the
 * query logic. Submitting always drops any existing `cursor`.
 *
 * An unset select submits `""`, which is why the query builder omits empty strings —
 * forwarding `?status=` to the server's `.strict()` enum is a 400, and the whole page
 * would fail because a dropdown was left alone.
 */
export function WorkerFilterBar({
  status,
  pendingDeletion,
}: {
  status: string;
  pendingDeletion: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState({ status, pendingDeletion });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    if (values.status) q.set("status", values.status);
    if (values.pendingDeletion) q.set("pendingDeletion", "true");
    const qs = q.toString();
    router.push(qs ? `/workers?${qs}` : "/workers");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Status</span>
        <select
          className="field__input"
          value={values.status}
          onChange={(e) => setValues((v) => ({ ...v, status: e.target.value }))}
        >
          <option value="">Any</option>
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </label>

      <label className="field field--check">
        <input
          type="checkbox"
          checked={values.pendingDeletion}
          onChange={(e) => setValues((v) => ({ ...v, pendingDeletion: e.target.checked }))}
        />
        <span className="field__label">Deletion scheduled only</span>
      </label>

      <div className="filters__actions">
        <button className="btn btn--primary" type="submit">
          Apply
        </button>
      </div>
    </form>
  );
}
