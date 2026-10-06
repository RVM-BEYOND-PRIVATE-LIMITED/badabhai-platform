"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { toJobCardView, type CardFields, type JobCardDraft } from "../lib/job-card-view";
import type { PostingFact } from "../lib/posting-facts";
import { observeRailScroll } from "../lib/rail-scroll";
import { observeDockHeight } from "../lib/dock-reserve";
import { Button, Dialog } from "./ds";
import { JobCardPreview } from "./job-card-preview";

/**
 * THE POSTING EDITOR'S PREVIEW RAIL — the worker card, what else the posting says, and the
 * actions, kept on screen while the payer fills the form. Shared by every posting form (company
 * create, company edit, agency create/edit) so they behave as one product.
 *
 * DESKTOP (≥64rem): a column beside the form, sticky BELOW the shell header, capped to the
 * viewport. The card and the "Also in your posting" list scroll inside it only when they truly do
 * not fit; the actions are its pinned footer — so the whole card AND the publish button are on
 * screen together while the payer edits any field.
 *
 * BELOW 64rem: the rail is not drawn. A dock pinned to the bottom of the form carries a one-line
 * summary of the card (title · pay · place) and the primary action; the summary opens the full
 * card in a bottom sheet (the DS `Dialog`: focus-trapped, Esc closes, focus returns to the dock).
 * The form keeps its natural scroll and its own actions at its end.
 *
 * Presentation only: the forms own every value, every handler and every rule. The card is built
 * from the same `fields`/`draft` the form's submit reads (`readCardForm`), so the rail, the dock
 * and the sheet can never disagree with each other or with what gets saved.
 */

/**
 * What the payer entered that the worker's swipe card does not put into WORDS — role kind,
 * openings, match skills, location note, description — listed under the preview so nothing they
 * typed looks silently dropped. Every value wraps inside the column and is clamped to two lines
 * with the full text in `title`.
 *
 * "not WRITTEN on the worker's card" since the owner ruling of 2026-10-05 (#2009): the role is
 * now on that card, drawn as its ROLE ILLUSTRATION (`@badabhai/role-art`) — the same picture the
 * preview above this list is already painting, so the payer can see their pick land. Its NAME is
 * still never text on the card, which is what this list is telling them. The flat "not on the
 * worker's card" became a false claim the moment the art shipped.
 */
