"use client";

import { useState } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import type { ApplicantPosting } from "../../../../../lib/candidate-inbox";
import type { ContactView, RevealView, UnlockView } from "../../../../../lib/unlock-view";
import { isoDay, type GrantedUnlock } from "../../../../../lib/unlock-history";
import { Avatar, Badge, Button, Card, Tabs, Toast } from "../../../../../components/ds";
import { PageHeader, type PageHeaderProps } from "../../../../../components/page-header";
import { PortalLink } from "../../../../../components/portal-link";
import { bandLabel, monthsLabel, opaqueId } from "../../../../../lib/masking";
import { hasSavedStages, STAGE_LABEL } from "../../../../../lib/applicant-stages";
import {
  ConfirmSpendDialog,
  MaskedResumeCard,
  RoutedContactCard,
  UnlockResultToast,
  type UnlockResultKind,
} from "../../../../../components/unlock";
import {
  maskedResumeAction,
  revealContactAction,
  setApplicantStageAction,
  unlockAction,
  type StageActionResult,
} from "./actions";

/**
 * Client interactivity for the faceless applicant pipeline + unlock + reveal (ADR-0019
 * Decision E) — DS1.3 re-skin onto the BadaBhai Design System. The VISUAL layer changed
 * (DS primitives); every behavior / invariant from the prior build is preserved exactly.
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to
 * the server-held payer (the payer JWT, XB-A) and return only PII-free, already-mapped views.
 *
 * PIPELINE — LOCAL or SAVED, decided by the ROWS (owner ruling 2026-10-07; API #2137). The server
 * saves stages behind a flag the portal cannot read; while it is on, every row arrives with a
 * `stage`, and while it is off none does (`hasSavedStages`). Either way the backend's best-first
 * order is preserved (we only filter the already-sorted feed by stage) and the engine's `hot`
 * boolean is rendered AS-IS — we NEVER recompute a percentile or re-sort client-side (ranking is
 * backend-owned), and nothing here decides who may move whom (the server checks ownership).
 *  - LOCAL (no `stage` on the rows — exactly the board this has always been): a two-stage
 *    New → Shortlist board. Keep (New→Shortlist), Pass (dismiss), and "Mark as contacted" are pure
 *    CLIENT transitions — NO network call, no event, nothing persisted; a reload starts over.
 *  - SAVED (every row carries `stage`): the board is SEEDED from the rows and a third tab, Passed,
 *    lists the passed (the server still lists them; which tab shows whom is ours). Keep (→
 *    shortlist), Pass (→ passed) and Move to New (→ new) go through `setApplicantStageAction`:
 *    OPTIMISTIC — the row moves at once — then reconciled to the stage the server answered, or
 *    ROLLED BACK to where it was with ONE polite toast (the cause in plain words: failed, too many
 *    changes, or the list changed — that last one, the neutral 404, also brings the page back
 *    re-read from the server). While a row's move is in flight its stage buttons are disabled (no
 *    double-submit; the server is idempotent anyway). "Mark as contacted" stays LOCAL in both.
 *
 * CONTACT: the routed-contact card (relay handle · channel · access until) is the row's ONE
 * contact read-out — NEVER a phone (ADR-0010 F-4: ContactView has no phone/number field; the
 * channel is only `in_app_relay` / `proxy_number`). There are no Call / WhatsApp buttons: the
 * routed channel is not open yet (the card says so — "nothing to dial or message today") and no
 * field on the contract says when it is, so a Call button could only ever be a control that does
 * nothing. They come back with the backend change that opens the channel. "Mark as contacted"
 * shows once a routed handle exists and rides the SAME already-confirmed spend (the unlock) — it
 * never re-spends, re-prompts, or calls the network.
 *
 * ALREADY UNLOCKED: `unlocked` carries the payer's LIVE grants for this feed's workers (read by
 * the page from the payer's own unlock history). A row in it starts in the granted state — the
 * "Unlocked until" band with Open routed contact — so a reload never offers a fresh spend on an
 * applicant the payer already holds. An unlock is one grant per (payer, worker) (ADR-0010
 * sign-off 1), so the worker id alone identifies the row. Session state for the row layers on top.
 *
 * LOADING: busy / contactBusy / resumeBusy each surface the Button `loading` spinner + `aria-busy`
 * + disabled on their OWN action while it is pending; the error region stays aria-live for SRs.
 *
 * PAGE HEAD: this component renders the screen's PageHeader itself, so the New / Shortlist tabs
 * (state that lives HERE) sit in the head's toolbar row — the header's filter slot — directly
 * under the posting's name, and the feed starts right below a one-sentence privacy note. The
 * page passes the head's text (`header`); the states with no feed (not found, read error, no
 * applicants yet) render their own head in page.tsx.
 *
 * NO-ORACLE (XB-C): an "unavailable" unlock renders ONE neutral "Currently engaged" state —
 * IDENTICAL copy for capped / unknown / no-consent / already-unlocked (the mapper collapses
 * them; no branch here infers the cause). A transient action FAILURE renders a retryable inline
 * error and NEVER blanks the row or the feed. NO-LOG: nothing logs the result / handle / payer
 * id. Confirm-on-spend (C11): only the FIRST unlock per row prompts, via a DS Dialog.
 *
 * TWO CALLERS, ONE CARD. A posting's Applicants page passes `postingId`: ONE posting's feed, with
 * the New / Shortlist board. The Candidates tab (`/candidates`, the cross-posting inbox) passes no
 * `postingId`; each row carries its OWN `posting` instead, and:
 *  - the row's posting is the unlock's `job_id` and the masked resume's context — per row, so the
 *    confirm dialog remembers WHICH row asked (a worker who applied to two postings is two rows);
 *  - confirm-on-spend is per ROW (its key), not per worker: a row that has not confirmed always
 *    opens the dialog, even when the same worker's other row confirmed and then failed. "Retry"
 *    (no re-prompt) and its error line belong to the row that confirmed — a different row never
 *    inherits them, so it can never spend on its own posting without a confirm;
 *  - the card names its posting ("Applied to …"), linked to its details when this session has one,
 *    and the applicant's rank on THAT posting reads on the same line ("· ranked #2") — not as the
 *    rank badge, which in a newest-first list would look like a place in this list;
 *  - there are NO stage tabs and no Mark as contacted — the head's toolbar is the caller's filter.
 *    With LOCAL stages there is no board at all: over a paged, filtered inbox a stage nothing
 *    persists would be a filter that silently forgets. With SAVED stages each card shows its stage
 *    and the same Keep / Pass / Move to New as its posting's board, saved the same way, keyed by
 *    the CARD (one worker on two postings holds two independent stages). A move never removes the
 *    card: the inbox is the server's page (its `?stage=` filter is the page's, read server-side),
 *    so a moved card stays where it is with its new stage until the next read. A `viewOnly`
 *    posting's card shows its stage and offers no move, as it offers no unlock;
 *  - a row whose posting is `viewOnly` (its own Applicants page offers this session no unlock)
 *    offers none here either.
 * Row state stays keyed by worker id in both modes: an unlock is one grant per (payer, worker), so
 * unlocking him on one row shows him unlocked on his other row too (and an unlock in flight is
 * in flight on both). The ONE ConfirmSpendDialog, the balance affordance and the toast are shared
 * by both. On a posting's feed a card's key IS the worker id, so every per-row rule above is the
 * per-worker rule it always was.
 */

