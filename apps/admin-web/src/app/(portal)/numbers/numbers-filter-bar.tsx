"use client";

import { ACTION_ICON, Icon } from "@badabhai/icons";
import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import {
  NUMBERS_CITY_GROUPS,
  NUMBERS_CITY_LABELS,
  NUMBERS_TRADE_GROUPS,
  NUMBERS_TRADE_LABELS,
} from "../../../lib/numbers-vocabulary";

/**
 * The weekly numbers filters (#2884). City, trade and the series length are the three the API
 * serves; anything else is refused by its strict query, so this bar sends only these.
 */
export function NumbersFilterBar({
  city,
  trade,
  weeks,
}: {
  city: string;
  trade: string;
  weeks: string;
}) {
  const [pending, push] = usePendingPush();
  const [values, setValues] = useUrlState({ city, trade, weeks });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    if (values.city && values.city !== "all") q.set("city", values.city);
    if (values.trade && values.trade !== "all") q.set("trade", values.trade);
    if (values.weeks) q.set("weeks", values.weeks);
    const qs = q.toString();
    push(qs ? `/numbers?${qs}` : "/numbers");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">City</span>
        <select
          className="field__input"
          value={values.city}
          onChange={(e) => setValues((v) => ({ ...v, city: e.target.value }))}
        >
          {NUMBERS_CITY_GROUPS.map((group) => (
            <option key={group} value={group}>
              {NUMBERS_CITY_LABELS[group]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Trade</span>
        <select
          className="field__input"
          value={values.trade}
          onChange={(e) => setValues((v) => ({ ...v, trade: e.target.value }))}
        >
          {NUMBERS_TRADE_GROUPS.map((group) => (
            <option key={group} value={group}>
              {NUMBERS_TRADE_LABELS[group]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Weeks</span>
        <input
          className="field__input"
          type="number"
          min={1}
          max={26}
          value={values.weeks}
          onChange={(e) => setValues((v) => ({ ...v, weeks: e.target.value }))}
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
