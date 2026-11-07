"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../../../components/dialog";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { FieldError } from "../../../components/form-feedback";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import type { CandidateDetail } from "../../../lib/candidate-detail";
import { postCandidateCorrection } from "../../../lib/candidate-edit-client";
import {
  CORRECTION_REASON_CATEGORIES,
  editChanges,
  editSection,
  initialEditDraft,
  parseEntries,
  validateEditDraft,
  type CorrectionReasonCode,
  type EditDraft,
  type EditFieldSpec,
  type EditSectionId,
  type EntryColumnSpec,
  type EntryRow,
} from "../../../lib/candidate-edit-model";
import { REASON_MIN_CHARS, reasonLongEnough } from "../../../lib/confirm-tiers";

/**
 * EDIT ONE SECTION (A7, #2577) — the two-step T2 the issue asks for.
 *
 *  1. The section's fields, pre-filled from the record. A field the API cannot accept in the
 *     record's shape is not offered (see `candidate-edit-model.ts`); name, phone, WhatsApp and
 *     photo visibility never appear here at all.
 *  2. A field-by-field before/after diff, the API's four reason codes, and a required reason of
 *     15–500 characters. "Save corrections" sends ONE request per changed fact, all reusing that
 *     reason (the API takes one fact per request).
 *
 * A partial save is handled honestly: already-saved facts are not sent again on Retry, and the
 * drawer is refreshed for what did land. A locked field or an unknown taxonomy id comes back as
 * the API's own sentence in the banner, never a silent failure.
 */