type Stage = "new" | "shortlist";
type RowStage = Stage | "passed";

/**
 * The ONE toast a failed saved move raises (SAVED stages only): why, in plain words, and where the
 * row is now. `id` is the card's own opaque id (what the card shows); `stage` is the stage the row
 * was rolled back to. No server message is ever shown — the action returns a reason, not text.
 */
interface StageNotice {
  reason: Extract<StageActionResult, { ok: false }>["reason"];
  id: string;
  stage: RowStage;
}

/** A copy of `map` without `key`. */
function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/** The stage toolbar a pressed stage button sits in (null outside a browser, or with no event). */
function toolbarOf(e: { currentTarget: EventTarget | null } | undefined): Element | null {
  if (typeof Element === "undefined" || !e || !(e.currentTarget instanceof Element)) return null;
  return e.currentTarget.closest(".applicant__pipeline");
}

/**
 * After a SAVED move settles, give keyboard focus back to the card the move came from — when that
 * card is still on screen and focus fell to the page. The inbox keeps a moved card, but the
 * pressed button is replaced (Keep becomes the Shortlisted badge), which would drop a keyboard
 * user to the top of the document; this puts them on the card's first stage button instead.
 * Hook-free, like the DS Tabs' arrow keys: the live DOM is read once the move has settled — and,
 * since the settled render may land a frame or two later, re-read for a few frames until a stage
 * button is enabled again. On a posting's board the moved card has left its tab, so its toolbar
 * is gone and nothing happens — focus there is what it always was. Focus the user has since put
 * elsewhere is never taken.
 */
const REFOCUS_FRAMES = 10;
function refocusToolbar(toolbar: Element | null, framesLeft = REFOCUS_FRAMES): void {
  if (!toolbar || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    if (!toolbar.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const next = toolbar.querySelector<HTMLButtonElement>("button:not([disabled])");
    if (next) next.focus();
    else if (framesLeft > 0) refocusToolbar(toolbar, framesLeft - 1);
  });
}

/** A Candidates row: the faceless applicant plus the posting it applied to (see candidate-inbox). */
export type CandidateRow = FacelessApplicant & { posting: ApplicantPosting };

/** One rendered card: who, which posting it names (inbox only), and its actions' posting context. */
interface FeedRow {
  applicant: FacelessApplicant;
  posting: ApplicantPosting | null;
  /** The posting an unlock / resume disclosure on this row names. */
  context: string;
  /** Unique per card — in the inbox one worker can be two rows (two postings). */
  key: string;
}

type FeedProps =
  /** ONE posting's feed (its Applicants page): every row's context is that posting; the board. */
  | { postingId: string; applicants: FacelessApplicant[] }
  /** The Candidates inbox: each row names its own posting; no board. */
  | { postingId?: undefined; applicants: CandidateRow[] };

/**
 * A card's key — also the key of its confirm-on-spend. A posting's feed: the worker (one card per
 * worker). The inbox: posting + worker (one worker who applied to two postings is two cards).
 */
function rowKey(board: boolean, context: string, workerId: string): string {
  return board ? workerId : `${context}:${workerId}`;
}

