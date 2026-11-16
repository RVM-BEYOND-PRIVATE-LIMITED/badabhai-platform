"use client";

import { Checkbox, Select } from "../../../components/ds";
import {
  JOB_AUDIENCE_LABEL,
  type AudienceOptions,
  type JobAudience,
  type RvmReview,
} from "../../../lib/contracts";

/** Does this audience reach RVM students (so targeting and a review apply)? */
export function audienceHasRvm(audience: JobAudience): boolean {
  return audience !== "badabhai_workers";
}

export interface AudienceValue {
  audience: JobAudience;
  branchIds: number[];
  courseIds: string[];
}

/**
 * #2746 — the audience picker + RVM branch/course multi-selects.
 *
 * Only rendered when `GET /payer/job-postings/audience-options` answered 200; the page hides it
 * entirely on the house 404 while the `job_audience` switch is off, so the form is exactly what
 * it was before. An empty branch/course selection means ALL, as the API stores `[]`.
 *
 * When a posting's RVM review is `approved`, the caller passes `reviewApproved` so the company is
 * told BEFORE they save that editing a student-visible field sends the job back to `pending`.
 */
export function AudienceFields({
  options,
  value,
  onChange,
  review,
  error,
}: {
  options: AudienceOptions;
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
  /** The stored review, when editing a posting with an RVM part. */
  review?: RvmReview | null;
  /** A server refusal to show at the audience control. */
  error?: string;
}) {
  const hasRvm = audienceHasRvm(value.audience);
  const toggleBranch = (id: number) =>
    onChange({
      ...value,
      branchIds: value.branchIds.includes(id)
        ? value.branchIds.filter((b) => b !== id)
        : [...value.branchIds, id],
    });
  const toggleCourse = (id: string) =>
    onChange({
      ...value,
      courseIds: value.courseIds.includes(id)
        ? value.courseIds.filter((c) => c !== id)
        : [...value.courseIds, id],
    });

  return (
    <div className="form__section">
      <p className="form__legend">Who sees this job</p>
      <Select
        id="audience"
        label="Audience"
        value={value.audience}
        error={error}
        aria-invalid={error ? true : undefined}
        hint="RVM students see a student-audience posting only after RVM's placement team approves it."
        onChange={(e) => {
          const audience = e.target.value as JobAudience;
          // The server refuses targeting with no RVM part, so a move BACK to BadaBhai-only drops
          // the targeting rather than leaving a combination it would reject.
          onChange({
            audience,
            branchIds: audienceHasRvm(audience) ? value.branchIds : [],
            courseIds: audienceHasRvm(audience) ? value.courseIds : [],
          });
        }}
      >
        {options.audiences.map((audience) => (
          <option key={audience} value={audience}>
            {JOB_AUDIENCE_LABEL[audience]}
          </option>
        ))}
      </Select>

      {hasRvm ? (
        <>
          <p className="form__legend">RVM branches</p>
          <p className="mw-card__sub">Leave every box unticked to target all branches.</p>
          <div className="trade-fields__chips">
            {options.branches.map((branch) => (
              <Checkbox
                key={branch.id}
                label={branch.label}
                checked={value.branchIds.includes(branch.id)}
                onChange={() => toggleBranch(branch.id)}
              />
            ))}
          </div>

          <p className="form__legend">RVM courses</p>
          <p className="mw-card__sub">Leave every box unticked to target all courses.</p>
          <div className="trade-fields__chips">
            {options.courses.map((course) => (
              <Checkbox
                key={course.id}
                label={course.label}
                checked={value.courseIds.includes(course.id)}
                onChange={() => toggleCourse(course.id)}
              />
            ))}
          </div>

          {review?.state === "approved" ? (
            <div className="alert alert--warning" role="status">
              <div className="alert__text">
                <p className="alert__title">Editing sends this job back to review</p>
                <p className="alert__body">
                  RVM approved this posting. Saving a change to anything students see — title,
                  description, requirements, benefits, pay, location, shift, experience, openings,
                  audience or targeting — sends it back to <strong>pending</strong>.
                </p>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
