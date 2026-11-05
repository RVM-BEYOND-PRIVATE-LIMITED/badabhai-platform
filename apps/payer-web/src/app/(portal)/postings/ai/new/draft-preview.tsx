import { RoleArt } from "@badabhai/role-art";
import { Badge, Card, Input, Select } from "../../../../../components/ds";
import { formatInr } from "../../../../../lib/format";
import { roleOptionGroups } from "../../../../../lib/job-roles";
import type { JobPostingDraft } from "../../../../../lib/contracts";

const ROLE_GROUPS = roleOptionGroups();

/**
 * The STRUCTURED PREVIEW of the live `JobPostingDraft` (ADR-0035) — what the chat has
 * understood so far, filling in turn by turn beside the conversation.
 *
 * Presentational + hookless (safe from a server OR client parent). Renders DS primitives
 * only (Card / Badge) and DS tokens via `.ai-draft-*` classes — no raw colours, no new
 * visual language.
 *
 * TWO DESIGN RULES MADE VISIBLE HERE:
 *  - **No company/org name row (rule A / ADR-0035 §Decision 3).** The payer's own org name
 *    is never asked in the chat and never sent to the LLM — the server auto-fills it from
 *    `payers.orgNameEnc` at publish. There is deliberately no field for it in the draft.
 *  - **Vacancy is a BAND, never a raw count (rule B / ADR-0012).** The draft carries
 *    `vacancyBand` ("1" | "2-5" | "6-10" | "11-25" | "25+") and this card renders that
 *    band verbatim; it never derives or shows an integer head count.
 *
 * A missing value renders as an em dash — the card never invents content, and `missingFields`
 * is surfaced as an explicit "still to cover" list so the payer sees why publish is not ready.
 */

const NONE = "—";

/** Human label for a draft field key the engine reports as still-missing. */
const FIELD_LABELS: Record<string, string> = {
  role_title: "Role title",
  trade_key: "Trade",
  skill_phrases: "Skills",
  location_label: "Location",
  vacancy_band: "Openings",
  pay_min: "Pay (min)",
  pay_max: "Pay (max)",
  shift: "Shift",
  benefits: "Benefits",
  requirements: "Requirements",
  description: "Description",
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ");
}

/** `in_hand` → "In-hand". A RAW ENUM never reaches a payer's eye. */
export function payTypeLabel(payType: string | null): string {
  switch (payType) {
    case "in_hand":
      return "In-hand";
    case "gross":
      return "Gross";
    case "ctc":
      return "CTC";
    default:
      return NONE;
  }
}

/** `immediate` → "Immediate". */
export function neededByLabel(neededBy: string | null): string {
  switch (neededBy) {
    case "immediate":
      return "Immediate";
    case "soon":
      return "Soon";
    case "flexible":
      return "Flexible";
    default:
      return NONE;
  }
}

/** `night` → "Night". The draft's raw enum used to print here verbatim. */
export function shiftLabel(shift: string | null): string {
  switch (shift) {
    case "day":
      return "Day";
    case "night":
      return "Night";
    case "rotational":
      return "Rotational";
    default:
      return NONE;
  }
}

/**
 * The experience window. EITHER END MAY BE NULL ON ITS OWN — "5+ years" has no
 * max and "up to 2 years" has no min — and 0 is a real value (a fresher), so
 * neither bound is coerced.
 */
export function experienceLabel(lo: number | null, hi: number | null): string {
  if (lo !== null && hi !== null) return `${lo}–${hi} yrs`;
  if (lo !== null) return `${lo}+ yrs`;
  if (hi !== null) return `up to ${hi} yrs`;
  return NONE;
}

/**
 * Render the pay band. Both ends optional; `formatInr` throws on a non-integer/negative,
 * so a malformed value degrades to the em dash rather than crashing the preview.
 */
export function payLabel(payMin: number | null, payMax: number | null): string {
  const safe = (n: number | null): string | null => {
    if (n === null || !Number.isInteger(n) || n < 0) return null;
    return formatInr(n);
  };
  const lo = safe(payMin);
  const hi = safe(payMax);
  if (lo !== null && hi !== null) return `${lo} – ${hi} / month`;
  if (lo !== null) return `${lo}+ / month`;
  if (hi !== null) return `up to ${hi} / month`;
  return NONE;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="ai-draft__row">
      <dt className="ai-draft__label">{label}</dt>
      <dd className="ai-draft__value">{value}</dd>
    </div>
  );
}

function TagRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="ai-draft__row">
      <dt className="ai-draft__label">{label}</dt>
      <dd className="ai-draft__value">
        {values.length === 0 ? (
          NONE
        ) : (
          <span className="ai-draft__tags">
            {values.map((v) => (
              <Badge key={v} tone="neutral">
                {v}
              </Badge>
            ))}
          </span>
        )}
      </dd>
    </div>
  );
}

export interface DraftPreviewProps {
  draft: JobPostingDraft | null;
  /** The engine's deterministic readiness signal — never inferred from the fields here. */
  draftReady: boolean;
  /**
   * The publish-step role pick (#2490) — `""` until the payer chooses one. It is the SAME
   * closed 21-value set the manual form sends, drives the card illustration below, and rides
   * the publish body as `role_kind`. Display only; never a match input.
   */
  roleKind: string;
  onRoleKindChange: (roleKind: string) => void;
  /**
   * The publish-step area/locality (#2493) — prefilled from `draft.area`, editable
   * here. It rides the publish body as `area`. Optional: blank stays absent, so
   * the worker card shows the city alone (exactly as before).
   */
  area: string;
  onAreaChange: (area: string) => void;
}

export function DraftPreview({
  draft,
  draftReady,
  roleKind,
  onRoleKindChange,
  area,
  onAreaChange,
}: DraftPreviewProps) {
  return (
    <Card variant="outline" className="ai-draft" aria-live="polite">
      <div className="ai-draft__head">
        <h2 className="ai-draft__title">Your posting so far</h2>
        <Badge tone={draftReady ? "success" : "info"} upper>
          {draftReady ? "Ready to publish" : "In progress"}
        </Badge>
      </div>

      {/* The job card's role illustration, keyed by the publish-step pick. The chat interview
          never asks for a role, so the payer chooses it here; before a pick this is the generic
          scene. The same `role_kind` rides the publish body, and the worker card draws this art. */}
      <RoleArt roleKind={roleKind || null} animated={false} className="ai-draft__art" />

      <Select
        id="chatRoleKind"
        label="Role (card illustration)"
        hint="Picks the illustration on the worker's card. Optional — leave it blank for the generic art."
        value={roleKind}
        onChange={(e) => onRoleKindChange(e.target.value)}
      >
        <option value="">— pick the role —</option>
        {ROLE_GROUPS.map((group) => (
          <optgroup key={group.family} label={group.label}>
            {group.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>

      <Input
        id="chatArea"
        label="Area / locality"
        hint="Prefilled from your location answer. Optional — leave it blank for city only."
        value={area}
        maxLength={120}
        onChange={(e) => onAreaChange(e.target.value)}
      />

      {draft === null ? (
        <p className="ai-draft__empty">
          Answer a few questions and your posting will build itself here.
        </p>
      ) : (
        <>
          <dl className="ai-draft__list">
            <Row label="Role title" value={draft.roleTitle ?? NONE} />
            {/* PR-B: the "Trade" row is gone. The chat interview never asks for a trade, so it
                was ALWAYS "—" — a permanently empty row that read as a hole in the posting. The
                role is surfaced by the skills below + the role picker above; the picked
                `role_kind` rides the publish body (#2490). */}
            <Row label="Location" value={draft.locationLabel ?? NONE} />
            {/* #1727 — the coarse card city, beside the poster's own wording
                rather than instead of it: only this one reaches a worker. */}
            <Row label="City" value={draft.city ?? NONE} />
            {/* BANDED, never a raw count (ADR-0012 / rule B). */}
            <Row label="Openings" value={draft.vacancyBand ?? NONE} />
            <Row label="Pay" value={payLabel(draft.payMin, draft.payMax)} />
            <Row label="Pay type" value={payTypeLabel(draft.payType)} />
            <Row
              label="Experience"
              value={experienceLabel(draft.minExperienceYears, draft.maxExperienceYears)}
            />
            <Row label="Shift" value={shiftLabel(draft.shift)} />
            <Row label="Joining time" value={neededByLabel(draft.neededBy)} />
            <TagRow label="Skills" values={draft.skillPhrases} />
            <TagRow label="Benefits" values={draft.benefits} />
            <TagRow label="Requirements" values={draft.requirements} />
            <Row label="Description" value={draft.description ?? NONE} />
          </dl>

          {draft.missingFields.length > 0 ? (
            <p className="ai-draft__missing">
              Still to cover: {draft.missingFields.map(fieldLabel).join(", ")}.
            </p>
          ) : null}
        </>
      )}

      <p className="ai-draft__note">
        Your company name is added automatically from your account — we never ask for it here.
      </p>
    </Card>
  );
}
