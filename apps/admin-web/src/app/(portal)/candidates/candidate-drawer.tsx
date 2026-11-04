"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Drawer, useUrlDrawer } from "../../../components/drawer";
import type { CandidateRecordResult } from "../../../lib/candidate-detail";
import { candidateIdTitle, candidateTitle } from "../../../lib/candidate-view";
import { shortId } from "../../../lib/format";
import {
  CANDIDATE_PARAM,
  RECORD_SETTLE_MS,
  drawerMove,
  fetchCandidateRecord,
  neighbours,
  takesArrows,
  type DrawerRow,
  type Neighbours,
} from "./candidate-drawer-model";
import {
  CANDIDATE_TABS,
  CandidateRecordPanels,
  recordSummary,
  type CandidateTab,
} from "./candidate-record-view";

/** The record the PAGE read on the server, for the `?c=` it was rendered with (a reload, a link). */
export interface InitialCandidateRecord {
  id: string;
  result: CandidateRecordResult;
}

export interface CandidateDrawerProps {
  /** The rows of the list under the drawer, in order — where ↑/↓ go. */
  rows: readonly DrawerRow[];
  initial: InitialCandidateRecord | null;
  /** The session holds `read_identity` (a withheld name is then a capped read, not the role). */
  entitled: boolean;
  /** The session holds `reveal_pii`. */
  canReveal: boolean;
}

/**
 * THE CANDIDATE DRAWER (A7, #2577) — one candidate's #2560 record, over the Candidates list.
 *
 *  - ADDRESSED BY URL: open while `?c=<worker id>` is in the address (`useUrlDrawer`), so it is
 *    linkable and survives a reload; the list's own filters and page cursor stay beside it. A row
 *    opens it (a new history entry), ↑/↓ and Previous/Next move it (the same entry), Escape, the
 *    scrim, Close and Back close it. All shallow — the list under it is never re-read.
 *  - ITS OWN READ: the page reads the record on the server when it loads with `?c=`; every later
 *    open or move reads it from the browser (`[id]/record`), aborting the read it replaces. A MOVE
 *    waits {@link RECORD_SETTLE_MS} for the next press first — each read is audited and spends a
 *    name — while the title and the skeleton change at once.
 *  - STATES: a skeleton while loading, the record's seven tabs, not found, a role that may not
 *    read records, a session that ended, and an error with Retry.
 *  - MOTION: A5's Drawer slides in over 220ms; a move cross-fades the content in over 140ms with
 *    no slide (the panel keeps its place). Zero under reduced motion.
 */
