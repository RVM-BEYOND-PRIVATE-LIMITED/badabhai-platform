import { Icon } from "@badabhai/icons";
import { FieldFeedback, Select, fieldFeedbackId } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import type { PostingTradeFormWire } from "../../../lib/contracts";
import { roleOptionGroups } from "../../../lib/job-roles";
import {
  postingTradesProblemMessage,
  type PostingTradesProblem,
} from "../../../lib/posting-trades";

/**
 * #2645 — THE COMPANY TRADE PICKER. One copy for New posting, Edit posting and the AI chat's
 * publish step, so the three cannot drift apart (the payer app's `PostingTradePickerPlaceholder`
 * and the live pickers beside it).
 *
 * It lists ONLY the 16 postable trades the API served (`GET /payer/posting-trades`), grouped by
 * family, because a company job matches only within them (#2635). The control carries the ONE id
 * a refused publish focuses. When the catalogue did not load (or listed nothing), the same spot
 * names the real cause and offers Retry. Retry re-reads on the server, so what the payer typed
 * stays. A refusal placed at the role still has a line to show under. There is no free role list
 * to fall back on: a job posted from one could never go live.
 *
 * Hookless and presentational; the Retry control is the one client piece.
 */
export function PostingTradePicker({
  id,
  label,
  hint,
  trades,
  problem,
  value,
  error,
  onChange,
}: {
  /** The control's id — what a refused publish focuses (`focusControl`). */
  id: string;
  label: string;
  hint?: string;
  trades: readonly PostingTradeFormWire[];
  /** Why `trades` is empty; null when the 16 are there (or no cause was given). */
  problem: PostingTradesProblem | null;
  /** The picked role kind, `""` until one is picked. */
  value: string;
  /** The inline refusal ("Pick one of the 16 trades"), or undefined. */
  error?: string;
  onChange: (roleKind: string) => void;
}) {
  if (trades.length === 0) {
    return <TradesUnavailable id={id} label={label} problem={problem} error={error} />;
  }
  return (
    <Select
      id={id}
      label={label}
      hint={hint}
      value={value}
      error={error}
      aria-invalid={error ? true : undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">— pick one of the 16 trades —</option>
      {roleOptionGroups(trades.map((trade) => trade.role_kind)).map((group) => (
        <optgroup key={group.family} label={group.label}>
          {group.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/**
 * The picker's spot while the 16 trades are not there: its label, the real cause and Retry, then
 * the role's inline error. The group carries the control id (`tabIndex={-1}`), so a refused
 * publish still moves focus here, and it is described by the cause and the refusal.
 */
function TradesUnavailable({
  id,
  label,
  problem,
  error,
}: {
  id: string;
  label: string;
  problem: PostingTradesProblem | null;
  error?: string;
}) {
  const labelId = `${id}-label`;
  const causeId = `${id}-cause`;
  const feedbackId = fieldFeedbackId(id);
  return (
    <div className="bb-field">
      <span id={labelId} className="bb-field__label">
        {label}
      </span>
      <div
        id={id}
        role="group"
        tabIndex={-1}
        className="alert alert--warning trade-picker__unavailable"
        aria-labelledby={labelId}
        aria-describedby={error ? `${causeId} ${feedbackId}` : causeId}
      >
        <Icon name="warning" className="alert__icon" />
        <div className="alert__text">
          <p id={causeId} className="alert__body">
            {postingTradesProblemMessage(problem)}
          </p>
        </div>
        <div className="alert__actions">
          <RetryButton />
        </div>
      </div>
      <FieldFeedback id={feedbackId} error={error} />
    </div>
  );
}
