"use client";

import { useId } from "react";
import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import { EVENT_ACTOR_TYPES, EVENT_SUBJECT_TYPES } from "../../../lib/list-filter-values";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export type EventFilterValues = {
  eventName: string;
  actorType: string;
  subjectType: string;
  correlationId: string;
  /** IST days, `YYYY-MM-DD` — the page turns them into the instants the API compares. */
  occurredFrom: string;
  occurredTo: string;
};

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
 * name is a COMBOBOX: free text (the API matches any string, and an event that has not fired
 * lately is still a name to search), suggesting the names the spine recorded lately — the page
 * reads them (`eventNames`), since the registry's 230, growing with every feature, are not this
 * app's to copy. Without them it is the same field, unsuggested. Placeholders are examples.
 */
export function EventFilterBar({
  eventNames = [],
  ...initial
}: EventFilterValues & { eventNames?: readonly string[] }) {
  const namesId = useId();
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
          placeholder="e.g. profile.confirmed"
          spellCheck={false}
          autoComplete="off"
          list={eventNames.length > 0 ? namesId : undefined}
        />
        {eventNames.length > 0 ? (
          <datalist id={namesId}>
            {eventNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        ) : null}
      </label>
      <label className="field">
        <span className="field__label">Actor type</span>
        <select className="field__input" value={values.actorType} onChange={set("actorType")}>
          {typeOptions(values.actorType, EVENT_ACTOR_TYPES)}
        </select>
      </label>
      <label className="field">
        <span className="field__label">Subject type</span>
        <select className="field__input" value={values.subjectType} onChange={set("subjectType")}>
          {typeOptions(values.subjectType, EVENT_SUBJECT_TYPES)}
        </select>
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
 * A closed set's options, with "Any" first. A value in the address that is not in the set (a
 * hand-edited URL, a type the schema gained after this copy) is offered as it stands — its own
 * option, marked — rather than the select silently showing "Any" while the list is filtered by it.
 */
function typeOptions(value: string, options: readonly string[]) {
  const unknown = value !== "" && !options.includes(value);
  return [
    <option key="" value="">
      Any
    </option>,
    ...(unknown
      ? [
          <option key={`unknown:${value}`} value={value}>
            {value} (not a known type)
          </option>,
        ]
      : []),
    ...options.map((o) => (
      <option key={o} value={o}>
        {o}
      </option>
    )),
  ];
}
