"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Overlay } from "../../../components/overlay";
import { HeldRolesPanel } from "./held-roles-panel";
import type { TradeReleaseRow } from "../../../lib/trade-release";
import {
  TRADE_STATUS_FILTERS,
  TRADE_STATUS_FILTER_LABELS,
  departmentGroups,
  filterTradeRows,
  tradeKindLabel,
  tradeWhen,
  type TradeStatusFilter,
} from "../../../lib/trade-release-view";
import { updateTradeReleaseAction } from "./actions";

type SwitchField = "posting" | "form";

interface Change {
  row: TradeReleaseRow;
  field: SwitchField;
  next: boolean;
}

const FIELD_WORDS: Record<SwitchField, string> = {
  posting: "posting",
  form: "the form hand-over",
};

function changeTitle(change: Change): string {
  return `Turn ${FIELD_WORDS[change.field]} ${change.next ? "on" : "off"} for ${change.row.role_label}`;
}

/**
 * #3023 — the trade catalogue: every declared trade, the two release switches, and the held
 * Campus roles. Rows are shown in the server's order (department, then pack order) and the two
 * filters only narrow that list; they never re-sort it. A switch opens an explicit dialog, and
 * that dialog closes only by Cancel or Confirm — never by a scrim click or Escape.
 */
export function TradesScreen({
  rows: initialRows,
  canWrite,
  held,
  heldState,
}: {
  rows: readonly TradeReleaseRow[];
  canWrite: boolean;
  held: readonly { role_label: string; count: number }[];
  heldState: "ready" | "off" | "error";
}) {
  const router = useRouter();
  const [rows, setRows] = useState<TradeReleaseRow[]>([...initialRows]);
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState<TradeStatusFilter>("all");
  const [change, setChange] = useState<Change | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const titleId = useId();
  const descriptionId = useId();

  const groups = departmentGroups(rows);
  const visible = filterTradeRows(rows, { department, status });

  function ask(row: TradeReleaseRow, field: SwitchField) {
    if (!canWrite || busy) return;
    setError(null);
    setChange({
      row,
      field,
      next: field === "posting" ? !row.posting_enabled : !row.form_enabled,
    });
  }

  function cancel() {
    if (busy) return;
    setChange(null);
    setError(null);
  }

  async function confirm() {
    if (!change || busy) return;
    setBusy(true);
    setError(null);
    const result = await updateTradeReleaseAction(
      change.field === "posting"
        ? { roleKind: change.row.role_kind, postingEnabled: change.next }
        : { roleKind: change.row.role_kind, formEnabled: change.next },
    );
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    setRows((current) =>
      current.map((row) => (row.role_kind === result.row.role_kind ? result.row : row)),
    );
    setAnnouncement(`${changeTitle(change)} — saved.`);
    setChange(null);
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <section className="panel" aria-labelledby="trades-heading">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="trades-heading">
              All declared trades
            </h2>
            <p className="panel__sub">
              {visible.length} of {rows.length} trade{rows.length === 1 ? "" : "s"} shown.
              {canWrite
                ? " Changing a switch asks for confirmation first."
                : " Your role can read the catalogue but not change it."}
            </p>
          </div>
        </div>
        <div className="panel__body">
          <div className="filters">
            <label className="field">
              <span className="field__label">Department</span>
              <select
                className="field__input"
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
              >
                <option value="">All departments</option>
                {groups.map((group) => (
                  <option key={group.department} value={group.department}>
                    {group.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Status</span>
              <select
                className="field__input"
                value={status}
                onChange={(event) => setStatus(event.target.value as TradeStatusFilter)}
              >
                {TRADE_STATUS_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {TRADE_STATUS_FILTER_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="field__help" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="state">
            <h3 className="state__title">No trades declared yet</h3>
            <p className="state__body">
              The catalogue is empty. Trades appear here once the backend declares them.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="state">
            <h3 className="state__title">No trades match these filters</h3>
            <p className="state__body">
              Nothing matches the department and status currently chosen. Widen them to see the
              whole catalogue.
            </p>
            <div className="state__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setDepartment("");
                  setStatus("all");
                }}
              >
                Clear filters
              </button>
            </div>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Declared trades and their release switches</caption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col">Department</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Wave</th>
                  <th scope="col">Posting on</th>
                  <th scope="col">Form hand-over on</th>
                  <th scope="col">Last changed by</th>
                  <th scope="col">When</th>
                  <th scope="col">Posting</th>
                  <th scope="col">Form</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.role_kind}>
                    <td>
                      <span className="mono">{row.role_kind}</span>
                    </td>
                    <td>{row.role_label}</td>
                    <td>{row.department_label}</td>
                    <td>{tradeKindLabel(row.kind)}</td>
                    <td>{row.wave === null ? "—" : row.wave}</td>
                    <td>
                      {row.posting_changed_at ? (
                        <time dateTime={row.posting_changed_at}>
                          {tradeWhen(row.posting_changed_at)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {row.form_changed_at ? (
                        <time dateTime={row.form_changed_at}>
                          {tradeWhen(row.form_changed_at)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{row.updated_by ?? "—"}</td>
                    <td>
                      {row.updated_at ? (
                        <time dateTime={row.updated_at}>{tradeWhen(row.updated_at)}</time>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className="switch-row">
                        <button
                          type="button"
                          role="switch"
                          className="switch"
                          aria-checked={row.posting_enabled}
                          aria-label={`Posting for ${row.role_label}`}
                          disabled={!canWrite || busy}
                          onClick={() => ask(row, "posting")}
                        >
                          <span className="switch__thumb" aria-hidden="true" />
                        </button>
                        <span className="switch-row__state">
                          {row.posting_enabled ? "On" : "Off"}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="switch-row">
                        <button
                          type="button"
                          role="switch"
                          className="switch"
                          aria-checked={row.form_enabled}
                          aria-label={`Form hand-over for ${row.role_label}`}
                          disabled={!canWrite || busy}
                          onClick={() => ask(row, "form")}
                        >
                          <span className="switch__thumb" aria-hidden="true" />
                        </button>
                        <span className="switch-row__state">
                          {row.form_enabled ? "On" : "Off"}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <HeldRolesPanel roles={held} state={heldState} />

      <Overlay
        kind="dialog"
        open={change !== null}
        onClose={cancel}
        labelledBy={titleId}
        describedBy={descriptionId}
        dismissible={false}
      >
        <div className="overlay__head">
          <div className="overlay__heading">
            <h2 className="overlay__title" id={titleId}>
              {change ? changeTitle(change) : "Change a trade switch"}
            </h2>
            <p className="overlay__sub" id={descriptionId}>
              {change
                ? `${change.row.department_label} · ${change.row.role_kind}. The change is stored with your admin id in the audit trail.`
                : ""}
            </p>
          </div>
        </div>
        <div className="overlay__body">
          {error ? (
            <div className="alert alert--danger notice notice--inline" role="status">
              {error}
            </div>
          ) : (
            <p className="state__body">
              The switch is unchanged until you confirm. Cancel leaves it as it is.
            </p>
          )}
        </div>
        <div className="overlay__foot">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </Overlay>
    </>
  );
}
