"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { jobRoleLabel } from "@badabhai/types";
import { ConfirmDialog } from "../../../../../components/confirm-dialog";
import { POSTING_REASON_CATEGORIES } from "../../../../../lib/company-vocabulary";
import { setCampusTradesAction } from "../actions";

/**
 * #2957 — choose the trades RVM trains. Only a job in one of these can be sent to Campus; a job in
 * any other trade can only show on BadaBhai. Saving replaces the whole list and asks for a reason.
 * Jobs already on Campus stay there when their trade is removed; only new decisions are refused.
 */
export function TradesForm({ trades }: { trades: readonly { key: string; taught: boolean }[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    new Set(trades.filter((t) => t.taught).map((t) => t.key)),
  );
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const before = trades.filter((t) => t.taught).map((t) => t.key);
  const added = [...picked].filter((k) => !before.includes(k));
  const removed = before.filter((k) => !picked.has(k));
  const label = (key: string) => jobRoleLabel(key) ?? key;

  return (
    <section className="panel">
      <div className="panel__head">
        <div className="panel__text">
          <h2 className="panel__title">Trades RVM trains</h2>
          <p className="panel__sub">Tick every trade RVM trains and certifies today.</p>
        </div>
      </div>
      <div className="panel__body">
        <fieldset className="field">
          <legend className="field__label">Trades</legend>
          {trades.map((t) => (
            <label key={t.key} className="field" htmlFor={`trade-${t.key}`}>
              <span>
                <input
                  id={`trade-${t.key}`}
                  type="checkbox"
                  checked={picked.has(t.key)}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(t.key)) next.delete(t.key);
                      else next.add(t.key);
                      return next;
                    })
                  }
                />{" "}
                {label(t.key)}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="state__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={added.length === 0 && removed.length === 0}
            onClick={() => {
              setMessage(null);
              setConfirming(true);
            }}
          >
            Save the list
          </button>
        </div>
        {message ? (
          <p className="field__help" role="status">
            {message}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        tier="consequential"
        title="Save the trades RVM trains"
        description="Only jobs in these trades can be sent to Campus. Jobs already on Campus stay where they are."
        changes={[
          { label: "Added", before: "—", after: added.map(label).join(", ") || "None" },
          { label: "Removed", before: removed.map(label).join(", ") || "None", after: "—" },
        ]}
        categories={POSTING_REASON_CATEGORIES}
        confirmLabel="Save"
        onConfirm={(reason) => setCampusTradesAction({ tradeKeys: [...picked], reason })}
        onSettled={(outcome) => {
          if (!outcome.ok) return;
          setConfirming(false);
          setMessage(outcome.message);
          router.refresh();
        }}
      />
    </section>
  );
}
