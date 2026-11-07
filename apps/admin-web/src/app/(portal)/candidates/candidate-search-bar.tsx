"use client";

import { useEffect, useRef, useState } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The Candidates universal search (A7, #2577). One box over every field: labels, a full phone
 * number and name words, matched by the API's own `POST /admin/candidates/search`.
 *
 *  - 300ms DEBOUNCE: a term is sent when typing pauses, or at once on Enter (the form's submit).
 *  - BODY ONLY: the term is a prop of the list's POST; it is never written to the address bar,
 *    a route or a log line (ADR-0062 §3.6). A reload starts from the filters in the URL, not
 *    from what someone typed — the local saved views are where a term can be kept.
 *  - The input's displayed value is owned here, but a view change (Clear, a saved view) lands
 *    through `value` and replaces it without remounting, so focus is never dropped.
 */
export function CandidateSearchBar({
  value,
  onSearch,
  disabled = false,
}: {
  /** The committed term (the list's current one). */
  value: string;
  onSearch: (q: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A term set from outside (Clear filters, a saved view) replaces the field in place, and the
  // scheduled term it replaces must not fire afterwards.
  if (value !== synced) {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSynced(value);
    setText(value);
  }

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function schedule(next: string) {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onSearch(next.trim());
    }, 300);
  }

  function change(next: string) {
    setText(next);
    schedule(next);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    onSearch(text.trim());
  }

  function clear() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setText("");
    onSearch("");
  }

  return (
    <form className="bank-search" role="search" onSubmit={submit}>
      <label className="field bank-search__field">
        <span className="field__label">Search candidates</span>
        <span className="bank-search__input">
          <Icon name="magnifying-glass" className="bank-search__icon" />
          <input
            className="field__input"
            type="search"
            value={text}
            onChange={(e) => change(e.target.value)}
            placeholder="Name, phone, trade, city, skill…"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            maxLength={200}
          />
          {text !== "" ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm bank-search__clear"
              onClick={clear}
            >
              <Icon name={ACTION_ICON.clearFilters} />
              Clear search
            </button>
          ) : null}
        </span>
        <span className="field__help">
          Searches every field at once. The term stays out of the address bar and is sent only to
          the search service.
        </span>
      </label>
      <button className="btn btn--primary" type="submit" disabled={disabled}>
        <Icon name="magnifying-glass" />
        Search
      </button>
    </form>
  );
}