export function PostingFacts({ facts }: { facts: readonly PostingFact[] }) {
  if (facts.length === 0) return null;
  return (
    <section className="posting-facts" aria-label="Also in your posting — not written on the worker's card">
      <p className="posting-facts__title">
        Also in your posting{" "}
        <span className="posting-facts__sub">— not written on the worker&rsquo;s card</span>
      </p>
      <dl className="posting-facts__list">
        {facts.map((fact) => (
          <div className="posting-facts__row" key={fact.label}>
            <dt className="posting-facts__key">{fact.label}</dt>
            <dd className="posting-facts__value">
              {fact.value !== null && fact.value.trim() !== "" ? (
                <span className="posting-facts__text" title={fact.value}>
                  {fact.value}
                </span>
              ) : (
                <span className="posting-facts__unset">Not set</span>
              )}
              {fact.note ? <span className="posting-facts__note">{fact.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The actions block — what the last publish/save produced, right above the buttons. On desktop it
 * is the rail's pinned footer. Below 1024px the form repeats the BUTTONS at its end (nothing else
 * there) and the dock carries the rest, so exactly one copy is ever on screen — next to the button
 * the payer can see.
 *
 * Two slots, so a screen reader hears each message ONCE:
 *  - `status` — what a FIELD owns: the refusal that blocked a publish/save (and, on edit, the
 *    "Still to fill" summary, which is its own polite `role="status"` as it changes). The slot is
 *    NOT a live region: a refused publish moves focus to that field, and its description (the DS
 *    feedback line) reads the reason — an alert here would say it twice.
 *  - `outcome` — a failure no field owns (the server refused). A polite live region that is ALWAYS
 *    in the page, even empty (never `display: none`), so the text that lands in it is announced.
 */
export function PostingActions({
  status,
  outcome,
  children,
}: {
  status?: ReactNode;
  outcome?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="posting-actions">
      {status === undefined && outcome === undefined ? null : (
        <>
          <div className="posting-actions__status">{status}</div>
          <div className="posting-actions__live" aria-live="polite">
            {outcome}
          </div>
        </>
      )}
      <div className="posting-actions__buttons">{children}</div>
    </div>
  );
}

/**
 * The publish label when the picked skills reach nobody yet. The phone dock shows only "Publish
 * anyway" (the detail is visually hidden there — still in the button's accessible name), so the
 * long label can never widen a 320px page; the rail and the form's end show it whole. The space is
 * its own text node so the accessible name keeps it.
 */
export const zeroReachLabel = (
  <>
    Publish anyway <span className="posting-cta__detail">— reaches nobody yet</span>
  </>
);

export interface PostingPreviewRailProps {
  /** The card fields, from `readCardForm(...).card`. */
  fields: CardFields;
  /** The live form's draft state, from `readCardForm(...).draft`. */
  draft?: JobCardDraft;
  /** "Also in your posting — not written on the worker's card". */
  facts: readonly PostingFact[];
  /** The full actions block (status + buttons) — the rail's pinned footer. */
  actions: ReactNode;
  /** The ONE primary button, repeated in the phone dock. */
  primary: ReactNode;
  /** The same field-owned status the rail footer shows, for the phone dock. Not live. */
  status?: ReactNode;
  /** The same outcome the rail footer announces, for the phone dock. Announced (polite). */
  outcome?: ReactNode;
  /**
   * A publish/save is in flight: the dock's "Preview the card" waits. A sheet opened now would
   * make the dock — and its live slot — inert exactly when the server's answer lands there, and
   * that answer would never be announced.
   */
  busy?: boolean;
}

export function PostingPreviewRail({
  fields,
  draft,
  facts,
  actions,
  primary,
  status,
  outcome,
  busy = false,
}: PostingPreviewRailProps) {
  // APPENDED-ONLY state for the positional useState mocks in the form tests: this is the only one.
  const [sheetOpen, setSheetOpen] = useState(false);
  const view = toJobCardView(fields, draft);
  const pay = view.salary === null ? null : (view.salary.band ?? view.salary.issue);
  const meta = [pay, view.place].filter(
    (part): part is string => part !== null && part.trim() !== "",
  );
  const close = () => setSheetOpen(false);

  return (
    <>
      <aside className="posting-preview posting-preview--rail" aria-label="Live card preview">
        {/* Focusable (and so keyboard-scrollable) only while it overflows — see rail-scroll.ts. */}
        <div
          className="posting-preview__scroll"
          role="region"
          aria-label="Card preview and the rest of your posting"
          ref={observeRailScroll}
        >
          <JobCardPreview fields={fields} draft={draft} />
          <PostingFacts facts={facts} />
          {/* A visual cue only (the region itself is the keyboard path): shown while content
              remains below the region's fold. Zero height, so it never shifts the content. */}
          <p className="posting-preview__more" aria-hidden="true">
            <span>More below ↓</span>
          </p>
        </div>
        <div className="posting-preview__foot">{actions}</div>
      </aside>

      {/* Its measured height is the room the page keeps for it (dock-reserve.ts). */}
      <div className="posting-dock" ref={observeDockHeight}>
        <div className="posting-dock__status">{status}</div>
        <div className="posting-dock__live" aria-live="polite">
          {outcome}
        </div>
        <div className="posting-dock__row">
          <button
            type="button"
            className="posting-dock__summary"
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => setSheetOpen(true)}
          >
            <span className="posting-dock__title">
              {view.title !== "" ? view.title : "Your role title"}
            </span>
            <span className="posting-dock__meta">
              {meta.length > 0 ? meta.join(" · ") : "Pay and place not set yet"}
            </span>
            <span className="posting-dock__cue">Preview the card</span>
          </button>
          <div className="posting-dock__primary">{primary}</div>
        </div>
      </div>

      {sheetOpen ? (
        <Dialog
          open
          sheet
          title="Card preview"
          onClose={close}
          footer={
            <Button variant="secondary" onClick={close}>
              Back to the form
            </Button>
          }
        >
          <div className="posting-sheet">
            <JobCardPreview fields={fields} draft={draft} />
            <PostingFacts facts={facts} />
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
