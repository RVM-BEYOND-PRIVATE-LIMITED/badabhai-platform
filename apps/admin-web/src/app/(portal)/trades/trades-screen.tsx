"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Overlay } from "../../../components/overlay";
import { HeldRolesPanel } from "./held-roles-panel";
import type { TradeRelease, TradeRow } from "../../../lib/trade-release";
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
  row: TradeRow;
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
 * Campus roles. Rows are shown in catalogue order and the two filters only narrow that list;
 * they never re-sort it. A switch opens an explicit dialog, and that dialog closes only by Cancel
 * or Confirm — never by a scrim click or Escape. Without `manage_trade_release` (#3067) the API
 * lets this session read neither switch, so the list is the catalogue alone: no switch columns,
 * no status filter.
 */
export function TradesScreen({
  rows: initialRows,
  canManage,
  held,
  heldState,
}: {
  rows: readonly TradeRow[];
  canManage: boolean;
  held: readonly { role_label: string; count: number }[];
  heldState: "ready" | "off" | "error";
}) {
  const router = useRouter();
  const [rows, setRows] = useState<TradeRow[]>([...initialRows]);
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

  function ask(row: TradeRow, field: SwitchField) {
    if (!canManage || busy || !row.release) return;
    setError(null);
    setChange({
      row,
      field,
      next: field === "posting" ? !row.release.posting_enabled : !row.release.form_enabled,
    });
  }

  function cancel() {
    if (busy) return;
    setChange(null);
    setError(null);
  }

  async function confirm() {
    const release = change?.row.release;
    if (!change || !release || busy) return;
    setBusy(true);
    setError(null);
    // The API sets both flags at once: the one being changed, and the other as it stands.
    const result = await updateTradeReleaseAction({
      roleKind: change.row.role_kind,
      postingEnabled: change.field === "posting" ? change.next : release.posting_enabled,
      formEnabled: change.field === "form" ? change.next : release.form_enabled,
    });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    setRows((current) =>
      current.map((row) =>
        row.role_kind === result.release.role_kind ? { ...row, release: result.release } : row,
      ),
    );
    setAnnouncement(`${changeTitle(change)} — saved.`);
    setChange(null);
    setBusy(false);
    router.refresh();
  }

  /** The four switch cells of one row: who last changed it, when, and the two switches. */
  function releaseCells(row: TradeRow, release: TradeRelease) {
    return (
      <>
        <td>{release.updated_by ?? "—"}</td>
        <td>
          {release.updated_at ? (
            <time dateTime={release.updated_at}>{tradeWhen(release.updated_at)}</time>
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
              aria-checked={release.posting_enabled}
              aria-label={`Posting for ${row.role_label}`}
              disabled={busy}
              onClick={() => ask(row, "posting")}
            >
              <span className="switch__thumb" aria-hidden="true" />
            </button>
            <span className="switch-row__state">{release.posting_enabled ? "On" : "Off"}</span>
          </span>
        </td>
        <td>
          <span className="switch-row">
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={release.form_enabled}
              aria-label={`Form hand-over for ${row.role_label}`}
              disabled={busy}
              onClick={() => ask(row, "form")}
            >
              <span className="switch__thumb" aria-hidden="true" />
            </button>
            <span className="switch-row__state">{release.form_enabled ? "On" : "Off"}</span>
          </span>
        </td>
      </>
    );
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
              {canManage
                ? " Changing a switch asks for confirmation first."
                : " Only a super admin can see and change the release switches."}
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
                    {group.department}
                  </option>
                ))}
              </select>
            </label>
            {canManage ? (
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
            ) : null}
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
                  {canManage ? (
                    <>
                      <th scope="col">Last changed by</th>
                      <th scope="col">When</th>
                      <th scope="col">Posting</th>
                      <th scope="col">Form</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.role_kind}>
                    <td>
                      <span className="mono">{row.role_kind}</span>
                    </td>
                    <td>{row.role_label}</td>
                    <td>{row.department}</td>
                    <td>{tradeKindLabel(row.kind)}</td>
                    <td>{row.wave === null ? "—" : row.wave}</td>
                    {canManage && row.release ? releaseCells(row, row.release) : null}
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
                ? `${change.row.department} · ${change.row.role_kind}. The change is stored with your admin id in the audit trail.`
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
