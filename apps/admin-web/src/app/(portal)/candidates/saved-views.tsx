"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CANDIDATE_SAVED_VIEWS_KEY,
  parseSavedViews,
  type CandidateSavedView,
} from "../../../lib/candidate-search";

/**
 * Saved views (A7, #2577) — the operator's named filter sets.
 *
 * A view stores the list address's query (filters, sort and page size) in THIS browser's
 * localStorage; the address itself stays shareable on its own. What is stored never holds a
 * search term: views are URL-safe by construction (`savedViewQuery` drops the page and never
 * takes a term). Storage is guarded like the grid preferences — disabled or full storage
 * keeps the views in memory for this page's life.
 */
function readViews(): CandidateSavedView[] {
  try {
    if (typeof window === "undefined") return [];
    return parseSavedViews(window.localStorage.getItem(CANDIDATE_SAVED_VIEWS_KEY));
  } catch {
    return [];
  }
}

function writeViews(views: CandidateSavedView[]): void {
  try {
    window.localStorage.setItem(CANDIDATE_SAVED_VIEWS_KEY, JSON.stringify(views));
  } catch {
    // Disabled or full: the views hold in memory for this page's life.
  }
}

export function CandidateSavedViews({ currentQuery }: { currentQuery: string }) {
  const [views, setViews] = useState<CandidateSavedView[]>(() => readViews());
  const [name, setName] = useState("");
  const canSave = currentQuery.length > 0 && name.trim().length > 0;

  function save() {
    const clean = name.trim().slice(0, 60);
    if (!clean || !currentQuery) return;
    const next = [...views.filter((v) => v.name !== clean), { name: clean, query: currentQuery }].slice(-20);
    setViews(next);
    writeViews(next);
    setName("");
  }

  function remove(view: string) {
    const next = views.filter((v) => v.name !== view);
    setViews(next);
    writeViews(next);
  }

  return (
    <div className="filters">
      <label className="field">
        <span className="field__label">Name this view</span>
        <input
          className="field__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Welders in Pune"
          maxLength={60}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <div className="filters__actions">
        <button className="btn btn--ghost" type="button" disabled={!canSave} onClick={save}>
          Save view
        </button>
      </div>
      {views.length > 0 ? (
        <div className="segmented" role="group" aria-label="Saved views">
          {views.map((v) => (
            <span key={v.name}>
              <Link className="btn btn--ghost btn--sm" href={v.query ? `/candidates?${v.query}` : "/candidates"}>
                {v.name}
              </Link>{" "}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label={`Remove saved view ${v.name}`}
                onClick={() => remove(v.name)}
              >
                Remove
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="table__meta">No saved views yet — name the current filters to keep them.</p>
      )}
    </div>
  );
}
