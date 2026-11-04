"use client";

import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import { EVENT_ACTOR_TYPES, EVENT_SUBJECT_TYPES } from "../../../lib/list-filter-values";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export interface EventFilterValues {
  eventName: string;
  actorType: string;
  subjectType: string;
  correlationId: string;
  /** IST days, `YYYY-MM-DD` — the page turns them into the instants the API compares. */
  occurredFrom: string;
  occurredTo: string;
}

/**
 * Event filters.
 *
 * A plain form that navigates — it writes the filters into the URL and lets the Server
 * Component re-render. No client-side fetching, so there is no second copy of the query
 * logic and no way for the two to disagree.
 *
 * Submitting always drops any existing `cursor`: keeping it would apply page 3's cursor
 * to a brand-new query and return an arbitrary slice of it.
 *
 * A4 (#2574): the actor and subject types are SELECTS — the event schema's closed sets
 * (`lib/list-filter-values.ts`) — and the date range is two IST days, both inclusive. The event
 * name stays free text: 230 names, growing with every feature, and the API matches any string, so
 * a pinned copy would go stale in the very release that adds an event. Placeholders are examples.
 */
export function EventFilterBar(initial: EventFilterValues) {
  // Navigates in a transition, so Apply can show that the new list is on its way — the same
  // signal a link gives, with no loading boundary (components/nav-pending.tsx).
  const [pending, push] = usePendingPush();
  const [values, setValues] = useUrlState<EventFilterValues>({
    eventName: initial.eventName,
    actorType: initial.actorType,
    subjectType: initial.subjectType,
    correlationId: initial.correlationId,
    occurredFrom: initial.occurredFrom,
    occurredTo: initial.occurredTo,
  });
  const set =
    (k: keyof EventFilterValues) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((v) => ({ ...v, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) {
      const t = v.trim();
      if (t) q.set(k, t);
    }
    const qs = q.toString();
    push(qs ? `/events?${qs}` : "/events");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Event name</span>
        <input
          className="field__input"
          value={values.eventName}
          onChange={set("eventName")}
          placeholder="e.g. worker.profile_confirmed"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="field__label">Actor type</span>
        <TypeSelect value={values.actorType} options={EVENT_ACTOR_TYPES} onChange={set("actorType")} />
      </label>
      <label className="field">
        <span className="field__label">Subject type</span>
        <TypeSelect
          value={values.subjectType}
          options={EVENT_SUBJECT_TYPES}
          onChange={set("subjectType")}
        />
      </label>
      <label className="field">
        <span className="field__label">Correlation id</span>
        <input
          className="field__input mono"
          value={values.correlationId}
          onChange={set("correlationId")}
          placeholder="e.g. 0b7c5d2e-1f3a-4c8e-9d61-2a4f6b8c0e13"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="field__label">From (IST)</span>
        <input
          className="field__input"
          type="date"
          value={values.occurredFrom}
          max={values.occurredTo || undefined}
          onChange={set("occurredFrom")}
        />
      </label>
      <label className="field">
        <span className="field__label">To (IST)</span>
        <input
          className="field__input"
          type="date"
          value={values.occurredTo}
          min={values.occurredFrom || undefined}
          onChange={set("occurredTo")}
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

/**
 * A closed set as a select, with "Any". A value in the address that is not in the set (a
 * hand-edited URL, a type the schema gained after this copy) is shown as it stands — as its own
 * option, marked — rather than silently displayed as "Any" while the list is filtered by it.
 */
function TypeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  const unknown = value !== "" && !options.includes(value);
  return (
    <select className="field__input" value={value} onChange={onChange}>
      <option value="">Any</option>
      {unknown ? <option value={value}>{value} (not a known type)</option> : null}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
