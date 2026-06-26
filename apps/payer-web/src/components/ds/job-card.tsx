"use client";

/**
 * BadaBhai Design System — JobCard (swipe-to-apply: right = apply, left = skip).
 *
 * Client primitive (apply/skip handlers). Presentational only. Prop contract mirrors
 * docs/design/.../components/brand/JobCard.d.ts. The verified seal color resolves from
 * a token via inline style (no raw hex).
 */
import type { HTMLAttributes } from "react";

export interface JobCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Role title, e.g. "CNC Operator". */
  title: string;
  /** Hiring company name. */
  company: string;
  /** Optional company logo URL. */
  companyLogo?: string;
  /** Show the verified seal next to the company. @default true */
  verified?: boolean;
  location?: string;
  shift?: string;
  /** Wage string, e.g. "₹22,000–28,000 / mo" (rendered in mono). */
  salary?: string;
  /** Short tag strings (skills, perks). */
  tags?: string[];
  /** Remaining applicant-quota spots (from the vacancy band). */
  vacanciesLeft?: number;
  /** Right action — apply. */
  onApply?: () => void;
  /** Left action — skip. */
  onSkip?: () => void;
}

export function JobCard({
  title,
  company,
  companyLogo,
  verified = true,
  location,
  shift,
  salary,
  tags = [],
  vacanciesLeft,
  onApply,
  onSkip,
  className = "",
  ...rest
}: JobCardProps) {
  return (
    <div className={["bb-jobcard", className].filter(Boolean).join(" ")} {...rest}>
      <div className="bb-jobcard__top">
        <div>
          <div className="bb-jobcard__title">{title}</div>
          <div className="bb-jobcard__company">
            {company}
            {verified && (
              <i className="ph-fill ph-seal-check" style={{ color: "var(--success)" }} aria-label="Verified" />
            )}
          </div>
        </div>
        <div className="bb-jobcard__logo">
          {companyLogo ? <img src={companyLogo} alt={company} /> : <i className="ph ph-buildings" aria-hidden="true" />}
        </div>
      </div>

      <div className="bb-jobcard__facts">
        {location && (
          <span className="bb-jobcard__fact">
            <i className="ph ph-map-pin" aria-hidden="true" />
            {location}
          </span>
        )}
        {shift && (
          <span className="bb-jobcard__fact">
            <i className="ph ph-clock" aria-hidden="true" />
            {shift}
          </span>
        )}
        {salary && (
          <span className="bb-jobcard__fact">
            <i className="ph ph-currency-inr" aria-hidden="true" />
            <span className="bb-jobcard__salary">{salary}</span>
          </span>
        )}
      </div>

      {tags.length > 0 && (
        <div className="bb-jobcard__tags">
          {tags.map((t, i) => (
            <span key={i} className="bb-badge bb-badge--neutral">
              {t}
            </span>
          ))}
        </div>
      )}

      {vacanciesLeft != null && (
        <div className="bb-jobcard__quota">
          <i className="ph ph-users-three" aria-hidden="true" />
          <b>{vacanciesLeft} spots</b> left of this opening
        </div>
      )}

      <div className="bb-jobcard__foot">
        <button className="bb-jobcard__skipbtn" onClick={onSkip} aria-label="Skip">
          <i className="ph ph-x" aria-hidden="true" />
        </button>
        <button className="bb-btn bb-btn--primary bb-btn--lg" style={{ flex: 1 }} onClick={onApply}>
          <i className="ph ph-check" aria-hidden="true" />
          <span>Apply</span>
        </button>
      </div>
    </div>
  );
}
