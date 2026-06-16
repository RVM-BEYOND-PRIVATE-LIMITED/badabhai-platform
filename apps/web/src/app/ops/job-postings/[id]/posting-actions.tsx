"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { VacancyBand } from "@badabhai/types";
import {
  updateJobPosting,
  closeJobPosting,
  type JobPostingRow,
  type UpdateJobPostingBody,
} from "@/lib/api";
import {
  VACANCY_BAND_OPTIONS,
  descriptionLooksLikePii,
  DESCRIPTION_PII_MESSAGE,
  FREE_TEXT_PII_WARNING,
} from "@/lib/job-postings";

/**
 * Edit / Publish / Close controls for one posting.
 *
 * Lifecycle (ADR-0012):
 *   - draft: editable; can Publish (draft -> open); can Close.
 *   - open:  editable; can Close.
 *   - closed: TERMINAL — read-only, no controls rendered at all.
 *
 * Mutations call the API from the browser, then `router.refresh()` re-runs the
 * server component so the page reflects the new state.
 */
export function PostingActions({ posting }: { posting: JobPostingRow }) {
  const router = useRouter();

  const [orgLabel, setOrgLabel] = useState(posting.orgLabel);
  const [roleTitle, setRoleTitle] = useState(posting.roleTitle);
  const [locationLabel, setLocationLabel] = useState(posting.locationLabel ?? "");
  const [description, setDescription] = useState(posting.description ?? "");
  const [vacancyBand, setVacancyBand] = useState<VacancyBand>(posting.vacancyBand);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Closed postings are read-only: render nothing actionable.
  if (posting.status === "closed") {
    return (
      <p className="page-sub">
        This posting is <strong>closed</strong> and read-only.
      </p>
    );
  }

  async function onSaveEdits(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    // Description-only PII mirror (NOT applied to org/role/location).
    if (description.trim() && descriptionLooksLikePii(description)) {
      setError(DESCRIPTION_PII_MESSAGE);
      return;
    }

    // Only send fields that actually changed; the server rejects a no-op edit.
    const body: UpdateJobPostingBody = {};
    if (orgLabel.trim() !== posting.orgLabel) body.org_label = orgLabel.trim();
    if (roleTitle.trim() !== posting.roleTitle) body.role_title = roleTitle.trim();
    if (locationLabel.trim() !== (posting.locationLabel ?? "")) {
      body.location_label = locationLabel.trim();
    }
    if (description.trim() !== (posting.description ?? "")) {
      body.description = description.trim();
    }
    if (vacancyBand !== posting.vacancyBand) body.vacancy_band = vacancyBand;

    if (Object.keys(body).length === 0) {
      setNotice("No changes to save.");
      return;
    }

    await run(() => updateJobPosting(posting.id, body), "Changes saved.");
  }

  async function onPublish() {
    setError(null);
    setNotice(null);
    await run(() => updateJobPosting(posting.id, { status: "open" }), "Posting published.");
  }

  async function onClose() {
    setError(null);
    setNotice(null);
    if (!window.confirm("Close this posting? Closed postings are read-only and cannot be reopened.")) {
      return;
    }
    await run(() => closeJobPosting(posting.id), "Posting closed.");
  }

  async function run(action: () => Promise<JobPostingRow>, ok: string) {
    setBusy(true);
    try {
      await action();
      setNotice(ok);
      // Re-fetch the server component so status/timestamps/fields refresh.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        {posting.status === "draft" ? (
          <button className="btn" type="button" onClick={onPublish} disabled={busy}>
            Publish (draft → open)
          </button>
        ) : null}
        <button className="btn btn-danger" type="button" onClick={onClose} disabled={busy}>
          Close posting
        </button>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {notice ? <p className="page-sub">{notice}</p> : null}

      <h3 style={{ marginTop: 24 }}>Edit fields</h3>
      <form className="form" onSubmit={onSaveEdits}>
        <p className="note">{FREE_TEXT_PII_WARNING}</p>

        <div className="field">
          <label htmlFor="org_label">
            Org<span className="req">*</span>
          </label>
          <input
            id="org_label"
            className="input"
            required
            maxLength={200}
            value={orgLabel}
            onChange={(e) => setOrgLabel(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="role_title">
            Role<span className="req">*</span>
          </label>
          <input
            id="role_title"
            className="input"
            required
            maxLength={200}
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="location_label">Location</label>
          <input
            id="location_label"
            className="input"
            maxLength={200}
            value={locationLabel}
            onChange={(e) => setLocationLabel(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="vacancy_band">Vacancy band</label>
          <select
            id="vacancy_band"
            className="select"
            value={vacancyBand}
            onChange={(e) => setVacancyBand(e.target.value as VacancyBand)}
          >
            {VACANCY_BAND_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            className="textarea"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </>
  );
}
