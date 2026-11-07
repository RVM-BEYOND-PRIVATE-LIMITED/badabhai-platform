"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  UNIVERSAL_SEARCH_DEBOUNCE_MS,
  candidateSearchBody,
  normalizeSearchTerm,
  parseCandidateSearchParams,
} from "../../../lib/candidate-search";
import { candidateIdTitle } from "../../../lib/candidate-view";
import { displayName } from "../../../lib/identity";
import { formatCount } from "../../../lib/format";

/**
 * The universal search box (A7, #2577) — one box over every field of the data bank.
 *
 * ── THE TERM NEVER TOUCHES THE URL ────────────────────────────────────────────────
 * The debounced term is POSTed to the same-origin `candidates/search` route, in the body
 * only (ADR-0062 §3.6: the term must never reach a log line, and access logs record URLs).
 * The list under it stays the bare-filters list from the address; the box answers a
 * dropdown of the top matches, each opening the drawer (`?c=<id>`, filters kept).
 *
 * ── TIMING ────────────────────────────────────────────────────────────────────────
 * 300ms after the last keystroke the search runs (`UNIVERSAL_SEARCH_DEBOUNCE_MS`); an
 * in-flight search is aborted when the term moves on. Escape clears and closes. The
 * dropdown reuses the chooser panel (`grid-menu__panel`), so it opens on the same 140ms
 * fade and needs no style of its own.
 */
interface SlimCandidate {
  worker_id: string;
  name?: string | null;
  status: string | null;
  current_city: string | null;
  current_state: string | null;
  trade_label: string | null;
  profile_status: string | null;
}

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "ok"; total: number; q_type: "name" | "phone" | null; candidates: SlimCandidate[] }
  | { status: "signed_out" | "forbidden" | "error" };

function narrowBody(body: unknown): SearchState {
  if (typeof body !== "object" || body === null) return { status: "error" };
  const { status, total, q_type, candidates } = body as {
    status?: unknown;
    total?: unknown;
    q_type?: unknown;
    candidates?: unknown;
  };
  if (status !== "ok") {
    if (status === "signed_out" || status === "forbidden") return { status };
    return { status: "error" };
  }
  if (typeof total !== "number" || !Array.isArray(candidates)) {
    return { status: "error" };
  }
  return {
    status: "ok",
    total,
    q_type: q_type === "name" || q_type === "phone" ? q_type : null,
    candidates: candidates.filter(isSlim),
  };
}

function isSlim(c: unknown): c is SlimCandidate {
  return (
    typeof c === "object" && c !== null && typeof (c as { worker_id?: unknown }).worker_id === "string"
  );
}

/** Where a result row leads: this list with `?c=<id>`, every filter and the page kept. */
function resultHref(search: string, workerId: string): string {
  const q = new URLSearchParams(search);
  q.set("c", workerId);
  const s = q.toString();
  return s ? `/candidates?${s}` : `/candidates?c=${encodeURIComponent(workerId)}`;
}

const EMPTY_SEARCH = { status: "idle" } as const;

export function CandidateSearchBox() {
  const params = useSearchParams();
  const [term, setTerm] = useState("");
  const [state, setState] = useState<SearchState>(EMPTY_SEARCH);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listId = useId();
  const query = params.toString();

  // The debounced search: 300ms after the last keystroke, POST the term with the page's
  // filters. An in-flight search is aborted when the term moves on.
  useEffect(() => {
    const q = normalizeSearchTerm(term);
    if (!q) {
      abortRef.current?.abort();
      setState(EMPTY_SEARCH);
      setOpen(false);
      return;
    }
    setState({ status: "searching" });
    setOpen(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      const parsed = parseCandidateSearchParams(Object.fromEntries(new URLSearchParams(query)));
      const body = candidateSearchBody(parsed, q);
      fetch("/candidates/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      })
        .then(async (res) => narrowBody(await res.json().catch(() => null)))
        .then((next) => {
          if (!abort.signal.aborted) setState(next);
        })
        .catch(() => {
          if (!abort.signal.aborted) setState({ status: "error" });
        });
    }, UNIVERSAL_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, query]);

  // Escape clears and closes; a pointer outside the box closes. The panel is
  // `visibility: hidden` when closed (grid-menu__panel) — out of the tab order and the
  // accessibility tree.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setTerm("");
      setOpen(false);
    };
    const onOutside = (e: Event) => {
      if (boxRef.current && e.target instanceof Node && !boxRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, [open]);

  function retry() {
    // Re-fire the debounced search through the same path (a trailing space normalizes away).
    setTerm((t) => (t.endsWith(" ") ? t.slice(0, -1) : `${t} `));
  }

  const shown = state.status === "ok" ? state.candidates : [];
  const total = state.status === "ok" ? state.total : 0;

  return (
    <div className="grid-menu" ref={boxRef}>
      <label className="field">
        <span className="field__label">Search every field</span>
        <input
          className="field__input"
          type="search"
          role="searchbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label="Search every candidate field"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onFocus={() => {
            if (normalizeSearchTerm(term)) setOpen(true);
          }}
          placeholder="e.g. welder in Pune"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <div
        className="grid-menu__panel"
        id={listId}
        data-open={open ? "true" : "false"}
        role="region"
        aria-label="Matching candidates"
      >
        {state.status === "searching" ? (
          <p className="grid-menu__title">Searching…</p>
        ) : state.status === "ok" ? (
          shown.length > 0 ? (
            <>
              <p className="grid-menu__title" aria-live="polite">
                {formatCount(total)} {total === 1 ? "match" : "matches"}
                {state.q_type === "phone"
                  ? " — exact phone match"
                  : state.q_type === "name"
                    ? " — name match"
                    : total > shown.length
                      ? " — refine the term to narrow it"
                      : ""}
              </p>
              <ul>
                {shown.map((c) => (
                  <li key={c.worker_id}>
                    <Link
                      className="link"
                      href={resultHref(query, c.worker_id)}
                      onClick={() => setOpen(false)}
                    >
                      {displayName(typeof c.name === "string" ? c.name : null) ??
                        candidateIdTitle(c.worker_id)}
                      <span className="table__meta">
                        {" — "}
                        {[c.trade_label, c.current_city, c.status].filter(Boolean).join(" · ")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="grid-menu__title">No candidate matches this term</p>
          )
        ) : state.status === "signed_out" ? (
          <p className="grid-menu__title">
            The session ended. <Link href="/login">Sign in again</Link>, then search.
          </p>
        ) : state.status === "forbidden" ? (
          <p className="grid-menu__title">Your role may not search candidates.</p>
        ) : state.status === "error" ? (
          <p className="grid-menu__title">
            Search is unavailable.{" "}
            <button type="button" className="link" onClick={retry}>
              Retry
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
