"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@badabhai/icons";
import { FieldFeedback, Input, Select, fieldFeedbackId } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import type {
  PostingTradeCatalogueEntryWire,
  PostingTradeDetailWire,
} from "../../../lib/contracts";
import {
  postingTradeFormProblemMessage,
  postingTradesProblemMessage,
  type PostingTradesProblem,
} from "../../../lib/posting-trades";
import { humaniseRungLabel, tradeDepartmentGroups } from "../../../lib/trade-catalogue";
import {
  loadPostingTradeFormAction,
  type LoadPostingTradeFormResult,
} from "./trade-form-action";

/**
 * #3020 — THE COMPANY TRADE PICKER. One copy for New posting, Edit posting and the AI chat's
 * publish step.
 *
 * The list is the server's catalogue: departments are headings in server order and every visible
 * trade label comes from the server. Picking a trade loads ONLY that trade's form (through a
 * server action) and caches it for the session. A stored trade the catalogue no longer offers is
 * shown as a locked label, so its posting can still be edited without re-sending the trade.
 */

const formCache = new Map<string, PostingTradeDetailWire>();
const inFlight = new Map<string, Promise<LoadPostingTradeFormResult>>();

/** Test seam for the session cache. */
export function clearPostingTradeFormCache(): void {
  formCache.clear();
  inFlight.clear();
}

/** Load one form, reusing the session cache and coalescing concurrent requests for the same trade. */
export async function loadPostingTradeFormCached(
  roleKind: string,
): Promise<LoadPostingTradeFormResult> {
  const cached = formCache.get(roleKind);
  if (cached !== undefined) return { ok: true, trade: cached };
  const pending = inFlight.get(roleKind);
  if (pending !== undefined) return pending;
  const request = loadPostingTradeFormAction(roleKind)
    .then((result) => {
      if (result.ok) formCache.set(roleKind, result.trade);
      return result;
    })
    .finally(() => {
      inFlight.delete(roleKind);
    });
  inFlight.set(roleKind, request);
  return request;
}

export interface PostingTradePickerProps {
  /** The control's id — what a refused publish focuses (`focusControl`). */
  id: string;
  label: string;
  hint?: string;
  /** The catalogue rows, in the order the server sent them. */
  trades: readonly PostingTradeCatalogueEntryWire[];
  /** Why `trades` is empty; null when they are there (or no cause was given). */
  problem: PostingTradesProblem | null;
  /** The picked role kind, `""` until one is picked. */
  value: string;
  /** The inline refusal ("Pick one of the trades"), or undefined. */
  error?: string;
  onChange: (roleKind: string) => void;
  /** The loaded form for the current pick, or null while none/loading/failed. */
  onFormLoaded?: (form: PostingTradeDetailWire | null) => void;
  /** A form already loaded by the page (an edit page's stored trade). */
  initialForm?: PostingTradeDetailWire | null;
  /** A stored trade the catalogue no longer offers: shown read-only, with no list or search. */
  lockedLabel?: string | null;
  /** The stored rung, shown with a locked trade when no form is available. */
  lockedLevel?: string | null;
  /** False for the AI chat, whose publish body only needs the catalogue. */
  loadForm?: boolean;
}

