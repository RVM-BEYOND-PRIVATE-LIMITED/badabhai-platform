"use client";

import { useState } from "react";
import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import type { ContactView, RevealView, UnlockView } from "../../../../../lib/unlock-view";
import { isoDay, type GrantedUnlock } from "../../../../../lib/unlock-history";
import { Avatar, Badge, Button, Card, Tabs } from "../../../../../components/ds";
import { PageHeader, type PageHeaderProps } from "../../../../../components/page-header";
import { bandLabel, monthsLabel, opaqueId } from "../../../../../lib/masking";
import {
  ConfirmSpendDialog,
  MaskedResumeCard,
  RoutedContactCard,
  UnlockResultToast,
  type UnlockResultKind,
} from "../../../../../components/unlock";
import { maskedResumeAction, revealContactAction, unlockAction } from "./actions";

/**
 * Client interactivity for the faceless applicant pipeline + unlock + reveal (ADR-0019
 * Decision E) — DS1.3 re-skin onto the BadaBhai Design System. The VISUAL layer changed
 * (DS primitives); every behavior / invariant from the prior build is preserved exactly.
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to
 * the server-held payer (the payer JWT, XB-A) and return only PII-free, already-mapped views.
 *
 * PIPELINE (LOCAL ONLY): a two-stage New → Shortlist board over the existing faceless feed.
 * Keep (New→Shortlist), Pass (dismiss), and "Mark as contacted" are pure CLIENT transitions —
 * NO network call, no event, nothing persisted. The backend's best-first order is preserved
 * (we only filter the already-sorted feed by stage) and the engine's `hot` boolean is rendered
 * AS-IS — we NEVER recompute a percentile or re-sort client-side (ranking is backend-owned).
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
 */

type Stage = "new" | "shortlist";
type RowStage = Stage | "passed";

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

