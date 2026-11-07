"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import type {
  CandidateCorrection,
  CandidateDetail,
  CandidateField,
} from "../../../lib/candidate-detail";
import {
  candidatePosture,
  candidateTitle,
  consentLabel,
  corrections,
  fieldLabel,
  formatAnswer,
  formatAvailability,
  formatMonths,
  formatSalaryPeriod,
  formatStint,
  formatTradeLevel,
  formatYears,
  humanize,
  sourceTag,
  type CandidateFieldKey,
} from "../../../lib/candidate-view";
import {
  FACT_LABELS,
  type CorrectionHistoryItem,
  type CorrectionHistoryView,
  type EditSectionId,
} from "../../../lib/candidate-edit-model";
import type { IdentityPosture } from "../../../lib/identity";
import { formatCount, formatPayBand, matchTierLabel, shortId } from "../../../lib/format";
import { WORKER_FLAG_REASON_LABELS } from "../../../lib/admin-action-vocabulary";
import { DetailList } from "../../../components/detail-list";
import { PanelSection } from "../../../components/panel-section";
import { StatusPill, type Tone } from "../../../components/status-pill";
import { Timestamp } from "../../../components/timestamp";
import { CopyId } from "../../../components/copy-id";
import { NameCell } from "../../../components/name-cell";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { Stat } from "../../../components/stat";
import { LOCK_REASONS, LockedTag } from "./locked-tag";
import { PhoneField } from "./phone-reveal";
import { CandidateAccountActions } from "./candidate-account-actions";

/**
 * ONE candidate's #2560 record, as the drawer's seven tabs (A7, #2577). Each tab renders exactly
 * the groups the response carries — every field with its value and a small tag saying where the
 * value came from (`source`, humanised by `sourceTag`). Nothing is derived here that the API did
 * not say; a value the record does not hold is a dash beside a "Not stored" tag.
 *
 * ── EDITING (A7, #2561) ────────────────────────────────────────────────────────────────
 * A session holding `edit_candidates` gets an Edit control on the sections the record can read
 * back in the correction's own shape; the drawer opens a T2 field diff and reason. Every field
 * with a live `correction` shows the "Edited by admin" badge and a Revert. Name, phone, WhatsApp
 * and photo visibility are shown LOCKED (ADR-0062 §3.4) and have no edit control.
 */
export const CANDIDATE_TABS = [
  { id: "profile", label: "Profile" },
  { id: "work", label: "Work history" },
  { id: "skills", label: "Skills" },
  { id: "applications", label: "Applications" },
  { id: "resume", label: "Resume" },
  { id: "activity", label: "Activity" },
  { id: "edits", label: "Edit log" },
] as const;

export type CandidateTab = (typeof CANDIDATE_TABS)[number]["id"];

export interface CandidateRecordViewProps {
  detail: CandidateDetail;
  /** The session holds `read_identity` — only to tell a capped read from a faceless role. */
  entitled: boolean;
  /** The session holds `reveal_pii` — the Reveal phone control is offered. */
  canReveal: boolean;
  /** The tab on screen; the others stay mounted but hidden (a revealed phone survives a tab switch). */
  active: CandidateTab;
  /** The id root the tab list and its panels name each other by. */
  idBase: string;
  /** The session holds `edit_candidates` (A7, #2561): section Edit controls, badges and Reverts. */
  canEdit?: boolean;
  /** The correction history for this record (reason text is only available to editors). */
  history?: CorrectionHistoryView;
  /** Open the edit dialog for one section. */
  onEditSection?: (section: EditSectionId) => void;
  /** Open the T2 reason prompt for one live correction. */
  onRevert?: (item: CorrectionHistoryItem) => void;
  /** Detail field keys whose values just changed — the 1.2s yellow flash after a save. */
  flashed?: ReadonlySet<string>;
  /** Retry a failed correction-history read. */
  onReloadHistory?: () => void;
  /** The session holds `manage_worker_account` (A7, #2562). */
  canManageAccount?: boolean;
  /** Re-read the record after a correction, revert or account action. */
  onRefresh?: () => void;
}

interface CandidateEditContextValue {
  canEdit: boolean;
  history: CorrectionHistoryView;
  onEditSection?: (section: EditSectionId) => void;
  onRevert?: (item: CorrectionHistoryItem) => void;
  flashed: ReadonlySet<string>;
  onReloadHistory?: () => void;
  canManageAccount: boolean;
  onRefresh?: () => void;
}

