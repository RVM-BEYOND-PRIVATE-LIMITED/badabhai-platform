"use client";

import { useState } from "react";
import Link from "next/link";
import { jobRoleLabel } from "@badabhai/types";
import { StatusPill } from "../../../../components/status-pill";
import type { AudienceListItem } from "../../../../lib/job-audience";
import { SHOWN_TO_LABELS, openingsLabel } from "../../../../lib/job-audience-vocabulary";
import { AudienceChoice } from "./audience-choice";
import type { AudienceDecisionOutcome } from "./actions";

/**
 * #2958 — the "where jobs show" list: one row per live job, a checkbox each, and one decision for
 * the selection. The openings band is in its own column because it usually decides the choice:
 * a few openings in a trade RVM trains → Campus only; many → Campus and BadaBhai.
 */
export function AudienceTable({ rows }: { rows: readonly AudienceListItem[] }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, string>>(new Map());
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.posting_id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const decided = (outcome: AudienceDecisionOutcome) => {
    setOutcomes(new Map((outcome.results ?? []).map((r) => [r.postingId, r.message])));
    setSelected(new Set());
  };

  return (
    <section className="panel">
      <div className="panel__head">
        <div className="panel__text">
          <h2 className="panel__title">Decide for the selected jobs</h2>
          <p className="panel__sub">{selected.size} selected. Each job keeps its own outcome.</p>
        </div>
      </div>
      <div className="panel__body">
        <AudienceChoice
          postingIds={[...selected]}
          shownTo={null}
          {...(selected.size === 0 ? { disabledReason: "Select one or more jobs first." } : {})}
          onDecided={decided}
        />
      </div>
      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">Jobs and where they show</caption>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  aria-label="Select every job on this page"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.posting_id)))
                  }
                />
              </th>
              <th scope="col">Job</th>
              <th scope="col">Trade</th>
              <th scope="col">Openings</th>
              <th scope="col">Shown to</th>
              <th scope="col">RVM review</th>
              <th scope="col">Decided</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.posting_id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    checked={selected.has(row.posting_id)}
                    onChange={() => toggle(row.posting_id)}
                  />
                </td>
                <td>
                  <Link className="table__link" href={`/jobs/${row.posting_id}`}>
                    {row.title}
                  </Link>
                  <span className="table__meta">
                    {row.company_label}
                    {row.city ? ` · ${row.city}` : ""}
                    {row.campus_origin ? " · from Campus" : ""}
                    {row.hidden ? " · hidden" : ""}
                  </span>
                  {outcomes.has(row.posting_id) ? (
                    <span className="table__meta" role="status">
                      {outcomes.get(row.posting_id)}
                    </span>
                  ) : null}
                </td>
                <td>
                  {row.role_kind ? (jobRoleLabel(row.role_kind) ?? row.role_kind) : "No trade"}
                  <span className="table__meta">
                    {row.taught_at_campus ? "RVM trains it" : "Not an RVM trade"}
                  </span>
                </td>
                <td>{openingsLabel(row.vacancy_band)}</td>
                <td>
                  <StatusPill
                    value={SHOWN_TO_LABELS[row.shown_to]}
                    tone={row.shown_to === "nobody" ? "warn" : "muted"}
                  />
                </td>
                <td>{row.rvm_review_state ?? "—"}</td>
                <td>
                  {row.decided_at ? new Date(row.decided_at).toLocaleDateString("en-IN") : "Not yet"}
                  {row.changed_since_decision ? (
                    <span className="table__meta">Changed by the company since</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
