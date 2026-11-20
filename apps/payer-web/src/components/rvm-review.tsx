import type { RvmReview } from "../lib/contracts";
import { Badge } from "./ds";

/**
 * #2746 — a posting's placement-team review, as the company reads it.
 *
 * `reason` is written by RVM's placement team, so it is rendered as PLAIN TEXT: React escapes it,
 * and nothing here parses markdown, auto-links a URL, or injects HTML. A rejected reason is the
 * only field a company must act on, so it sits beside the pill rather than behind a tooltip.
 */
export function RvmReviewBadge({ review }: { review: RvmReview | null | undefined }) {
  if (!review) return null;
  const tone =
    review.state === "approved" ? "success" : review.state === "rejected" ? "danger" : "warning";
  return (
    <Badge tone={tone} upper>
      RVM review: {review.state}
    </Badge>
  );
}

/** The full review line — pill plus the decision's reason when one was written. */
export function RvmReviewNotice({ review }: { review: RvmReview | null | undefined }) {
  if (!review) return null;
  return (
    <div className="alert alert--info" role="status">
      <div className="alert__text">
        <p className="alert__title">
          <RvmReviewBadge review={review} />
        </p>
        {review.reason ? <p className="alert__body">{review.reason}</p> : null}
        {review.state === "pending" ? (
          <p className="alert__body">
            RVM&rsquo;s placement team reviews this posting before students see it. Students do not
            wait on this for BadaBhai workers to see it.
          </p>
        ) : null}
      </div>
    </div>
  );
}
