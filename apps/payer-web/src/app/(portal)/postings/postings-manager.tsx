"use client";

import Link from "next/link";
import { useState } from "react";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button, Card } from "../../../components/ds";
import {
  closePostingAction,
  pausePostingAction,
  resumePostingAction,
  topUpQuotaAction,
} from "./actions";

/**
 * Client job-management surface (ADR-0019 Phase 1) — UI-1 skin, LIVE lifecycle.
 *
 * Runs in the BROWSER and sees NO secret. Each posting renders as a DS Card with its
 * real `status` Badge. Its TITLE opens the posting's details (as on the agency list); the row's
 * own links name what they open — "Applicants" (the faceless feed) and "Edit posting", the same
 * names every company surface uses (F13). (XB-A: the Server Actions bind tenancy to the
 * server-held session — the client never passes a payer id, only the posting id.)
 *
 * The trio (pause / resume / add applicant slots) + CLOSE are LIVE payer-authed routes
 * (`POST /payer/job-postings/:id/{pause|resume|quota-topup|close}`, #178/#180). A row draws
 * ONLY the actions its status allows (F27): a disabled button cannot say why (no hover on a
 * disabled control), so Pause is drawn for an OPEN posting only, Resume for a PAUSED one, Close
 * for a draft or open one, and a closed posting has no action bar at all. Each action is per-row
 * busy-guarded: the pressed button spins, its siblings are disabled (F39); a failure renders a
 * retryable inline error in the row's aria-live region — never fake data, never a blanked row.
 *
 * FACELESS: a posting row carries only the payer's OWN fields (role / location / openings
 * band / status / applicant count / created date) — no worker name/phone ever reaches the DOM.
 *
 * READ-ONLY (`readOnly`): an agent's OLDER company postings (see ../page.tsx) render without
 * the lifecycle buttons and without the row links (no Applicants, no Edit) — visible by direct
 * link, never managed or worked from here. The server actions keep their own gate; hiding the
 * controls is an affordance, not the control.
 */

const NONE = "—";

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/** The DS Badge tone for a posting's REAL lifecycle status (reflects `status`, never invented). */
function statusTone(status: PostingSummary["status"]): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused") return "warning";
  // draft + closed read as a muted/neutral status chip.
  return "neutral";
}

/** The lifecycle action a row is running (its button alone shows the spinner). */
type RowAction = "pause" | "resume" | "topUp" | "close";

interface RowState {
  /** The action in flight for this row, or null when idle. */
  busy: RowAction | null;
  error: string | null;
  /** A per-row SUCCESS note (e.g. the paid top-up confirmation — the faceless row
   * itself shows no quota column, so the effect must be said out loud). */
  notice: string | null;
}

const IDLE: RowState = { busy: null, error: null, notice: null };

type LifecycleResult =
  | { ok: true; posting: PostingSummary | null; notice?: string }
  | { ok: false; error: string };
type LifecycleAction = (input: { postingId: string }) => Promise<LifecycleResult>;

/** Each row action's Server Action (each binds tenancy to the session — only the id is sent). */
const ACTIONS: Record<RowAction, LifecycleAction> = {
  pause: pausePostingAction,
  resume: resumePostingAction,
  topUp: topUpQuotaAction,
  close: closePostingAction,
};

/**
 * The lifecycle actions a posting's status allows, in display order (F27) — an action that does
 * not apply is not drawn (a disabled one could not say why). Add applicant slots keeps today's
 * rule (any status but closed); the purchase itself is unchanged.
 */
export function rowActions(status: PostingSummary["status"]): RowAction[] {
  const out: RowAction[] = [];
  if (status === "open") out.push("pause");
  if (status === "paused") out.push("resume");
  if (status !== "closed") out.push("topUp");
  if (status === "draft" || status === "open") out.push("close");
  return out;
}

/** Each action's button face. */
const ACTION_FACE: Record<RowAction, { label: string; icon: IconName }> = {
  pause: { label: "Pause", icon: "pause" },
  resume: { label: "Resume", icon: "play" },
  topUp: { label: "Add applicant slots", icon: ACTION_ICON.topUpQuota },
  close: { label: "Close posting", icon: ACTION_ICON.reject },
};

