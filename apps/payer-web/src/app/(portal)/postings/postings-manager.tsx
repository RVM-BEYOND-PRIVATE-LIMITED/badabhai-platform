"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button, Card, Dialog } from "../../../components/ds";
import { NavPendingCue } from "../../../components/nav-pending";
import { formatInr } from "../../../lib/format";
import type { ChargedPrice } from "../../../lib/pricing-config";
import {
  earlierPurchaseMessage,
  OPTION_CHANGED_MESSAGE,
  priceChangedMessage,
} from "../../../lib/purchase-messages";
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
 *
 * ADD APPLICANT SLOTS IS A PURCHASE, SO IT SHOWS ITS PRICE AND ASKS FIRST (owner ruling
 * 2026-10-07, sweep F11 — it used to commit a charge on one tap). The trigger carries the slots and
 * the ₹ (`topUpOffer`, which the server page reads from the SAME live-catalog tier the action
 * charges by — never a literal here) and opens the generic DS Dialog — never a ConfirmSpendDialog,
 * which stays the unlock's alone. Only that dialog's confirm calls the action. No priced offer (the
 * catalog has no top-up tier) means nothing to sell, so the button is not drawn. Pause, Resume and
 * Close are not purchases and stay one tap. Who may buy is unchanged.
 *
 * FOCUS, ONLY WHEN IT WAS LOST (the team Remove pattern). The Dialog hands focus back to its
 * trigger on close — but a confirmed purchase disables the row's buttons while it runs, so that
 * restore falls to the body. Once the dialog is closed and the purchase has settled, focus goes
 * back to the row's slot button, and only if it is still lost: a payer who moved on is left there.
 *
 * SHOWN == CHARGED, ONCE (#2085). The confirm sends back the exact price it showed
 * (`expected_price_inr`) and ONE idempotency key per confirmed purchase, per posting — minted on
 * the confirm, reused by every retry of that posting's purchase (a re-tap after a timeout is
 * replayed, not bought twice), retired on success. A refused price (409 `price_mismatch`) means
 * nothing was bought: the row says so neutrally with the new price, the page re-renders with it,
 * and the key is retired — the next confirm is a new purchase. A duplicate still in flight is a
 * neutral "still processing", and keeps the key. Nothing retries on its own.
 *
 * THE TIER TOO (#2085 L1). The confirm sends the tier it described (code + slots); the seam buys
 * exactly that tier or refuses with "This option changed" — it never picks another one.
 */

const NONE = "—";

/**
 * The one applicant-slot top-up on offer, as the server page read it from the live catalog
 * (`quotaTopUpTier` — the tier `topUpQuotaAction` charges by), at the price it is charged
 * (#2085). That price is what the trigger and the confirm show and what the confirm sends back
 * as the confirmed price; the server still resolves the charge itself (XT5).
 */
export interface TopUpOffer extends ChargedPrice {
  /** The catalog tier code — sent back on the confirm, so exactly this tier is bought (L1). */
  code: string;
  /** Applicant slots one purchase adds. */
  additionalViews: number;
}

/** The neutral notice for a top-up whose first attempt is still running (#2085). */
const TOP_UP_PENDING =
  "Purchase is still processing — check this posting's applicant slots in a moment.";

/** A posting's live purchase key, and the offer it was first confirmed for (#2085 L2). */
interface HeldTopUpKey {
  key: string;
  code: string;
  additionalViews: number;
  priceInr: number;
}

/** What a confirm committed to: the tier (code + slots) and the price. */
function confirmedOffer(offer: TopUpOffer): Omit<HeldTopUpKey, "key"> {
  return { code: offer.code, additionalViews: offer.additionalViews, priceInr: offer.priceInr };
}

function sameOffer(held: HeldTopUpKey, offer: TopUpOffer): boolean {
  return (
    held.code === offer.code &&
    held.additionalViews === offer.additionalViews &&
    held.priceInr === offer.priceInr
  );
}

/** A row's slot button — where focus returns once its confirmed purchase has settled. */
const topUpButtonId = (postingId: string) => `posting-topup-${postingId}`;

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
  /** A NEUTRAL note — nothing failed and nothing was bought: a changed price, or a purchase
   * still processing (#2085). */
  info: string | null;
}

const IDLE: RowState = { busy: null, error: null, notice: null, info: null };

type LifecycleResult =
  | { ok: true; posting: PostingSummary | null; notice?: string }
  | { ok: false; error: string }
  | { ok: false; info: string };
type LifecycleAction = (input: { postingId: string }) => Promise<LifecycleResult>;
/** The one-tap actions. Add applicant slots is a purchase with its own call (`buyTopUp`). */
type OneTapAction = Exclude<RowAction, "topUp">;

/** Each one-tap action's Server Action (each binds tenancy to the session — only the id is sent). */
const ACTIONS: Record<OneTapAction, LifecycleAction> = {
  pause: pausePostingAction,
  resume: resumePostingAction,
  close: closePostingAction,
};

