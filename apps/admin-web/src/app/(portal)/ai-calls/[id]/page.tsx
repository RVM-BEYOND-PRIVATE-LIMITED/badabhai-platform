import Link from "next/link";
import type { ReactNode } from "react";
import { requireCapability } from "../../../../lib/auth";
import { can } from "../../../../lib/auth/capabilities";
import { isAdminForbidden, isAdminRequestError } from "../../../../lib/admin-http";
import { getAiTrace, type AiTraceDetail } from "../../../../lib/ai-traces";
import {
  AI_TRACE_TEXT_CAVEAT,
  AI_TRACE_TEXT_CONTROLS,
  aiTraceErrorLabel,
  aiTraceErrorNote,
  aiTraceHalf,
  outcomeTone,
  realCallLabel,
} from "../../../../lib/ai-trace-view";
import { taskTypeLabel } from "../../../../lib/ai-cost";
import { formatCount, formatTimestamp, healthTone } from "../../../../lib/format";
import { DetailList } from "../../../../components/detail-list";
import { StatusPill } from "../../../../components/status-pill";

// Per-request, never cached. The body of this page can contain a worker's own words, and the
// server sends the response it is built from with `Cache-Control: no-store` for exactly that
// reason — a statically rendered or revalidated copy would outlive the audited read that
// disclosed it.
export const dynamic = "force-dynamic";
export const metadata = { title: "AI call" };

/**
 * ONE AI call, decrypted — the request this API sent to the AI service, and the reply it got.
 *
 * ══ THIS IS THE MOST PRIVILEGED SCREEN IN THE PORTAL ═══════════════════════════════════
 * Every other surface here is faceless because the server sends nothing else. The feedback list
 * is the one exception and shows what a worker deliberately typed TO us. This one shows what a
 * worker said to the platform while using it — a whole interview turn at a time, from a table
 * holding every turn of every interview. Read `lib/ai-trace-view.ts` before touching a word of
 * the copy below: it records, in one place, what the platform enforces about that text and what
 * it deliberately does not promise.
 *
 * ══ FOUR NON-SUCCESS SCREENS, AND KEEPING THEM APART IS THE DESIGN ═════════════════════
 *  1. THE SESSION LACKS `read_ai_traces` → said plainly, and NO REQUEST IS MADE. The capability
 *     is in the published role matrix every admin can read on /roles, so naming it is not a
 *     disclosure; pretending the screen does not exist would just leave an operator refreshing.
 *  2. THE SERVER SAYS 403 → the same screen. It means the session's capability list and the
 *     guard disagree (a role changed under a live session), and the honest answer is identical.
 *  3. A MALFORMED ID → "that is not a call id". Distinguishable and worth distinguishing: the
 *     validation pipe rejects a non-uuid before any of the controls below are consulted, so this
 *     answer is available whatever the feature's state, and it tells the operator the one thing
 *     that will actually fix it.
 *  4. A 404 → "not available", NEUTRALLY, and never as an error or as a permission problem.
 *     ⚠ THE SERVER CANNOT TELL THESE APART AND NEITHER MAY THIS PAGE: the flag being off, no
 *     such trace, the per-admin allowance being spent, and a fail-closed Redis error ALL return
 *     the same 404 on purpose. Rendering "you do not have permission" would be false in three of
 *     the four cases; rendering "this call does not exist" would be false in three others; and
 *     rendering "the read is switched off" would answer the exact question the neutral 404 was
 *     built to refuse. So the copy states the ambiguity itself, which is the only true sentence
 *     available, and does it in the plain `.state` style rather than `.state--error` — nothing
 *     has failed.
 */
