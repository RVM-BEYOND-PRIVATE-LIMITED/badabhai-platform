"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../../../components/dialog";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { FieldError } from "../../../components/form-feedback";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import type { CandidateDetail } from "../../../lib/candidate-detail";
import { postCandidateCorrection } from "../../../lib/candidate-edit-client";
import {
  CORRECTION_REASON_CATEGORIES,
  editChanges,
  editSection,
  initialEditDraft,
  isStructuredEditKind,
  validateEditDraft,
  type CorrectionReasonCode,
  type EditDraft,
  type EditSectionId,
} from "../../../lib/candidate-edit-model";
import { REASON_MIN_CHARS, reasonLongEnough } from "../../../lib/confirm-tiers";
import { StructuredFieldEditor } from "./candidate-structured-editors";

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
  // #2728 — a structured section exists only when the API sent the gated correction-prefill
  // block. An older API (or a role without `edit_candidates`) simply gets the simple fields.
  const sectionFields = section.fields.filter(
    (field) => !isStructuredEditKind(field.kind) || detail.correction_values !== null,
  );
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
          {sectionFields.map((field) =>
            isStructuredEditKind(field.kind) ? (
              <div className="field" key={field.formKey}>
                <span className="field__label">{field.label}</span>
                <StructuredFieldEditor
                  field={field}
                  value={draft[field.formKey] ?? ""}
                  detail={detail}
                  onChange={(value) => set(field.formKey, value)}
                />
                {field.help ? <span className="field__help">{field.help}</span> : null}
                <FieldError id={`${id}-${field.formKey}-error`}>{errors[field.formKey]}</FieldError>
              </div>
            ) : (
              <label className="field" key={field.formKey}>
                <span className="field__label">{field.label}</span>
                {field.kind === "select" || field.kind === "tri" ? (
                  <select
                    className="field__input"
                    value={draft[field.formKey] ?? ""}
                    onChange={(e) => set(field.formKey, e.target.value)}
                    aria-invalid={errors[field.formKey] ? true : undefined}
                    aria-describedby={
                      errors[field.formKey] ? `${id}-${field.formKey}-error` : undefined
                    }
                  >
                    <option value="">
                      {field.kind === "tri" ? "Not answered" : "Not answered / clear"}
                    </option>
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
                    inputMode={
                      field.kind === "number" || field.kind === "int" ? "decimal" : undefined
                    }
                    min={field.formKey === "experience" ? 0 : field.kind === "int" ? 0 : undefined}
                    max={field.formKey === "experience" ? 60 : undefined}
                    value={draft[field.formKey] ?? ""}
                    onChange={(e) => set(field.formKey, e.target.value)}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={errors[field.formKey] ? true : undefined}
                    aria-describedby={
                      errors[field.formKey] ? `${id}-${field.formKey}-error` : undefined
                    }
                  />
                )}
                {field.help ? <span className="field__help">{field.help}</span> : null}
                <FieldError id={`${id}-${field.formKey}-error`}>{errors[field.formKey]}</FieldError>
              </label>
            ),
          )}
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