function feedRows(feed: FeedProps): FeedRow[] {
  if (feed.postingId !== undefined) {
    const postingId = feed.postingId;
    return feed.applicants.map((applicant) => ({
      applicant,
      posting: null,
      context: postingId,
      key: rowKey(true, postingId, applicant.workerId),
    }));
  }
  return feed.applicants.map(({ posting, ...applicant }) => ({
    applicant,
    posting,
    context: posting.id,
    key: rowKey(false, posting.id, applicant.workerId),
  }));
}

interface RowState {
  busy: boolean;
  unlock: UnlockView | null;
  unlockError: string | null;
  contactBusy: boolean;
  contact: ContactView | null;
  contactError: string | null;
  resumeBusy: boolean;
  resume: RevealView | null;
  resumeError: string | null;
  /** LOCAL "contacted" marker — set after a routed reveal; rides the already-spent unlock. */
  contacted: boolean;
}

const EMPTY: RowState = {
  busy: false,
  unlock: null,
  unlockError: null,
  contactBusy: false,
  contact: null,
  contactError: null,
  resumeBusy: false,
  resume: null,
  resumeError: null,
  contacted: false,
};

export type ApplicantActionsProps = FeedProps & {
  /**
   * The screen's head (back link, H1, description). On a posting's feed the New / Shortlist tabs
   * are its toolbar; in the inbox the caller's `toolbar` (the posting filter) is.
   */
  header: Pick<PageHeaderProps, "back" | "title" | "description" | "toolbar">;
  balance: number;
  /**
   * The payer's LIVE grants for this feed's workers, keyed by worker id (see liveUnlocksFor).
   * Default none — a caller that did not read the unlock history starts every row locked (the
   * server decides any Unlock pressed there; for a live grant it does not debit twice, F-6).
   */
  unlocked?: Record<string, GrantedUnlock>;
};

