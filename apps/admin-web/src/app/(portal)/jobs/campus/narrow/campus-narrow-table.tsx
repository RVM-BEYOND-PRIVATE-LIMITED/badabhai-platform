"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Overlay } from "../../../../../components/overlay";
import { formatDate, shortId, timestampTitle } from "../../../../../lib/format";
import { customerHref } from "../../../../../lib/customer";
import type { NarrowQueueItem } from "../../../../../lib/campus-narrow";
import {
  NARROWABLE_ROLE_KINDS,
  NARROWABLE_ROLE_LABELS,
  NARROW_DEFAULT_REASON,
  NARROW_REASON_CODES,
  NARROW_REASON_LABELS,
  narrowReasonValid,
  type NarrowLevels,
  type NarrowableRoleKind,
} from "../../../../../lib/campus-narrow-view";
import { readNarrowDescriptionAction, narrowTradeAction } from "./actions";

type DescriptionState =
  | { kind: "loading" }
  | { kind: "loaded"; text: string | null }
  | { kind: "error"; error: string };

/**
 * #3050 — the Campus narrow queue: job title, company, the Campus role text, when it was posted,
 * and one "Set trade" action per row.
 *
 * The dialog shows the job's description and exactly six machine trades, each with the optional
 * rungs of its own ladder. It closes only by its buttons (`dismissible={false}`): the decision is
 * explicit, like the trade-release switches. On a save that changes the job the row leaves the
 * queue; a refusal shows the server's own words and leaves the row in place.
 */
export function CampusNarrowTable({
  postings,
  levels,
}: {
  postings: NarrowQueueItem[];
  levels: NarrowLevels;
}) {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState<NarrowQueueItem | null>(null);
  const [roleKind, setRoleKind] = useState<NarrowableRoleKind>(NARROWABLE_ROLE_KINDS[0]);
  const [tradeLevel, setTradeLevel] = useState("");
  const [reasonCode, setReasonCode] = useState<(typeof NARROW_REASON_CODES)[number]>(
    NARROW_REASON_CODES[0],
  );
  const [reasonText, setReasonText] = useState(NARROW_DEFAULT_REASON);
  const [description, setDescription] = useState<DescriptionState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The job whose description is being read — a reply for an older row is discarded. */
  const reading = useRef<string | null>(null);

  const titleId = `${ids}-title`;
  const descId = `${ids}-description`;
  const levelChoices = levels[roleKind] ?? [];
  const valid = narrowReasonValid(reasonText);

  async function start(row: NarrowQueueItem): Promise<void> {
    setOpen(row);
    setError(null);
    setBusy(false);
    setRoleKind(NARROWABLE_ROLE_KINDS[0]);
    setTradeLevel("");
    setReasonCode(NARROW_REASON_CODES[0]);
    setReasonText(NARROW_DEFAULT_REASON);
    setDescription({ kind: "loading" });
    reading.current = row.posting_id;
    const res = await readNarrowDescriptionAction(row.posting_id);
    if (reading.current !== row.posting_id) return;
    setDescription(
      res.ok ? { kind: "loaded", text: res.description } : { kind: "error", error: res.error },
    );
  }

  async function save(): Promise<void> {
    if (!open || !valid) return;
    setBusy(true);
    const res = await narrowTradeAction({
      posting_id: open.posting_id,
      role_kind: roleKind,
      ...(tradeLevel ? { trade_level: tradeLevel } : {}),
      reason_code: reasonCode,
      reason_text: reasonText.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(null);
    router.refresh();
  }

  return (
    <>
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Job title</th>
              <th scope="col">Company</th>
              <th scope="col">Campus role</th>
              <th scope="col">Date posted</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {postings.map((row) => (
              <tr key={row.posting_id}>
                <td>
                  <Link href={`/jobs/${row.posting_id}`}>{row.title}</Link>
                  <span className="table__meta mono">{shortId(row.posting_id)}</span>
                </td>
                <td>
                  {row.company_id ? (
                    <Link href={customerHref(row.company_id)}>{row.company_label}</Link>
                  ) : (
                    row.company_label
                  )}
                </td>
                <td>{row.campus_role_text}</td>
                <td title={timestampTitle(row.posted_at)}>{formatDate(row.posted_at)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => void start(row)}
                  >
                    Set trade
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Overlay
        kind="dialog"
        open={open !== null}
        onClose={() => setOpen(null)}
        labelledBy={titleId}
        describedBy={descId}
        dismissible={false}
      >
        <div className="overlay__head">
          <div className="overlay__heading">
            <h2 className="overlay__title" id={titleId}>
              Set the machine trade
            </h2>
            <p className="overlay__sub" id={descId}>
              {open ? `${open.title} — ${open.company_label}` : ""}
            </p>
          </div>
        </div>
        <div className="overlay__body">
          <section aria-labelledby={`${ids}-job-text`}>
            <h3 className="panel__title" id={`${ids}-job-text`}>
              Job description
            </h3>
            {description.kind === "loading" ? (
              <p className="state__body">Reading the job…</p>
            ) : description.kind === "error" ? (
              <p className="state__body state--error">{description.error}</p>
            ) : description.text ? (
              <p className="prose__body">{description.text}</p>
            ) : (
              <p className="state__body">This job has no description.</p>
            )}
          </section>

          <label className="field" htmlFor={`${ids}-kind`}>
            <span className="field__label">
              Trade<span className="req">*</span>
            </span>
            <select
              id={`${ids}-kind`}
              className="field__input"
              value={roleKind}
              onChange={(e) => {
                setRoleKind(e.target.value as NarrowableRoleKind);
                setTradeLevel("");
              }}
            >
              {NARROWABLE_ROLE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {NARROWABLE_ROLE_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor={`${ids}-level`}>
            <span className="field__label">Level (optional)</span>
            <select
              id={`${ids}-level`}
              className="field__input"
              value={tradeLevel}
              disabled={levelChoices.length === 0}
              onChange={(e) => setTradeLevel(e.target.value)}
            >
              <option value="">No level</option>
              {levelChoices.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor={`${ids}-reason-code`}>
            <span className="field__label">Reason</span>
            <select
              id={`${ids}-reason-code`}
              className="field__input"
              value={reasonCode}
              onChange={(e) =>
                setReasonCode(e.target.value as (typeof NARROW_REASON_CODES)[number])
              }
            >
              {NARROW_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {NARROW_REASON_LABELS[code]}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor={`${ids}-reason-text`}>
            <span className="field__label">
              Why<span className="req">*</span>
            </span>
            <textarea
              id={`${ids}-reason-text`}
              className="field__input"
              rows={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
            />
            <span className="field__hint">
              At least 15 characters. Stored in the audit trail with your admin id.
            </span>
          </label>

          {error ? (
            <div className="alert alert--danger notice notice--inline" role="status">
              {error}
            </div>
          ) : null}
        </div>
        <div className="overlay__foot">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => setOpen(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !valid}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save trade"}
          </button>
        </div>
      </Overlay>
    </>
  );
}