/**
 * The lifecycle actions a posting's status allows, in display order (F27) — an action that does
 * not apply is not drawn (a disabled one could not say why). Add applicant slots keeps today's
 * rule (any status but closed) when there is a priced slot offer to sell.
 */
function rowActions(status: PostingSummary["status"], canBuySlots: boolean): RowAction[] {
  const out: RowAction[] = [];
  if (status === "open") out.push("pause");
  if (status === "paused") out.push("resume");
  if (status !== "closed" && canBuySlots) out.push("topUp");
  if (status === "draft" || status === "open") out.push("close");
  return out;
}

/** Each action's icon. */
const ACTION_ICON_OF: Record<RowAction, IconName> = {
  pause: "pause",
  resume: "play",
  topUp: ACTION_ICON.topUpQuota,
  close: ACTION_ICON.reject,
};

/** The fixed labels. Add applicant slots has none: its face names its slots and price (below). */
const ACTION_LABEL: Record<Exclude<RowAction, "topUp">, string> = {
  pause: "Pause",
  resume: "Resume",
  close: "Close posting",
};

/** A ₹ amount in mono tabular (brand rule), for button faces and dialog copy. */
function inr(value: number) {
  return <span className="bb-mono">{formatInr(value)}</span>;
}

export function PostingsManager({
  postings,
  readOnly = false,
  topUpOffer,
}: {
  postings: PostingSummary[];
  readOnly?: boolean;
  /** The priced slot top-up on offer, or null when the catalog sells none. */
  topUpOffer: TopUpOffer | null;
}) {
  // Rows RENDER FROM PROPS (each action's revalidatePath refreshes the RSC payload —
  // a local full copy would silently discard it). Only per-row action results are
  // held locally: fresher rows returned by an action overlay their prop row by id.
  const [freshRows, setFreshRows] = useState<Record<string, PostingSummary>>({});
  const [state, setState] = useState<Record<string, RowState>>({});
  // The posting whose slot purchase is waiting to be confirmed — the confirm dialog is open while set.
  const [confirmingTopUp, setConfirmingTopUp] = useState<string | null>(null);
  // The posting whose slot button opened the confirm: focus goes back there once the dialog is
  // closed and that row's purchase has settled — only if focus was lost meanwhile.
  const focusBack = useRef<string | null>(null);
  // ONE idempotency key per confirmed slot purchase, PER POSTING (#2085): reused by every retry of
  // that posting's purchase, dropped on success or a refused price. A ref — reusing a key must not
  // render. PII-free (`crypto.randomUUID()`), no payer id (XB-A).
  const topUpKeys = useRef<Map<string, HeldTopUpKey>>(new Map());
  const rows = postings.map((p) => freshRows[p.id] ?? p);

  useEffect(() => {
    const id = focusBack.current;
    if (id === null || confirmingTopUp !== null || (state[id] ?? IDLE).busy !== null) return;
    focusBack.current = null;
    // Only when focus was LOST: the payer may have moved on while it ran — leave them there.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    document.getElementById(topUpButtonId(id))?.focus();
  }, [confirmingTopUp, state]);

  function rowState(id: string): RowState {
    return { ...IDLE, ...state[id] };
  }
  function patchState(id: string, p: Partial<RowState>) {
    setState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? IDLE), ...p } }));
  }

  async function run(id: string, which: RowAction, call: () => Promise<LifecycleResult>) {
    patchState(id, { busy: which, error: null, notice: null, info: null });
    try {
      const res = await call();
      if (res.ok) {
        if (res.posting !== null) {
          const posting = res.posting;
          setFreshRows((prev) => ({ ...prev, [id]: posting }));
        }
        patchState(id, { busy: null, notice: res.notice ?? null });
      } else if ("info" in res) {
        patchState(id, { busy: null, info: res.info });
      } else {
        patchState(id, { busy: null, error: res.error });
      }
    } catch {
      // A rejected Server Action promise (offline / deploy mid-session) must not
      // strand the row busy-forever with every button disabled.
      patchState(id, { busy: null, error: "Could not reach the server. Please retry." });
    }
  }

  function runOneTap(id: string, which: OneTapAction) {
    const action = ACTIONS[which];
    return run(id, which, () => action({ postingId: id }));
  }

  /** Buy one slot top-up — the tier and price the confirm showed (`offer`) — under its key. */
  async function buyTopUp(id: string, offer: TopUpOffer): Promise<LifecycleResult> {
    // ONE KEY, ONE CONFIRMED OFFER (#2085 L2). A key still held here belongs to an earlier attempt
    // whose outcome is unknown (still processing, a failure, a dropped connection). Reusing it is
    // what keeps a retry from buying twice — the API replays the FIRST attempt — so it is never
    // replaced by a fresh key while held. But that replay is the first attempt's purchase: sent
    // under a different price or tier, the payer would be told "added" for something other than
    // what this dialog just showed. So a confirm that differs from what the held key was first
    // confirmed for is NOT sent; the row says an earlier purchase may still be processing. The
    // trade-off is deliberate: a stale-looking hold (until the page is reloaded and the earlier
    // attempt's effect is visible) over a second charge or a mislabelled one.
    const held = topUpKeys.current.get(id);
    if (held !== undefined && !sameOffer(held, offer)) {
      return { ok: false, info: earlierPurchaseMessage(held.priceInr) };
    }
    const key = held?.key ?? crypto.randomUUID();
    topUpKeys.current.set(id, { key, ...confirmedOffer(offer) });
    const res = await topUpQuotaAction({
      postingId: id,
      tier: { code: offer.code, additionalViews: offer.additionalViews },
      expectedPriceInr: offer.priceInr,
      idempotencyKey: key,
    });
    if (res.ok) {
      topUpKeys.current.delete(id); // DONE — a genuine next purchase gets a fresh key
      return res;
    }
    if ("priceChanged" in res) {
      // Nothing was bought; a confirm at the new price is a NEW purchase (the old key would
      // replay this refusal). The action re-rendered the page with the new price.
      topUpKeys.current.delete(id);
      return { ok: false, info: priceChangedMessage(res.currentPriceInr) };
    }
    if ("optionChanged" in res) {
      // Refused before any request. A key minted for THIS confirm was never sent — drop it; a key
      // held from an earlier attempt still names that attempt, so it stays.
      if (held === undefined) topUpKeys.current.delete(id);
      return { ok: false, info: OPTION_CHANGED_MESSAGE };
    }
    // Still in flight: KEEP the key, so a re-tap replays the first attempt instead of buying again.
    if ("pending" in res) return { ok: false, info: TOP_UP_PENDING };
    return res; // a failure — KEEP the key: a retry of this purchase must reuse it
  }

  /** A row's slot button only ASKS — nothing is bought, and the row's last result stays. */
  function askTopUp(id: string) {
    focusBack.current = id;
    setConfirmingTopUp(id);
  }

  /** The dialog's confirm — the ONLY path to the purchase; the row's slot button then spins. */
  function confirmTopUp() {
    const id = confirmingTopUp;
    // The offer THIS dialog showed is the price that is sent back (#2085).
    const offer = topUpOffer;
    if (id === null || offer === null) return;
    setConfirmingTopUp(null);
    void run(id, "topUp", () => buyTopUp(id, offer));
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

  const confirming =
    confirmingTopUp === null ? null : (rows.find((p) => p.id === confirmingTopUp) ?? null);
  // The slot button's face: what it buys and the price. No offer ⇒ no slot button is drawn at all.
  const topUpFace =
    topUpOffer === null ? null : (
      <>
        Add {topUpOffer.additionalViews} applicant slots · {inr(topUpOffer.priceInr)}
      </>
    );

  return (
    <>
      <div className="postings-list">
        {rows.map((p) => {
          const rs = rowState(p.id);
          const actions = rowActions(p.status, topUpOffer !== null);
          return (
            <Card key={p.id} padding="md" className="posting-card">
              <div className="posting-card__main">
                <div className="posting-card__head">
                  <Link className="posting-card__title" href={`/postings/${p.id}`}>
                    {p.roleTitle}
                    <NavPendingCue label={p.roleTitle} />
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
                      <NavPendingCue label="Applicants" />
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
                  {rs.info !== null && (
                    <div className="alert alert--info">
                      <Icon name="info" className="alert__icon" />
                      <div className="alert__text">
                        <p className="alert__body">{rs.info}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {readOnly || actions.length === 0 ? null : (
                <div className="posting-card__actions">
                  {/* LIVE lifecycle (#178/#180) — only what this status allows; per-row busy. The
                      slot purchase asks first (the dialog below); the rest act on one tap. */}
                  <div className="posting-card__btns">
                    {actions.map((a) => (
                      <Button
                        key={a}
                        id={a === "topUp" ? topUpButtonId(p.id) : undefined}
                        variant="secondary"
                        size="sm"
                        iconLeft={ACTION_ICON_OF[a]}
                        loading={rs.busy === a}
                        disabled={rs.busy !== null}
                        onClick={() => (a === "topUp" ? askTopUp(p.id) : void runOneTap(p.id, a))}
                      >
                        {a === "topUp" ? topUpFace : ACTION_LABEL[a]}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* The slot purchase asks first — the generic DS Dialog (never the credit-spend confirm). It
          asks a neutral priced question (what is bought, for how much — like the credits confirm;
          it claims no charge) and its confirm carries the price. */}
      {topUpOffer !== null ? (
        <Dialog
          open={confirmingTopUp !== null}
          onClose={() => setConfirmingTopUp(null)}
          title="Add applicant slots?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmingTopUp(null)}>
                Cancel
              </Button>
              <Button variant="primary" iconLeft={ACTION_ICON.topUpQuota} onClick={confirmTopUp}>
                Add slots · {inr(topUpOffer.priceInr)}
              </Button>
            </>
          }
        >
          Add <span className="bb-mono">{topUpOffer.additionalViews}</span> applicant slots to{" "}
          {confirming !== null ? <>&ldquo;{confirming.roleTitle}&rdquo;</> : "this posting"} for{" "}
          {inr(topUpOffer.priceInr)}?
        </Dialog>
      ) : null}
    </>
  );
}
