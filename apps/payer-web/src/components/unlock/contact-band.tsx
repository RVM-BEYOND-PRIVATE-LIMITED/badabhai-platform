/**
 * The faceless card's CONTACT BAND — the ONE spend → reveal surface every candidate card ends on:
 * the Unlock CTA (with its zero-balance next step), the neutral "Currently engaged" state, and —
 * once granted — "Unlocked until", Open routed contact (the relay handle, NEVER a phone) and View
 * masked resume. Used by a posting's Applicants feed / the applicant inbox (ApplicantActions) and
 * by the all-candidates search (CandidateSearchList), so the spend and the reveal read the same
 * everywhere (ADR-0010 F-4 / XB-C; C11's confirm gate stays in the caller's screen).
 *
 * A RENDER FUNCTION, not a component: it returns the band's elements in place, so the caller's
 * returned tree is exactly what it would be with the band written inline (the card suites walk
 * that tree without expanding components). Hook-free and handler-free: the caller owns the row's
 * state and passes the callbacks; nothing here calls the network, logs, or names a candidate.
 */
import type { ReactElement } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { ContactView, RevealView, UnlockView } from "../../lib/unlock-view";
import { isoDay } from "../../lib/unlock-history";
import { Badge, Button } from "../ds";
import { PortalLink } from "../portal-link";
import { MaskedResumeCard, RoutedContactCard } from "./routed-contact-card";

/** One card's spend / reveal state this session (layered over the page's unlock history). */
export interface UnlockRowState {
  busy: boolean;
  unlock: UnlockView | null;
  unlockError: string | null;
  contactBusy: boolean;
  contact: ContactView | null;
  contactError: string | null;
  resumeBusy: boolean;
  resume: RevealView | null;
  resumeError: string | null;
}

export const EMPTY_UNLOCK_ROW: UnlockRowState = {
  busy: false,
  unlock: null,
  unlockError: null,
  contactBusy: false,
  contact: null,
  contactError: null,
  resumeBusy: false,
  resume: null,
  resumeError: null,
};

export interface ContactBandInput {
  row: UnlockRowState;
  /**
   * The failed unlock's error line, when THIS card owns it (the caller decides: in the inbox a
   * worker's other card never inherits it). Non-null also relabels Unlock to "Retry unlock".
   */
  unlockError: string | null;
  /** The payer's own balance — an affordance only (an unread balance arrives as 1). */
  balance: number;
  /** The id of the visible "why Unlock is disabled" line — position-keyed, never a worker id. */
  unlockHintId: string;
  /** The card's posting offers this session no unlock (an inbox card's view-only posting). */
  viewOnly: boolean;
  onUnlock: () => void;
  onRevealContact: (unlockId: string) => void;
  onMaskedResume: (unlockId: string) => void;
}

export function contactBand({
  row,
  unlockError,
  balance,
  unlockHintId,
  viewOnly,
  onUnlock,
  onRevealContact,
  onMaskedResume,
}: ContactBandInput): ReactElement {
  const granted = row.unlock?.kind === "granted" ? row.unlock : null;
  return (
    <div className="applicant__contact">
      {viewOnly ? (
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
                onClick={() => onRevealContact(granted.unlockId)}
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
              {row.contactError ? <p className="applicant__error">{row.contactError}</p> : null}
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
                onClick={() => onMaskedResume(granted.unlockId)}
              >
                {row.resumeBusy
                  ? "Loading…"
                  : row.resumeError
                    ? "Retry — view masked resume"
                    : "View masked resume"}
              </Button>
            )}
            <div aria-live="polite">
              {row.resumeError ? <p className="applicant__error">{row.resumeError}</p> : null}
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
              onClick={() => onUnlock()}
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
              <PortalLink className="bb-btn bb-btn--secondary" href="/credits" pendingLabel="Credits">
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
              Buy credits to unlock. Guidance only — this is your own balance, never a signal
              about this applicant.
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
  );
}
