"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Account status filter, shared by Companies and Agencies.
 *
 * `basePath` is what makes it shared rather than duplicated: the two sections differ only
 * in where the form navigates. Submitting drops any existing cursor, since page three's
 * cursor applied to a new filter returns an arbitrary slice of it.
 */
export function PayerFilterBar({ basePath, status }: { basePath: string; status: string }) {
  const router = useRouter();
  const [value, setValue] = useState(status);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    router.push(value ? `${basePath}?status=${encodeURIComponent(value)}` : basePath);
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
          Apply
        </button>
      </div>
    </form>
  );
}
