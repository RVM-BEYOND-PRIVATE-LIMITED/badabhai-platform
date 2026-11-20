"use client";

import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  PAY_ON_JOINING_PAYMENT_STATE_LABELS,
  PAY_ON_JOINING_PAYMENT_STATES,
} from "../../../lib/pay-on-joining-vocabulary";

/**
 * The pay-on-joining list filters (#2753 item 11): the factory id, the partner id and the
 * derived payment state. Empty values are omitted — the API's query is strict.
 */
export function PayOnJoiningHiresFilterBar({
  factoryPayerId,
  partnerPayerId,
  paid,
}: {
  factoryPayerId: string;
  partnerPayerId: string;
  paid: string;
}) {
  const [pending, push] = usePendingPush();
  const [values, setValues] = useUrlState({ factoryPayerId, partnerPayerId, paid });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = new URLSearchParams();
    const factory = values.factoryPayerId.trim();
    const partner = values.partnerPayerId.trim();
    const state = values.paid.trim();
    if (factory) q.set("factory_payer_id", factory);
    if (partner) q.set("partner_payer_id", partner);
    if (state) q.set("paid", state);
    const query = q.toString();
    push(query ? `/pay-on-joining-hires?${query}` : "/pay-on-joining-hires");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Factory id</span>
        <input
          className="field__input mono"
          value={values.factoryPayerId}
          onChange={(event) =>
            setValues((v) => ({ ...v, factoryPayerId: event.target.value }))
          }
          placeholder="e.g. 0b7c5d2e-1f3a-4c8e-9d61-2a4f6b8c0e13"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Partner id</span>
        <input
          className="field__input mono"
          value={values.partnerPayerId}
          onChange={(event) =>
            setValues((v) => ({ ...v, partnerPayerId: event.target.value }))
          }
          placeholder="e.g. 0b7c5d2e-1f3a-4c8e-9d61-2a4f6b8c0e13"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Payment</span>
        <select
          className="field__input"
          value={values.paid}
          onChange={(event) => setValues((v) => ({ ...v, paid: event.target.value }))}
        >
          <option value="">Any</option>
          {PAY_ON_JOINING_PAYMENT_STATES.map((state) => (
            <option key={state} value={state}>
              {PAY_ON_JOINING_PAYMENT_STATE_LABELS[state]}
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
