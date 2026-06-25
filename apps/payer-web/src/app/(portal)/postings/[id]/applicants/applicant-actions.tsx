"use client";

import { useState } from "react";
import Link from "next/link";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import type { ContactView, RevealView, UnlockView } from "../../../../../lib/unlock-view";
import { maskedResumeAction, revealContactAction, unlockAction } from "./actions";

/**
 * Client interactivity for the faceless applicant pipeline + unlock + reveal (ADR-0019
 * Decision E).
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to
 * the server-held payer (the payer JWT, XB-A) and return only PII-free, already-mapped
 * views.
 *
 * PIPELINE (LOCAL ONLY): a two-stage New → Shortlist board over the existing faceless
 * feed. Keep (New→Shortlist) and Pass (dismiss) are pure CLIENT stage transitions — NO
 * network call, no event, nothing persisted. The backend's best-first order is preserved
 * (we only filter the already-sorted feed by stage) and the engine's `hot` boolean is
 * rendered AS-IS — we never recompute a percentile client-side (ranking is backend-owned).
 *
 * CONTACT (GATED): Call / WhatsApp are contact affordances that stay DISABLED until the
 * existing Unlock → reveal flow has returned a ROUTED relay handle for that row
 * (`row.contact.kind === "routed"`). They reuse that relay — they NEVER carry a phone
 * (ADR-0010 F-4: the ContactView type has no phone/number field; the channel is only
 * `in_app_relay` / `proxy_number`).
 *
 * NO-ORACLE (XB-C): an "unavailable" renders ONE neutral message — no branch infers the
 * cause. NO-LOG: nothing logs the result / handle / payer id. Confirm-on-spend (C11):
 * only the FIRST unlock per row prompts.
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

  async function onUnlock(workerId: string) {
    // First unlock for this row → confirm the spend. Money/credit copy is MOCK-neutral and
    // names NO candidate detail (faceless). XT5: the action sends only ids, never an amount.
    if (!confirmedUnlock[workerId]) {
      const ok = window.confirm(
        "Unlock this candidate's routed contact? This spends 1 credit and opens an in-app " +
          "relay — never a phone number. You can reuse the relay until your access window ends.",
      );
      if (!ok) return;
      setConfirmedUnlock((prev) => ({ ...prev, [workerId]: true }));
    }
    patch(workerId, { busy: true, unlockError: null });
    const res = await unlockAction({ postingId, workerId });
    if (res.ok) patch(workerId, { busy: false, unlock: res.view });
    else patch(workerId, { busy: false, unlockError: res.error });
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
        <div className="note warn">
          <strong>You have 0 credits.</strong> <Link href="/credits">Top up</Link> to unlock a
          candidate&rsquo;s routed contact. This is your own balance — not a signal about any
          candidate.
        </div>
      ) : null}

      {/* Two-stage pipeline tabs. Keep moves New→Shortlist; Pass dismisses (both LOCAL). */}
      <div className="btn-row" role="tablist" aria-label="Applicant pipeline">
        <button
          className={activeStage === "new" ? "btn" : "btn secondary"}
          type="button"
          role="tab"
          aria-selected={activeStage === "new"}
          onClick={() => setActiveStage("new")}
        >
          New ({counts.new})
        </button>
        <button
          className={activeStage === "shortlist" ? "btn" : "btn secondary"}
          type="button"
          role="tab"
          aria-selected={activeStage === "shortlist"}
          onClick={() => setActiveStage("shortlist")}
        >
          Shortlist ({counts.shortlist})
        </button>
        {counts.passed > 0 ? (
          <span className="page-sub" style={{ alignSelf: "center", margin: 0 }}>
            · {counts.passed} passed
          </span>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          {activeStage === "new"
            ? "No new candidates — Kept candidates are in Shortlist."
            : "No shortlisted candidates yet. Use Keep on a New candidate to add them here."}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Relevance</th>
              <th>Signals</th>
              <th>Pipeline</th>
              <th>Contact</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const row = rows[a.workerId] ?? EMPTY;
              const granted = row.unlock?.kind === "granted" ? row.unlock : null;
              const routed = row.contact?.kind === "routed" ? row.contact : null;
              const stage = stageOf(a.workerId);
              return (
                <tr key={a.workerId}>
                  <td>
                    <div className="mono">{a.workerId.slice(0, 8)}…</div>
                    {a.tradeLabel ? <div>{a.tradeLabel}</div> : null}
                    {a.experienceBand || a.cityLabel ? (
                      <div className="page-sub" style={{ margin: 0 }}>
                        {[a.experienceBand, a.cityLabel].filter(Boolean).join(" · ")}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className="badge">#{a.rank}</span>{" "}
                    <span className="mono">{a.score.toFixed(2)}</span>
                    {/* `hot` is the engine's flag, rendered AS-IS (no client-side percentile). */}
                    {a.hot ? <span className="badge badge-ok"> hot</span> : null}
                  </td>
                  <td>
                    <div className="skills">
                      {(a.skills && a.skills.length > 0 ? a.skills : a.signals).map((s) => (
                        <span className="skill" key={s}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {/* Pipeline + contact-reach actions. Keep/Pass are LOCAL; Call/WhatsApp are
                        gated behind a granted unlock + a routed reveal (see Contact cell). */}
                    <div className="btn-row">
                      {stage === "shortlist" ? (
                        <span className="badge badge-ok">Shortlisted</span>
                      ) : (
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => onKeep(a.workerId)}
                        >
                          Keep
                        </button>
                      )}
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => onPass(a.workerId)}
                      >
                        Pass
                      </button>
                    </div>
                    <div className="btn-row" style={{ marginTop: 8 }}>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={!routed}
                        title={routed ? undefined : "Unlock & open the routed contact to enable"}
                        onClick={() => onReach(a.workerId, "call")}
                      >
                        Call
                      </button>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={!routed}
                        title={routed ? undefined : "Unlock & open the routed contact to enable"}
                        onClick={() => onReach(a.workerId, "whatsapp")}
                      >
                        WhatsApp
                      </button>
                    </div>
                    {routed && row.reach ? (
                      <p className="page-sub" style={{ margin: "6px 0 0" }}>
                        {row.reach === "call" ? "Voice" : "Chat"} relay ready — reach this candidate
                        through the <strong>routed relay</strong> shown under Contact. It&rsquo;s an
                        opaque in-app relay, <strong>never a phone number</strong>.
                      </p>
                    ) : !routed ? (
                      <p className="page-sub" style={{ margin: "6px 0 0" }}>
                        Call / WhatsApp open after you unlock and open the routed contact.
                      </p>
                    ) : null}
                  </td>
                  <td>
                    {granted ? (
                      <div>
                        <span className="badge badge-ok">Unlocked</span> · until{" "}
                        <span className="mono">{day(granted.expiresAt)}</span>
                        <div style={{ marginTop: 8 }}>
                          {row.contact?.kind === "routed" ? (
                            <RoutedContact view={row.contact} />
                          ) : row.contact?.kind === "unavailable" ? (
                            <p className="note">{row.contact.message}</p>
                          ) : (
                            <button
                              className="btn secondary"
                              type="button"
                              disabled={row.contactBusy}
                              onClick={() => onRevealContact(granted.unlockId, a.workerId)}
                            >
                              {row.contactBusy ? "Opening…" : "Open routed contact"}
                            </button>
                          )}
                          <div aria-live="polite">
                            {row.contactError ? (
                              <p className="error-text">{row.contactError}</p>
                            ) : null}
                          </div>
                        </div>
                        <div style={{ marginTop: 8 }}>
                          {row.resume?.kind === "masked" ? (
                            <MaskedResume view={row.resume} />
                          ) : row.resume?.kind === "unavailable" ? (
                            <p className="note">{row.resume.message}</p>
                          ) : (
                            <button
                              className="btn secondary"
                              type="button"
                              disabled={row.resumeBusy}
                              onClick={() => onMaskedResume(granted.unlockId, a.workerId)}
                            >
                              {row.resumeBusy ? "Loading…" : "View masked resume (preview)"}
                            </button>
                          )}
                          <div aria-live="polite">
                            {row.resumeError ? (
                              <p className="error-text">{row.resumeError}</p>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : row.unlock?.kind === "unavailable" ? (
                      <p className="note">{row.unlock.message}</p>
                    ) : (
                      <>
                        <button
                          className="btn"
                          type="button"
                          disabled={row.busy || balance === 0}
                          title={balance === 0 ? "Top up to unlock" : undefined}
                          onClick={() => onUnlock(a.workerId)}
                        >
                          {row.busy ? "Unlocking…" : "Unlock contact (1 credit)"}
                        </button>
                        {balance === 0 ? (
                          <p className="note" style={{ margin: "6px 0 0" }}>
                            <Link href="/credits">Top up to unlock</Link>. Guidance only — this is
                            your own balance, never a signal about this candidate.
                          </p>
                        ) : null}
                        <div aria-live="polite">
                          {row.unlockError ? <p className="error-text">{row.unlockError}</p> : null}
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * Renders the LIVE reveal: a ROUTED relay handle ONLY (ADR-0010 F-4). There is NO
 * field here that could show a phone or a number — the artifact is an opaque, expiring
 * relay; the raw contact stays server-side and is never sent to the browser.
 */
function RoutedContact({ view }: { view: Extract<ContactView, { kind: "routed" }> }) {
  return (
    <div className="card" style={{ marginTop: 4 }}>
      <p className="page-sub" style={{ margin: 0 }}>
        <strong>Routed contact.</strong> This is an opaque relay —{" "}
        <strong>not a phone number</strong>. Use it in-app to reach the candidate; it expires with
        your access window.
      </p>
      <dl className="dl">
        <dt>Relay handle</dt>
        <dd className="mono">{view.relayHandle}</dd>
        <dt>Channel</dt>
        <dd>{view.channel === "in_app_relay" ? "In-app relay" : "Proxy number"}</dd>
        <dt>Access until</dt>
        <dd className="mono">{day(view.expiresAt)}</dd>
      </dl>
    </div>
  );
}

/**
 * WAITING (mock) masked-resume preview (XB-E): masked initials + a link + NO phone.
 * There is no field here that could show a raw name or phone — the artifact carries
 * neither. Flagged as a preview until a payer-authed disclosure endpoint lands.
 */
function MaskedResume({ view }: { view: Extract<RevealView, { kind: "masked" }> }) {
  return (
    <div className="card" style={{ marginTop: 4 }}>
      <p className="page-sub" style={{ margin: 0 }}>
        <strong>Masked resume (preview).</strong> Identity is masked —{" "}
        <strong>no phone, no full name</strong> is shown.
      </p>
      <dl className="dl">
        <dt>Candidate</dt>
        <dd className="mono">{view.displayInitials}</dd>
        <dt>Resume</dt>
        <dd>
          <a href={view.resumeUrl} target="_blank" rel="noopener noreferrer">
            Open masked resume (PDF) →
          </a>
        </dd>
        <dt>Access until</dt>
        <dd className="mono">{day(view.expiresAt)}</dd>
      </dl>
    </div>
  );
}