export default async function AiCallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The floor, first. `read_ai_traces` is then checked BELOW rather than passed to
  // `requireCapability`, and the difference is deliberate: this screen answers a bookmarked or
  // pasted link, and bouncing an operator to the dashboard with `?denied=` tells them nothing
  // about what they were looking at. `<Denied />` names the privilege and links to /roles.
  //
  // The LIST page does redirect, because it is reached from the nav — which already hides the
  // entry for a session that cannot use it — so a redirect there can only be the result of a
  // typed URL. Two screens, two right answers; neither is the boundary, which is the server's.
  const session = await requireCapability("read_entities");
  const { id } = await params;

  const mayReadText = can(session.capabilities, "read_ai_traces");

  /**
   * NO REQUEST AT ALL WITHOUT THE CAPABILITY. Not merely a hidden control: a fetch here would
   * earn a 403 and spend a round trip to learn what the session already told us, and on a route
   * whose every call is metered and logged, the request nobody had a right to make is the one
   * worth not making.
   */
  if (!mayReadText) return <Denied />;

  let trace: AiTraceDetail | null = null;
  let outcome: "ok" | "denied" | "bad-id" | "unavailable" = "ok";
  try {
    trace = await getAiTrace(id);
  } catch (err) {
    if (isAdminForbidden(err)) {
      outcome = "denied";
    } else if (isAdminRequestError(err) && err.status === 400) {
      outcome = "bad-id";
    } else if (isAdminRequestError(err) && err.status === 404) {
      outcome = "unavailable";
    } else {
      // A 5xx or an unreachable API is not any of the four screens above — it is an outage, and
      // dressing it up as "not available" would tell an operator the feature is off when the
      // portal simply could not ask. Let the error boundary say what actually happened.
      throw err;
    }
  }

  if (outcome === "denied") return <Denied />;
  if (outcome === "bad-id") return <BadId />;
  if (outcome === "unavailable" || trace === null) return <Unavailable />;

  const request = aiTraceHalf(trace.prompt, trace.prompt_chars);
  const reply = aiTraceHalf(trace.response, trace.response_chars);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href="/ai-calls">
              AI calls
            </Link>
          </p>
          <h1 className="page__title">{taskTypeLabel(trace.task_type)}</h1>
          <p className="page__sub">
            One AI call in full — what this API sent to the AI service, and what came back.
            Recorded <time dateTime={trace.created_at}>{formatTimestamp(trace.created_at)}</time>.
          </p>
        </div>
      </header>

      {/*
        THE ONE PIECE OF COPY ON THIS SURFACE THAT COULD DO REAL HARM IF IT OVERCLAIMED.
        Both sentences live in `lib/ai-trace-view.ts` and are pinned by its test: the first
        refuses to promise the text is clean, the second states the controls that genuinely
        exist. Neither may be softened into "identifying details are removed" — nothing on this
        path removes them, and an operator who believes otherwise will paste this somewhere.
        It is rendered HERE, inside the success branch, because its second half asserts that the
        audit row for this read has already been committed — which is only true once the server
        has actually returned text.
      */}
      <section className="notice notice--warn" role="status">
        <strong>Read this as the worker&apos;s own words.</strong> {AI_TRACE_TEXT_CAVEAT}{" "}
        {AI_TRACE_TEXT_CONTROLS}
      </section>

      <section className="panel" aria-labelledby="ac-call">
        <div className="panel__head">
          <h2 className="panel__title" id="ac-call">
            The call
          </h2>
          {/* Scoped deliberately to the IDS. "Nothing here is identifying" would be a sentence
              about the panel that the two panels below it would immediately contradict — the
              exact shape of overclaim this surface is guarded against. */}
          <p className="panel__sub">
            The same scalars the list shows, in full. The ids are opaque and this page resolves
            none of them to a name or a number; the words themselves are further down.
          </p>
        </div>
        <DetailList
          items={[
            {
              label: "Outcome",
              value: (
                <>
                  <StatusPill
                    value={trace.success ? "succeeded" : "failed"}
                    tone={outcomeTone(trace.success)}
                  />
                  {trace.error_code ? (
                    <>
                      {" "}
                      <span title={trace.error_code}>{aiTraceErrorLabel(trace.error_code)}</span>
                      {/* Only the two codes the RECORDER mints carry a note, because only they
                          describe the recording rather than the call — an operator who does not
                          know `provider_error` threw the provider's message away on purpose will
                          go looking for a string that was never kept. */}
                      {aiTraceErrorNote(trace.error_code) ? (
                        <>
                          <br />
                          <span className="table__meta">
                            {aiTraceErrorNote(trace.error_code)}
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </>
              ),
            },
            {
              label: "Provider call",
              value: (
                <StatusPill
                  value={realCallLabel(trace.real_call)}
                  tone={healthTone(realCallLabel(trace.real_call))}
                  title={
                    trace.real_call
                      ? "A provider was really called for this."
                      : "No provider was called — the mock adapter answered."
                  }
                />
              ),
            },
            { label: "Model", value: trace.model_name ?? <NotRecorded>no model label arrived with the call</NotRecorded> },
            {
              label: "Prompt template",
              value: trace.prompt_name ?? (
                <NotRecorded>
                  the AI service does not report which template it used back to this API
                </NotRecorded>
              ),
            },
            {
              label: "Template version",
              value: trace.prompt_version ?? (
                <NotRecorded>same reason as the template above</NotRecorded>
              ),
            },
            {
              label: "Worker",
              value: (
                <Link className="link mono" href={`/workers/${trace.worker_id}`}>
                  {trace.worker_id}
                </Link>
              ),
            },
            {
              label: "Interview session",
              value: trace.session_id ? (
                <Link
                  className="link mono"
                  href={`/workers/${trace.worker_id}/journey/${trace.session_id}`}
                >
                  {trace.session_id}
                </Link>
              ) : (
                <NotRecorded>this call was not part of an interview session</NotRecorded>
              ),
            },
            { label: "AI job", value: <span className="mono">{trace.ai_job_id ?? "—"}</span> },
            {
              label: "Correlation id",
              value: trace.correlation_id ? (
                <Link
                  className="link mono"
                  href={`/events?correlationId=${encodeURIComponent(trace.correlation_id)}`}
                  title="Everything recorded under this correlation id"
                >
                  {trace.correlation_id}
                </Link>
              ) : (
                <NotRecorded>no correlation id was recorded</NotRecorded>
              ),
            },
            { label: "AI call id", value: <span className="mono">{trace.ai_call_id}</span> },
            { label: "Trace id", value: <span className="mono">{trace.id}</span> },
          ]}
        />
      </section>

      <Half
        headingId="ac-request"
        title="Request"
        sub="What this API sent to the AI service, stored verbatim. It is the whole request body, not only the worker's words — their turn sits inside it."
        state={request}
      />

      <Half
        headingId="ac-reply"
        title="Reply"
        sub="What came back, stored verbatim and never interpreted here."
        state={reply}
      />
    </div>
  );
}

/**
 * One half of the call: the text, or an honest account of why there is none.
 *
 * The two absences are DIFFERENT FACTS and are never collapsed. `absent` means nothing was ever
 * stored; `undecryptable` means a length was recorded — so text WAS stored — and the ciphertext
 * did not come back. Telling an operator "there was no request" when the truth is "we could not
 * read it" would stop them looking at precisely the moment they should escalate.
 */
function Half({
  headingId,
  title,
  sub,
  state,
}: {
  headingId: string;
  title: string;
  sub: string;
  state: ReturnType<typeof aiTraceHalf>;
}) {
  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel__head">
        <h2 className="panel__title" id={headingId}>
          {title}
        </h2>
        <p className="panel__sub">{sub}</p>
      </div>
      {state.kind === "text" ? (
        // Verbatim, never reformatted. This is a record of what was actually exchanged, and
        // prettifying it would mean an operator reviewing an incident reads the portal's
        // interpretation rather than what was sent — the same ruling the event payload makes.
        // `code--wrap` is what keeps a long body readable without a horizontal drag.
        <pre className="code code--wrap">{state.text}</pre>
      ) : state.kind === "undecryptable" ? (
        <div className="state state--error">
          <h3 className="state__title">Stored, but it could not be read back</h3>
          <p className="state__body">
            {formatCount(state.chars)} characters were recorded for this half of the call, so the
            text was stored — and the stored value did not decrypt. That usually means the key it
            was written under has since been retired. Everything above came from the unencrypted
            columns and is unaffected.
          </p>
        </div>
      ) : (
        <div className="state">
          <h3 className="state__title">Nothing was stored here</h3>
          <p className="state__body">
            No text was recorded for this half of the call, and no length either. That is ordinary
            rather than a fault: speech-to-text sends audio and has no request text, and a call
            that failed before answering has no reply.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * A field the platform genuinely does not hold, with the reason attached.
 *
 * A bare em dash on `Prompt template` would read as "no template was used", which is false —
 * one was, and this app is simply never told which. Naming the reason is the difference between
 * an operator filing a bug and an operator understanding the seam.
 */
function NotRecorded({ children }: { children: ReactNode }) {
  return (
    <span className="table__meta">
      not recorded — {children}
    </span>
  );
}

/** The page frame every non-success screen shares: the same eyebrow, the same way back. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href="/ai-calls">
              AI calls
            </Link>
          </p>
          <h1 className="page__title">AI call</h1>
        </div>
      </header>
      {children}
    </div>
  );
}

/**
 * The session does not hold `read_ai_traces` — or the server disagreed with the session and
 * said 403. One screen for both, because the operator's situation is identical.
 *
 * NOT the neutral screen below, deliberately. This is a fact about the READER, which the portal
 * knows for certain and which the published role matrix already states; blurring it into "not
 * available" would leave an operator reloading a page that will never change for them.
 */
function Denied() {
  return (
    <Frame>
      <section className="state">
        <h3 className="state__title">Your role cannot read the text of an AI call</h3>
        <p className="state__body">
          The list of calls is open to you in full — what each one was for, which model answered,
          whether it succeeded, and how long the request and the reply were. Nothing on it has
          been withheld. Turning one of those lengths back into the words themselves is a
          separate capability, and this account does not hold it, so nothing was requested.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/ai-calls">
            Back to AI calls
          </Link>
          <Link className="btn btn--ghost" href="/roles">
            Roles and capabilities
          </Link>
        </div>
      </section>
    </Frame>
  );
}

/** The id in the address bar is not the shape a call id takes. */
function BadId() {
  return (
    <Frame>
      <section className="state">
        <h3 className="state__title">That is not a call id</h3>
        <p className="state__body">
          The value in the address bar is not in the form this table uses, so nothing was looked
          up. Open a call from the list rather than editing the address.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/ai-calls">
            Back to AI calls
          </Link>
        </div>
      </section>
    </Frame>
  );
}

/**
 * The NEUTRAL 404, rendered as what it is: one answer covering several situations, none of
 * which this page may claim.
 *
 * Plain `.state`, never `.state--error`: nothing failed. And no permission language, because in
 * most of the cases it covers the reader's permissions are not the reason — see the four-screen
 * note at the top of this file for why guessing between them is the one thing forbidden here.
 */
function Unavailable() {
  return (
    <Frame>
      <section className="state">
        <h3 className="state__title">This call&apos;s text is not available</h3>
        <p className="state__body">
          The server answered &ldquo;not found&rdquo;, and that one answer deliberately covers
          several different situations: there may be no call stored under this id, the text read
          may not be switched on, or this account may have used up its allowance for the moment.
          It is not possible to tell which from here, and that is by design — an answer specific
          enough to be useful would also be specific enough to probe. Nothing has failed, and the
          call&apos;s own record is still on the list.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/ai-calls">
            Back to AI calls
          </Link>
        </div>
      </section>
    </Frame>
  );
}
