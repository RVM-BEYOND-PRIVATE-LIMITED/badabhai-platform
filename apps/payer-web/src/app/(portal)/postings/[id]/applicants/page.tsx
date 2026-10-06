import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../../../lib/auth";
import { getOrgRole } from "../../../../../lib/auth/org-roles";
import { getApplicantFeed, getDashboard } from "../../../../../lib/payer-api";
import type { ApplicantFeed, UnlockHistoryItem } from "../../../../../lib/contracts";
import { COMPANY_POSTING_ROUTES } from "../../../../../lib/posting-routes";
import { liveUnlocksFor } from "../../../../../lib/unlock-history";
import { Card } from "../../../../../components/ds";
import { PageHeader } from "../../../../../components/page-header";
import { RetryButton } from "../../../../../components/retry-button";
import { ApplicantActions } from "./applicant-actions";

export const dynamic = "force-dynamic";

/**
 * Faceless applicant feed for one of the payer's OWN company postings (ADR-0019 Decision E).
 *
 * XB-A: the feed is fetched payer-scoped; a posting that isn't the payer's returns null ⇒ a
 * NEUTRAL not-found (no cross-tenant existence oracle). XB-C: applicants are faceless (opaque id
 * + banded taxonomy signals) — no name/phone/employer.
 *
 * COMPANY postings only. An agent is sent to the posting's details BEFORE any read: an agency's
 * older company postings are view-only (owner ruling 2026-10-01), and this feed unlocks
 * contacts. There is no agency route onto this feed either — an agency posting's applicants are
 * not reachable in the UI until the endpoint behind it serves agency jobs (backend issue #1898).
 *
 * The page NAMES ITS POSTING (in the back link and the description) from the read it already
 * makes: the dashboard read carries the payer's postings list. No extra fetch; if that read fails
 * or the posting is not in it, the head falls back to generic words.
 *
 * BALANCE (shown ONCE): the shell header's credits chip is the balance. This page still reads it,
 * independently, as an AFFORDANCE for the unlock band (a real zero disables Unlock; an unread
 * balance never does) — it does not print it a second time. The org role only decides whether a
 * zero balance may LINK to the Owner-only Credits page.
 *
 * ALREADY UNLOCKED: the same dashboard read carries the payer's own unlock history; its LIVE
 * grants for this feed's workers start those rows unlocked (an unlock is one grant per payer and
 * worker — ADR-0010 sign-off 1). A failed read starts every row locked, as before.
 *
 * A malformed id is the same neutral not-found as an unknown one, decided BEFORE any read (the
 * id never reaches the API path), like the posting's detail and edit pages.
 */
export default async function ApplicantsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePayer();
  const { id } = await params;
  if (session.role === "agent") redirect(`/postings/${encodeURIComponent(id)}`);

  if (!z.string().uuid().safeParse(id).success) {
    return (
      <div className="applicants-page">
        {/* No posting to go back to (see the not-found branch below). */}
        <PageHeader {...applicantsHeader(id, null)} back={undefined} />
        <PostingNotFound />
      </div>
    );
  }

  // The two concerns are DECOUPLED (C2): a failure fetching the balance/dashboard must
  // NOT blank the applicant feed. The feed is the page's primary content; the balance is
  // only an affordance signal. Each has its own try/catch and its own degraded state.
  let feed: ApplicantFeed | null = null;
  let feedError = false;
  let notFound = false;
  try {
    feed = await getApplicantFeed(id);
    if (!feed) notFound = true;
  } catch {
    feedError = true;
  }

  let balance: number | null = null;
  let roleTitle: string | null = null;
  let unlocks: UnlockHistoryItem[] = [];
  try {
    const dashboard = await getDashboard({ withPostings: true });
    balance = dashboard.credits.balance;
    roleTitle = dashboard.postings.find((p) => p.id === id)?.roleTitle ?? null;
    unlocks = dashboard.unlocks;
  } catch {
    // Balance unavailable → the feed renders with Unlock enabled; never blank it.
    balance = null;
  }

  const header = applicantsHeader(id, roleTitle);

  // `.applicants-page` only NAMESPACES this screen's layout rules (see the "APPLICANT FEED
  // (DS1.3 · W2-B polish)" block in globals.css); it carries no styling of its own.
  if (feed && feed.applicants.length > 0) {
    return (
      <div className="applicants-page">
        {/* The feed renders its own head: the New / Shortlist tabs are its state and sit in the
            head's toolbar row. */}
        <ApplicantActions
          header={header}
          postingId={feed.postingId}
          applicants={feed.applicants}
          // Balance is an affordance hint only. If it failed to load (null), keep unlock
          // ENABLED — the no-oracle server still makes the real decision; we never block on a
          // UI-side balance we couldn't read.
          balance={balance ?? 1}
          canBuyCredits={getOrgRole(session) === "owner"}
          // Only this feed's workers, only live grants — the client gets no unlock id it has no
          // row for. Request time: this page is force-dynamic.
          unlocked={liveUnlocksFor(
            unlocks,
            feed.applicants.map((a) => a.workerId),
            Date.now(),
          )}
        />
      </div>
    );
  }

  return (
    <div className="applicants-page">
      {/* Not found: there is no posting to go back to, so no back link; the state's own link to
          Postings is the way out (the header trail is not drawn on the narrowest phones). */}
      <PageHeader {...header} back={notFound ? undefined : header.back} />

      {notFound ? (
        <PostingNotFound />
      ) : feedError || !feed ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h2 className="state__title">We couldn&rsquo;t load applicants</h2>
            <p className="state__body">
              This is usually temporary — nothing about this posting has changed. Please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name={ACTION_ICON.users} />
            </span>
            <h2 className="state__title">No applicants on this posting yet</h2>
            <p className="state__body">
              Matching workers appear here — faceless — as they apply. Nothing is needed from you
              meanwhile; a wider skill list on the posting reaches more of them.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

/** The screen's head text, named from the payer's own postings read (null → generic words). */
function applicantsHeader(id: string, roleTitle: string | null) {
  return {
    // Back to the posting this feed belongs to, by its own name (its detail page's H1).
    back: { href: `/postings/${id}`, label: roleTitle ?? "Posting details" },
    title: "Applicants",
    description: roleTitle
      ? `Everyone who applied to ${roleTitle}, best match first and faceless until you unlock a contact.`
      : "Everyone who applied to this posting, best match first and faceless until you unlock a contact.",
  };
}

/**
 * NEUTRAL not-found (XB-A): the copy is the UNION of "does not exist" and "not yours", so it can
 * never be read as an existence oracle for another payer's posting. A malformed id gets it too.
 */
function PostingNotFound() {
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name="file-dashed" />
        </span>
        <h2 className="state__title">No posting found here</h2>
        <p className="state__body">It may not exist, or it isn&rsquo;t one of your postings.</p>
        <div className="state__actions">
          <Link className="bb-btn bb-btn--secondary" href={COMPANY_POSTING_ROUTES.list}>
            <Icon name={ACTION_ICON.posting} />
            <span>Postings</span>
          </Link>
        </div>
      </div>
    </Card>
  );
}
