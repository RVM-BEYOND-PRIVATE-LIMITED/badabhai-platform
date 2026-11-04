"use client";

import { useState, useTransition } from "react";
import { looksLikePii } from "@badabhai/validators";
import type {
  JobPostingChatSessionSummary,
  JobPostingDraft,
  PostingTradeFormWire,
} from "../../../../../lib/contracts";
import { focusControl } from "../../../../../lib/form-focus";
import {
  POSTING_TRADE_REQUIRED_MESSAGE,
  isPostingTrade,
  type PostingTradesProblem,
} from "../../../../../lib/posting-trades";
import { Badge, Button, Card, Textarea } from "../../../../../components/ds";
// Imported from the module path (not the ds barrel) so a test can mock just this
// interactive pill while rendering the other hookless DS primitives for real.
import { Chip } from "../../../../../components/ds/chip";
import { PortalLink } from "../../../../../components/portal-link";
import { usePortalNavigation } from "../../../../../components/portal-navigation";
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

/** The chat's server round-trips — each spins only its own button (W4). */
type ChatAction = "start" | "send" | "publish" | `resume:${string}`;

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
    return "Remove contact details (phone/email) — share those only after you unlock an applicant.";
  }
  return null;
}

/** A short "started <date>" label for a resumable session card. No time-of-day precision. */
function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/**
 * The conversation the choose screen leads with — its Continue is the screen's ONE primary (F18):
 * the most recent one that is ready to publish, else the most recent one. Recency is the last
 * message, else the start. Every other Continue, and "Start a new chat", is secondary.
 */
export function leadSessionId(sessions: readonly JobPostingChatSessionSummary[]): string | null {
  const when = (s: JobPostingChatSessionSummary) => {
    const t = Date.parse(s.lastMessageAt ?? s.startedAt);
    return Number.isNaN(t) ? 0 : t;
  };
  const ready = sessions.filter((s) => s.draftReady);
  let lead: JobPostingChatSessionSummary | null = null;
  for (const s of ready.length > 0 ? ready : sessions) {
    if (lead === null || when(s) > when(lead)) lead = s;
  }
  return lead?.sessionId ?? null;
}

export interface JobPostingChatProps {
  /** In-progress sessions from `GET /payer/job-posting-chat/sessions` (cross-device pickup). */
  resumable: JobPostingChatSessionSummary[];
  /** True when that list read failed — we degrade to "start a new chat", never to fake rows. */
  loadFailed?: boolean;
  /** #2645 — the 16 trades (`GET /payer/posting-trades`) the draft's trade is picked from. */
  postingTrades?: PostingTradeFormWire[];
  /** Why `postingTrades` is empty — said at the picker, with a Retry. */
  postingTradesProblem?: PostingTradesProblem | null;
}

