"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import {
  CREDIT_CALL_RESULT_LABELS,
  CREDIT_CALL_RESULTS,
  type CreditCallResult,
} from "../../../lib/numbers-vocabulary";
import { logCreditCallAction } from "./actions";

/**
 * "Log call" — five closed results, one button each (#2884).
 *
 * Each tap mints its own Idempotency-Key. A failed tap keeps that key, so pressing the same result
 * again is a retry of the SAME call, not a second one. A successful tap clears it: the next tap is
 * a new call and gets a new key.
 */
export function LogCallButtons({ payerId }: { payerId: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [keys, setKeys] = useState<Partial<Record<CreditCallResult, string>>>({});
  const [pending, startTransition] = useTransition();

  function log(result: CreditCallResult) {
    if (pending) return;
    const key = keys[result] ?? crypto.randomUUID();
    setKeys((current) => ({ ...current, [result]: key }));
    startTransition(async () => {
      const answer = await logCreditCallAction(payerId, result, key);
      setOutcome(answer);
      if (answer.ok) {
        setKeys((current) => {
          const next = { ...current };
          delete next[result];
          return next;
        });
        router.refresh();
      }
    });
  }

  return (
    <div className="row-actions">
      {CREDIT_CALL_RESULTS.map((result) => (
        <button
          key={result}
          className="btn btn--ghost btn--sm"
          type="button"
          disabled={pending}
          onClick={() => log(result)}
          aria-label={`Log call: ${CREDIT_CALL_RESULT_LABELS[result]}`}
        >
          <Icon name={ACTION_ICON.call} />
          <span>{CREDIT_CALL_RESULT_LABELS[result]}</span>
        </button>
      ))}
      {outcome ? <AdminActionResultBanner outcome={outcome} eventsLink={null} /> : null}
    </div>
  );
}