export function ApplicantActions(props: ApplicantActionsProps) {
  const { header, balance, unlocked = {} } = props;
  const feed = feedRows(props);
  // ONE posting's feed carries the New / Shortlist board; the inbox does not (see the top).
  const board = props.postingId !== undefined;
  // SAVED stages: every row came with one (the server saves them). Read from the rows — the flag
  // that decides it is server-side; no `stage` on the rows keeps the LOCAL board, exactly as before.
  const saved = hasSavedStages(feed.map((r) => r.applicant));
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Confirm-on-spend (C11): confirm only the FIRST unlock per row this session — a retry
  // after a transient failure (or a later reveal) does not re-prompt. Reveal/resume are
  // NOT spend actions and are never confirmed. Keyed by the card's key (`rowKey`): the worker on
  // a posting's feed, posting + worker in the inbox — so another row of the same worker confirms
  // for itself.
  const [confirmedUnlock, setConfirmedUnlock] = useState<Record<string, boolean>>({});
  // Pipeline stage per row, keyed by the card's key (`rowKey`: the worker on a posting's feed).
  // LOCAL: the whole board — a row absent from the map is "new". SAVED: this session's moves over
  // the rows' own `stage` — optimistic while one is in flight, then the stage the server answered.
  const [stages, setStages] = useState<Record<string, RowStage>>({});
  const [activeStage, setActiveStage] = useState<RowStage>("new");
  // The worker whose first unlock is awaiting confirmation (DS Dialog open ⇔ non-null). The
  // confirm is a pure UI gate in the SCREEN — it sends nothing and names no candidate detail.
  const [confirmWorker, setConfirmWorker] = useState<string | null>(null);
  // Transient unlock-RESULT toast (granted | unavailable). NO-ORACLE: the failure copy is one
  // neutral line with NO cause (the shared toast reuses NEUTRAL_UNLOCK_MESSAGE). It is purely a
  // confirmation of the spend outcome — never names a candidate, never logs. Added LAST so the
  // upstream useState order (rows, confirmedUnlock, stages, activeStage, confirmWorker) is intact.
  const [result, setResult] = useState<UnlockResultKind | null>(null);
  // The posting context of the row whose first unlock is awaiting confirmation (set with
  // confirmWorker). On a posting's feed every row's is that posting; in the inbox the same worker
  // can sit on two rows, so the worker id alone cannot say which posting the spend names. Added
  // LAST, after `result`, so every upstream useState keeps its position.
  const [confirmContext, setConfirmContext] = useState<string | null>(null);
  // SAVED stages only — appended AFTER `confirmContext`, so every upstream cell keeps its position.
  // The cards whose stage move is in flight (keyed like `stages`): their stage buttons are
  // disabled until the server answers — no double-submit.
  const [stageSaving, setStageSaving] = useState<Record<string, boolean>>({});
  // The last failed move's toast (null = none). One at a time: a new move clears it.
  const [stageNotice, setStageNotice] = useState<StageNotice | null>(null);

  // A row's state before anything happened to it this session: granted when the payer already
  // holds a live grant on this worker (the page's unlock-history read), else locked. Derived from
  // props on every render — not copied into state — so session changes layer over it.
  function baseRow(workerId: string): RowState {
    const held = unlocked[workerId];
    return held ? { ...EMPTY, unlock: held } : EMPTY;
  }

  function rowOf(workerId: string): RowState {
    return rows[workerId] ?? baseRow(workerId);
  }

  function patch(workerId: string, p: Partial<RowState>) {
    setRows((prev) => ({
      ...prev,
      [workerId]: { ...(prev[workerId] ?? baseRow(workerId)), ...p },
    }));
  }

  // The row's stage: this session's move, else (SAVED) the row's own, else "new". On a posting's
  // feed the key IS the worker id, so the LOCAL board reads exactly the map it always read.
  function stageOf(r: FeedRow): RowStage {
    return stages[r.key] ?? (saved ? r.applicant.stage : undefined) ?? "new";
  }

  // Keep / Pass are LOCAL stage transitions — no network, no event, nothing persisted.
  function onKeep(workerId: string) {
    setStages((prev) => ({ ...prev, [workerId]: "shortlist" }));
  }
  function onPass(workerId: string) {
    setStages((prev) => ({ ...prev, [workerId]: "passed" }));
  }

  // SAVED stages: move the row on the server's board. Optimistic — the row moves now — then
  // reconciled to the stage the server answered, or rolled back to where it was with one toast.
  // One move per card at a time (its buttons are disabled meanwhile, and this re-checks). The
  // posting it names is the row's own (`context`): a posting's feed, or the inbox row's posting.
  async function moveStage(r: FeedRow, to: RowStage, toolbar: Element | null = null) {
    const key = r.key;
    if (stageSaving[key]) return;
    const from = stageOf(r);
    if (from === to) return;
    // What the map held before this move (undefined = nothing: the row's own stage showed).
    const prior = stages[key];
    setStages((prev) => ({ ...prev, [key]: to }));
    setStageSaving((prev) => ({ ...prev, [key]: true }));
    setStageNotice(null);
    let res: StageActionResult;
    try {
      res = await setApplicantStageAction({
        jobId: r.context,
        workerId: r.applicant.workerId,
        stage: to,
      });
    } catch {
      // The action itself never arrived (offline, a dropped connection): nothing was saved.
      res = { ok: false, reason: "failed" };
    }
    setStageSaving((prev) => withoutKey(prev, key));
    refocusToolbar(toolbar);
    if (res.ok) {
      const answered = res.stage;
      setStages((prev) => ({ ...prev, [key]: answered }));
      return;
    }
    setStages((prev) => (prior === undefined ? withoutKey(prev, key) : { ...prev, [key]: prior }));
    setStageNotice({ reason: res.reason, id: opaqueId(r.applicant.workerId), stage: from });
  }

  // Mark-as-contacted: a LOCAL visual transition (the sibling of Keep→Shortlist). It is reachable
  // ONLY once a routed handle exists, so it rides the ALREADY-confirmed unlock spend (C11) — it
  // never re-spends, never re-prompts, and makes NO network call. Nothing is persisted/evented.
  function onContacted(workerId: string) {
    patch(workerId, { contacted: true });
  }

  // The unlock network call itself (ids-only body, XT5). Reused by the confirm-dialog's
  // success action AND by a retry on an already-confirmed row (no re-prompt). On resolution it
  // raises a transient RESULT toast — granted on a granted view, else the ONE neutral failure
  // line (an unavailable view AND a transient error both surface the same no-cause toast, XB-C).
  async function runUnlock(workerId: string, postingId: string) {
    patch(workerId, { busy: true, unlockError: null });
    const res = await unlockAction({ postingId, workerId });
    if (res.ok) {
      patch(workerId, { busy: false, unlock: res.view });
      setResult(res.view.kind === "granted" ? "granted" : "unavailable");
    } else {
      patch(workerId, { busy: false, unlockError: res.error });
      setResult("unavailable");
    }
  }

  function onUnlock(row: FeedRow) {
    const workerId = row.applicant.workerId;
    // First unlock for this row → OPEN the confirm dialog (the spend gate). A row already
    // confirmed this session (e.g. a retry after a transient failure) unlocks directly — no
    // re-prompt. The dialog copy is MOCK-neutral and names NO candidate detail (faceless).
    if (confirmedUnlock[row.key]) {
      void runUnlock(workerId, row.context);
      return;
    }
    setConfirmWorker(workerId);
    setConfirmContext(row.context);
  }

  // Closing the dialog without spending forgets WHICH row asked — both halves of it.
  function onCancelUnlock() {
    setConfirmWorker(null);
    setConfirmContext(null);
  }

  // The confirm dialog's success action: mark the row confirmed, close the dialog, then run
  // the (ids-only) unlock. Fires at most once per row — a later retry/reveal never re-prompts.
  // The posting it names is the asking row's. Absent that (state seeded without it), a posting's
  // feed has only its own posting to name; the inbox has no posting it may assume — a worker's
  // other row can be one this session may not spend on (a view-only posting) — so it spends
  // nothing and closes.
  function onConfirmUnlock() {
    const workerId = confirmWorker;
    if (workerId === null) return;
    const context = confirmContext ?? props.postingId ?? null;
    if (context === null) {
      onCancelUnlock();
      return;
    }
    setConfirmedUnlock((prev) => ({ ...prev, [rowKey(board, context, workerId)]: true }));
    setConfirmWorker(null);
    setConfirmContext(null);
    void runUnlock(workerId, context);
  }

  async function onRevealContact(unlockId: string, workerId: string) {
    patch(workerId, { contactBusy: true, contactError: null });
    const res = await revealContactAction({ unlockId });
    if (res.ok) patch(workerId, { contactBusy: false, contact: res.view });
    else patch(workerId, { contactBusy: false, contactError: res.error });
  }

  async function onMaskedResume(unlockId: string, workerId: string, postingId: string) {
    patch(workerId, { resumeBusy: true, resumeError: null });
    // postingId = the disclosure's audit context: the posting this row's applicant applied to.
    const res = await maskedResumeAction({ unlockId, workerId, postingId });
    if (res.ok) patch(workerId, { resumeBusy: false, resume: res.view });
    else patch(workerId, { resumeBusy: false, resumeError: res.error });
  }

  // The tab on show. Passed is a SAVED board's tab only: should the rows stop carrying a stage
  // while it is open (the server stopped saving them), the LOCAL board opens on New.
  const tab: RowStage = !saved && activeStage === "passed" ? "new" : activeStage;
  // Filter the ALREADY best-first feed by the active stage (order preserved; never re-sorted).
  // The inbox has no board: every row it was given is shown, in the server's order.
  const visible = board ? feed.filter((r) => stageOf(r) === tab) : feed;
  const counts = feed.reduce(
    (acc, r) => {
      acc[stageOf(r)] += 1;
      return acc;
    },
    { new: 0, shortlist: 0, passed: 0 } as Record<RowStage, number>,
  );

  // Pipeline tabs. LOCAL: two (Keep moves New→Shortlist; Pass dismisses, counted beside them).
  // SAVED: three — the passed have their own tab, since Move to New brings one back. They are the
  // screen's filter, so they sit in the page head's toolbar row. The inbox has no board: its
  // toolbar row is the caller's own (the posting filter).
  const pipeline = board ? (
    // `--saved` lets the three counted segments fit a phone's track (globals.css "APPLICANT FEED").
    <div className={saved ? "applicants-pipeline applicants-pipeline--saved" : "applicants-pipeline"}>
      <Tabs
        variant="segmented"
        aria-label="Applicant pipeline"
        value={tab}
        onChange={(id) => setActiveStage(id as RowStage)}
        tabs={[
          { id: "new", label: `New (${counts.new})` },
          { id: "shortlist", label: `Shortlist (${counts.shortlist})` },
          ...(saved ? [{ id: "passed", label: `Passed (${counts.passed})` }] : []),
        ]}
      />
      {!saved && counts.passed > 0 ? (
        <span className="applicants-pipeline__note">{counts.passed} passed</span>
      ) : null}
    </div>
  ) : (
    header.toolbar
  );

  // SAVED stages: a card's stage read-out and moves (the board's toolbar, and the inbox card's).
  // On the board the tab already says which stage a row is in, so a New row wears no badge there.
  // A `viewOnly` inbox posting offers no move (as it offers no unlock) — its stage still shows.
  function savedStageControls(r: FeedRow, stage: RowStage) {
    const saving = stageSaving[r.key] === true;
    const canMove = !r.posting?.viewOnly;
    return (
      <>
        {stage === "shortlist" ? (
          <Badge tone="success">Shortlisted</Badge>
        ) : stage === "passed" ? (
          <Badge tone="neutral">Passed</Badge>
        ) : board ? null : (
          <Badge tone="neutral">New</Badge>
        )}
        {canMove && stage === "new" ? (
          <Button
            variant="secondary"
            size="sm"
            iconLeft="bookmark-simple"
            disabled={saving}
            aria-busy={saving}
            onClick={(e) => void moveStage(r, "shortlist", toolbarOf(e))}
          >
            Keep
          </Button>
        ) : null}
        {canMove && stage !== "passed" ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft={ACTION_ICON.reject}
            disabled={saving}
            aria-busy={saving}
            onClick={(e) => void moveStage(r, "passed", toolbarOf(e))}
          >
            Pass
          </Button>
        ) : null}
        {canMove && stage !== "new" ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft="tray"
            disabled={saving}
            aria-busy={saving}
            onClick={(e) => void moveStage(r, "new", toolbarOf(e))}
          >
            Move to New
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHeader {...header} toolbar={pipeline} />

      {balance === 0 ? (
        <div className="alert alert--warning">
          <Icon name={ACTION_ICON.credits} className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">0 credits</p>
            <p className="alert__body">
              {/* Every member can open Credits (owner ruling 2026-10-07) — no viewer check. */}
              <PortalLink href="/credits" pendingLabel="Credits">
                Buy credits
              </PortalLink>{" "}
              to unlock an applicant&rsquo;s routed
              contact. This is your own balance — not a signal about any applicant.
            </p>
          </div>
        </div>
      ) : null}

      {/* THE PRIVACY BOUNDARY, stated once, before the data — ONE short line (no title row; one
          line from 360px up), so the first card's Unlock sits above the fold on a 375 × 812
          phone. The head's description already says the rest; the price is on every Unlock. */}
      <div className="alert alert--info">
        <Icon name="mask-happy" className="alert__icon" />
        <div className="alert__text">
          <p className="alert__body">Applicants are faceless until unlocked.</p>
        </div>
      </div>

      {board && visible.length === 0 ? (
        // Per-stage empty copy: each stage shows its OWN neutral message (the page-level "no
        // applicants on this posting yet" lives in page.tsx). Faceless — no PII. The recovery
        // action is another stage: it is a LOCAL tab switch (the same state the segmented control
        // above writes) — no network, no event, nothing persisted.
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon
                name={
                  tab === "new" ? "tray" : tab === "shortlist" ? "bookmark-simple" : ACTION_ICON.reject
                }
              />
            </span>
            {tab === "new" ? (
              <>
                <h3 className="state__title">No applicants in New</h3>
                <p className="state__body">
                  {saved
                    ? "Anything you Kept is under Shortlist; anything you Passed is under Passed."
                    : "Anything you Kept is under Shortlist; anything you Passed is hidden."}
                </p>
                <div className="state__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setActiveStage("shortlist")}
                  >
                    View Shortlist
                  </Button>
                </div>
              </>
            ) : tab === "shortlist" ? (
              <>
                <h3 className="state__title">No shortlisted applicants yet</h3>
                <p className="state__body">
                  Use Keep on a New applicant to move them here.
                </p>
                <div className="state__actions">
                  <Button variant="secondary" size="sm" onClick={() => setActiveStage("new")}>
                    View New
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h3 className="state__title">No passed applicants</h3>
                <p className="state__body">
                  Anyone you Pass is listed here, and Move to New brings them back.
                </p>
                <div className="state__actions">
                  <Button variant="secondary" size="sm" onClick={() => setActiveStage("new")}>
                    View New
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      ) : (
        <div className="applicants-list">
          {visible.map((r, i) => {
            const a = r.applicant;
            const row = rowOf(a.workerId);
            const granted = row.unlock?.kind === "granted" ? row.unlock : null;
            const routed = row.contact?.kind === "routed" ? row.contact : null;
            const stage = stageOf(r);
            // A failed unlock's "Retry" (which never re-prompts) and its error line are the row's
            // that confirmed it. On a posting's feed that is the worker's one card; in the inbox a
            // row of the same worker that has not confirmed shows a plain Unlock, which opens the
            // dialog for ITS posting.
            const unlockError = board || confirmedUnlock[r.key] ? row.unlockError : null;
            const tags = a.skills && a.skills.length > 0 ? a.skills : a.signals;
            // The visible line that says why Unlock is disabled (a real zero balance). Keyed by
            // position, not the worker id, so no full id lands in a DOM attribute.
            const unlockHintId = `applicant-${i}-unlock-hint`;
            return (
              <Card key={r.key} className="applicant">
                <div className="applicant__head">
                  {/* Faceless identity: a MASKED avatar (no photo, no name) + the truncated
                      opaque id; bands are banded taxonomy only — never PII. */}
                  <Avatar masked size={44} aria-hidden="true" />
                  <div className="applicant__id">
                    <span className="bb-mono applicant__id-code">{opaqueId(a.workerId)}</span>
                    {a.tradeLabel ? (
                      <span className="applicant__trade">{a.tradeLabel}</span>
                    ) : null}
                    {a.experienceBand || a.cityLabel ? (
                      <span className="applicant__bands">
                        {bandLabel([a.experienceBand, a.cityLabel])}
                      </span>
                    ) : null}
                  </div>
                  <div className="applicant__relevance">
                    {/* The rank is the applicant's place on ONE posting. On its feed that is the
                        list on screen; in the inbox it reads on the posting line below instead. */}
                    {board ? <Badge tone="neutral">#{a.rank}</Badge> : null}
                    {/*
                      MATCHING V1 (ADR-0036 moment ⑥) vs the legacy weighted engine. The
                      presence of `matchTier` is the discriminator — V1 has no score and
                      no hot flag, and the seam pins both to placeholder constants
                      precisely so they are never rendered as if they meant something.

                      E18: the RAW tier is what the badge says. A tier-2 worker promoted
                      into tier-1 ORDERING by the 36-month floor is still shown as
                      "related" — the company opted into that breadth and should see
                      plainly what it is looking at before spending ₹40 to unlock him.
                      Info tone, not brand: Safety Yellow is the Unlock CTA's colour, and a
                      yellow label on every related card competed with it (W3-A).
                    */}
                    {a.matchTier !== undefined ? (
                      <>
                        {a.matchTier === 1 ? (
                          <Badge tone="success">Has the skill</Badge>
                        ) : (
                          <Badge tone="info">
                            {a.matchedSkillLabel
                              ? `Related · ${a.matchedSkillLabel}`
                              : "Related skill"}
                          </Badge>
                        )}
                        {a.skillMonths !== undefined && a.skillMonths > 0 ? (
                          <span className="bb-mono applicant__months">
                            {monthsLabel(a.skillMonths)}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <span className="bb-mono applicant__score">{a.score.toFixed(2)}</span>
                        {/* `hot` is the engine's boolean, rendered AS-IS as a distinct tag — never a
                            client-side percentile or re-sort (the RANK core owns relevance). */}
                        {a.hot === true ? <Badge tone="warning">Hot</Badge> : null}
                      </>
                    )}
                  </div>
                </div>

                {/* INBOX ONLY — the posting this applicant applied to, and his rank on IT (the
                    inbox itself is newest first, so a rank badge up top would read as a place in
                    this list). The payer's own title; linked to its details when this session has
                    that page, plain text when it does not (an agency's older company posting). */}
                {r.posting ? (
                  <p className="applicant__posting">
                    <span className="applicant__posting-lead">Applied to</span>{" "}
                    {r.posting.href ? (
                      // The click answers before the details page arrives (no loading boundary —
                      // components/portal-link.tsx).
                      <PortalLink
                        className="applicant__posting-link"
                        href={r.posting.href}
                        pendingLabel={r.posting.title}
                      >
                        {r.posting.title}
                      </PortalLink>
                    ) : (
                      <span className="applicant__posting-title">{r.posting.title}</span>
                    )}
                    {" "}
                    <span className="applicant__posting-rank">· ranked #{a.rank}</span>
                  </p>
                ) : null}

                {/* Static taxonomy TAGS, not controls: a list of outline Badges (the outline
                    keeps them visibly distinct from the soft rank badge). They were disabled
                    toggle Chips, which a screen reader announced as "toggle button, not
                    pressed, dimmed". Same text; the list is named for what it holds. */}
                {tags.length > 0 ? (
                  <ul
                    className="applicant__signals"
                    aria-label={a.skills && a.skills.length > 0 ? "Skills" : "Relevance signals"}
                  >
                    {tags.map((s) => (
                      <li key={s}>
                        <Badge tone="neutral" variant="outline">
                          {s}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* The row's SECONDARY actions — the triage toolbar (Keep / Pass, then "Mark as
                    contacted" once a routed handle exists). The PRIMARY action (Unlock) is the
                    footer band below, the card's one focal point. No Call / WhatsApp: see the
                    CONTACT note at the top of this file. A posting's feed always has it; the
                    inbox only with SAVED stages, and only the stage moves (see TWO CALLERS). */}
                {board || saved ? (
                  <div className="applicant__actions">
                    <div className="applicant__pipeline">
                      {/* LOCAL: Keep/Pass are client-only. SAVED: the row's stage and its
                          moves, saved (see PIPELINE at the top). "Mark as contacted" shows only
                          on a posting's board, after a routed reveal, and rides the already-spent
                          unlock (no network). */}
                      {saved ? (
                        savedStageControls(r, stage)
                      ) : (
                        <>
                          {stage === "shortlist" ? (
                            <Badge tone="success">Shortlisted</Badge>
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              iconLeft="bookmark-simple"
                              onClick={() => onKeep(a.workerId)}
                            >
                              Keep
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            iconLeft={ACTION_ICON.reject}
                            onClick={() => onPass(a.workerId)}
                          >
                            Pass
                          </Button>
                        </>
                      )}
                      {board && routed ? (
                        row.contacted ? (
                          <Badge tone="brand" variant="solid">
                            Contacted
                          </Badge>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            iconLeft="check-circle"
                            onClick={() => onContacted(a.workerId)}
                          >
                            Mark as contacted
                          </Button>
                        )
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="applicant__contact">
                  {r.posting?.viewOnly ? (
                    // Its posting's own Applicants page offers this session no unlock, so
                    // neither does its card (candidate-inbox.ts). A constant line, never a
                    // statement about this applicant.
                    <p className="applicant__neutral">
                      View only — applicants to this posting can&rsquo;t be unlocked here.
                    </p>
                  ) : granted ? (
                    <div className="applicant__granted">
                      {/* The UNLOCK status only. "Contacted" is a pipeline stage and shows once,
                          in the toolbar where "Mark as contacted" was (W3-A: it was repeated
                          here as a second solid badge); the unlock itself stays true. */}
                      <div className="applicant__granted-head">
                        <Badge tone="success">Unlocked</Badge>
                        <span className="applicant__until">
                          until <span className="bb-mono">{isoDay(granted.expiresAt)}</span>
                        </span>
                      </div>
                      <div className="applicant__reveal">
                        {row.contact?.kind === "routed" ? (
                          <RoutedContactCard view={row.contact} />
                        ) : row.contact?.kind === "unavailable" ? (
                          // No-oracle: a reveal that comes back unavailable shows the SAME
                          // neutral message for every cause; no retry button (not transient).
                          <p className="applicant__neutral">{row.contact.message}</p>
                        ) : (
                          // A read-out of what the unlock already granted: the VIEW glyph (no
                          // spend, no new tab, nothing to message or dial yet), as on the resume.
                          <Button
                            variant="secondary"
                            size="sm"
                            iconLeft={ACTION_ICON.view}
                            disabled={row.contactBusy}
                            loading={row.contactBusy}
                            aria-busy={row.contactBusy}
                            onClick={() => onRevealContact(granted.unlockId, a.workerId)}
                          >
                            {row.contactBusy
                              ? "Opening…"
                              : row.contactError
                                ? "Retry — open routed contact"
                                : "Open routed contact"}
                          </Button>
                        )}
                        {/* Transient reveal failure: retryable inline error (the button above
                            stays), aria-live for SRs; the row/feed are never blanked. */}
                        <div aria-live="polite">
                          {row.contactError ? (
                            <p className="applicant__error">{row.contactError}</p>
                          ) : null}
                        </div>
                      </div>
                      <div className="applicant__reveal">
                        {row.resume?.kind === "masked" ? (
                          <MaskedResumeCard view={row.resume} />
                        ) : row.resume?.kind === "unavailable" ? (
                          <p className="applicant__neutral">{row.resume.message}</p>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            iconLeft={ACTION_ICON.view}
                            disabled={row.resumeBusy}
                            loading={row.resumeBusy}
                            aria-busy={row.resumeBusy}
                            onClick={() => onMaskedResume(granted.unlockId, a.workerId, r.context)}
                          >
                            {row.resumeBusy
                              ? "Loading…"
                              : row.resumeError
                                ? "Retry — view masked resume"
                                : "View masked resume"}
                          </Button>
                        )}
                        <div aria-live="polite">
                          {row.resumeError ? (
                            <p className="applicant__error">{row.resumeError}</p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : row.unlock?.kind === "unavailable" ? (
                    // CURRENTLY ENGAGED / UNAVAILABLE (no-oracle): one neutral state, IDENTICAL
                    // copy for capped vs unknown vs no-consent vs already-unlocked. The badge is
                    // a constant label (never a deny reason); the message comes from the mapper.
                    <div className="applicant__engaged">
                      <Badge tone="warning">Currently engaged</Badge>
                      <p className="applicant__neutral">{row.unlock.message}</p>
                    </div>
                  ) : (
                    <div className="applicant__unlock">
                      <div className="applicant__unlock-actions">
                        {/* A disabled button takes no hover, so a `title` here was never shown:
                            the reason is the visible line below, tied to the button. */}
                        <Button
                          variant="primary"
                          size="md"
                          iconLeft={ACTION_ICON.unlock}
                          disabled={row.busy || balance === 0}
                          loading={row.busy}
                          aria-busy={row.busy}
                          aria-describedby={balance === 0 ? unlockHintId : undefined}
                          onClick={() => onUnlock(r)}
                        >
                          {row.busy
                            ? "Unlocking…"
                            : unlockError
                              ? "Retry unlock (1 credit)"
                              : "Unlock contact (1 credit)"}
                        </Button>
                        {/* A REAL zero balance only — an unread balance arrives here as 1 (the
                            page's affordance default), so Unlock stays enabled and this never
                            shows. Every member can open Credits, so the disabled Unlock always
                            gets an enabled next step beside it; it is about the payer's own
                            balance, never a signal about this applicant. */}
                        {balance === 0 ? (
                          <PortalLink
                            className="bb-btn bb-btn--secondary"
                            href="/credits"
                            pendingLabel="Credits"
                          >
                            <Icon name={ACTION_ICON.credits} />
                            <span>Buy credits</span>
                          </PortalLink>
                        ) : null}
                      </div>
                      {/* Plain text, not a link: the "Buy credits" button right above is this
                          band's one way to /credits (a second link to the same page was a
                          redundant tab stop on every card). */}
                      {balance === 0 ? (
                        <p className="applicant__hint" id={unlockHintId}>
                          Buy credits to unlock. Guidance only — this is your own balance, never a
                          signal about this applicant.
                        </p>
                      ) : null}
                      {/* Transient unlock failure: retryable inline error (the Unlock button
                          stays + relabels to "Retry"); aria-live for SRs; never blanks the row. */}
                      <div aria-live="polite">
                        {unlockError ? <p className="applicant__error">{unlockError}</p> : null}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Confirm-on-spend (C11): the FIRST unlock per row opens the shared confirm dialog. The
          copy is MOCK-neutral, faceless (names NO candidate detail), and carries no amount
          language beyond "1 credit". Confirming runs the (ids-only) unlock exactly once. */}
      <ConfirmSpendDialog
        open={confirmWorker !== null}
        onCancel={onCancelUnlock}
        onConfirm={onConfirmUnlock}
      />

      {/* Transient unlock-RESULT toast — granted vs. the ONE neutral no-cause failure (XB-C).
          Dismissible; faceless; never logged. Lives in a fixed bottom-right region. With SAVED
          stages the region is always mounted (fixed: it takes no room), so a failed move's toast
          is announced into a live region that already exists; the two toasts stack. A move's
          toast outlives the stages themselves: when the server stops saving them mid-session,
          the "gone" answer's re-read brings rows with no stage (the board turns LOCAL) — and the
          toast saying why must still show. */}
      {result || saved || stageNotice ? (
        <div
          className={
            saved || stageNotice ? "unlock-toast-region unlock-toast-region--stack" : "unlock-toast-region"
          }
          aria-live="polite"
        >
          {result ? <UnlockResultToast kind={result} onClose={() => setResult(null)} /> : null}
          {stageNotice ? (
            <StageNoticeToast notice={stageNotice} onClose={() => setStageNotice(null)} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * A failed SAVED move, said once and politely: what happened and where the row is now. Never a
 * server message (the action returns a reason only) and never a cause about the applicant — the
 * neutral 404 ("gone") is one sentence for every reason the server had, and the page behind it has
 * already been re-read.
 */
function StageNoticeToast({ notice, onClose }: { notice: StageNotice; onClose: () => void }) {
  const where = `${notice.id} is back in ${STAGE_LABEL[notice.stage]}.`;
  if (notice.reason === "gone") {
    return (
      <Toast tone="danger" title="Couldn’t save that move" onClose={onClose}>
        This list changed since it loaded, so it has been refreshed.
      </Toast>
    );
  }
  if (notice.reason === "rate-limited") {
    return (
      <Toast tone="danger" title="Too many changes" onClose={onClose}>
        {where} Try again in a few minutes.
      </Toast>
    );
  }
  return (
    <Toast tone="danger" title="Couldn’t save that move" onClose={onClose}>
      {where} Please try again.
    </Toast>
  );
}
