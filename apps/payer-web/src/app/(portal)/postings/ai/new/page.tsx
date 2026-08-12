import Link from "next/link";
import { requirePayer } from "../../../../../lib/auth";
import { getJobPostingChatSessions } from "../../../../../lib/payer-api";
import type { JobPostingChatSessionSummary } from "../../../../../lib/contracts";
import { JobPostingChat } from "./job-posting-chat";

export const dynamic = "force-dynamic";

/**
 * AI-assisted job posting (ADR-0035) — the chat-first alternative to the manual form.
 *
 * On load this SERVER page calls `GET /payer/job-posting-chat/sessions` (the frozen
 * cross-device entry point): if the payer already has a conversation in progress — very
 * plausibly started in the BadaBhai payer app on their phone, since ownership is the
 * ACCOUNT and not a device/browser session — the client offers "Continue where you left
 * off" instead of a blank chat.
 *
 * The list read is best-effort: a failure degrades to the start-fresh path with an honest
 * note (`loadFailed`), never to fabricated sessions and never to a blocked page. Starting
 * or resuming is an explicit payer action, so merely opening this page creates no session row.
 */
export default async function AiPostingChatPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";

  let sessions: JobPostingChatSessionSummary[] = [];
  let loadFailed = false;
  try {
    sessions = await getJobPostingChatSessions();
  } catch {
    loadFailed = true;
  }

  // Only an unfinished conversation is resumable — published/abandoned ones are history.
  const resumable = sessions.filter(
    (s) => s.status === "active" || s.status === "draft_ready",
  );

  return (
    <>
      <p className="page-back">
        <Link href="/postings/new">← Post a {isAgency ? "vacancy" : "job"}</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Post with AI</h1>
          <p className="page-head__sub">
            Have a short conversation instead of filling a form. Applicants stay faceless
            until you unlock them.
          </p>
        </div>
      </div>

      <JobPostingChat resumable={resumable} loadFailed={loadFailed} />
    </>
  );
}
