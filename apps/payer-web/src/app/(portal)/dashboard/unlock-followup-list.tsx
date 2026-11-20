"use client";

import { useRef, useState, useTransition } from "react";
import { Icon } from "@badabhai/icons";
import { Button, Card, Toast } from "../../../components/ds";
import type { ButtonProps } from "../../../components/ds";
import type { UnlockCompanyOutcome } from "../../../lib/contracts";
import { isoDay } from "../../../lib/unlock-history";
import { recordUnlockOutcomeAction } from "./actions";

/**
 * #2984 §4 — the company's follow-up rows ("Did you hire this person?").
 *
 * FACELESS by construction: a row carries no name, phone or worker id — only "Unlocked contact",
 * the day it was opened and the current answer. One row per due unlock; answering removes it.
 *
 * IDEMPOTENCY: one key is minted per (unlock, outcome) answer intent and kept in a ref until that
 * answer SUCCEEDS. A retry of the same intent reuses it (so a lost response cannot double-write);
 * choosing a different outcome is a new intent and gets a new key.
 */

export interface UnlockFollowupItem {
  unlockId: string;
  grantedAt: string;
  outcome: UnlockCompanyOutcome | null;
}

const OUTCOME_LABEL: Record<UnlockCompanyOutcome, string> = {
  hired: "Hired",
  not_hired: "Not hired",
  still_talking: "Still talking",
};

const ANSWERS: ReadonlyArray<{
  outcome: UnlockCompanyOutcome;
  label: string;
  variant: ButtonProps["variant"];
}> = [
  { outcome: "still_talking", label: "Still talking", variant: "secondary" },
  { outcome: "hired", label: "Hired", variant: "success" },
  { outcome: "not_hired", label: "Not hired", variant: "danger" },
];

function outcomeLabel(outcome: UnlockCompanyOutcome | null): string {
  return outcome === null ? "No answer yet" : OUTCOME_LABEL[outcome];
}

/** A random `Idempotency-Key` (PII-free; one per answer intent). */
function mintIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `unlock-outcome-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function UnlockFollowupList({ items }: { items: UnlockFollowupItem[] }) {
  const [answered, setAnswered] = useState<string[]>([]);
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [, startTransition] = useTransition();
  const keys = useRef(new Map<string, string>());

  if (hidden) return null;
  const visible = items.filter((item) => !answered.includes(item.unlockId));
  if (visible.length === 0) return null;

  function answer(item: UnlockFollowupItem, outcome: UnlockCompanyOutcome) {
    if (pendingFor !== null) return;
    setError(null);

    const intent = `${item.unlockId}:${outcome}`;
    setPendingFor(intent);
    let key = keys.current.get(intent);
    if (key === undefined) {
      key = mintIdempotencyKey();
      keys.current.set(intent, key);
    }

    startTransition(async () => {
      const result = await recordUnlockOutcomeAction({
        unlockId: item.unlockId,
        outcome,
        idempotencyKey: key,
      });
      if (result.ok) {
        // Answer recorded: retire the key and drop the row.
        keys.current.delete(intent);
        setAnswered((prev) => [...prev, item.unlockId]);
        setError(null);
      } else if (result.reason === "not_found") {
        // The switch went off, or the unlock is no longer ours: hide the whole control.
        keys.current.delete(intent);
        setHidden(true);
      } else {
        // Retryable (429 / in-flight / 5xx): keep the row AND the key for a retry.
        setError(result.error);
      }
      setPendingFor(null);
    });
  }

  return (
    <div className="dash-candlist unlock-followup__list">
      {visible.map((item) => {
        return (
          <Card key={item.unlockId} padding="sm" className="dash-unlock">
            <span className="dash-unlock__icon" aria-hidden="true">
              <Icon name="lock-key" />
            </span>
            <div className="dash-unlock__main">
              <div className="dash-unlock__title">Unlocked contact</div>
              <div className="dash-unlock__meta">
                Unlocked <span className="bb-mono">{isoDay(item.grantedAt)}</span> ·{" "}
                {outcomeLabel(item.outcome)}
              </div>
            </div>
            <div className="unlock-followup__actions">
              {ANSWERS.map((answerOption) => (
                <Button
                  key={answerOption.outcome}
                  type="button"
                  size="md"
                  variant={answerOption.variant}
                  loading={pendingFor === `${item.unlockId}:${answerOption.outcome}`}
                  disabled={pendingFor !== null}
                  onClick={() => answer(item, answerOption.outcome)}
                >
                  {answerOption.label}
                </Button>
              ))}
            </div>
          </Card>
        );
      })}
      <div aria-live="polite" className="form-status">
        {error ? (
          <Toast tone="danger" title="Couldn’t save that answer">
            {error}
          </Toast>
        ) : null}
      </div>
    </div>
  );
}
