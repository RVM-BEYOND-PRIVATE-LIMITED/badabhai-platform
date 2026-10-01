import { redirect } from "next/navigation";
import { requirePayer } from "../../../../../lib/auth";
import { agentPostingRedirect, COMPANY_POSTING_ROUTES } from "../../../../../lib/posting-routes";
import { PageHeader } from "../../../../../components/page-header";
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
 *
 * Company-only (owner ruling 2026-10-01): it creates a company `job_postings` row, and an agency
 * posts AGENCY jobs only — an agent who opens it is sent to their own New posting form.
 */
export default async function AiPostingChatPage() {
  const session = await requirePayer();
  if (session.role === "agent") redirect(agentPostingRedirect("create"));

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
      {/* A child of New posting (the same destination, by conversation): back to the form. */}
      <PageHeader
        back={{ href: COMPANY_POSTING_ROUTES.create, label: "New posting" }}
        title="Post with AI"
        description="Have a short conversation instead of filling a form — applicants stay faceless until you unlock them."
      />

      <JobPostingChat resumable={resumable} loadFailed={loadFailed} />
    </>
  );
}