export function PostingTradePicker({
  id,
  label,
  hint,
  trades,
  problem,
  value,
  error,
  onChange,
  onFormLoaded,
  initialForm = null,
  lockedLabel = null,
  lockedLevel = null,
  loadForm = true,
}: PostingTradePickerProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadProblem, setLoadProblem] = useState<PostingTradesProblem | null>(null);
  const latest = useRef(0);
  const onLoaded = useRef(onFormLoaded);
  onLoaded.current = onFormLoaded;
  const locked = lockedLabel !== null && lockedLabel !== "";
  const initialKind = initialForm?.role_kind ?? null;

  useEffect(() => {
    if (locked) {
      setLoading(false);
      setLoadProblem(null);
      return;
    }
    if (!loadForm) return;
    if (value === "") {
      setLoading(false);
      setLoadProblem(null);
      onLoaded.current?.(null);
      return;
    }
    if (initialKind === value && initialForm !== null) {
      setLoading(false);
      setLoadProblem(null);
      onLoaded.current?.(initialForm);
      return;
    }
    const request = ++latest.current;
    setLoading(true);
    setLoadProblem(null);
    void loadPostingTradeFormCached(value).then((result) => {
      if (request !== latest.current) return;
      setLoading(false);
      if (result.ok) {
        onLoaded.current?.(result.trade);
        return;
      }
      setLoadProblem(result.problem);
      onLoaded.current?.(null);
    });
  }, [value, loadForm, locked, initialForm, initialKind]);

  if (locked) {
    return (
      <LockedTrade
        id={id}
        label={label}
        roleLabel={lockedLabel}
        level={lockedLevel}
        error={error}
      />
    );
  }

  if (trades.length === 0) {
    return <TradesUnavailable id={id} label={label} problem={problem} error={error} />;
  }

  const groups = tradeDepartmentGroups(trades, query);
  const selected = trades.find((trade) => trade.role_kind === value);
  const searchId = `${id}-search`;

  return (
    <div className="trade-picker">
      <Input
        id={searchId}
        label="Search trades"
        type="search"
        value={query}
        hint="Type part of a trade name to narrow the list."
        onChange={(e) => setQuery(e.target.value)}
      />
      <Select
        id={id}
        label={label}
        hint={hint}
        value={value}
        error={error}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— pick a trade —</option>
        {groups.map((group) => (
          <optgroup key={group.department} label={group.label}>
            {group.trades.map((trade) => (
              <option key={trade.role_kind} value={trade.role_kind}>
                {trade.role_label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      {selected !== undefined ? (
        <p id={`${id}-selection`} className="trade-picker__selection">
          Selected: {selected.role_label}
        </p>
      ) : null}
      {groups.length === 0 ? (
        <p className="trade-picker__status" role="status">
          No trade matches “{query.trim()}”.
        </p>
      ) : null}
      {loading ? (
        <p className="trade-picker__status" role="status">
          Loading trade details…
        </p>
      ) : null}
      {loadProblem !== null ? (
        <p className="bb-field__error" role="alert">
          {postingTradeFormProblemMessage(loadProblem)}
        </p>
      ) : null}
    </div>
  );
}

/** A stored trade the catalogue no longer offers: its label and rung stay visible, never editable. */
function LockedTrade({
  id,
  label,
  roleLabel,
  level,
  error,
}: {
  id: string;
  label: string;
  roleLabel: string;
  level: string | null;
  error?: string;
}) {
  const labelId = `${id}-label`;
  const feedbackId = fieldFeedbackId(id);
  return (
    <div className="bb-field">
      <span id={labelId} className="bb-field__label">
        {label}
      </span>
      <p
        id={id}
        tabIndex={-1}
        className="bb-field__readonly"
        aria-labelledby={labelId}
        aria-describedby={error ? feedbackId : undefined}
      >
        {roleLabel}
      </p>
      {level !== null && level !== "" ? (
        <p className="bb-field__hint">Level: {humaniseRungLabel(level)} — kept from the saved posting.</p>
      ) : (
        <p className="bb-field__hint">This trade is no longer offered; the saved role is kept.</p>
      )}
      <FieldFeedback id={feedbackId} error={error} />
    </div>
  );
}

/**
 * The picker's spot while the catalogue did not load: its label, the real cause and Retry, then
 * the role's inline error. The group carries the control id (`tabIndex={-1}`), so a refused
 * publish still moves focus here, and it is described by the cause and the refusal.
 */
function TradesUnavailable({
  id,
  label,
  problem,
  error,
}: {
  id: string;
  label: string;
  problem: PostingTradesProblem | null;
  error?: string;
}) {
  const labelId = `${id}-label`;
  const causeId = `${id}-cause`;
  const feedbackId = fieldFeedbackId(id);
  return (
    <div className="bb-field">
      <span id={labelId} className="bb-field__label">
        {label}
      </span>
      <div
        id={id}
        role="group"
        tabIndex={-1}
        className="alert alert--warning trade-picker__unavailable"
        aria-labelledby={labelId}
        aria-describedby={error ? `${causeId} ${feedbackId}` : causeId}
      >
        <Icon name="warning" className="alert__icon" />
        <div className="alert__text">
          <p id={causeId} className="alert__body">
            {postingTradesProblemMessage(problem)}
          </p>
        </div>
        <div className="alert__actions">
          <RetryButton />
        </div>
      </div>
      <FieldFeedback id={feedbackId} error={error} />
    </div>
  );
}
