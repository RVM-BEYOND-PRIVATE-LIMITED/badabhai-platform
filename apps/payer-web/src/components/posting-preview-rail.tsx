"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { toJobCardView, type CardFields, type JobCardDraft } from "../lib/job-card-view";
import type { PostingFact } from "../lib/posting-facts";
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
 * What the payer entered that the worker's swipe card does NOT show — role kind, openings, match
 * skills, location note, description — listed under the preview so nothing they typed looks
 * silently dropped. Every value wraps inside the column and is clamped to two lines with the full
 * text in `title`.
 */
export function PostingFacts({ facts }: { facts: readonly PostingFact[] }) {
  if (facts.length === 0) return null;
  return (
    <section className="posting-facts" aria-label="Also in your posting — not on the worker's card">
      <p className="posting-facts__title">
        Also in your posting{" "}
        <span className="posting-facts__sub">— not on the worker&rsquo;s card</span>
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
 * The actions block — a live status line (the gap that blocked a publish, a server error) above
 * the buttons. A form renders the SAME node twice: in the rail's pinned footer (desktop) and at
 * the end of the form (below 64rem); CSS shows exactly one, so a message always sits next to the
 * button that produced it.
 */
export function PostingActions({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="posting-actions">
      <div className="posting-actions__status" aria-live="polite">
        {status}
      </div>
      <div className="posting-actions__buttons">{children}</div>
    </div>
  );
}

export interface PostingPreviewRailProps {
  /** The card fields, from `readCardForm(...).card`. */
  fields: CardFields;
  /** The live form's draft state, from `readCardForm(...).draft`. */
  draft?: JobCardDraft;
  /** "Also in your posting — not on the worker's card". */
  facts: readonly PostingFact[];
  /** The full actions block (status + buttons) — the rail's pinned footer. */
  actions: ReactNode;
  /** The ONE primary button, repeated in the phone dock. */
  primary: ReactNode;
}

export function PostingPreviewRail({
  fields,
  draft,
  facts,
  actions,
  primary,
}: PostingPreviewRailProps) {
  // APPENDED-ONLY state for the positional useState mocks in the form tests: this is the only one.
  const [sheetOpen, setSheetOpen] = useState(false);
  const view = toJobCardView(fields, draft);
  const pay = view.salary === null ? null : (view.salary.band ?? view.salary.issue);
  const meta = [pay, view.place].filter((part): part is string => part !== null && part !== "");
  const close = () => setSheetOpen(false);

  return (
    <>
      <aside className="posting-preview posting-preview--rail" aria-label="Live card preview">
        <div className="posting-preview__scroll">
          <JobCardPreview fields={fields} draft={draft} />
          <PostingFacts facts={facts} />
        </div>
        <div className="posting-preview__foot">{actions}</div>
      </aside>

      <div className="posting-dock">
        <button
          type="button"
          className="posting-dock__summary"
          aria-haspopup="dialog"
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
