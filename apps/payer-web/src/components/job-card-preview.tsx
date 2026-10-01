import type { IconName } from "@badabhai/icons";
import { toJobCardView, type CardFields, type JobCardChip } from "../lib/job-card-view";

/**
 * THE JOB-CARD PREVIEW — what the payer's posting will show, built LIVE from what they entered.
 *
 * HOOKLESS + SERVER-SAFE (no "use client"): it takes the collected {@link CardFields}, derives the
 * ONE {@link JobCardView} via {@link toJobCardView}, and renders ONLY from that view — the same
 * mapper Create / Edit / Detail / Agency use, so the preview can never disagree with what a worker
 * would eventually be shown. Token-only `.jcp-*` classes, `ph-fill` glyphs; no raw colours.
 *
 * DELIBERATELY ABSENT (ADR-0024 addendum, #1823): NO company/org name, NO verified seal, NO spots
 * count, NO boost/urgent flag. `role_kind` is NOT worker-visible, so the caption is EXACTLY
 * "Card preview — built from what you entered" — never "what workers see".
 */

const CHIP_ICON: Record<JobCardChip["kind"], IconName> = {
  shift: "clock",
  experience: "user",
  needed_by: "lightning",
  requirement: "wrench",
  benefit: "gift",
};

export function JobCardPreview({ fields }: { fields: CardFields }) {
  const view = toJobCardView(fields);
  const hasTitle = view.title.trim() !== "";

  return (
    <figure className="jcp" aria-label="Job card preview">
      <div className="jcp__card">
        <div className="jcp__head">
          {hasTitle ? (
            <h3 className="jcp__title">{view.title}</h3>
          ) : (
            <h3 className="jcp__title jcp__title--empty">Your role title</h3>
          )}
          {view.roleLabel !== null ? (
            <span className="jcp__role">
              <i className="ph-fill ph-briefcase" aria-hidden="true" />
              {view.roleLabel}
            </span>
          ) : null}
          {view.place !== null ? (
            <span className="jcp__place">
              <i className="ph-fill ph-map-pin" aria-hidden="true" />
              {view.place}
            </span>
          ) : null}
        </div>

        {view.salary !== null ? (
          <div className="jcp__salary">
            <div className="jcp__salary-top">
              <span className="jcp__salary-label">MAHINE KI SALARY</span>
              {view.salary.payTypePill !== null ? (
                <span className="jcp__paytype">{view.salary.payTypePill}</span>
              ) : null}
            </div>
            <span className="jcp__salary-band bb-mono">{view.salary.band}</span>
          </div>
        ) : null}

        {view.chips.length > 0 ? (
          <div className="jcp__duty">
            <span className="jcp__duty-label">Duty &amp; Suvidhayein</span>
            <div className="jcp__chips">
              {view.chips.map((chip, i) => (
                <span key={`${chip.kind}:${i}`} className="jcp__chip">
                  <i className={`ph-fill ph-${CHIP_ICON[chip.kind]}`} aria-hidden="true" />
                  {chip.label}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <figcaption className="jcp__caption">Card preview — built from what you entered</figcaption>
    </figure>
  );
}