export function CandidateEditDialog({
  open,
  sectionId,
  detail,
  onClose,
  onSaved,
}: {
  open: boolean;
  sectionId: EditSectionId;
  detail: CandidateDetail;
  onClose: () => void;
  /** Called after at least one fact was saved, with the fact keys that changed. */
  onSaved: (factKeys: string[]) => void;
}) {
  const id = useId();
  const section = editSection(sectionId);
  const [stage, setStage] = useState<"form" | "review">("form");
  const [draft, setDraft] = useState<EditDraft>(() => initialEditDraft(detail, sectionId));
  const [reasonCode, setReasonCode] = useState<CorrectionReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [failure, setFailure] = useState<AdminActionOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFacts, setSavedFacts] = useState<ReadonlySet<string>>(new Set());
  const wasOpen = useRef(false);

  // A fresh open (or a different section) starts from the record as it is now.
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStage("form");
      setDraft(initialEditDraft(detail, sectionId));
      setReasonCode("");
      setReasonText("");
      setFailure(null);
      setSavedFacts(new Set());
    }
    if (open && wasOpen.current) {
      // The section changed while the dialog stayed open: start that section's draft.
      setStage("form");
      setDraft(initialEditDraft(detail, sectionId));
      setFailure(null);
      setSavedFacts(new Set());
    }
    wasOpen.current = open;
    // The detail intentionally does not reset a draft: after a save the record refreshes, and
    // resetting would wipe the review the operator is still looking at.
  }, [open, sectionId]);

  const errors = validateEditDraft(detail, sectionId, draft);
  const changes = editChanges(detail, sectionId, draft);
  const pending = changes.filter((c) => !savedFacts.has(c.factKey));
  const hasErrors = Object.keys(errors).length > 0;

  function set(formKey: string, value: string) {
    setDraft((current) => ({ ...current, [formKey]: value }));
  }

  function setEntries(formKey: string, rows: EntryRow[]) {
    set(formKey, JSON.stringify(rows));
  }

  function close() {
    if (saving) return;
    onClose();
  }

  async function save() {
    if (saving || !reasonLongEnough(reasonText) || reasonCode === "") return;
    if (pending.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setFailure(null);
    const reason = { reason_code: reasonCode, reason_text: reasonText.trim() };
    const saved = new Set(savedFacts);
    const problems: string[] = [];
    for (const change of pending) {
      const outcome = await postCandidateCorrection(
        detail.worker_id,
        change.factKey,
        change.value,
        reason,
      );
      if (outcome.ok) saved.add(change.factKey);
      else problems.push(`${change.label}: ${outcome.error}`);
    }
    setSaving(false);
    setSavedFacts(saved);
    if (saved.size > 0) onSaved([...saved]);
    if (problems.length === 0) {
      onClose();
      return;
    }
    setFailure({
      ok: false,
      error:
        problems.length === 1
          ? problems[0]!
          : `Some fields were saved; these were not — ${problems.join(" ")}`,
    });
  }

  const reasonReady = reasonCode !== "" && reasonLongEnough(reasonText);
  const footer =
    stage === "form" ? (
      <>
        <span className="overlay__hint">
          {hasErrors
            ? "Fix the highlighted fields."
            : changes.length === 0
              ? "Change at least one field to continue."
              : ""}
        </span>
        <button type="button" className="btn btn--ghost" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={hasErrors || changes.length === 0}
          onClick={() => setStage("review")}
        >
          Review {changes.length} change{changes.length === 1 ? "" : "s"}
        </button>
      </>
    ) : (
      <>
        <span className="overlay__hint">
          {reasonCode === "" || !reasonLongEnough(reasonText)
            ? `Choose a reason and explain it in at least ${REASON_MIN_CHARS} characters.`
            : ""}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setStage("form")}
          disabled={saving}
        >
          Back to fields
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!reasonReady || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save corrections"}
        </button>
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Edit ${section.title.toLowerCase()}`}
      description={
        stage === "form"
          ? "Only what you change will be sent. Name, phone, WhatsApp and photo visibility are the worker's own settings and stay locked."
          : "Check the diff, then choose why. The reason is recorded on every field you change and appears in the Edit log."
      }
      footer={footer}
    >
      {stage === "form" ? (
        <form
          className="form bank-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (!hasErrors && changes.length > 0) setStage("review");
          }}
        >
          {section.fields.map((field) => (
            <FieldInput
              key={field.formKey}
              field={field}
              value={draft[field.formKey] ?? ""}
              error={errors[field.formKey]}
              errorId={`${id}-${field.formKey}-error`}
              onText={(value) => set(field.formKey, value)}
              onEntries={(rows) => setEntries(field.formKey, rows)}
            />
          ))}
          {changes.length > 0 ? (
            <p className="field__help">
              {changes.length} field{changes.length === 1 ? "" : "s"} will change:{" "}
              {changes.map((c) => c.label).join(", ")}.
            </p>
          ) : null}
        </form>
      ) : (
        <>
          <table className="diff">
            <caption className="sr-only">What changes</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.factKey}>
                  <th scope="row">{change.label}</th>
                  <td className="diff__before">{change.before}</td>
                  <td className="diff__after">{change.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form">
            <label className="field" htmlFor={`${id}-reason-code`}>
              <span className="field__label">
                Reason<span className="req">*</span>
              </span>
              <select
                id={`${id}-reason-code`}
                className="field__input"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value as CorrectionReasonCode)}
                required
              >
                <option value="" disabled>
                  Choose a reason
                </option>
                {CORRECTION_REASON_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" htmlFor={`${id}-reason-text`}>
              <span className="field__label">
                Explain why<span className="req">*</span>
              </span>
              <textarea
                id={`${id}-reason-text`}
                className="field__input"
                rows={3}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                maxLength={500}
                required
                minLength={REASON_MIN_CHARS}
              />
              <span className="field__help">
                {reasonText.trim().length} of at least {REASON_MIN_CHARS} characters. It is recorded
                with every field above and shown in the Edit log.
              </span>
            </label>
          </div>
          {failure ? (
            <AdminActionResultBanner outcome={failure} eventsLink={null} onRetry={save} />
          ) : null}
        </>
      )}
    </Dialog>
  );
}

/**
 * One section field: the flat inputs (text, selects, numbers, dates) exactly as before,
 * plus the structured inputs the new sections need — `multi` checkbox groups and
 * `entries` dynamic rows (with one nested row level for work-history roles).
 */
function FieldInput({
  field,
  value,
  error,
  errorId,
  onText,
  onEntries,
}: {
  field: EditFieldSpec;
  value: string;
  error: string | undefined;
  errorId: string;
  onText: (value: string) => void;
  onEntries: (rows: EntryRow[]) => void;
}) {
  if (field.kind === "multi") {
    return (
      <MultiInput
        field={field}
        value={value}
        error={error}
        errorId={errorId}
        onText={onText}
      />
    );
  }
  if (field.kind === "entries") {
    return (
      <EntriesInput
        field={field}
        value={value}
        error={error}
        errorId={errorId}
        onEntries={onEntries}
      />
    );
  }
  return (
    <label className="field">
      <span className="field__label">{field.label}</span>
      {field.kind === "select" || field.kind === "tri" ? (
        <select
          className="field__input"
          value={value}
          onChange={(e) => onText(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        >
          <option value="">{field.kind === "tri" ? "Not answered" : "Not answered / clear"}</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="field__input"
          type={
            field.kind === "number" || field.kind === "int"
              ? "number"
              : field.kind === "date"
                ? "date"
                : "text"
          }
          inputMode={field.kind === "number" || field.kind === "int" ? "decimal" : undefined}
          min={field.formKey === "experience" ? 0 : field.kind === "int" ? 0 : undefined}
          max={field.formKey === "experience" ? 60 : undefined}
          value={value}
          onChange={(e) => onText(e.target.value)}
          placeholder={field.placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      )}
      {field.help ? <span className="field__help">{field.help}</span> : null}
      <FieldError id={errorId}>{error}</FieldError>
    </label>
  );
}

/** A closed multi-select: one checkbox per option, the draft a comma-joined slug list. */
function MultiInput({
  field,
  value,
  error,
  errorId,
  onText,
}: {
  field: EditFieldSpec;
  value: string;
  error: string | undefined;
  errorId: string;
  onText: (value: string) => void;
}) {
  const selected = new Set(
    value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== ""),
  );
  function toggle(slug: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(slug);
    else next.delete(slug);
    onText([...next].join(", "));
  }
  return (
    <fieldset className="field">
      <legend className="field__label">{field.label}</legend>
      <div className="filters">
        {(field.options ?? []).map((o) => (
          <label className="field field--check" key={o.value}>
            <input
              type="checkbox"
              checked={selected.has(o.value)}
              onChange={(e) => toggle(o.value, e.target.checked)}
              aria-describedby={error ? errorId : undefined}
            />
            <span className="field__label">{o.label}</span>
          </label>
        ))}
      </div>
      {field.help ? <span className="field__help">{field.help}</span> : null}
      <FieldError id={errorId}>{error}</FieldError>
    </fieldset>
  );
}

/** Dynamic rows for one entries field, with add/remove and one nested row level. */
function EntriesInput({
  field,
  value,
  error,
  errorId,
  onEntries,
}: {
  field: EditFieldSpec;
  value: string;
  error: string | undefined;
  errorId: string;
  onEntries: (rows: EntryRow[]) => void;
}) {
  const rows = parseEntries(value);
  const atMax = field.maxRows !== undefined && rows.length >= field.maxRows;

  function update(index: number, next: EntryRow) {
    onEntries(rows.map((r, i) => (i === index ? next : r)));
  }
  function remove(index: number) {
    onEntries(rows.filter((_, i) => i !== index));
  }
  function add() {
    if (atMax) return;
    onEntries([...rows, { ...(field.emptyRow ?? {}) }]);
  }

  return (
    <fieldset className="field">
      <legend className="field__label">{field.label}</legend>
      {rows.length === 0 ? (
        <p className="field__help">None yet — add one below, or leave this empty.</p>
      ) : null}
      {rows.map((row, i) => (
        <div key={i} className="filters" aria-label={`${field.label} ${i + 1}`}>
          <EntryRowInputs
            columns={field.columns ?? []}
            row={row}
            rowLabel={`${field.label} ${i + 1}`}
            invalid={!!error}
            describedBy={error ? errorId : undefined}
            onChange={(next) => update(i, next)}
          />
          {field.children ? (
            <NestedRows
              spec={field.children}
              rows={childEntries(row[field.children.key])}
              rowLabel={`${field.label} ${i + 1}`}
              invalid={!!error}
              describedBy={error ? errorId : undefined}
              onChange={(kids) => update(i, { ...row, [field.children!.key]: kids })}
            />
          ) : null}
          <div className="filters__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => remove(i)}
              aria-label={`Remove ${field.label.toLowerCase()} ${i + 1}`}
            >
              <Icon name={ACTION_ICON.delete} />
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="filters__actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={add}
          disabled={atMax}
        >
          <Icon name={ACTION_ICON.add} />
          Add {field.label.toLowerCase()}
        </button>
      </div>
      {field.help ? <span className="field__help">{field.help}</span> : null}
      <FieldError id={errorId}>{error}</FieldError>
    </fieldset>
  );
}

/** One entries row's cells. */
function EntryRowInputs({
  columns,
  row,
  rowLabel,
  invalid,
  describedBy,
  onChange,
}: {
  columns: ReadonlyArray<EntryColumnSpec>;
  row: EntryRow;
  rowLabel: string;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (next: EntryRow) => void;
}) {
  return (
    <>
      {columns.map((col) => {
        if (col.kind === "check") {
          return (
            <label className="field field--check" key={col.key}>
              <input
                type="checkbox"
                checked={row[col.key] === true}
                onChange={(e) => onChange({ ...row, [col.key]: e.target.checked })}
                aria-describedby={describedBy}
              />
              <span className="field__label">{col.label}</span>
            </label>
          );
        }
        if (col.kind === "select") {
          return (
            <label className="field" key={col.key}>
              <span className="field__label">{col.label}</span>
              <select
                className="field__input"
                value={typeof row[col.key] === "string" ? (row[col.key] as string) : ""}
                onChange={(e) => onChange({ ...row, [col.key]: e.target.value })}
                aria-label={`${col.label} (${rowLabel})`}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={describedBy}
              >
                <option value="">{col.required ? "Choose…" : "Not answered / clear"}</option>
                {col.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        return (
          <label className="field" key={col.key}>
            <span className="field__label">{col.label}</span>
            <input
              className="field__input"
              type={col.kind === "int" ? "number" : "text"}
              inputMode={col.kind === "int" ? "numeric" : undefined}
              value={typeof row[col.key] === "string" ? (row[col.key] as string) : ""}
              onChange={(e) => onChange({ ...row, [col.key]: e.target.value })}
              placeholder={col.placeholder}
              aria-label={`${col.label} (${rowLabel})`}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={describedBy}
            />
            {col.help ? <span className="field__help">{col.help}</span> : null}
          </label>
        );
      })}
    </>
  );
}

/** The nested rows inside one entries row (work-history roles). */
function NestedRows({
  spec,
  rows,
  rowLabel,
  invalid,
  describedBy,
  onChange,
}: {
  spec: NonNullable<EditFieldSpec["children"]>;
  rows: EntryRow[];
  rowLabel: string;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (rows: EntryRow[]) => void;
}) {
  const atMax = spec.maxRows !== undefined && rows.length >= spec.maxRows;
  return (
    <div className="filters" aria-label={`${spec.title} (${rowLabel})`}>
      {rows.map((row, j) => (
        <div key={j} className="filters" aria-label={`${spec.title} ${j + 1} (${rowLabel})`}>
          <EntryRowInputs
            columns={spec.columns}
            row={row}
            rowLabel={`${spec.title} ${j + 1} (${rowLabel})`}
            invalid={invalid}
            describedBy={describedBy}
            onChange={(next) => onChange(rows.map((r, k) => (k === j ? next : r)))}
          />
          <div className="filters__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onChange(rows.filter((_, k) => k !== j))}
              aria-label={`Remove ${spec.title.toLowerCase().replace(/s$/, "")} ${j + 1} (${rowLabel})`}
            >
              <Icon name={ACTION_ICON.delete} />
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="filters__actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            if (!atMax) onChange([...rows, { ...spec.emptyRow }]);
          }}
          disabled={atMax}
        >
          <Icon name={ACTION_ICON.add} />
          {spec.addLabel}
        </button>
      </div>
    </div>
  );
}

/** The nested rows of an entries cell, defensively. */
function childEntries(value: unknown): EntryRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is EntryRow => typeof r === "object" && r !== null && !Array.isArray(r),
  );
}
