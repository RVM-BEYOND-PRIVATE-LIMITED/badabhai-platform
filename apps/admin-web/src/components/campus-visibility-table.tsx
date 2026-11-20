"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusPill } from "./status-pill";
import {
  setCampusVisibilityAction,
  setCampusVisibilityBulkAction,
  type CampusResult,
} from "./campus-visibility-actions";
import type { CampusPosting } from "../lib/campus-visibility";
import { campusOutcomeCopy } from "../lib/campus-visibility-view";
import { POSTING_REASON_CODES, POSTING_REASON_LABELS, type PostingReasonCode } from "../lib/company-vocabulary";
import { formatTimestamp, shortId } from "../lib/format";

/**
 * #2891 — the Campus jobs visibility table: checkboxes, one show/hide per row and in bulk, each
 * with a reason code + text. Every row's outcome is shown individually; never one "done" for a
 * batch.
 */
export function CampusVisibilityTable({ postings }: { postings: CampusPosting[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"on" | "off">("on");
  const [reasonCode, setReasonCode] = useState<PostingReasonCode>(POSTING_REASON_CODES[0]);
  const [reasonText, setReasonText] = useState("");
  const [asking, setAsking] = useState<{ ids: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CampusResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reasonValid = reasonText.trim().length >= 15 && reasonText.trim().length <= 500;

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply(ids: string[], nextState: "on" | "off"): Promise<void> {
    setBusy(true);
    const res =
      ids.length === 1
        ? await setCampusVisibilityAction(ids[0]!, nextState, reasonCode, reasonText.trim())
        : await setCampusVisibilityBulkAction(ids, nextState, reasonCode, reasonText.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setResults(res.results);
    setAsking(null);
    setReasonText("");
    setSelected(new Set());
    router.refresh();
  }

  const outcomes = new Map(results.map((r) => [r.posting_id, r.outcome]));

  return (
    <>
      <div className="state__actions">
        <button
          className="btn btn--primary btn--sm"
          type="button"
          disabled={selected.size === 0}
          onClick={() => {
            setState("on");
            setAsking({ ids: [...selected] });
          }}
        >
          Show to workers
        </button>
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          disabled={selected.size === 0}
          onClick={() => {
            setState("off");
            setAsking({ ids: [...selected] });
          }}
        >
          Hide from workers
        </button>
      </div>

      {asking ? (
        <div className="panel-section">
          <h3 className="panel__title">
            {state === "on" ? "Show" : "Hide"} {asking.ids.length} job
            {asking.ids.length === 1 ? "" : "s"}
          </h3>
          <label className="field" htmlFor="campus-reason-code">
            <span className="field__label">Reason code</span>
            <select
              id="campus-reason-code"
              className="field__input"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as PostingReasonCode)}
            >
              {POSTING_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {POSTING_REASON_LABELS[code]}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="campus-reason-text">
            <span className="field__label">
              Reason<span className="req">*</span>
            </span>
            <textarea
              id="campus-reason-text"
              className="field__input"
              rows={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="15–500 characters, no phone or email"
            />
          </label>
          <div className="state__actions">
            <button
              className="btn btn--primary btn--sm"
              type="button"
              disabled={busy || !reasonValid}
              onClick={() => void apply(asking.ids, state)}
            >
              Confirm
            </button>
            <button className="btn btn--ghost btn--sm" type="button" onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
          {error ? <p className="field__hint">{error}</p> : null}
        </div>
      ) : null}

      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">Campus jobs BadaBhai worker visibility</caption>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={selected.size === postings.length && postings.length > 0}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(postings.map((p) => p.posting_id)) : new Set())
                  }
                />
              </th>
              <th scope="col">Job</th>
              <th scope="col">Company</th>
              <th scope="col">City</th>
              <th scope="col">Status</th>
              <th scope="col">RVM review</th>
              <th scope="col">Trade</th>
              <th scope="col">Arrived</th>
              <th scope="col">Workers</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {postings.map((p) => {
              const outcome = outcomes.get(p.posting_id);
              return (
                <tr key={p.posting_id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.title}`}
                      checked={selected.has(p.posting_id)}
                      onChange={() => toggle(p.posting_id)}
                    />
                  </td>
                  <td>
                    <Link href={`/jobs/${p.posting_id}`}>{p.title}</Link>
                    {p.hidden ? <span className="tag">Hidden</span> : null}
                  </td>
                  <td>{p.company_label || (p.company_id ? shortId(p.company_id) : "—")}</td>
                  <td>{p.city ?? "—"}</td>
                  <td>
                    <StatusPill value={p.status} />
                  </td>
                  <td>{p.rvm_review_state ?? "—"}</td>
                  <td>
                    {p.role_kind ?? "No trade"}
                    {!p.trade_ready ? (
                      <Link className="table__meta" href={`/jobs/${p.posting_id}`}>
                        {" "}
                        Set trade
                      </Link>
                    ) : null}
                  </td>
                  <td>{formatTimestamp(p.arrived_at)}</td>
                  <td>
                    <StatusPill
                      value={p.worker_visibility}
                      label={p.worker_visibility === "on" ? "Shown" : "Hidden"}
                      tone={p.worker_visibility === "on" ? "ok" : "warn"}
                    />
                  </td>
                  <td>
                    <button
                      className="btn btn--ghost btn--sm"
                      type="button"
                      disabled={p.worker_visibility === "off" && !p.trade_ready}
                      onClick={() => {
                        setState(p.worker_visibility === "on" ? "off" : "on");
                        setAsking({ ids: [p.posting_id] });
                      }}
                    >
                      {p.worker_visibility === "on" ? "Hide" : "Show"}
                    </button>
                    {outcome ? (
                      <span className="table__meta"> {campusOutcomeCopy(outcome)}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
