"use client";

import { useState } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { candidateViewHref, type CandidateSearchQuery } from "../../../lib/candidate-search-model";
import type { SavedCandidateView } from "../../../lib/candidate-saved-views";

/**
 * Saved views for the Candidates data bank (A7, #2577) — both halves of "URL + local":
 *
 *  - COPY LINK is the URL half: the current filters, order, page and page size (never the search
 *    term, which is body-only) become a link another admin can open.
 *  - SAVE HERE is the local half: the same view — and, because localStorage never reaches a log
 *    or the API's URL, the search term too — under a name in this browser.
 *
 * A saved view replaces the list's query; Apply starts at page 1, because a view describes a
 * scope rather than a moment. Nothing here writes to the server.
 */
export function CandidateSavedViews({
  query,
  views,
  onApply,
  onSave,
  onRemove,
}: {
  query: CandidateSearchQuery;
  views: readonly SavedCandidateView[];
  onApply: (view: SavedCandidateView) => void;
  onSave: (name: string) => void;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    const href = candidateViewHref(query);
    const url = typeof window === "undefined" ? href : `${window.location.origin}${href}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="bank-views">
      <summary className="btn btn--ghost btn--sm">
        <Icon name={ACTION_ICON.disclosure} className="disclosure__caret" />
        Saved views{views.length > 0 ? ` (${views.length})` : ""}
      </summary>
      <div className="bank-views__panel">
        <div className="bank-views__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={copyLink}>
            <Icon name="link" />
            {copied ? "Link copied" : "Copy view link"}
          </button>
          <span className="field__help">
            A link keeps the filters, order and page size. A search term is never put in a URL.
          </span>
        </div>

        <form
          className="bank-views__save"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (trimmed === "") return;
            onSave(trimmed);
            setName("");
          }}
        >
          <label className="field">
            <span className="field__label">Save this view as</span>
            <input
              className="field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="Welders in Pune"
            />
          </label>
          <button className="btn btn--primary btn--sm" type="submit" disabled={name.trim() === ""}>
            Save view
          </button>
        </form>

        {views.length === 0 ? (
          <p className="empty">No saved views in this browser yet.</p>
        ) : (
          <ul className="bank-views__list">
            {views.map((view) => (
              <li className="bank-views__item" key={view.id}>
                <button type="button" className="bank-views__apply" onClick={() => onApply(view)}>
                  <span className="bank-views__name">{view.name}</span>
                  <span className="table__meta">
                    {view.q ? `Search: ${view.q} · ` : ""}
                    {view.page_size} per page
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => onRemove(view.id)}
                  aria-label={`Delete saved view ${view.name}`}
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