export function JobPostingChat({
  resumable,
  loadFailed = false,
  postingTrades = [],
  postingTradesProblem = null,
}: JobPostingChatProps) {
  // useState order (mirrored by job-posting-chat.test.tsx): convo, text, error, navigating.
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Keep the publish CTA disabled across the success→navigation window so it can never be
  // re-clicked (no double publish) — the same latch the manual posting form uses.
  const [navigating, setNavigating] = useState(false);
  // The publish-step role pick (#2490) — `""` until the payer chooses one. Optional: blank
  // publishes with `role_kind` absent, so the worker card keeps the generic art.
  const [roleKind, setRoleKind] = useState("");
  // The publish-step area/locality (#2493). Until the payer edits it, the input follows the
  // interview draft (`draft.area`); once edited, the payer's value wins and rides the body.
  const [area, setArea] = useState("");
  const [areaTouched, setAreaTouched] = useState(false);
  // Which action is in flight (W4) — so only ITS button spins; the others are just disabled.
  // APPENDED after the seeded states (the tests mirror the order).
  const [acting, setActing] = useState<ChatAction | null>(null);
  // #2645 — the conversation whose Publish was refused for want of a trade (APPENDED).
  const [tradeRefusedFor, setTradeRefusedFor] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The publish lands on the posting's edit page with the shell's "Opening Edit posting…" cue.
  const { navigate } = usePortalNavigation();

  const busy = pending || navigating || acting !== null;
  /** True for the ONE button whose action is running (W4 — one spinner per action). */
  const spins = (action: ChatAction) => acting === action || (action === "publish" && navigating);

  function begin(action: ChatAction, run: () => Promise<void>) {
    setError(null);
    setActing(action);
    startTransition(() => {
      void run().finally(() => setActing(null));
    });
  }

  function onStart() {
    begin("start", async () => {
      const res = await startJobPostingChatAction();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // A new conversation starts with no role/area picked — never carry a
      // previous pick into a different draft.
      setRoleKind("");
      setArea("");
      setAreaTouched(false);
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
    begin(`resume:${sessionId}`, async () => {
      const res = await resumeJobPostingChatAction({ sessionId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRoleKind("");
      setArea("");
      setAreaTouched(false);
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

    begin("send", async () => {
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
    // The publish-step role pick rides the body (#2490). #2645 — it is the draft's trade, one of
    // the 16 (#2635: a company job with none can never go live): Publish without one is refused
    // AT the picker and sends nothing.
    const pickedRole = roleKind.trim();
    if (!isPostingTrade(postingTrades, pickedRole)) {
      setTradeRefusedFor(sessionId);
      focusControl("chatRoleKind");
      return;
    }
    // #2493 — until the payer edits it, the area follows the interview draft; after that the
    // payer's correction wins. Blank stays ABSENT (NULL area = city-only card, never a block).
    const pickedArea = (areaTouched ? area : (convo.draft?.area ?? "")).trim();
    begin("publish", async () => {
      const res = await publishJobPostingChatAction({
        sessionId,
        ...(pickedRole ? { roleKind: pickedRole } : {}),
        ...(pickedArea ? { area: pickedArea } : {}),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // PR-B: ALWAYS route to the EDIT page. The chat publish still leaves the card columns the
      // interview does not collect (area, match skills) NULL/+unset, and the edit page is where
      // `workerCardGaps` are highlighted so the payer completes the card in one place — rather
      // than landing on a read-only detail that hides what is still missing. Latch BEFORE
      // navigating so the CTA can never be re-clicked across the success→navigation window.
      setNavigating(true);
      navigate(`/postings/${res.postingId}/edit`, { pendingLabel: "Edit posting", refresh: true });
    });
  }

  /* ── 1. CHOOSE: continue where you left off, or start fresh ─────────────────── */
  if (convo === null) {
    const lead = leadSessionId(resumable);
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
                    <span className="ai-chat-resume__role">
                      {s.roleTitle ?? "Untitled role"}
                      {/* #1727 — the draft's coarse card city, when it has one. */}
                      {s.city === null ? null : ` · ${s.city}`}
                    </span>
                    <Badge tone={s.draftReady ? "success" : "info"} upper>
                      {s.draftReady ? "Ready to publish" : "In progress"}
                    </Badge>
                    <span className="ai-chat-resume__when">
                      Last active{" "}
                      <span className="bb-mono">{day(s.lastMessageAt ?? s.startedAt)}</span>
                    </span>
                  </div>
                  <Button
                    variant={s.sessionId === lead ? "primary" : "secondary"}
                    size="md"
                    iconRight="arrow-right"
                    loading={spins(`resume:${s.sessionId}`)}
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
            {/* The screen's one primary is a Continue while there is anything to continue. */}
            <Button
              variant={resumable.length > 0 ? "secondary" : "primary"}
              size="lg"
              iconRight="chat-circle-dots"
              loading={spins("start")}
              disabled={busy}
              onClick={onStart}
            >
              {resumable.length > 0 ? "Start a new chat" : "Start chat"}
            </Button>
            <PortalLink className="ai-chat-intro__alt" href="/postings/new" pendingLabel="New posting">
              Use the manual form instead
            </PortalLink>
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
              hint="Never include a phone number or email — share contact only after you unlock an applicant."
              onChange={(e) => setText(e.target.value)}
            />
            {/* Secondary (W4): the screen's one primary is Publish. */}
            <Button
              variant="secondary"
              iconRight="paper-plane-tilt"
              loading={spins("send")}
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
        <DraftPreview
          draft={convo.draft}
          draftReady={convo.draftReady}
          roleKind={roleKind}
          onRoleKindChange={setRoleKind}
          trades={postingTrades}
          tradesProblem={postingTradesProblem}
          roleError={
            tradeRefusedFor === convo.sessionId && !isPostingTrade(postingTrades, roleKind)
              ? POSTING_TRADE_REQUIRED_MESSAGE
              : undefined
          }
          area={areaTouched ? area : (convo.draft?.area ?? "")}
          onAreaChange={(value) => {
            setArea(value);
            setAreaTouched(true);
          }}
        />
        <div className="ai-chat__publish">
          {/* BLOCK: it fills the draft column whatever it reads. Content-sized, it shrank 29px
              under the click (the rocket became the spinner, the label "Publishing…"). */}
          <Button
            block
            size="lg"
            iconRight="rocket-launch"
            loading={spins("publish")}
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
          {/* The page has no back link (a MODE of New posting — F15), so the way to the manual
              form stays here once a conversation is open, as on the choose screen. */}
          <PortalLink className="ai-chat__alt" href="/postings/new" pendingLabel="New posting">
            Use the manual form instead
          </PortalLink>
        </div>
      </aside>
    </div>
  );
}
