"use client";

import type { CandidateDetail } from "../../../lib/candidate-detail";
import {
  DOCUMENT_OPTIONS,
  EDUCATION_COUNCIL_OPTIONS,
  EDUCATION_CREDENTIAL_OPTIONS,
  LANGUAGE_OPTIONS,
  WORK_TYPE_OPTIONS,
  parseCertificateRows,
  parseEducationRows,
  parseLanguageRows,
  parseStringList,
  parseTrainingRows,
  parseWorkHistoryRows,
  serializeCertificateRows,
  serializeEducationRows,
  serializeLanguageRows,
  serializeStringList,
  serializeTrainingRows,
  serializeWorkHistoryRows,
  type CertificateDraftRow,
  type EditFieldSpec,
  type EducationDraftRow,
  type LanguageDraftRow,
  type StructuredEditKind,
  type TrainingDraftRow,
  type WorkHistoryDraftRow,
} from "../../../lib/candidate-edit-model";

/**
 * The eight structured field editors (#2728).
 *
 * Each one is CONTROLLED by the dialog's draft: the draft holds one JSON string per fact, and
 * these components parse it, render repeatable rows or closed-set chips, and serialize the API's
 * exact shape back on every change. Nothing here talks to the API; the dialog's T2 review step
 * still sends one correction per changed fact.
 *
 * WORK HISTORY NEVER ATTACHES A VOICE NOTE. There is no control for one, and the serializer writes
 * `work_done_voice_note_id: null` at both levels.
 *
 * Presentational rules: the console's own tokens/classes (`.field`, `.form-grid`, `.form-actions`,
 * `.chips`, `.chip--action`), no new colours and no animation — so reduced motion needs nothing
 * extra.
 */

const NUMBER_INPUT = { inputMode: "numeric" as const, autoComplete: "off" };