const NO_HISTORY: CorrectionHistoryView = { status: "idle", items: [] };
const NO_FLASH: ReadonlySet<string> = new Set();

const CandidateEditContext = createContext<CandidateEditContextValue>({
  canEdit: false,
  history: NO_HISTORY,
  flashed: NO_FLASH,
  canManageAccount: false,
});

/** The seven panels. Hidden ones stay in the DOM so their state (a revealed phone) is kept. */
export function CandidateRecordPanels({
  detail,
  entitled,
  canReveal,
  active,
  idBase,
  canEdit = false,
  history = NO_HISTORY,
  onEditSection,
  onRevert,
  flashed = NO_FLASH,
  onReloadHistory,
  canManageAccount = false,
  onRefresh,
}: CandidateRecordViewProps) {
  const posture = candidatePosture(detail, entitled);
  const panels: Record<CandidateTab, ReactNode> = {
    profile: <ProfilePanel d={detail} posture={posture} canReveal={canReveal} />,
    work: <WorkHistoryPanel d={detail} />,
    skills: <SkillsPanel d={detail} />,
    applications: <ApplicationsPanel d={detail} />,
    resume: <ResumePanel d={detail} />,
    activity: <ActivityPanel d={detail} />,
    edits: <EditLogPanel d={detail} />,
  };
  return (
    <CandidateEditContext.Provider
      value={{
        canEdit,
        history,
        onEditSection,
        onRevert,
        flashed,
        onReloadHistory,
        canManageAccount,
        onRefresh,
      }}
    >
      {CANDIDATE_TABS.map((t) => (
        <section
          key={t.id}
          className="cdrawer__panel"
          role="tabpanel"
          id={`${idBase}-panel-${t.id}`}
          aria-labelledby={`${idBase}-tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
        >
          {panels[t.id]}
        </section>
      ))}
    </CandidateEditContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// one field: its value, a lock when it is locked, and where it came from
// ---------------------------------------------------------------------------

/** "Interview", "Worker edit", … — with the meaning on hover and "Source:" for a screen reader. */
export function SourceTag({ source }: { source: string }) {
  const tag = sourceTag(source);
  return (
    <span className="source-tag" title={tag.meaning}>
      <span className="sr-only">Source: </span>
      {tag.label}
    </span>
  );
}

/** A field's value cell. An empty value is a dash — its "Not stored" tag says why. */
function FieldValue({
  field,
  fieldKey,
  locked,
  children,
}: {
  field: { source: string; correction?: CandidateCorrection };
  fieldKey?: string;
  locked?: string;
  children: ReactNode;
}) {
  const empty = children === null || children === undefined || children === "";
  const edit = useContext(CandidateEditContext);
  const correction = field.correction ?? null;
  const historyItem = correction
    ? (edit.history.items.find((i) => i.override_id === correction.override_id) ?? null)
    : null;
  const flashed = fieldKey !== undefined && edit.flashed.has(fieldKey);
  return (
    <span className={flashed ? "cfield cfield--flash" : "cfield"}>
      <span className="cfield__value">
        {empty ? <span className="table__meta">—</span> : children}
      </span>
      {locked ? <LockedTag why={locked} /> : null}
      {correction ? (
        <CorrectionBadge
          correction={correction}
          item={historyItem}
          canRevert={edit.canEdit}
          onRevert={edit.onRevert}
        />
      ) : null}
      <SourceTag source={field.source} />
    </span>
  );
}

/**
 * "Edited by admin", with who/when/why on hover (A7, #2561): the reason code and timestamp ride
 * on the detail; the full reason TEXT is only on the edit history, so it is added when that has
 * loaded. A live correction also offers Revert to a session holding `edit_candidates`.
 */
function CorrectionBadge({
  correction,
  item,
  canRevert,
  onRevert,
}: {
  correction: NonNullable<CandidateCorrection>;
  item: CorrectionHistoryItem | null;
  canRevert: boolean;
  onRevert?: (item: CorrectionHistoryItem) => void;
}) {
  const why = item?.reason_text ?? humanize(correction.reason_code);
  const title = `${why} — ${humanize(item?.reason_code ?? correction.reason_code)}, by admin ${shortId(
    correction.admin_id,
  )}, ${correction.created_at}`;
  return (
    <>
      <span className="edited-badge" title={title}>
        Edited by admin
      </span>
      {canRevert && item?.live && onRevert ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm cfield__revert"
          onClick={() => onRevert(item)}
        >
          Revert
        </button>
      ) : null}
    </>
  );
}

/** A section's Edit control, offered only to `edit_candidates` holders. */
function SectionEdit({ section, label }: { section: EditSectionId; label: string }) {
  const edit = useContext(CandidateEditContext);
  if (!edit.canEdit || !edit.onEditSection) return null;
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm cdrawer__edit"
      onClick={() => edit.onEditSection!(section)}
    >
      Edit {label}
    </button>
  );
}

/** One DetailList row for a record field, labelled from the ONE label list (`CANDIDATE_FIELDS`). */
function row(
  key: CandidateFieldKey,
  field: CandidateField<unknown>,
  value: ReactNode,
  locked?: string,
) {
  return {
    label: fieldLabel(key),
    value: (
      <FieldValue field={field} fieldKey={key} locked={locked}>
        {value}
      </FieldValue>
    ),
  };
}

/** Text, with a blank string read as absent (worker-typed text can be "   "). */
const text = (v: string | null): string | null => (v && v.trim() ? v : null);

/** A list as chips, or nothing when it is empty. */
function chips(items: readonly string[]): ReactNode {
  if (items.length === 0) return null;
  return (
    <ul className="chips">
      {items.map((item, i) => (
        <li key={`${i}-${item}`} className="chip">
          {item}
        </li>
      ))}
    </ul>
  );
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");
const answer = (v: boolean | null) => formatAnswer(v);

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfilePanel({
  d,
  posture,
  canReveal,
}: {
  d: CandidateDetail;
  posture: IdentityPosture;
  canReveal: boolean;
}) {
  const band = d.salary.band.value;
  return (
    <>
      {posture === "capped" ? (
        <IdentityCapNotice>
          Your role may see this worker&apos;s name, so the title shows their id: this admin account
          has spent its hourly name budget.
        </IdentityCapNotice>
      ) : null}

      <PanelSection title="Locked">
        <p className="panel__sub">Only the worker can change these — an admin never edits them.</p>
        <DetailList
          items={[
            row(
              "identity.name",
              d.identity.name,
              <NameValue d={d} posture={posture} />,
              LOCK_REASONS.name,
            ),
            { label: "Phone", value: <PhoneField workerId={d.worker_id} canReveal={canReveal} /> },
            {
              label: "WhatsApp",
              value: (
                <span className="cfield">
                  <span className="cfield__value">
                    <span className="table__meta">Hidden</span>
                  </span>
                  <LockedTag why={LOCK_REASONS.whatsapp} />
                </span>
              ),
            },
            row(
              "identity.resume_show_photo",
              d.identity.resume_show_photo,
              d.identity.resume_show_photo.value ? "Shown on the resume" : "Hidden on the resume",
              LOCK_REASONS.photo,
            ),
          ]}
        />
      </PanelSection>

      <PanelSection title="Identity">
        <DetailList
          items={[
            {
              label: "Worker id",
              value: (
                <span className="cfield__value">
                  <span className="mono">{d.worker_id}</span>
                  <CopyId id={d.worker_id} label="worker id" />
                </span>
              ),
            },
            row(
              "identity.has_photo",
              d.identity.has_photo,
              d.identity.has_photo.value ? "Uploaded" : "None",
            ),
            row(
              "identity.preferred_language",
              d.identity.preferred_language,
              text(d.identity.preferred_language.value),
            ),
          ]}
        />
      </PanelSection>

      <PanelSection title="Location" action={<SectionEdit section="location" label="location" />}>
        <DetailList
          items={[
            row(
              "location.current_city",
              d.location.current_city,
              text(d.location.current_city.value),
            ),
            row(
              "location.current_state",
              d.location.current_state,
              text(d.location.current_state.value),
            ),
            row(
              "location.preferred_locations",
              d.location.preferred_locations,
              chips(d.location.preferred_locations.value),
            ),
          ]}
        />
      </PanelSection>

      <PanelSection title="Trade" action={<SectionEdit section="trade" label="trade" />}>
        <DetailList
          items={[
            row("trade.display_name", d.trade.display_name, text(d.trade.display_name.value)),
            row("trade.job_domain", d.trade.job_domain, d.trade.job_domain.value?.label ?? null),
            row(
              "trade.secondary_roles",
              d.trade.secondary_roles,
              chips(d.trade.secondary_roles.value.map((r) => r.label)),
            ),
            row(
              "trade.canonical_trade_id",
              d.trade.canonical_trade_id,
              mono(d.trade.canonical_trade_id.value),
            ),
            row(
              "trade.canonical_role_id",
              d.trade.canonical_role_id,
              mono(d.trade.canonical_role_id.value),
            ),
          ]}
        />
      </PanelSection>

      <PanelSection title="Languages">
        <DetailList items={[row("languages", d.languages, chips(d.languages.value))]} />
      </PanelSection>

      <PanelSection
        title="Salary"
        action={<SectionEdit section="pay" label="pay and availability" />}
      >
        <DetailList
          items={[
            row(
              "salary.band",
              d.salary.band,
              band ? (
                <>
                  <span className="ui-num">{formatPayBand(band.low, band.high)}</span>
                  {d.salary.open_top_chip ? (
                    <span className="table__meta"> · chose the “50,000 or more” chip</span>
                  ) : null}
                </>
              ) : null,
            ),
            row("salary.period", d.salary.period, formatSalaryPeriod(d.salary.period.value)),
          ]}
        />
      </PanelSection>

      <PanelSection
        title="Preferences"
        action={<SectionEdit section="pay" label="pay and availability" />}
      >
        <DetailList
          items={[
            row(
              "preferences.availability",
              d.preferences.availability,
              formatAvailability(d.preferences.availability.value),
            ),
            row("preferences.shift", d.preferences.shift, text(d.preferences.shift.value)),
            row(
              "preferences.night_shift_ready",
              d.preferences.night_shift_ready,
              answer(d.preferences.night_shift_ready.value),
            ),
            row("preferences.job_type", d.preferences.job_type, text(d.preferences.job_type.value)),
            row(
              "preferences.work_types",
              d.preferences.work_types,
              chips(d.preferences.work_types.value),
            ),
            row(
              "preferences.relocation",
              d.preferences.relocation,
              answer(d.preferences.relocation.value),
            ),
            row(
              "preferences.accommodation",
              d.preferences.accommodation,
              answer(d.preferences.accommodation.value),
            ),
            row(
              "preferences.commute_max_km",
              d.preferences.commute_max_km,
              d.preferences.commute_max_km.value === null
                ? null
                : `${d.preferences.commute_max_km.value} km`,
            ),
            row(
              "preferences.willing_to_travel",
              d.preferences.willing_to_travel,
              answer(d.preferences.willing_to_travel.value),
            ),
            row(
              "preferences.documents",
              d.preferences.documents,
              chips(d.preferences.documents.value),
            ),
          ]}
        />
      </PanelSection>

      <PanelSection title="Education">
        <DetailList
          items={[
            row("education.headline", d.education.headline, text(d.education.headline.value)),
            row("education.education", d.education.education, chips(d.education.education.value)),
            row(
              "education.education_level",
              d.education.education_level,
              text(d.education.education_level.value),
            ),
            row(
              "education.education_field",
              d.education.education_field,
              text(d.education.education_field.value),
            ),
            row(
              "education.education_credential",
              d.education.education_credential,
              text(d.education.education_credential.value),
            ),
            row(
              "education.education_detail",
              d.education.education_detail,
              text(d.education.education_detail.value),
            ),
            row(
              "education.certifications",
              d.education.certifications,
              chips(d.education.certifications.value),
            ),
            row("education.training", d.education.training, chips(d.education.training.value)),
          ]}
        />
      </PanelSection>
    </>
  );
}

/**
 * The name, in the console's three postures. Named: the name, or the honest dash for "none on
 * record". Capped: withheld for this read (the notice above says why). Faceless: hidden for the
 * ROLE — an analyst — and said so, never an empty cell.
 */
function NameValue({ d, posture }: { d: CandidateDetail; posture: IdentityPosture }) {
  if (posture === "named") return <NameCell value={d.identity.name.value} />;
  if (posture === "capped")
    return <span className="table__meta">Withheld — name budget spent</span>;
  return <span className="table__meta">Hidden for your role</span>;
}

/** An id-like value (a taxonomy id) in the mono face, or nothing. */
function mono(v: string | null): ReactNode {
  const t = text(v);
  return t ? <span className="mono">{t}</span> : null;
}

// ---------------------------------------------------------------------------
// Work history
// ---------------------------------------------------------------------------

function WorkHistoryPanel({ d }: { d: CandidateDetail }) {
  const jobs = d.work_history.value;
  const years = d.experience.total_years.value;
  return (
    <>
      <PanelSection title="Experience" action={<SectionEdit section="work" label="experience" />}>
        <DetailList
          items={[
            row(
              "experience.total_years",
              d.experience.total_years,
              years === null ? null : formatYears(years),
            ),
            row(
              "experience.industry_tenure",
              d.experience.industry_tenure,
              chips(
                d.experience.industry_tenure.value.map(
                  (t) => `${t.industry.label} · ${formatMonths(t.calendar_months)}`,
                ),
              ),
            ),
          ]}
        />
      </PanelSection>

      <PanelSection title={fieldLabel("work_history")}>
        <p className="panel__sub cfield">
          <span>Where this came from:</span>
          <SourceTag source={d.work_history.source} />
        </p>
        {jobs.length === 0 ? (
          <p className="state__body">No work history recorded.</p>
        ) : (
          <ol className="cjobs">
            {jobs.map((job, i) => (
              <li key={i} className="cjob">
                <p className="cjob__head">
                  <strong>
                    {[job.employer_city, job.employer_state].filter(Boolean).join(", ") ||
                      "Place not given"}
                  </strong>
                  {" · "}
                  {formatStint(job.start_ym, job.end_ym)}
                  {job.duration_stated ? "" : " · length not stated by the worker"}
                </p>
                {job.roles.length === 0 ? (
                  <p className="table__meta">No role recorded for this employer.</p>
                ) : (
                  <ul className="cjob__roles">
                    {job.roles.map((r, j) => (
                      <li key={j} className="cjob__role">
                        <p className="cjob__role-head">
                          <strong>{r.role_label}</strong> · {formatStint(r.start_ym, r.end_ym)}
                        </p>
                        {text(r.work_done) ? (
                          <p className="cjob__words">
                            <span className="table__meta">In their words: </span>
                            {r.work_done}
                          </p>
                        ) : null}
                        {text(r.work_done_polished) ? (
                          <p className="cjob__words">
                            <span className="table__meta">Rewritten for the resume: </span>
                            {r.work_done_polished}
                            {r.work_done_polish_declined ? (
                              <span className="table__meta">
                                {" "}
                                (declined — the resume prints their own words)
                              </span>
                            ) : null}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="table__meta">Employer names are not shown here.</p>
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Skills — the profile's, the matcher's, and the card employers see
// ---------------------------------------------------------------------------

function SkillsPanel({ d }: { d: CandidateDetail }) {
  const card = d.employer_card;
  const months = (n: number | null) => (n === null ? null : formatMonths(n));
  return (
    <>
      <PanelSection title="On the profile">
        <DetailList
          items={[
            row("skills.skills", d.skills.skills, chips(d.skills.skills.value)),
            row("skills.machines", d.skills.machines, chips(d.skills.machines.value)),
          ]}
        />
      </PanelSection>

      <PanelSection title="What matching reads">
        {d.skills.match_skills.length === 0 ? (
          <p className="state__body">No match skills derived for this worker yet.</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Match skills</caption>
              <thead>
                <tr>
                  <th scope="col">Skill</th>
                  <th scope="col">Industry</th>
                  <th scope="col">Experience</th>
                  <th scope="col">Wants it</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {d.skills.match_skills.map((s) => (
                  <tr key={`${s.skill_id}-${s.industry.id}`}>
                    <td title={s.skill_id}>{s.label}</td>
                    <td title={s.industry.id}>{s.industry.label}</td>
                    <td className="ui-num">{formatMonths(s.months_bucketed)}</td>
                    <td>{yesNo(s.wants)}</td>
                    <td>
                      <SourceTag source={s.source} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelSection>

      <PanelSection title="The card employers see">
        <p className="panel__sub">
          {card.in_search_pool
            ? "This worker is in the employer search pool; this is their card there."
            : "This worker is not in the employer search pool, so employers do not see a card."}
          {card.is_sample ? " Badged as a sample candidate." : ""}
        </p>
        <DetailList
          items={[
            row("employer_card.role", card.role, card.role.value?.label ?? null),
            row("employer_card.role_months", card.role_months, months(card.role_months.value)),
            row(
              "employer_card.other_roles",
              card.other_roles,
              chips(card.other_roles.value.map((r) => r.label)),
            ),
            row("employer_card.industry", card.industry, card.industry.value?.label ?? null),
            row(
              "employer_card.industry_months",
              card.industry_months,
              months(card.industry_months.value),
            ),
            row("employer_card.city", card.city, text(card.city.value)),
            row(
              "employer_card.trade_levels",
              card.trade_levels,
              chips(card.trade_levels.value.map(formatTradeLevel)),
            ),
          ]}
        />
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

function ApplicationsPanel({ d }: { d: CandidateDetail }) {
  const a = d.activity;
  return (
    <>
      <div className="stats stats--compact">
        <Stat label="Applied" value={formatCount(a.application_count)} />
        <Stat label="Skipped" value={formatCount(a.skipped_count)} />
      </div>
      <PanelSection title="Recent applications">
        {a.recent_applications.length === 0 ? (
          <p className="state__body">
            {a.application_count === 0
              ? "This worker has not applied to a posting yet."
              : "No recent applications came back with this record."}
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">The ten most recent applications</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Posting</th>
                  <th scope="col">From</th>
                  <th scope="col">Match tier</th>
                </tr>
              </thead>
              <tbody>
                {a.recent_applications.map((app) => (
                  <tr key={app.id}>
                    <td>
                      <Timestamp iso={app.created_at} />
                    </td>
                    <td>
                      {app.job_posting_id ? (
                        <>
                          <Link className="link mono" href={`/jobs/${app.job_posting_id}`}>
                            {shortId(app.job_posting_id)}
                          </Link>
                          <CopyId id={app.job_posting_id} label="posting id" />
                        </>
                      ) : app.job_id ? (
                        <span className="mono" title="Legacy job (pre-Matching-V1)">
                          {shortId(app.job_id)}
                        </span>
                      ) : (
                        <span className="table__meta">—</span>
                      )}
                    </td>
                    <td className="table__meta">{humanize(app.source_surface)}</td>
                    <td className="table__meta">{matchTierLabel(app.match_tier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

function ResumePanel({ d }: { d: CandidateDetail }) {
  const r = d.resume;
  return (
    <PanelSection title="Versions">
      <p className="panel__sub">
        {r.version_count === 0
          ? "No resume has been generated for this worker."
          : `${formatCount(r.version_count)} version${r.version_count === 1 ? "" : "s"}, newest first${
              r.truncated ? ` — the ${formatCount(r.versions.length)} most recent are listed` : ""
            }. A resume prints the worker's phone, so it is not offered for download here.`}
      </p>
      {r.versions.length > 0 ? (
        <div className="tablewrap">
          <table className="table">
            <caption className="sr-only">Resume versions</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Generated</th>
                <th scope="col">Why</th>
                <th scope="col">From</th>
                <th scope="col">Render</th>
                <th scope="col">PDF</th>
              </tr>
            </thead>
            <tbody>
              {r.versions.map((v) => (
                <tr key={v.resume_id}>
                  <td className="ui-num">v{v.version}</td>
                  <td>
                    <Timestamp iso={v.generated_at} />
                  </td>
                  <td className="table__meta">
                    {v.generation_trigger ? humanize(v.generation_trigger) : "—"}
                  </td>
                  <td className="table__meta">
                    {v.generation_source ? humanize(v.generation_source) : "—"}
                  </td>
                  <td>
                    <StatusPill value={v.render_status} tone={renderTone(v.render_status)} />{" "}
                    <span className="table__meta mono" title="Template">
                      {v.template_id}
                    </span>
                  </td>
                  <td>
                    {v.has_pdf ? (
                      v.rendered_at ? (
                        <>
                          Rendered <Timestamp iso={v.rendered_at} />
                        </>
                      ) : (
                        "Rendered"
                      )
                    ) : (
                      <span className="table__meta">Not rendered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </PanelSection>
  );
}

/**
 * A resume render's tone: the pill map is the lifecycle one, where an unknown word is a warning —
 * so a FINISHED render would read as one. Rendered is fine, failed is bad, anything else (queued,
 * rendering) is still under way.
 */
function renderTone(status: string): Tone {
  if (status === "rendered") return "ok";
  if (status === "failed" || status === "error") return "bad";
  return "warn";
}

// ---------------------------------------------------------------------------
// Activity — the account: state, profile, consent, devices, flag
// ---------------------------------------------------------------------------

/** The console's quiet dash for a value the record does not hold. */
const DASH = <span className="table__meta">—</span>;

/** A timestamp, or a dash for "never". */
function when(iso: string | null): ReactNode {
  return iso ? <Timestamp iso={iso} /> : DASH;
}

function ActivityPanel({ d }: { d: CandidateDetail }) {
  const edit = useContext(CandidateEditContext);
  const acc = d.account;
  return (
    <>
      <PanelSection title="Account">
        <DetailList
          items={[
            { label: "Status", value: <StatusPill value={acc.status} /> },
            {
              label: "Verification",
              value: acc.verification_state ? (
                <>
                  {humanize(acc.verification_state)}
                  {acc.verified_at ? (
                    <span className="table__meta">
                      {" "}
                      · <Timestamp iso={acc.verified_at} />
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="table__meta">Not verified</span>
              ),
            },
            { label: "Test account", value: yesNo(acc.is_test_account) },
            { label: "Sample candidate", value: yesNo(acc.is_sample) },
            {
              label: "Deletion scheduled",
              value: acc.deletion_scheduled_at ? (
                <span className="pill pill--bad">
                  <Timestamp iso={acc.deletion_scheduled_at} />
                </span>
              ) : (
                "No"
              ),
            },
            { label: "Registered", value: <Timestamp iso={acc.created_at} /> },
            { label: "Last updated", value: <Timestamp iso={acc.updated_at} /> },
            { label: "Contact unlocks", value: formatCount(d.activity.unlock_count) },
          ]}
        />
        {edit.canManageAccount ? (
          <CandidateAccountActions
            workerId={d.worker_id}
            status={acc.status}
            targetName={candidateTitle(d)}
            onChanged={() => edit.onRefresh?.()}
          />
        ) : null}
      </PanelSection>

      <PanelSection title="Profile">
        <DetailList
          items={[
            { label: "Status", value: <StatusPill value={acc.profile.status} /> },
            {
              label: "Made by",
              value: (
                <span className="cfield">
                  <SourceTag source={acc.profile.source} />
                </span>
              ),
            },
            { label: "Confirmed", value: when(acc.profile.confirmed_at) },
            {
              label: "Form level",
              value: acc.profile.form_level ? humanize(acc.profile.form_level) : DASH,
            },
          ]}
        />
      </PanelSection>

      <PanelSection title="Consent">
        <DetailList
          items={[
            { label: "Consent", value: consentLabel(acc.consent.state) },
            {
              label: "Version",
              value: acc.consent.consent_version ? (
                <span className="mono">{acc.consent.consent_version}</span>
              ) : (
                DASH
              ),
            },
            { label: "Given", value: when(acc.consent.accepted_at) },
            { label: "Purposes", value: chips(acc.consent.purposes.map(humanize)) ?? DASH },
            { label: "Shares with employers", value: yesNo(acc.consent.employer_sharing) },
          ]}
        />
      </PanelSection>

      <PanelSection title="Devices">
        <DetailList
          items={[
            { label: "Signed-in devices", value: formatCount(acc.devices.count) },
            {
              label: "Latest app version",
              value: acc.devices.latest_app_version ? (
                <span className="mono">{acc.devices.latest_app_version}</span>
              ) : (
                DASH
              ),
            },
            { label: "Last seen", value: when(acc.devices.last_seen_at) },
          ]}
        />
      </PanelSection>

      <PanelSection title="Flag">
        <DetailList
          items={[
            { label: "Flagged", value: yesNo(acc.flag.flagged) },
            {
              label: "Reason",
              value: acc.flag.reason_code
                ? ((WORKER_FLAG_REASON_LABELS as Record<string, string>)[acc.flag.reason_code] ??
                  humanize(acc.flag.reason_code))
                : DASH,
            },
            { label: "Flagged on", value: when(acc.flag.flagged_at) },
          ]}
        />
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Edit log — admin corrections, which do not exist until #2561
// ---------------------------------------------------------------------------

/**
 * The Edit log (A7, #2561). For an editor it is the API's correction HISTORY: every override,
 * the full reason text, the admin, and whether it is live or superseded, with Revert on the live
 * one. For a role without `edit_candidates` the record's own `correction` metadata is all there
 * is — the API deliberately never sends the reason text on that read.
 *
 * The correction events live on the candidate's timeline; this panel links to it. The history
 * contract carries no event id, so the link is to the timeline, not one event.
 */
function EditLogPanel({ d }: { d: CandidateDetail }) {
  const edit = useContext(CandidateEditContext);
  const timelineHref = `/candidates/${d.worker_id}/timeline`;

  if (edit.canEdit) {
    if (edit.history.status === "loading" && edit.history.items.length === 0) {
      return <p className="state__body">Loading the edit log…</p>;
    }
    if (edit.history.status === "failed") {
      return (
        <div className="state state--error">
          <h3 className="state__title">The edit log did not load</h3>
          <p className="state__body">{edit.history.error}</p>
          {edit.onReloadHistory ? (
            <div className="state__actions">
              <button type="button" className="btn btn--ghost" onClick={edit.onReloadHistory}>
                Retry
              </button>
            </div>
          ) : null}
        </div>
      );
    }
    const items = edit.history.items;
    if (items.length === 0) {
      return (
        <div className="state">
          <h3 className="state__title">No admin edits</h3>
          <p className="state__body">
            No admin has corrected a field on this record. Each field&apos;s source tag says where
            its value came from.
          </p>
        </div>
      );
    }
    return (
      <>
        <p className="panel__sub">
          Newest first. Every correction writes an event to the{" "}
          <Link href={timelineHref}>candidate timeline</Link>.
        </p>
        <div className="tablewrap">
          <table className="table">
            <caption className="sr-only">Admin corrections, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Field</th>
                <th scope="col">Reason</th>
                <th scope="col">Admin</th>
                <th scope="col">State</th>
                <th scope="col">Timeline</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.override_id}>
                  <td>
                    <Timestamp iso={item.created_at} />
                  </td>
                  <td>{FACT_LABELS[item.fact_key] ?? humanize(item.fact_key)}</td>
                  <td className="cdrawer__reason">
                    <span>{item.reason_text}</span>
                    <span className="table__meta"> · {humanize(item.reason_code)}</span>
                  </td>
                  <td>
                    <span className="mono" title={item.admin_id}>
                      {shortId(item.admin_id)}
                    </span>
                    <CopyId id={item.admin_id} label="admin id" />
                  </td>
                  <td>
                    {item.live ? (
                      <>
                        <span className="pill pill--ok">Live</span>
                        {edit.onRevert ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => edit.onRevert!(item)}
                          >
                            Revert
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <span className="table__meta">
                        Reverted{" "}
                        {item.superseded_at ? <Timestamp iso={item.superseded_at} /> : null}
                      </span>
                    )}
                  </td>
                  <td>
                    <Link className="link" href={timelineHref}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  const entries = corrections(d);
  if (entries.length === 0) {
    return (
      <div className="state">
        <h3 className="state__title">No admin edits</h3>
        <p className="state__body">
          No admin has corrected a field on this record. Each field&apos;s source tag says where its
          value came from.
        </p>
      </div>
    );
  }
  return (
    <>
      <p className="panel__sub">
        Your role can see that a field was corrected, not the reason text an editor recorded.
      </p>
      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">Admin corrections, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Field</th>
              <th scope="col">Reason</th>
              <th scope="col">Admin</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.correction.override_id}>
                <td>
                  <Timestamp iso={e.correction.created_at} />
                </td>
                <td>{e.label}</td>
                <td>{humanize(e.correction.reason_code)}</td>
                <td>
                  <span className="mono" title={e.correction.admin_id}>
                    {shortId(e.correction.admin_id)}
                  </span>
                  <CopyId id={e.correction.admin_id} label="admin id" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The record's one-line summary under the drawer title: "TIG Welder · Pune", or "" when neither is known. */
export function recordSummary(d: CandidateDetail): string {
  return [text(d.trade.display_name.value), text(d.location.current_city.value)]
    .filter((p): p is string => p !== null)
    .join(" · ");
}
