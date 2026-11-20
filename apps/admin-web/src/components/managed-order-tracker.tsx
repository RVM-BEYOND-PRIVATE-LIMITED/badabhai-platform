"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addInterestAction, removeInterestAction } from "./managed-hiring-actions";
import type { AdminManagedOrderDetail } from "../lib/managed-hiring";

/** #2751 — the desk's tracker actions: add a phone-confirmed worker with a note, or remove one. */
export function ManagedOrderTracker({ order }: { order: AdminManagedOrderDetail }) {
  const router = useRouter();
  const [workerId, setWorkerId] = useState("");
  const [note, setNote] = useState("");
  const [removeId, setRemoveId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(): Promise<void> {
    setBusy(true);
    const res = await addInterestAction(order.order_id, workerId.trim(), note.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setWorkerId("");
    setNote("");
    router.refresh();
  }

  async function remove(): Promise<void> {
    setBusy(true);
    const res = await removeInterestAction(order.order_id, removeId.trim(), reason.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setRemoveId("");
    setReason("");
    router.refresh();
  }

  return (
    <div className="panel-section">
      <h2 className="panel__title">Tracker</h2>
      <ul>
        {order.workers.map((w) => (
          <li key={w.worker_id}>
            <span className="mono">{w.worker_id}</span>
            {w.note ? <span className="panel__sub"> · {w.note}</span> : null}
          </li>
        ))}
      </ul>
      <div className="field">
        <label className="field" htmlFor="mh-worker">
          <span className="field__label">Worker id</span>
          <input
            id="mh-worker"
            className="field__input"
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value)}
          />
        </label>
        <label className="field" htmlFor="mh-note">
          <span className="field__label">Note (15–500)</span>
          <textarea
            id="mh-note"
            className="field__input"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          className="btn btn--primary btn--sm"
          type="button"
          disabled={busy || !workerId.trim() || note.trim().length < 15}
          onClick={() => void add()}
        >
          Add worker
        </button>
      </div>
      <div className="field">
        <label className="field" htmlFor="mh-remove">
          <span className="field__label">Remove a worker</span>
          <select
            id="mh-remove"
            className="field__input"
            value={removeId}
            onChange={(e) => setRemoveId(e.target.value)}
          >
            <option value="">Choose…</option>
            {order.workers.map((w) => (
              <option key={w.worker_id} value={w.worker_id}>
                {w.worker_id}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="mh-reason">
          <span className="field__label">Reason (15–500)</span>
          <input
            id="mh-reason"
            className="field__input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          disabled={busy || !removeId || reason.trim().length < 15}
          onClick={() => void remove()}
        >
          Remove
        </button>
      </div>
      {error ? <p className="field__hint">{error}</p> : null}
    </div>
  );
}
