"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { VacancyBand } from "@badabhai/types";
import type { CreateJobPostingBody } from "@/lib/api";
import { createJobPostingAction } from "../actions";
import {
  OPS_ACTOR_ID,
  VACANCY_BAND_OPTIONS,
  DEFAULT_VACANCY_BAND,
  descriptionLooksLikePii,
  DESCRIPTION_PII_MESSAGE,
  FREE_TEXT_PII_WARNING,
} from "@/lib/job-postings";

/**
 * Create-posting form. New postings are always created as `draft` (the server
 * hard-codes status; we never send one). `created_by` is the stub ops-actor id
 * (no ops auth in alpha) — the operator never sees or types a uuid.
 */
export function PostingCreateForm() {
  const router = useRouter();
  const [orgLabel, setOrgLabel] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [description, setDescription] = useState("");
  const [vacancyBand, setVacancyBand] = useState<VacancyBand>(DEFAULT_VACANCY_BAND);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side mirror of the server's DESCRIPTION-ONLY PII reject. Applied to
    // `description` only — NOT to org/role/location (legit machine model numbers
    // / pincodes / job codes can be long digit runs there).
    if (description.trim() && descriptionLooksLikePii(description)) {
      setError(DESCRIPTION_PII_MESSAGE);
      return;
    }

    const body: CreateJobPostingBody = {
      created_by: OPS_ACTOR_ID,
      org_label: orgLabel.trim(),
      role_title: roleTitle.trim(),
      vacancy_band: vacancyBand,
    };
    const location = locationLabel.trim();
    if (location) body.location_label = location;
    const desc = description.trim();
    if (desc) body.description = desc;

    setSubmitting(true);
    // Through a Server Action, NOT a browser fetch: `POST /job-postings` is behind
    // the API's InternalServiceGuard and the shared token is a server secret, so a
    // call made from this component would arrive unauthenticated and 401.
    const result = await createJobPostingAction(body);
    if (result.ok) {
      router.push(`/ops/job-postings/${result.posting.id}`);
      return;
    }
    // Surface the server's own message (e.g. its 422 description reject, or a
    // validation error) verbatim.
    setError(result.error);
    setSubmitting(false);
  }

  return (
    <form className="form" onSubmit={onSubmit}>
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

      {error ? <p className="error-text">{error}</p> : null}

      <div className="btn-row">
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create draft"}
        </button>
      </div>
    </form>
  );
}