export function CandidateDrawer({ rows, initial, entitled, canReveal }: CandidateDrawerProps) {
  const drawer = useUrlDrawer(CANDIDATE_PARAM);
  const id = drawer.isOpen ? drawer.value : null;
  const record = useCandidateRecord(id, initial);
  const around = neighbours(rows, record.viewId);
  const [tab, setTab] = useState<CandidateTab>("profile");
  const idBase = useId();
  const contentRef = useRef<HTMLDivElement>(null);

  // A fresh open starts on Profile; a move keeps the tab (scanning Skills down a list).
  const [wasOpen, setWasOpen] = useState(id !== null);
  if ((id !== null) !== wasOpen) {
    setWasOpen(id !== null);
    if (id !== null) setTab("profile");
  }

  function move(to: DrawerRow | null) {
    if (!to) return;
    record.settleNext();
    drawer.move(to.id);
  }

  // ↑ / ↓ — read through a ref, so the one window listener always sees this render's rows.
  const keys = useRef({ around, move });
  keys.current = { around, move };
  useEffect(() => {
    if (id === null) return;
    const onKey = (event: KeyboardEvent) => {
      const to = drawerMove(
        {
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          inField: takesArrows(event.target instanceof HTMLElement ? event.target : null),
          outside: !pressedInDrawer(event.target, contentRef.current),
        },
        keys.current.around,
      );
      if (!to) return;
      event.preventDefault();
      keys.current.move(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);

  const viewId = record.viewId;
  const result = record.result;
  const detail = result?.status === "ok" ? result.detail : null;
  const rowTitle = viewId ? rows.find((r) => r.id === viewId)?.title : undefined;
  const title = detail ? candidateTitle(detail) : viewId ? (rowTitle ?? candidateIdTitle(viewId)) : "";
  const summary = detail ? recordSummary(detail) : "";

  return (
    <Drawer
      open={id !== null}
      onClose={drawer.close}
      title={title}
      description={
        /* Text only: a control here would take the focus the drawer gives its Close button. */
        viewId ? (
          <span className="cdrawer__sub">
            {summary ? <span>{summary}</span> : null}
            <span className="mono" title={viewId}>
              {shortId(viewId)}
            </span>
          </span>
        ) : null
      }
      footer={
        viewId ? (
          <DrawerFooter
            around={around}
            total={rows.length}
            onMove={move}
            fullPageHref={`/candidates/${encodeURIComponent(viewId)}`}
          />
        ) : null
      }
    >
      <div className="cdrawer" ref={contentRef}>
        {/* Sticky at the top of the drawer's scroller: a long Profile never scrolls the tabs away. */}
        <div className="cdrawer__tabbar">
          <CandidateTabList
            idBase={idBase}
            active={tab}
            onSelect={setTab}
            disabled={detail === null}
          />
        </div>
        {/* Keyed by the record shown: a move remounts the body, which fades it in (140ms). */}
        <div
          key={`${viewId ?? ""}:${result?.status ?? "loading"}`}
          className="cdrawer__view"
          aria-busy={result === null ? true : undefined}
        >
          {result === null ? (
            <RecordSkeleton />
          ) : result.status === "ok" ? (
            <CandidateRecordPanels
              detail={result.detail}
              entitled={entitled}
              canReveal={canReveal}
              active={tab}
              idBase={idBase}
            />
          ) : (
            <RecordProblem status={result.status} onRetry={record.retry} />
          )}
        </div>
      </div>
    </Drawer>
  );
}

/**
 * Was this key pressed IN the drawer — on one of its controls, or with focus on the page body (a
 * control that unmounted under a move) while no other overlay sits on top? A confirm opened over
 * the drawer is portalled outside it, so its presses are not.
 */
function pressedInDrawer(target: EventTarget | null, content: HTMLElement | null): boolean {
  const panel = content?.closest(".overlay__panel") ?? null;
  if (!panel) return false;
  if (target instanceof Node && panel.contains(target)) return true;
  if (target !== document.body) return false;
  const layers = document.querySelectorAll(".overlay");
  return layers[layers.length - 1] === panel.closest(".overlay");
}

// ---------------------------------------------------------------------------
// the record read
// ---------------------------------------------------------------------------

interface Loaded {
  id: string;
  result: CandidateRecordResult;
  attempt: number;
}

/**
 * The record for the drawer's id: the page's server read when it is for this id, else a read from
 * the browser. `result` is null while it loads. `viewId` is the record on screen — while the
 * drawer plays its exit it is the one that was open, so the content does not blank out under it.
 */
function useCandidateRecord(id: string | null, initial: InitialCandidateRecord | null) {
  const [loaded, setLoaded] = useState<Loaded | null>(() =>
    initial ? { ...initial, attempt: 0 } : null,
  );
  const [attempt, setAttempt] = useState(0);
  const [lastId, setLastId] = useState(id);
  const settle = useRef(false);

  // A REOPEN is a new look — read again rather than show what was read before it closed.
  if (id !== null && id !== lastId) setLastId(id);
  const [wasOpen, setWasOpen] = useState(id !== null);
  if ((id !== null) !== wasOpen) {
    setWasOpen(id !== null);
    if (id !== null && loaded?.id === id) setAttempt((n) => n + 1);
  }

  // A server render (a reload, a refresh) brought a fresh read of the open record: take it.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    if (initial && initial.id === id) setLoaded({ ...initial, attempt });
  }

  const viewId = id ?? lastId;
  const current =
    loaded !== null && loaded.id === viewId && (id === null || loaded.attempt === attempt);

  useEffect(() => {
    if (id === null || current) return;
    const controller = new AbortController();
    const wait = settle.current ? RECORD_SETTLE_MS : 0;
    settle.current = false;
    const timer = setTimeout(() => {
      fetchCandidateRecord(id, controller.signal).then(
        (result) => setLoaded({ id, result, attempt }),
        () => {
          /* aborted: the drawer moved on, and nobody reads this answer */
        },
      );
    }, wait);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, attempt, current]);

  return {
    viewId,
    result: current ? loaded!.result : null,
    retry: () => setAttempt((n) => n + 1),
    /** The next change of id is a MOVE: let a burst of presses settle before reading. */
    settleNext: () => {
      settle.current = true;
    },
  };
}

// ---------------------------------------------------------------------------
// the tab row, the footer, the states
// ---------------------------------------------------------------------------

/**
 * The seven tabs, as the console's segmented chip row (the agency posting's tabs) with the ARIA
 * tabs pattern: one tab stop, ←/→ and Home/End move between tabs. While a record loads there is
 * nothing to switch to, so the row is drawn disabled.
 */
function CandidateTabList({
  idBase,
  active,
  onSelect,
  disabled,
}: {
  idBase: string;
  active: CandidateTab;
  onSelect: (tab: CandidateTab) => void;
  disabled: boolean;
}) {
  const refs = useRef<Partial<Record<CandidateTab, HTMLButtonElement | null>>>({});
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const next = tabAfterKey(active, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    refs.current[next]?.focus();
  }
  return (
    <div
      className="segmented cdrawer__tabs"
      role="tablist"
      aria-label="Candidate record"
      onKeyDown={onKeyDown}
    >
      {CANDIDATE_TABS.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-controls={disabled ? undefined : `${idBase}-panel-${t.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`btn btn--sm ${selected ? "btn--selected" : "btn--ghost"}`}
            onClick={() => onSelect(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** ←/→ wrap through the tabs, Home/End jump to the ends; any other key is not the tab row's. */
export function tabAfterKey(active: CandidateTab, key: string): CandidateTab | null {
  const ids = CANDIDATE_TABS.map((t) => t.id);
  const at = ids.indexOf(active);
  if (key === "ArrowRight") return ids[(at + 1) % ids.length]!;
  if (key === "ArrowLeft") return ids[(at - 1 + ids.length) % ids.length]!;
  if (key === "Home") return ids[0]!;
  if (key === "End") return ids[ids.length - 1]!;
  return null;
}

function DrawerFooter({
  around,
  total,
  onMove,
  fullPageHref,
}: {
  around: Neighbours;
  total: number;
  onMove: (to: DrawerRow | null) => void;
  fullPageHref: string;
}) {
  return (
    <>
      <nav className="cdrawer__nav" aria-label="Candidates on this page">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!around.prev}
          aria-keyshortcuts="ArrowUp"
          onClick={() => onMove(around.prev)}
        >
          <Icon name="caret-left" />
          Previous
        </button>
        <span className="cdrawer__pos ui-num">
          {around.index >= 0 ? `${around.index + 1} of ${total} on this page` : "Not on this page"}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!around.next}
          aria-keyshortcuts="ArrowDown"
          onClick={() => onMove(around.next)}
        >
          Next
          <Icon name="caret-right" />
        </button>
      </nav>
      <Link className="btn btn--ghost btn--sm" href={fullPageHref}>
        <Icon name={ACTION_ICON.view} />
        Open full page
      </Link>
    </>
  );
}

/** The loading state: the shape of a record, with the console's 1.4s sheen. */
function RecordSkeleton() {
  return (
    <div className="cdrawer__skeleton" aria-hidden="true">
      {[0, 1, 2].map((group) => (
        <div key={group} className="cdrawer__skeleton-group">
          <span className="skeleton skeleton--title" />
          {[0, 1, 2, 3].map((line) => (
            <span key={line} className="cdrawer__skeleton-row">
              <span className="skeleton skeleton--label" />
              <span className="skeleton skeleton--value" />
            </span>
          ))}
        </div>
      ))}
      <span className="sr-only">Loading the candidate&apos;s record…</span>
    </div>
  );
}

/** Every way the read can fail, each with its own way out. */
function RecordProblem({
  status,
  onRetry,
}: {
  status: Exclude<CandidateRecordResult["status"], "ok">;
  onRetry: () => void;
}) {
  if (status === "not_found") {
    return (
      <div className="state">
        <h3 className="state__title">No such candidate</h3>
        <p className="state__body">
          No worker has this id. The link may be mistyped, or the account may have been deleted.
        </p>
      </div>
    );
  }
  if (status === "forbidden") {
    return (
      <div className="state">
        <h3 className="state__title">Your role cannot open candidate records</h3>
        <p className="state__body">
          The server refused this record for your role. The list itself is unaffected.
        </p>
      </div>
    );
  }
  if (status === "signed_out") {
    return (
      <div className="state state--error">
        <h3 className="state__title">Your session has ended</h3>
        <p className="state__body">Sign in again to open this record.</p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/login">
            <Icon name="sign-in" />
            Sign in
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="state state--error">
      <h3 className="state__title">The record did not load</h3>
      <p className="state__body">
        That is a fault on our side, not this candidate&apos;s. The list behind the drawer is
        unaffected.
      </p>
      <div className="state__actions">
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          <Icon name={ACTION_ICON.retry} />
          Retry
        </button>
      </div>
    </div>
  );
}
