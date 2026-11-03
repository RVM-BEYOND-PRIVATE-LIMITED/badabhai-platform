"use client";

import { useState } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { CandidateSearchRow } from "../../../lib/contracts";
import type { GrantedUnlock } from "../../../lib/unlock-history";
import { bandLabel, monthsLabel, opaqueId } from "../../../lib/masking";
import { shownTradeLevel } from "../../../lib/trade-level";
// The count copy's own dependency-free module — the search's URL reads (zod) stay off the client.
import { countSummary, type SearchCounts } from "../../../lib/candidate-counts";
import { Avatar, Badge, Card } from "../../../components/ds";
import { PageHeader, type PageHeaderProps } from "../../../components/page-header";
import { PortalLink } from "../../../components/portal-link";
import {
  ConfirmSpendDialog,
  contactBand,
  EMPTY_UNLOCK_ROW,
  UnlockResultToast,
  type UnlockResultKind,
  type UnlockRowState,
} from "../../../components/unlock";
import {
  candidateUnlockAction,
  maskedResumeAction,
  revealContactAction,
  type ContactActionResult,
  type RevealActionResult,
  type UnlockActionResult,
} from "../postings/[id]/applicants/actions";

/**
 * ALL CANDIDATES — the faceless card list of one search page (ADR-0040 E2; owner rulings
 * 2026-11-03). The applicant card's family, for people who applied to nothing: the SAME masked
 * card (masked avatar, opaque id, closed-vocabulary facts — never a name, phone or photo), the
 * SAME 1-credit unlock behind the ONE ConfirmSpendDialog, the SAME reveal (an opaque in-app relay
 * handle) and the SAME masked résumé — the contact band is the applicant card's own
 * (components/unlock/contact-band.tsx). What differs is only what a search row carries:
 *  - NO POSTING: the unlock goes out with `job_id: null` (`candidateUnlockAction`) and the masked
 *    résumé with `job_posting_id: null` (`maskedResumeAction` with no posting) — the API's own
 *    "no context". The client names only the opaque worker id; the server decides every spend.
 *  - THE CARD leads with the role (`role.label`); a related match (tier 2) says "Related to <the
 *    picked role>"; years in role are the applicant card's months formatter (bucketed to 6 — never
 *    a precision the data lacks); industry + years in it, or "not recorded"; the city only when
 *    the worker's own is recorded; his other roles as tags (four at most); the rung exactly as the
 *    applicant card prints it (lib/trade-level.ts).
 *  - THE COUNTS sit right above the list, from the same response as the rows (ADR-0040 Decision 3):
 *    three numbers, never folded. A filtered, non-strict list draws "Other candidates" before its
 *    first non-match, so it is plain that the matches lead (the order is the server's — nothing
 *    here re-sorts or filters a row).
 *
 * Runs in the BROWSER and sees NO secret: the Server Actions bind to the server-held payer (XB-A)
 * and return only PII-free, already-mapped views. ALREADY UNLOCKED: `unlocked` carries the payer's
 * LIVE grants for this page's workers, so a reload never offers a fresh spend on one he holds.
 * Confirm-on-spend (C11): only the FIRST unlock per card prompts; a retry never does. A call that
 * never arrives (offline) is the same retryable inline error as a failed one — never a stuck
 * spinner, never a blanked list. NO-ORACLE (XB-C) and NO-LOG as on the applicant card.
 */

/** A call to a Server Action that never arrived (offline, a dropped connection) — retryable. */
const UNREACHABLE = "Couldn’t reach BadaBhai. Please retry.";
/** His other roles a card shows (the API sends at most four; a card never shows more). */
const MAX_OTHER_ROLES = 4;

export interface CandidateSearchListProps {
  /** The screen's head: H1, description, and the toolbar (the view switch + the filter). */
  header: Pick<PageHeaderProps, "title" | "description" | "toolbar">;
  /** The counts from THIS page's response. */
  counts: SearchCounts;
  /** The page's rows, in the server's order. */
  candidates: CandidateSearchRow[];
  /** The role filter's label — what a related (tier-2) card is related TO; null with no role filter. */
  relatedTo: string | null;
  /** The payer's own balance — an affordance only (an unread balance arrives as 1). */
  balance: number;
  /** The payer's LIVE grants for this page's workers, keyed by worker id (see liveUnlocksFor). */
  unlocked?: Record<string, GrantedUnlock>;
}

