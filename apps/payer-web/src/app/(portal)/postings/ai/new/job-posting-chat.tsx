"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import type {
  JobPostingChatSessionSummary,
  JobPostingDraft,
} from "../../../../../lib/contracts";
import { Badge, Button, Card, Textarea } from "../../../../../components/ds";
// Imported from the module path (not the ds barrel) so a test can mock just this
// interactive pill while rendering the other hookless DS primitives for real.
import { Chip } from "../../../../../components/ds/chip";
import { DraftPreview } from "./draft-preview";
import {
  publishJobPostingChatAction,
  resumeJobPostingChatAction,
  sendJobPostingChatMessageAction,
  startJobPostingChatAction,
} from "./actions";

/**
 * AI job-posting chat (ADR-0035) — the conversational front door onto the UNCHANGED
 * job-posting create path.
 *
 * Runs in the BROWSER and sees NO secret: every backend call goes through a Server Action
 * into the server-only seam, where the httpOnly-cookie Bearer carries the payer identity
 * (XB-A). The client never holds a token and never sends a payer id.
 *
 * TWO SCREENS, no mount effect:
 *  1. CHOOSE — if `GET /payer/job-posting-chat/sessions` found an in-progress conversation
 *     we offer "Continue where you left off" (the CROSS-DEVICE pickup: it was very likely
 *     started in the payer mobile app — ownership is the ACCOUNT, never a device or browser
 *     session), alongside "Start a new chat". A session row is created only when the payer
 *     actually asks for one, never merely by loading the page.
 *  2. CHAT — the transcript, the deterministic engine's suggested-answer chips, a live
 *     structured {@link DraftPreview}, and the publish CTA.
 *
 * INVARIANTS VISIBLE HERE:
 *  - The company/org name is NEVER asked and never typed (rule A) — it is auto-filled
 *    server-side at publish from `payers.orgNameEnc` and never reaches the LLM.
 *  - Vacancies stay BANDED (rule B / ADR-0012) — the preview renders the band, never a count.
 *  - The suggested replies come from the DETERMINISTIC engine (invariant #4); this component
 *    never invents a question or decides readiness — `draftReady` is the engine's signal.
 *  - The inline `looksLikePii` screen mirrors the manual posting form's description check;
 *    the Server Action re-validates it and the backend's fail-closed pseudonymization
 *    gateway remains the authority.
 */

const MAX_TURN_CHARS = 2000;

interface ChatLine {
  role: "payer" | "assistant";
  text: string;
}

interface Conversation {
  sessionId: string;
  lines: ChatLine[];
  draft: JobPostingDraft | null;
  draftReady: boolean;
  suggestions: string[];
}

/** Inline UX-parity screen (the Server Action's Zod stays the authority). */
export function validateTurn(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "Type an answer first.";
  if (t.length > MAX_TURN_CHARS) {
    return `That message is too long — keep it under ${MAX_TURN_CHARS} characters.`;
  }
  if (looksLikePii(t)) {
    return "Remove contact details (phone/email) — share those only after you unlock a candidate.";
  }
  return null;
}

/** A short "started <date>" label for a resumable session card. No time-of-day precision. */
function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

export interface JobPostingChatProps {
  /** In-progress sessions from `GET /payer/job-posting-chat/sessions` (cross-device pickup). */
  resumable: JobPostingChatSessionSummary[];
  /** True when that list read failed — we degrade to "start a new chat", never to fake rows. */
  loadFailed?: boolean;
}

