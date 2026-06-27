"use client";

import { useState } from "react";
import Link from "next/link";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import type { ContactView, RevealView, UnlockView } from "../../../../../lib/unlock-view";
import { Avatar, Badge, Button, Card, Chip, Tabs } from "../../../../../components/ds";
import { bandLabel, opaqueId } from "../../../../../lib/masking";
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
 * CONTACT (GATED): Call / WhatsApp stay DISABLED until the existing Unlock → reveal flow has
 * returned a ROUTED relay handle for that row (`row.contact.kind === "routed"`). They reuse
 * that relay — NEVER a phone (ADR-0010 F-4: ContactView has no phone/number field; the channel
 * is only `in_app_relay` / `proxy_number`). "Mark as contacted" rides the SAME already-confirmed
 * spend (the unlock) — it never re-spends, re-prompts, or calls the network.
 *
 * LOADING: busy / contactBusy / resumeBusy each surface the Button `loading` spinner + `aria-busy`
 * + disabled on their OWN action while it is pending; the error region stays aria-live for SRs.
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
  /** Which routed-relay modality the payer chose to reach out on (LOCAL; never a phone). */
  reach: "call" | "whatsapp" | null;
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
  reach: null,
  contacted: false,
};

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

export function ApplicantActions({
  postingId,
  applicants,
  balance,
}: {
  postingId: string;
  applicants: FacelessApplicant[];
  balance: number;
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

  function patch(workerId: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [workerId]: { ...(prev[workerId] ?? EMPTY), ...p } }));
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

  // Call / WhatsApp: choose a routed-relay modality. LOCAL — only enabled once a routed
  // handle exists; it records the chosen modality and reuses the relay shown above. It
  // NEVER dials a phone (there is none) and makes no network call.
  function onReach(workerId: string, modality: "call" | "whatsapp") {
    patch(workerId, { reach: modality });
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
    const res = await maskedResumeAction({ unlockId, workerId });
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

  return (
    <>
      {balance === 0 ? (
        <Card variant="outline" className="applicants-warn">
          <Badge tone="warning" upper>
            0 credits
          </Badge>
          <p className="applicants-warn__msg">
            <Link href="/credits">Top up</Link> to unlock a candidate&rsquo;s routed contact. This
            is your own balance — not a signal about any candidate.
          </p>
        </Card>
      ) : null}

      {/* Two-stage pipeline tabs. Keep moves New→Shortlist; Pass dismisses (both LOCAL). */}
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
          <span className="applicants-pipeline__note">· {counts.passed} passed</span>
        ) : null}
      </div>

      {visible.length === 0 ? (
        // Per-stage empty copy: New and Shortlist each show their OWN neutral message (the
        // page-level "no applicants on this posting yet" lives in page.tsx). Faceless — no PII.
        <Card variant="flat" className="applicants-empty">
          {activeStage === "new"
            ? "No candidates in New. Anything you Kept is under Shortlist; anything you Passed is hidden."
            : "No shortlisted candidates yet. Use Keep on a New candidate to move them here."}
        </Card>
      ) : (
        <div className="applicants-list">
          {visible.map((a) => {
            const row = rows[a.workerId] ?? EMPTY;
            const granted = row.unlock?.kind === "granted" ? row.unlock : null;
            const routed = row.contact?.kind === "routed" ? row.contact : null;
            const stage = stageOf(a.workerId);
            const tags = a.skills && a.skills.length > 0 ? a.skills : a.signals;
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
                    <span className="bb-mono applicant__score">{a.score.toFixed(2)}</span>
                    {/* `hot` is the engine's boolean, rendered AS-IS as a distinct tag — never a
                        client-side percentile or re-sort (the RANK core owns relevance). */}
                    {a.hot === true ? (
                      <Badge tone="warning">Hot</Badge>
                    ) : null}
                  </div>
                </div>

                {tags.length > 0 ? (
                  <div className="applicant__signals">
                    {tags.map((s) => (
                      <Chip key={s} tabIndex={-1} aria-disabled="true">
                        {s}
                      </Chip>
                    ))}
                  </div>
                ) : null}

                <div className="applicant__pipeline">
                  {/* Keep/Pass are LOCAL; "Mark as contacted" shows only after a routed reveal
                      and rides the already-spent unlock (no network). */}
                  {stage === "shortlist" ? (
                    <Badge tone="success">Shortlisted</Badge>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => onKeep(a.workerId)}>
                      Keep
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onPass(a.workerId)}>
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
                        onClick={() => onContacted(a.workerId)}
                      >
                        Mark as contacted
                      </Button>
                    )
                  ) : null}
                </div>

                <div className="applicant__reach">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!routed}
                    title={routed ? undefined : "Unlock & open the routed contact to enable"}
                    onClick={() => onReach(a.workerId, "call")}
                  >
                    Call
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!routed}
                    title={routed ? undefined : "Unlock & open the routed contact to enable"}
                    onClick={() => onReach(a.workerId, "whatsapp")}
                  >
                    WhatsApp
                  </Button>
                  {routed && row.reach ? (
                    <p className="applicant__hint">
                      {row.reach === "call" ? "Voice" : "Chat"} relay ready — reach this candidate
                      through the <strong>routed relay</strong> shown below. It&rsquo;s an opaque
                      in-app relay, <strong>never a phone number</strong>.
                    </p>
                  ) : !routed ? (
                    <p className="applicant__hint">
                      Call / WhatsApp open after you unlock and open the routed contact.
                    </p>
                  ) : null}
                </div>

                <div className="applicant__contact">
                  {granted ? (
                    <div className="applicant__granted">
                      <div className="applicant__granted-head">
                        {row.contacted ? (
                          <Badge tone="brand" variant="solid">
                            Contacted
                          </Badge>
                        ) : (
                          <Badge tone="success">Unlocked</Badge>
                        )}
                        <span className="applicant__until">
                          until <span className="bb-mono">{day(granted.expiresAt)}</span>
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
                          <Button
                            variant="secondary"
                            size="sm"
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
                            disabled={row.resumeBusy}
                            loading={row.resumeBusy}
                            aria-busy={row.resumeBusy}
                            onClick={() => onMaskedResume(granted.unlockId, a.workerId)}
                          >
                            {row.resumeBusy
                              ? "Loading…"
                              : row.resumeError
                                ? "Retry — view masked resume"
                                : "View masked resume (preview)"}
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
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={row.busy || balance === 0}
                        loading={row.busy}
                        aria-busy={row.busy}
                        title={balance === 0 ? "Top up to unlock" : undefined}
                        onClick={() => onUnlock(a.workerId)}
                      >
                        {row.busy
                          ? "Unlocking…"
                          : row.unlockError
                            ? "Retry unlock (1 credit)"
                            : "Unlock contact (1 credit)"}
                      </Button>
                      {balance === 0 ? (
                        <p className="applicant__hint">
                          <Link href="/credits">Top up to unlock</Link>. Guidance only — this is
                          your own balance, never a signal about this candidate.
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
