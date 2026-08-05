"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Job posting filters.
 *
 * `payerId` is here because the Companies/Agencies pages link into this screen scoped to
 * one account ("all their postings"). Keeping it a real, editable filter rather than a
 * hidden parameter means that view is bookmarkable and the operator can see why the list
 * is scoped.
 */
export function JobFilterBar({
  status,
  verificationStatus,
  payerId,
}: {
  status: string;
  verificationStatus: string;
  payerId: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState({ status, verificationStatus, payerId });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) {
      const t = v.trim();
      if (t) q.set(k, t);
    }
    const qs = q.toString();
    router.push(qs ? `/jobs?${qs}` : "/jobs");
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
          <option value="draft">Draft</option>
          <option value="open">Open</option>
          <option value="paused">Paused</option>
          <option value="suspended">Suspended — owner account is suspended</option>
          <option value="closed">Closed</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Trust review</span>
        <select
          className="field__input"
          value={values.verificationStatus}
          onChange={(e) => setValues((v) => ({ ...v, verificationStatus: e.target.value }))}
        >
          <option value="">Any</option>
          <option value="unverified">Unverified — awaiting review</option>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Owner account id</span>
        <input
          className="field__input mono"
          value={values.payerId}
          onChange={(e) => setValues((v) => ({ ...v, payerId: e.target.value }))}
          placeholder="full UUID"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <div className="filters__actions">
        <button className="btn btn--primary" type="submit">
          Apply
        </button>
      </div>
    </form>
  );
}