export function PostingsManager({
  postings,
  readOnly = false,
}: {
  postings: PostingSummary[];
  readOnly?: boolean;
}) {
  // Rows RENDER FROM PROPS (each action's revalidatePath refreshes the RSC payload —
  // a local full copy would silently discard it). Only per-row action results are
  // held locally: fresher rows returned by an action overlay their prop row by id.
  const [freshRows, setFreshRows] = useState<Record<string, PostingSummary>>({});
  const [state, setState] = useState<Record<string, RowState>>({});
  const rows = postings.map((p) => freshRows[p.id] ?? p);

  function rowState(id: string): RowState {
    return state[id] ?? IDLE;
  }
  function patchState(id: string, p: Partial<RowState>) {
    setState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? IDLE), ...p } }));
  }

  async function run(id: string, which: RowAction) {
    const action = ACTIONS[which];
    patchState(id, { busy: which, error: null, notice: null });
    try {
      const res = await action({ postingId: id });
      if (res.ok) {
        if (res.posting !== null) {
          const posting = res.posting;
          setFreshRows((prev) => ({ ...prev, [id]: posting }));
        }
        patchState(id, { busy: null, notice: res.notice ?? null });
      } else {
        patchState(id, { busy: null, error: res.error });
      }
    } catch {
      // A rejected Server Action promise (offline / deploy mid-session) must not
      // strand the row busy-forever with every button disabled.
      patchState(id, { busy: null, error: "Could not reach the server. Please retry." });
    }
  }

  if (rows.length === 0) {
    // Phase 16 empty state: what is empty, why it matters, and the one thing to do next.
    // FACELESS: an empty feed names nobody — the copy is about the payer's own postings.
    return (
      <Card>
        <div className="state">
          <span className="state__icon">
            <Icon name={ACTION_ICON.posting} />
          </span>
          <h2 className="state__title">No postings yet</h2>
          {/* What to do next is the page head's one primary action, "New posting" — the state
              names it rather than offering a second door to the same form. */}
          <p className="state__body">
            Matched workers can only find you once a role is live — use New posting above.
            Posting is free through launch.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="postings-list">
      {rows.map((p) => {
        const rs = rowState(p.id);
        const actions = rowActions(p.status);
        return (
          <Card key={p.id} padding="md" className="posting-card">
            <div className="posting-card__main">
              <div className="posting-card__head">
                <Link className="posting-card__title" href={`/postings/${p.id}`}>
                  {p.roleTitle}
                </Link>
                <Badge tone={statusTone(p.status)} upper>
                  {p.status}
                </Badge>
              </div>
              {/* The middot separators are drawn by CSS (`::before` on the segments) so the
                  glyph travels with its following segment and can't orphan on a wrap — see
                  `.posting-card__meta` in globals.css. The row holds FACTS only. */}
              <div className="posting-card__meta">
                <span>{p.locationLabel ?? "Location flexible"}</span>
                <span>{p.vacancyBand} openings</span>
                <span>
                  <span className="bb-mono">{p.applicantCount}</span> /{" "}
                  <span className="bb-mono">{p.applicantQuota ?? NONE}</span> applicants
                </span>
                <span>
                  Posted <span className="bb-mono">{day(p.createdAt)}</span>
                </span>
              </div>
              {/* The row's two page links get their own line: inside the facts row they read
                  as one "Applicants Edit" label led by a separator dot. The title above opens
                  the posting's details. A read-only row has neither. */}
              {readOnly ? null : (
                <div className="posting-card__links">
                  <Link className="postings-link" href={`/postings/${p.id}/applicants`}>
                    <Icon name={ACTION_ICON.users} /> Applicants
                  </Link>{" "}
                  <Link className="postings-link" href={`/postings/${p.id}/edit`}>
                    <Icon name={ACTION_ICON.edit} /> Edit posting
                  </Link>
                </div>
              )}

              {/* B8 — the per-row result region is announceable (aria-live): a retryable
                  error OR the success notice (e.g. the paid top-up confirmation). It sits
                  in the row's text column so the message reads left-aligned under the row
                  it belongs to, and its tone now says which of the two it is. */}
              <div aria-live="polite">
                {rs.error !== null && (
                  <div className="alert alert--danger">
                    <Icon name="warning-circle" className="alert__icon" />
                    <div className="alert__text">
                      <p className="alert__title">That didn&rsquo;t go through</p>
                      <p className="alert__body">{rs.error}</p>
                    </div>
                  </div>
                )}
                {rs.notice !== null && (
                  <div className="alert alert--success">
                    <Icon name="check-circle" className="alert__icon" />
                    <div className="alert__text">
                      <p className="alert__title">Done</p>
                      <p className="alert__body">{rs.notice}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {readOnly || actions.length === 0 ? null : (
              <div className="posting-card__actions">
                {/* LIVE lifecycle (#178/#180) — only what this status allows; per-row busy. */}
                <div className="posting-card__btns">
                  {actions.map((a) => (
                    <Button
                      key={a}
                      variant="secondary"
                      size="sm"
                      iconLeft={ACTION_FACE[a].icon}
                      loading={rs.busy === a}
                      disabled={rs.busy !== null}
                      onClick={() => void run(p.id, a)}
                    >
                      {ACTION_FACE[a].label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
