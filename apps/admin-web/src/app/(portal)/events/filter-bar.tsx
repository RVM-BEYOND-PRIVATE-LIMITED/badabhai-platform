"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Event filters.
 *
 * A plain form that navigates — it writes the filters into the URL and lets the Server
 * Component re-render. No client-side fetching, so there is no second copy of the query
 * logic and no way for the two to disagree.
 *
 * Submitting always drops any existing `cursor`: keeping it would apply page 3's cursor
 * to a brand-new query and return an arbitrary slice of it.
 */
export function EventFilterBar({
  eventName,
  actorType,
  subjectType,
  correlationId,
}: {
  eventName: string;
  actorType: string;
  subjectType: string;
  correlationId: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState({ eventName, actorType, subjectType, correlationId });
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) {
      const t = v.trim();
      if (t) q.set(k, t);
    }
    const qs = q.toString();
    router.push(qs ? `/events?${qs}` : "/events");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Event name</span>
        <input
          className="field__input"
          value={values.eventName}
          onChange={set("eventName")}
          placeholder="worker.profile_confirmed"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="field__label">Actor type</span>
        <input
          className="field__input"
          value={values.actorType}
          onChange={set("actorType")}
          placeholder="admin"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="field__label">Subject type</span>
        <input
          className="field__input"
          value={values.subjectType}
          onChange={set("subjectType")}
          placeholder="worker"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="field__label">Correlation id</span>
        <input
          className="field__input mono"
          value={values.correlationId}
          onChange={set("correlationId")}
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