export function ApplicantActions({
  header,
  postingId,
  applicants,
  balance,
  canBuyCredits = false,
  unlocked = {},
}: {
  /** The screen's head text (back link, H1, description); the tabs are added as its toolbar. */
  header: Pick<PageHeaderProps, "back" | "title" | "description">;
  postingId: string;
  applicants: FacelessApplicant[];
  balance: number;
  /**
   * Owner-only AFFORDANCE: a zero balance links to the Credits page only for a viewer who can
   * open it (`/credits` is `requireOwner()`; a recruiter would land on a 404). Default false —
   * a caller that cannot say who is looking never links anyone to a page that may 404.
   */
  canBuyCredits?: boolean;
  /**
   * The payer's LIVE grants for this feed's workers, keyed by worker id (see liveUnlocksFor).
   * Default none — a caller that did not read the unlock history starts every row locked (the
   * server decides any Unlock pressed there; for a live grant it does not debit twice, F-6).
   */
  unlocked?: Record<string, GrantedUnlock>;
}) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Confirm-on-spend (C11): confirm only the FIRST unlock per row this session — a retry
  // after a transient failure (or a later reveal) does not re-prompt. Reveal/resume are
  // NOT spend actions and are never confirmed.
  const [confirmedUnlock, setConfirmedUnlock] = useState<Record<string, boolean>>({});
  // Pipeline stage per row (LOCAL ONLY). A worker absent from the map is "new".
  const [stages, setStages] = useState<Record<string, RowStage>>({});
  const [activeStage, setActiveStage] = useState<Stage>("new");
  // The worker whose first unlock is awaiting confirmation (DS Dialog open ⇔ non-null). The
  // confirm is a pure UI gate in the SCREEN — it sends nothing and names no candidate detail.
  const [confirmWorker, setConfirmWorker] = useState<string | null>(null);
  // Transient unlock-RESULT toast (granted | unavailable). NO-ORACLE: the failure copy is one
  // neutral line with NO cause (the shared toast reuses NEUTRAL_UNLOCK_MESSAGE). It is purely a
  // confirmation of the spend outcome — never names a candidate, never logs. Added LAST so the
  // upstream useState order (rows, confirmedUnlock, stages, activeStage, confirmWorker) is intact.
  const [result, setResult] = useState<UnlockResultKind | null>(null);

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

  function stageOf(workerId: string): RowStage {
    return stages[workerId] ?? "new";
  }

  // Keep / Pass are LOCAL stage transitions — no network, no event, nothing persisted.
  function onKeep(workerId: string) {
    setStages((prev) => ({ ...prev, [workerId]: "shortlist" }));
  }
  function onPass(workerId: string) {
    setStages((prev) => ({ ...prev, [workerId]: "passed" }));
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
  async function runUnlock(workerId: string) {
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

  function onUnlock(workerId: string) {
    // First unlock for this row → OPEN the confirm dialog (the spend gate). A row already
    // confirmed this session (e.g. a retry after a transient failure) unlocks directly — no
    // re-prompt. The dialog copy is MOCK-neutral and names NO candidate detail (faceless).
    if (confirmedUnlock[workerId]) {
      void runUnlock(workerId);
      return;
    }
    setConfirmWorker(workerId);
  }

  // The confirm dialog's success action: mark the row confirmed, close the dialog, then run
  // the (ids-only) unlock. Fires at most once per row — a later retry/reveal never re-prompts.
  function onConfirmUnlock() {
    const workerId = confirmWorker;
    if (workerId === null) return;
    setConfirmedUnlock((prev) => ({ ...prev, [workerId]: true }));
    setConfirmWorker(null);
    void runUnlock(workerId);
  }

  async function onRevealContact(unlockId: string, workerId: string) {
    patch(workerId, { contactBusy: true, contactError: null });
    const res = await revealContactAction({ unlockId });
    if (res.ok) patch(workerId, { contactBusy: false, contact: res.view });
    else patch(workerId, { contactBusy: false, contactError: res.error });
  }

  async function onMaskedResume(unlockId: string, workerId: string) {
    patch(workerId, { resumeBusy: true, resumeError: null });
    // postingId = the disclosure's audit context (the posting whose applicants these are).
    const res = await maskedResumeAction({ unlockId, workerId, postingId });
    if (res.ok) patch(workerId, { resumeBusy: false, resume: res.view });
    else patch(workerId, { resumeBusy: false, resumeError: res.error });
  }

  // Filter the ALREADY best-first feed by the active stage (order preserved; never re-sorted).
  const visible = applicants.filter((a) => stageOf(a.workerId) === activeStage);
  const counts = applicants.reduce(
    (acc, a) => {
      acc[stageOf(a.workerId)] += 1;
      return acc;
    },
    { new: 0, shortlist: 0, passed: 0 } as Record<RowStage, number>,
  );

  // Two-stage pipeline tabs. Keep moves New→Shortlist; Pass dismisses (both LOCAL). They are the
  // screen's filter, so they sit in the page head's toolbar row.
  const pipeline = (
    <div className="applicants-pipeline">
      <Tabs
        variant="segmented"
        aria-label="Applicant pipeline"
        value={activeStage}
        onChange={(id) => setActiveStage(id as Stage)}
        tabs={[
          { id: "new", label: `New (${counts.new})` },
          { id: "shortlist", label: `Shortlist (${counts.shortlist})` },
        ]}
      />
      {counts.passed > 0 ? (
        <span className="applicants-pipeline__note">{counts.passed} passed</span>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader {...header} toolbar={pipeline} />

      {balance === 0 ? (
        <div className="alert alert--warning">
          <Icon name={ACTION_ICON.credits} className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">0 credits</p>
            <p className="alert__body">
              {canBuyCredits ? (
                <>
                  <Link href="/credits">Buy credits</Link> to unlock an applicant&rsquo;s routed
                  contact.
                </>
              ) : (
                <>
                  Ask your account owner to buy credits to unlock an applicant&rsquo;s routed
                  contact.
                </>
              )}{" "}
              This is your own balance — not a signal about any applicant.
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

      {visible.length === 0 ? (
        // Per-stage empty copy: New and Shortlist each show their OWN neutral message (the
        // page-level "no applicants on this posting yet" lives in page.tsx). Faceless — no PII.
        // The recovery action is the OTHER stage: it is a LOCAL tab switch (the same state the
        // segmented control above writes) — no network, no event, nothing persisted.
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name={activeStage === "new" ? "tray" : "bookmark-simple"} />
            </span>
            {activeStage === "new" ? (
              <>
                <h3 className="state__title">No applicants in New</h3>
                <p className="state__body">
                  Anything you Kept is under Shortlist; anything you Passed is hidden.
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
            ) : (
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
            )}
          </div>
        </Card>
      ) : (
        <div className="applicants-list">
          {visible.map((a, i) => {
            const row = rowOf(a.workerId);
            const granted = row.unlock?.kind === "granted" ? row.unlock : null;
            const routed = row.contact?.kind === "routed" ? row.contact : null;
            const stage = stageOf(a.workerId);
            const tags = a.skills && a.skills.length > 0 ? a.skills : a.signals;
            // The visible line that says why Unlock is disabled (a real zero balance). Keyed by
            // position, not the worker id, so no full id lands in a DOM attribute.
            const unlockHintId = `applicant-${i}-unlock-hint`;
            return (
              <Card key={a.workerId} className="applicant">
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
                    <Badge tone="neutral">#{a.rank}</Badge>
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
                    CONTACT note at the top of this file. */}
                <div className="applicant__actions">
                  <div className="applicant__pipeline">
                    {/* Keep/Pass are LOCAL; "Mark as contacted" shows only after a routed
                        reveal and rides the already-spent unlock (no network). */}
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
                    {routed ? (
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

                <div className="applicant__contact">
                  {granted ? (
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
                            onClick={() => onMaskedResume(granted.unlockId, a.workerId)}
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
                          onClick={() => onUnlock(a.workerId)}
                        >
                          {row.busy
                            ? "Unlocking…"
                            : row.unlockError
                              ? "Retry unlock (1 credit)"
                              : "Unlock contact (1 credit)"}
                        </Button>
                        {/* A REAL zero balance only — an unread balance arrives here as 1 (the
                            page's affordance default), so Unlock stays enabled and this never
                            shows. For a viewer who can open Credits, the disabled Unlock gets an
                            enabled next step beside it; it is about the payer's own balance,
                            never a signal about this applicant. */}
                        {balance === 0 && canBuyCredits ? (
                          <Link className="bb-btn bb-btn--secondary" href="/credits">
                            <Icon name={ACTION_ICON.credits} />
                            <span>Buy credits</span>
                          </Link>
                        ) : null}
                      </div>
                      {/* Plain text, not a link: the "Buy credits" button right above is this
                          band's one way to /credits (a second link to the same page was a
                          redundant tab stop on every card). */}
                      {balance === 0 ? (
                        <p className="applicant__hint" id={unlockHintId}>
                          {canBuyCredits
                            ? "Buy credits to unlock."
                            : "Ask your account owner to buy credits."}{" "}
                          Guidance only — this is your own balance, never a signal about this
                          applicant.
                        </p>
                      ) : null}
                      {/* Transient unlock failure: retryable inline error (the Unlock button
                          stays + relabels to "Retry"); aria-live for SRs; never blanks the row. */}
                      <div aria-live="polite">
                        {row.unlockError ? (
                          <p className="applicant__error">{row.unlockError}</p>
                        ) : null}
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
        onCancel={() => setConfirmWorker(null)}
        onConfirm={onConfirmUnlock}
      />

      {/* Transient unlock-RESULT toast — granted vs. the ONE neutral no-cause failure (XB-C).
          Dismissible; faceless; never logged. Lives in a fixed bottom-right region. */}
      {result ? (
        <div className="unlock-toast-region" aria-live="polite">
          <UnlockResultToast kind={result} onClose={() => setResult(null)} />
        </div>
      ) : null}
    </>
  );
}