export function JobPostingChat({ resumable, loadFailed = false }: JobPostingChatProps) {
  const router = useRouter();
  // useState order (mirrored by job-posting-chat.test.tsx): convo, text, error, navigating.
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Keep the publish CTA disabled across the success→navigation window so it can never be
  // re-clicked (no double publish) — the same latch the manual posting form uses.
  const [navigating, setNavigating] = useState(false);
  const [pending, startTransition] = useTransition();

  const busy = pending || navigating;

  function begin(run: () => Promise<void>) {
    setError(null);
    startTransition(() => {
      void run();
    });
  }

  function onStart() {
    begin(async () => {
      const res = await startJobPostingChatAction();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConvo({
        sessionId: res.turn.sessionId,
        lines: [{ role: "assistant", text: res.turn.replyText }],
        draft: res.turn.draft,
        draftReady: res.turn.draftReady,
        suggestions: res.turn.suggestedReplies,
      });
    });
  }

  function onResume(sessionId: string) {
    begin(async () => {
      const res = await resumeJobPostingChatAction({ sessionId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConvo({
        sessionId: res.transcript.sessionId,
        lines: res.transcript.messages
          .filter((m) => m.text.trim().length > 0)
          .map((m) => ({ role: m.role, text: m.text })),
        draft: res.transcript.draft,
        draftReady: res.transcript.draftReady,
        suggestions: res.transcript.suggestedReplies,
      });
    });
  }

  function onSend(raw: string) {
    if (convo === null) return;
    const invalid = validateTurn(raw);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    const said = raw.trim();
    const sessionId = convo.sessionId;
    // Optimistically show the payer's own line and clear the composer; a failed turn keeps
    // the line visible with a retryable error rather than silently swallowing what they typed.
    setConvo({ ...convo, lines: [...convo.lines, { role: "payer", text: said }], suggestions: [] });
    setText("");

    begin(async () => {
      const res = await sendJobPostingChatMessageAction({ sessionId, text: said });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConvo((prev) =>
        prev === null
          ? prev
          : {
              sessionId: res.turn.sessionId,
              lines: [...prev.lines, { role: "assistant", text: res.turn.replyText }],
              draft: res.turn.draft,
              draftReady: res.turn.draftReady,
              suggestions: res.turn.suggestedReplies,
            },
      );
    });
  }

  function onPublish() {
    if (convo === null) return;
    const sessionId = convo.sessionId;
    begin(async () => {
      const res = await publishJobPostingChatAction({ sessionId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Latch BEFORE navigating, then route to the posting's EXISTING detail page.
      setNavigating(true);
      router.push(`/postings/${res.postingId}`);
      router.refresh();
    });
  }

  /* ── 1. CHOOSE: continue where you left off, or start fresh ─────────────────── */
  if (convo === null) {
    return (
      <div className="ai-chat-start">
        {resumable.length > 0 ? (
          <Card variant="outline" className="ai-chat-resume">
            <Badge tone="brand" upper>
              Continue where you left off
            </Badge>
            <p className="ai-chat-resume__msg">
              You have a conversation already in progress. It picks up on any device you sign in
              on — including the BadaBhai app on your phone.
            </p>
            <ul className="ai-chat-resume__list">
              {resumable.map((s) => (
                <li key={s.sessionId} className="ai-chat-resume__item">
                  <div className="ai-chat-resume__meta">
                    <span className="ai-chat-resume__role">{s.roleTitle ?? "Untitled role"}</span>
                    <Badge tone={s.draftReady ? "success" : "info"} upper>
                      {s.draftReady ? "Ready to publish" : "In progress"}
                    </Badge>
                    <span className="ai-chat-resume__when">
                      Last active{" "}
                      <span className="bb-mono">{day(s.lastMessageAt ?? s.startedAt)}</span>
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    size="md"
                    iconRight="arrow-right"
                    loading={busy}
                    disabled={busy}
                    onClick={() => onResume(s.sessionId)}
                  >
                    Continue
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card variant="flat" className="ai-chat-intro">
          <h2 className="ai-chat-intro__title">Describe the role, we&rsquo;ll write the posting</h2>
          <p className="ai-chat-intro__msg">
            Answer a few short questions in plain language. We build the posting as you go, and
            you review it before anything goes live. Your company name comes from your account —
            we never ask for it.
          </p>
          {loadFailed ? (
            <p className="ai-chat-intro__msg">
              We couldn&rsquo;t check for an earlier conversation just now. You can still start a
              new one.
            </p>
          ) : null}
          <div className="ai-chat-intro__actions">
            <Button
              size="lg"
              iconRight="chat-circle-dots"
              loading={busy}
              disabled={busy}
              onClick={onStart}
            >
              {resumable.length > 0 ? "Start a new chat" : "Start chat"}
            </Button>
            <Link className="ai-chat-intro__alt" href="/postings/new">
              Use the manual form instead
            </Link>
          </div>
        </Card>

        <div aria-live="polite" className="ai-chat-status">
          {error !== null ? <p className="ai-chat-status__error">{error}</p> : null}
        </div>
      </div>
    );
  }

  /* ── 2. CHAT: transcript + suggestions + live draft + publish ───────────────── */
  return (
    <div className="ai-chat">
      <div className="ai-chat__convo">
        <Card variant="flat" className="ai-chat__thread">
          <ul className="ai-chat__lines" aria-live="polite" aria-label="Conversation">
            {convo.lines.map((line, i) => (
              <li
                key={`${convo.sessionId}:${i}`}
                className={
                  line.role === "payer" ? "ai-chat__line ai-chat__line--payer" : "ai-chat__line"
                }
              >
                <span className="ai-chat__who">{line.role === "payer" ? "You" : "BadaBhai"}</span>
                <span className="ai-chat__text">{line.text}</span>
              </li>
            ))}
          </ul>

          {convo.suggestions.length > 0 ? (
            <div className="ai-chat__chips" aria-label="Suggested answers">
              {convo.suggestions.map((s) => (
                <Chip key={s} disabled={busy} onClick={() => onSend(s)}>
                  {s}
                </Chip>
              ))}
            </div>
          ) : null}

          <div className="ai-chat__composer">
            <Textarea
              id="chatTurn"
              label="Your answer"
              rows={3}
              placeholder="e.g. I need 6 CNC operators in Pune for the night shift"
              value={text}
              maxLength={MAX_TURN_CHARS}
              hint="Never include a phone number or email — share contact only after you unlock a candidate."
              onChange={(e) => setText(e.target.value)}
            />
            <Button
              iconRight="paper-plane-tilt"
              loading={busy}
              disabled={busy || text.trim().length === 0}
              onClick={() => onSend(text)}
            >
              Send
            </Button>
          </div>

          <div aria-live="polite" className="ai-chat-status">
            {error !== null ? <p className="ai-chat-status__error">{error}</p> : null}
          </div>
        </Card>
      </div>

      <aside className="ai-chat__side">
        <DraftPreview draft={convo.draft} draftReady={convo.draftReady} />
        <div className="ai-chat__publish">
          <Button
            size="lg"
            iconRight="rocket-launch"
            loading={busy}
            disabled={busy || !convo.draftReady}
            onClick={onPublish}
          >
            {navigating ? "Publishing…" : "Publish posting"}
          </Button>
          {!convo.draftReady ? (
            <p className="ai-chat__publish-note">
              Keep answering — publish unlocks once the posting has everything it needs.
            </p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
