"use client";

import type { CSSProperties } from "react";
import type { IconName } from "@badabhai/icons";
import {
  JOB_CARD_CLAMPS,
  toJobCardView,
  type CardFields,
  type JobCardChip,
  type JobCardDraft,
} from "../lib/job-card-view";
import { observeChipFold } from "../lib/job-card-fold";
import { BadaBhaiLogo } from "./ds";

/**
 * THE JOB-CARD PREVIEW — the worker's swipe card (`Design1JobCard`), drawn from what the payer
 * entered, LIVE.
 *
 * A MIRROR, ROW FOR ROW. Same rows in the same order as the phone (see `toJobCardView`): the
 * title with its chevron, the place ("Area, City"), the "MAHINE KI SALARY" box with the pay-type
 * pill and the full band, the "Duty & Suvidhayein" chips, the BadaBhai lockup at the foot. Same
 * line limits ({@link JOB_CARD_CLAMPS}, stamped as `data-clamp` and clamped in CSS), same type
 * scale × one uniform factor (`--jcp-scale`), same width, so a title wraps and an ellipsis lands
 * where the phone puts them.
 *
 * NOTHING IS HIDDEN SILENTLY. A clamped line carries its full text in `title`; long unbroken
 * words wrap inside the card instead of overflowing it; and the content box clips at the
 * REFERENCE PHONE's height like the real deck card does — with the number of chips that fall
 * below that line stated under the card and a control that shows them all (`job-card-fold.ts`).
 *
 * DELIBERATELY ABSENT (ADR-0024 addendum, #1823; #1651): NO company/org name, NO verified seal,
 * NO spots/openings count, NO boost/urgent flag, NO role-kind row — none of them is on the
 * worker's card. The caption stays EXACTLY "Card preview — built from what you entered".
 *
 * Client component only for the fold's ref callback; it holds NO hooks and NO state — every
 * render is a pure function of `fields` + `draft`, so it can never show a stale value.
 */

const CHIP_ICON: Record<JobCardChip["kind"], IconName> = {
  shift: "clock",
  experience: "user",
  needed_by: "lightning",
  requirement: "wrench",
  benefit: "gift",
};

/** The worker card's footer lockup, at the card's own scale (22dp mark, like `BrandBadge`). */
const LOCKUP_SIZE = { "--bb-lockup-size": "calc(22 * var(--jcp-u))" } as CSSProperties;

export interface JobCardPreviewProps {
  /** The card fields — a saved posting's, or a live form's (via `readCardForm`). */
  fields: CardFields;
  /** A live form's draft state (numbers that cannot be drawn, chip text not yet added). */
  draft?: JobCardDraft;
}

export function JobCardPreview({ fields, draft }: JobCardPreviewProps) {
  const view = toJobCardView(fields, draft);
  const hasTitle = view.title !== "";
  const salary = view.salary;

  return (
    <figure className="jcp">
      <div className="jcp__card">
        <div className="jcp__content" ref={observeChipFold}>
          <div className="jcp__flow">
            <div className="jcp__titlerow">
              <h3
                className={hasTitle ? "jcp__title" : "jcp__title jcp__title--empty"}
                data-slot="title"
                data-clamp={JOB_CARD_CLAMPS.title}
                title={hasTitle ? view.title : undefined}
              >
                {hasTitle ? view.title : "Your role title"}
              </h3>
              <span className="jcp__chevron" aria-hidden="true" />
            </div>

            {view.place !== null ? (
              <p className="jcp__place">
                <i className="ph-fill ph-map-pin" aria-hidden="true" />
                <span
                  className="jcp__place-text"
                  data-slot="place"
                  data-clamp={JOB_CARD_CLAMPS.place}
                  title={view.place}
                >
                  {view.place}
                </span>
              </p>
            ) : null}

            {salary !== null ? (
              <div
                className={salary.issue === null ? "jcp__salary" : "jcp__salary jcp__salary--issue"}
              >
                <div className="jcp__salary-top">
                  <span
                    className="jcp__salary-label"
                    data-slot="pay_label"
                    data-clamp={JOB_CARD_CLAMPS.pay_label}
                  >
                    MAHINE KI SALARY
                  </span>
                  {salary.payTypePill !== null ? (
                    <span className="jcp__paytype" data-slot="pay_type">
                      {salary.payTypePill}
                    </span>
                  ) : null}
                </div>
                {salary.issue === null ? (
                  <span
                    className="jcp__salary-band"
                    data-slot="pay_band"
                    data-clamp={JOB_CARD_CLAMPS.pay_band}
                    title={salary.band}
                  >
                    {salary.band}
                  </span>
                ) : (
                  <span className="jcp__salary-issue" data-slot="pay_issue">
                    {salary.issue}
                  </span>
                )}
              </div>
            ) : null}

            {view.chips.length > 0 ? (
              <div className="jcp__duty">
                <span className="jcp__duty-label" data-slot="duty_label">
                  Duty &amp; Suvidhayein
                </span>
                <ul className="jcp__chips">
                  {view.chips.map((chip, i) => (
                    <li
                      key={`${chip.kind}:${i}`}
                      className={
                        chip.state === undefined
                          ? `jcp__chip jcp__chip--${chip.kind}`
                          : `jcp__chip jcp__chip--${chip.kind} jcp__chip--${chip.state}`
                      }
                    >
                      <i className={`ph-fill ph-${CHIP_ICON[chip.kind]}`} aria-hidden="true" />
                      <span
                        className="jcp__chip-text"
                        data-slot="chip"
                        data-kind={chip.kind}
                        data-clamp={JOB_CARD_CLAMPS.chip}
                        title={chip.label}
                      >
                        {chip.label}
                      </span>
                      {chip.state === "pending" ? (
                        <span className="sr-only"> (typed, not added yet — it will be saved)</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          {/* Where the reference phone's content box ends. Invisible while the card is clipped
              (it sits on the clip edge); drawn as a dashed line once the payer shows all. */}
          <span className="jcp__foldline" data-fold-line="" aria-hidden="true" />
        </div>
        <div className="jcp__brand">
          <span className="jcp__brand-plate">
            <BadaBhaiLogo style={LOCKUP_SIZE} />
          </span>
        </div>
      </div>
      <details className="jcp__fold" data-fold="">
        <summary className="jcp__fold-summary">
          <span data-fold-count="" />
          <span className="jcp__fold-closed"> cut off on a typical phone — show all</span>
          <span className="jcp__fold-open">
            {" "}
            cut off on a typical phone — below the dashed line
          </span>
        </summary>
      </details>
      <figcaption className="jcp__caption">Card preview — built from what you entered</figcaption>
    </figure>
  );
}