export function CandidateSearchList({
  header,
  counts,
  candidates,
  relatedTo,
  balance,
  unlocked = {},
}: CandidateSearchListProps) {
  // One card per worker (the server's order is total over worker ids), so every per-card state
  // below is keyed by the worker id.
  const [rows, setRows] = useState<Record<string, UnlockRowState>>({});
  // Confirm-on-spend (C11): a card that confirmed this session unlocks directly on a retry.
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  // The worker whose first unlock awaits confirmation (the dialog is open ⇔ non-null).
  const [confirmWorker, setConfirmWorker] = useState<string | null>(null);
  // The transient unlock-RESULT toast — granted, or the ONE neutral no-cause failure (XB-C).
  const [result, setResult] = useState<UnlockResultKind | null>(null);

  // A card before anything happened to it this session: granted when the payer already holds a
  // live grant on this worker, else locked. Derived from props, so session changes layer over it.
  function baseRow(workerId: string): UnlockRowState {
    const held = unlocked[workerId];
    return held ? { ...EMPTY_UNLOCK_ROW, unlock: held } : EMPTY_UNLOCK_ROW;
  }
  function rowOf(workerId: string): UnlockRowState {
    return rows[workerId] ?? baseRow(workerId);
  }
  function patch(workerId: string, p: Partial<UnlockRowState>) {
    setRows((prev) => ({ ...prev, [workerId]: { ...(prev[workerId] ?? baseRow(workerId)), ...p } }));
  }

  // The posting-less unlock (ids-only body; `job_id` null). Its result raises the toast.
  async function runUnlock(workerId: string) {
    patch(workerId, { busy: true, unlockError: null });
    let res: UnlockActionResult;
    try {
      res = await candidateUnlockAction({ workerId });
    } catch {
      res = { ok: false, error: UNREACHABLE };
    }
    if (res.ok) {
      patch(workerId, { busy: false, unlock: res.view });
      setResult(res.view.kind === "granted" ? "granted" : "unavailable");
    } else {
      patch(workerId, { busy: false, unlockError: res.error });
      setResult("unavailable");
    }
  }

  // The FIRST unlock on a card opens the confirm dialog; one confirmed before (a retry) spends.
  function onUnlock(workerId: string) {
    if (confirmed[workerId]) {
      void runUnlock(workerId);
      return;
    }
    setConfirmWorker(workerId);
  }

  function onConfirmUnlock() {
    const workerId = confirmWorker;
    if (workerId === null) return;
    setConfirmed((prev) => ({ ...prev, [workerId]: true }));
    setConfirmWorker(null);
    void runUnlock(workerId);
  }

  async function onRevealContact(unlockId: string, workerId: string) {
    patch(workerId, { contactBusy: true, contactError: null });
    let res: ContactActionResult;
    try {
      res = await revealContactAction({ unlockId });
    } catch {
      res = { ok: false, error: UNREACHABLE };
    }
    if (res.ok) patch(workerId, { contactBusy: false, contact: res.view });
    else patch(workerId, { contactBusy: false, contactError: res.error });
  }

  // The masked résumé with NO posting context: `job_posting_id` goes out as null.
  async function onMaskedResume(unlockId: string, workerId: string) {
    patch(workerId, { resumeBusy: true, resumeError: null });
    let res: RevealActionResult;
    try {
      res = await maskedResumeAction({ unlockId, workerId });
    } catch {
      res = { ok: false, error: UNREACHABLE };
    }
    if (res.ok) patch(workerId, { resumeBusy: false, resume: res.view });
    else patch(workerId, { resumeBusy: false, resumeError: res.error });
  }

  const summary = countSummary(counts);
  // Filters REORDER (ADR-0040 Decision 1): in a filtered, non-strict list the matches lead and
  // everyone else follows — the divider sits before the first card that does not match.
  const dividerAt =
    counts.filtered && !counts.strict ? candidates.findIndex((c) => !c.matchesFilters) : -1;

  return (
    <>
      <PageHeader {...header} />

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
              to unlock a candidate&rsquo;s routed contact. This is your own balance — not a
              signal about any candidate.
            </p>
          </div>
        </div>
      ) : null}

      {/* THE PRIVACY BOUNDARY, stated once, before the data — one short line. */}
      <div className="alert alert--info">
        <Icon name="mask-happy" className="alert__icon" />
        <div className="alert__text">
          <p className="alert__body">Candidates are faceless until unlocked.</p>
        </div>
      </div>

      {summary ? (
        <div className="candidate-search__summary">
          <p className="candidate-search__count">{summary.line}</p>
          {summary.strictNote ? (
            <p className="candidate-search__note">{summary.strictNote}</p>
          ) : null}
        </div>
      ) : null}

      <div className="applicants-list">
        {candidates.flatMap((c, i) => {
          const row = rowOf(c.workerId);
          const level = shownTradeLevel(c.tradeLevels, {
            skillId: c.role.id,
            skillLabel: c.role.label,
          });
          // Bucketed months as the applicant card reads them (lib/masking.ts); a zero bucket
          // prints nothing there, and nothing here.
          const inRole = monthsLabel(c.skillMonths);
          const inIndustry = monthsLabel(c.industryMonths);
          const facts = bandLabel([inRole ? `${inRole} in role` : null, c.city]);
          const industry = bandLabel([
            c.industry.label,
            c.industryMonths === null
              ? "years not recorded"
              : inIndustry
                ? `${inIndustry} in industry`
                : null,
          ]);
          const others = c.otherRoles.slice(0, MAX_OTHER_ROLES);
          // Position-keyed, so no full worker id lands in a DOM attribute.
          const rolesLabelId = `candidate-${i}-roles`;
          const card = (
            <Card key={c.workerId} className="applicant">
              <div className="applicant__head">
                {/* Faceless identity: a MASKED avatar (no photo, no name) + the truncated
                    opaque id; every fact below is closed-vocabulary or bucketed. */}
                <Avatar masked size={44} aria-hidden="true" />
                <div className="applicant__id">
                  <span className="bb-mono applicant__id-code">{opaqueId(c.workerId)}</span>
                  <span className="applicant__trade">{c.role.label}</span>
                  {facts ? <span className="applicant__bands">{facts}</span> : null}
                  <span className="applicant__bands">{industry}</span>
                </div>
                <div className="applicant__relevance">
                  {/* E18's rule, here too: a RELATED match says so plainly before a spend. Info
                      tone, not brand — Safety Yellow is the Unlock CTA's colour. */}
                  {c.matchTier === 2 ? (
                    <Badge tone="info">
                      {relatedTo ? `Related to ${relatedTo}` : "Related role"}
                    </Badge>
                  ) : null}
                  {/* Middle Way P5 — the rung he stated for THIS card's role, printed verbatim
                      (display only: nothing here re-sorts or filters the list). */}
                  {level ? (
                    <Badge tone="neutral" variant="outline" className="applicant__level">
                      {level.tradeLevelLabel}
                    </Badge>
                  ) : null}
                </div>
              </div>

              {/* His other roles: static taxonomy TAGS, not controls. */}
              {others.length > 0 ? (
                <div className="candidate-card__roles">
                  <span className="candidate-card__roles-lead" id={rolesLabelId}>
                    Other roles
                  </span>
                  <ul className="applicant__signals" aria-labelledby={rolesLabelId}>
                    {others.map((r) => (
                      <li key={r.id}>
                        <Badge tone="neutral" variant="outline">
                          {r.label}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* The SAME spend → reveal band as the applicant card. No posting: never view-only. */}
              {contactBand({
                row,
                unlockError: row.unlockError,
                balance,
                unlockHintId: `candidate-${i}-unlock-hint`,
                viewOnly: false,
                onUnlock: () => onUnlock(c.workerId),
                onRevealContact: (unlockId) => onRevealContact(unlockId, c.workerId),
                onMaskedResume: (unlockId) => onMaskedResume(unlockId, c.workerId),
              })}
            </Card>
          );
          return i === dividerAt
            ? [
                <h2 key="other-candidates" className="candidate-search__divider">
                  Other candidates
                </h2>,
                card,
              ]
            : [card];
        })}
      </div>

      {/* Confirm-on-spend (C11): ONE dialog for the list, the same copy as the applicant card's. */}
      <ConfirmSpendDialog
        open={confirmWorker !== null}
        onCancel={() => setConfirmWorker(null)}
        onConfirm={onConfirmUnlock}
      />

      {result ? (
        <div className="unlock-toast-region" aria-live="polite">
          <UnlockResultToast kind={result} onClose={() => setResult(null)} />
        </div>
      ) : null}
    </>
  );
}
