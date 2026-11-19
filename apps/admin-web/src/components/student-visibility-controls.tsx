"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  setBulkVisibilityAction,
  setStudentVisibilityAction,
} from "./student-visibility-actions";
import type { BulkSelector } from "../lib/students";

function ReasonBox({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
}) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">
        Reason<span className="req">*</span>
      </span>
      <input
        id={id}
        className="field__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="15–500 characters"
        minLength={15}
        maxLength={500}
      />
    </label>
  );
}

/** One row's on/off switch, asking for the reason before it writes. */
export function StudentVisibilitySwitch({
  workerId,
  visible,
}: {
  workerId: string;
  visible: boolean;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: boolean): Promise<void> {
    setBusy(true);
    const res = await setStudentVisibilityAction(workerId, next, reason.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAsking(false);
    setReason("");
    setError(null);
    router.refresh();
  }

  return (
    <div>
      {asking ? (
        <div className="field">
          <ReasonBox id={`reason-${workerId}`} value={reason} onChange={setReason} />
          <div className="state__actions">
            <button
              className="btn btn--primary btn--sm"
              type="button"
              disabled={busy || reason.trim().length < 15}
              onClick={() => void save(!visible)}
            >
              {visible ? "Hide" : "Show"}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              onClick={() => setAsking(false)}
            >
              Cancel
            </button>
          </div>
          {error ? <p className="field__hint">{error}</p> : null}
        </div>
      ) : (
        <button className="btn btn--ghost btn--sm" type="button" onClick={() => setAsking(true)}>
          {visible ? "Hide" : "Show"}
        </button>
      )}
    </div>
  );
}

/** The one-selector bulk action: import run, branch or course. */
export function BulkVisibilityControl({
  batches,
  branches,
  courses,
}: {
  batches: string[];
  branches: string[];
  courses: string[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<BulkSelector["kind"]>("batch_id");
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = kind === "batch_id" ? batches : kind === "branch" ? branches : courses;

  async function run(): Promise<void> {
    setBusy(true);
    setResult(null);
    const res = await setBulkVisibilityAction({ kind, value }, visible, reason.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setResult(`${res.changed} student${res.changed === 1 ? "" : "s"} changed.`);
    router.refresh();
  }

  return (
    <div className="panel-section">
      <h2 className="panel__title">Show / hide a whole group</h2>
      <p className="panel__sub">Name exactly one selector. A repeat changes none.</p>
      <div className="field">
        <label className="field" htmlFor="bulk-kind">
          <span className="field__label">Selector</span>
          <select
            id="bulk-kind"
            className="field__input"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as BulkSelector["kind"]);
              setValue("");
            }}
          >
            <option value="batch_id">Import run</option>
            <option value="branch">Branch</option>
            <option value="course">Course</option>
          </select>
        </label>
        <label className="field" htmlFor="bulk-value">
          <span className="field__label">Value</span>
          <select
            id="bulk-value"
            className="field__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="bulk-visible">
          <span className="field__label">Change to</span>
          <select
            id="bulk-visible"
            className="field__input"
            value={visible ? "show" : "hide"}
            onChange={(e) => setVisible(e.target.value === "show")}
          >
            <option value="show">Show to companies</option>
            <option value="hide">Hide from companies</option>
          </select>
        </label>
        <ReasonBox id="bulk-reason" value={reason} onChange={setReason} />
        <button
          className="btn btn--primary btn--sm"
          type="button"
          disabled={busy || !value || reason.trim().length < 15}
          onClick={() => void run()}
        >
          Apply
        </button>
        {result ? <p className="panel__sub" role="status">{result}</p> : null}
        {error ? <p className="field__hint">{error}</p> : null}
      </div>
    </div>
  );
}