export function StructuredFieldEditor({
  field,
  value,
  detail,
  onChange,
}: {
  field: EditFieldSpec;
  value: string;
  detail: CandidateDetail;
  onChange: (value: string) => void;
}) {
  switch (field.kind as StructuredEditKind) {
    case "skill-list":
      return <SkillList value={value} detail={detail} onChange={onChange} />;
    case "work-history-rows":
      return <WorkHistoryRows value={value} onChange={onChange} />;
    case "education-rows":
      return <EducationRows value={value} onChange={onChange} />;
    case "certificate-rows":
      return <CertificateRows value={value} onChange={onChange} />;
    case "training-rows":
      return <TrainingRows value={value} onChange={onChange} />;
    case "language-rows":
      return <LanguageRows value={value} onChange={onChange} />;
    case "work-type-list":
      return <ClosedList value={value} options={WORK_TYPE_OPTIONS} max={4} onChange={onChange} />;
    case "document-list":
      return <ClosedList value={value} options={DOCUMENT_OPTIONS} max={8} onChange={onChange} />;
  }
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

function SkillList({
  value,
  detail,
  onChange,
}: {
  value: string;
  detail: CandidateDetail;
  onChange: (value: string) => void;
}) {
  const selected = parseStringList(value);
  const offered = detail.skills.match_skills.map((skill) => ({
    value: skill.skill_id,
    label: skill.label,
  }));
  const unknown = selected
    .filter((id) => !offered.some((option) => option.value === id))
    .map((id) => ({ value: id, label: id }));
  const options = [...offered, ...unknown];

  function toggle(id: string) {
    onChange(
      serializeStringList(
        selected.includes(id) ? selected.filter((current) => current !== id) : [...selected, id],
      ),
    );
  }

  return (
    <>
      {options.length === 0 ? (
        <p className="field__help">
          This record has no match skills to choose from yet. A skill id already stored stays
          visible below.
        </p>
      ) : (
        <ul className="chips" aria-label="Skills">
          {options.map((option) => {
            const picked = selected.includes(option.value);
            return (
              <li key={option.value}>
                <button
                  type="button"
                  className="chip chip--action"
                  aria-pressed={picked}
                  onClick={() => toggle(option.value)}
                >
                  {picked ? "Selected: " : ""}
                  {option.label}
                  {option.label === option.value ? " (current id)" : ""}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="field__help">{selected.length} of 50 selected.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// work history
// ---------------------------------------------------------------------------

function WorkHistoryRows({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const rows = parseWorkHistoryRows(value);
  const commit = (next: WorkHistoryDraftRow[]) => onChange(serializeWorkHistoryRows(next));

  const update = (index: number, patch: Partial<WorkHistoryDraftRow>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const addRow = () =>
    commit([
      ...rows,
      {
        employer_name: "",
        employer_city: "",
        employer_state: "",
        start_ym: "",
        end_ym: "",
        roles: [{ role_label: "", start_ym: "", end_ym: "", work_done: "" }],
      },
    ]);

  const removeRow = (index: number) => commit(rows.filter((_, at) => at !== index));

  const updateRole = (
    rowIndex: number,
    roleIndex: number,
    patch: Partial<WorkHistoryDraftRow["roles"][number]>,
  ) =>
    update(rowIndex, {
      roles: rows[rowIndex]!.roles.map((role, at) =>
        at === roleIndex ? { ...role, ...patch } : role,
      ),
    });

  const addRole = (rowIndex: number) =>
    update(rowIndex, {
      roles: [
        ...rows[rowIndex]!.roles,
        { role_label: "", start_ym: "", end_ym: "", work_done: "" },
      ],
    });

  const removeRole = (rowIndex: number, roleIndex: number) =>
    update(rowIndex, {
      roles: rows[rowIndex]!.roles.filter((_, at) => at !== roleIndex),
    });

  return (
    <>
      <p className="field__help">
        One entry per employer. Add a role for each title held there; a voice note is never
        attached.
      </p>
      {rows.map((row, index) => (
        <fieldset className="form__section" key={`employment-${index}`}>
          <legend className="form__legend">Employment {index + 1}</legend>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Employer name</span>
              <input
                className="field__input"
                type="text"
                value={row.employer_name}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => update(index, { employer_name: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">City</span>
              <input
                className="field__input"
                type="text"
                value={row.employer_city}
                maxLength={80}
                autoComplete="off"
                onChange={(event) => update(index, { employer_city: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">State</span>
              <input
                className="field__input"
                type="text"
                value={row.employer_state}
                maxLength={80}
                autoComplete="off"
                onChange={(event) => update(index, { employer_state: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">From (month)</span>
              <input
                className="field__input"
                type="month"
                value={row.start_ym}
                onChange={(event) => update(index, { start_ym: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">To (month)</span>
              <input
                className="field__input"
                type="month"
                value={row.end_ym}
                onChange={(event) => update(index, { end_ym: event.target.value })}
              />
            </label>
          </div>

          {row.roles.map((role, roleIndex) => (
            <fieldset className="form__section" key={`role-${index}-${roleIndex}`}>
              <legend className="form__legend">Role {roleIndex + 1}</legend>
              <div className="form-grid">
                <label className="field">
                  <span className="field__label">Role title</span>
                  <input
                    className="field__input"
                    type="text"
                    value={role.role_label}
                    maxLength={80}
                    autoComplete="off"
                    onChange={(event) =>
                      updateRole(index, roleIndex, { role_label: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field__label">From (month)</span>
                  <input
                    className="field__input"
                    type="month"
                    value={role.start_ym}
                    onChange={(event) =>
                      updateRole(index, roleIndex, { start_ym: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field__label">To (month)</span>
                  <input
                    className="field__input"
                    type="month"
                    value={role.end_ym}
                    onChange={(event) =>
                      updateRole(index, roleIndex, { end_ym: event.target.value })
                    }
                  />
                </label>
              </div>
              <label className="field">
                <span className="field__label">What they did</span>
                <input
                  className="field__input"
                  type="text"
                  value={role.work_done}
                  maxLength={300}
                  autoComplete="off"
                  onChange={(event) =>
                    updateRole(index, roleIndex, { work_done: event.target.value })
                  }
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => removeRole(index, roleIndex)}
                >
                  Remove role
                </button>
              </div>
            </fieldset>
          ))}

          <div className="form-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => addRole(index)}>
              Add role
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => removeRow(index)}
            >
              Remove employment
            </button>
          </div>
        </fieldset>
      ))}
      <div className="form-actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={addRow}>
          Add employment
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// education
// ---------------------------------------------------------------------------

function EducationRows({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const rows = parseEducationRows(value);
  const commit = (next: EducationDraftRow[]) => onChange(serializeEducationRows(next));
  const update = (index: number, patch: Partial<EducationDraftRow>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <>
      {rows.map((row, index) => (
        <fieldset className="form__section" key={`education-${index}`}>
          <legend className="form__legend">Education {index + 1}</legend>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Credential</span>
              <select
                className="field__input"
                value={row.credential}
                onChange={(event) => update(index, { credential: event.target.value })}
              >
                <option value="">Not stated</option>
                {EDUCATION_CREDENTIAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Field of study</span>
              <input
                className="field__input"
                type="text"
                value={row.field}
                maxLength={80}
                autoComplete="off"
                onChange={(event) => update(index, { field: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Council</span>
              <select
                className="field__input"
                value={row.council}
                onChange={(event) => update(index, { council: event.target.value })}
              >
                <option value="">Not stated</option>
                {EDUCATION_COUNCIL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Year</span>
              <input
                className="field__input"
                type="number"
                {...NUMBER_INPUT}
                value={row.year}
                min={1950}
                max={new Date().getFullYear()}
                onChange={(event) => update(index, { year: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Institute</span>
              <input
                className="field__input"
                type="text"
                value={row.institute}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => update(index, { institute: event.target.value })}
              />
            </label>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => commit(rows.filter((_, at) => at !== index))}
            >
              Remove education
            </button>
          </div>
        </fieldset>
      ))}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            commit([...rows, { credential: "", field: "", council: "", year: "", institute: "" }])
          }
        >
          Add education
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// certificates
// ---------------------------------------------------------------------------

function CertificateRows({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const rows = parseCertificateRows(value);
  const commit = (next: CertificateDraftRow[]) => onChange(serializeCertificateRows(next));
  const update = (index: number, patch: Partial<CertificateDraftRow>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <>
      {rows.map((row, index) => (
        <fieldset className="form__section" key={`certificate-${index}`}>
          <legend className="form__legend">Certificate {index + 1}</legend>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="field__input"
                type="text"
                value={row.name}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => update(index, { name: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Issuer</span>
              <input
                className="field__input"
                type="text"
                value={row.issuer}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => update(index, { issuer: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Year</span>
              <input
                className="field__input"
                type="number"
                {...NUMBER_INPUT}
                value={row.year}
                min={1950}
                max={new Date().getFullYear()}
                onChange={(event) => update(index, { year: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Licence number</span>
              <input
                className="field__input"
                type="text"
                value={row.licence_number}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update(index, { licence_number: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Licence expiry</span>
              <input
                className="field__input"
                type="date"
                value={row.licence_expiry}
                onChange={(event) => update(index, { licence_expiry: event.target.value })}
              />
            </label>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => commit(rows.filter((_, at) => at !== index))}
            >
              Remove certificate
            </button>
          </div>
        </fieldset>
      ))}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            commit([
              ...rows,
              { name: "", issuer: "", year: "", licence_number: "", licence_expiry: "" },
            ])
          }
        >
          Add certificate
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// training
// ---------------------------------------------------------------------------

function TrainingRows({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const rows = parseTrainingRows(value);
  const commit = (next: TrainingDraftRow[]) => onChange(serializeTrainingRows(next));
  const update = (index: number, patch: Partial<TrainingDraftRow>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <>
      {rows.map((row, index) => (
        <fieldset className="form__section" key={`training-${index}`}>
          <legend className="form__legend">Training {index + 1}</legend>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="field__input"
                type="text"
                value={row.name}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => update(index, { name: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Provider</span>
              <input
                className="field__input"
                type="text"
                value={row.provider}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => update(index, { provider: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">Year</span>
              <input
                className="field__input"
                type="number"
                {...NUMBER_INPUT}
                value={row.year}
                min={1950}
                max={new Date().getFullYear()}
                onChange={(event) => update(index, { year: event.target.value })}
              />
            </label>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => commit(rows.filter((_, at) => at !== index))}
            >
              Remove training
            </button>
          </div>
        </fieldset>
      ))}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => commit([...rows, { name: "", provider: "", year: "" }])}
        >
          Add training
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// languages
// ---------------------------------------------------------------------------

function LanguageRows({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const rows = parseLanguageRows(value);
  const commit = (next: LanguageDraftRow[]) => onChange(serializeLanguageRows(next));
  const update = (index: number, patch: Partial<LanguageDraftRow>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <>
      {rows.map((row, index) => (
        <fieldset className="form__section" key={`language-${index}`}>
          <legend className="form__legend">Language {index + 1}</legend>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Language</span>
              <select
                className="field__input"
                value={row.language}
                onChange={(event) => update(index, { language: event.target.value })}
              >
                <option value="">Choose a language</option>
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                ["can_speak", "Speak"],
                ["can_read", "Read"],
                ["can_write", "Write"],
              ] as const
            ).map(([key, label]) => (
              <label className="field field--check" key={key}>
                <input
                  type="checkbox"
                  checked={row[key]}
                  onChange={(event) => update(index, { [key]: event.target.checked })}
                />
                <span className="field__label">{label}</span>
              </label>
            ))}
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => commit(rows.filter((_, at) => at !== index))}
            >
              Remove language
            </button>
          </div>
        </fieldset>
      ))}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            commit([...rows, { language: "", can_speak: false, can_read: false, can_write: false }])
          }
        >
          Add language
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// closed lists
// ---------------------------------------------------------------------------

function ClosedList({
  value,
  options,
  max,
  onChange,
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  max: number;
  onChange: (value: string) => void;
}) {
  const selected = parseStringList(value);

  function toggle(slug: string) {
    const next = selected.includes(slug)
      ? selected.filter((current) => current !== slug)
      : [...selected, slug];
    onChange(serializeStringList(next));
  }

  return (
    <>
      <ul className="chips" aria-label="Options">
        {options.map((option) => {
          const picked = selected.includes(option.value);
          const atMax = selected.length >= max && !picked;
          return (
            <li key={option.value}>
              <button
                type="button"
                className="chip chip--action"
                aria-pressed={picked}
                disabled={atMax}
                onClick={() => toggle(option.value)}
              >
                {picked ? "Selected: " : ""}
                {option.label}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="field__help">
        {selected.length} of {max} selected.
      </p>
    </>
  );
}
