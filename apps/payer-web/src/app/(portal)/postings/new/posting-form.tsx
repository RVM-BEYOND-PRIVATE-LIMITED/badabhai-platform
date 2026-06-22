"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { VACANCY_BANDS } from "../../../../lib/contracts";
import { createPostingAction } from "./actions";

/** Client form for posting a job. Free-through-launch copy comes from the server page. */
export function PostingForm() {
  const router = useRouter();
  const [roleTitle, setRoleTitle] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [description, setDescription] = useState("");
  const [vacancyBand, setVacancyBand] = useState<string>(VACANCY_BANDS[0]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ roleTitle?: string; vacancyBand?: string }>({});
  const [pending, startTransition] = useTransition();

  /** Client-side field validation (mirrors createPostingInputSchema; inline per-field). */
  function validate(): { roleTitle?: string; vacancyBand?: string } {
    const errs: { roleTitle?: string; vacancyBand?: string } = {};
    const trimmed = roleTitle.trim();
    if (trimmed.length < 2 || trimmed.length > 120) {
      errs.roleTitle = "Role title must be 2–120 characters.";
    }
    if (!VACANCY_BANDS.includes(vacancyBand as (typeof VACANCY_BANDS)[number])) {
      errs.vacancyBand = "Select a vacancy band.";
    }
    return errs;
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    startTransition(async () => {
      const res = await createPostingAction({
        roleTitle: roleTitle.trim(),
        locationLabel,
        description,
        vacancyBand,
      });
      if (res.ok) {
        router.push(`/postings/${res.postingId}/applicants`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="roleTitle">
          Role title<span className="req">*</span>
        </label>
        <input
          id="roleTitle"
          className="input"
          placeholder="CNC Machinist"
          value={roleTitle}
          aria-invalid={fieldErrors.roleTitle ? true : undefined}
          aria-describedby={fieldErrors.roleTitle ? "roleTitle-error" : undefined}
          onChange={(e) => {
            setRoleTitle(e.target.value);
            if (fieldErrors.roleTitle) setFieldErrors((p) => ({ ...p, roleTitle: undefined }));
          }}
        />
        {fieldErrors.roleTitle ? (
          <p className="error-text" id="roleTitle-error">
            {fieldErrors.roleTitle}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="locationLabel">Location</label>
        <input
          id="locationLabel"
          className="input"
          placeholder="Pune, MH"
          value={locationLabel}
          onChange={(e) => setLocationLabel(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="vacancyBand">
          Vacancies<span className="req">*</span>
        </label>
        <select
          id="vacancyBand"
          className="input"
          value={vacancyBand}
          aria-invalid={fieldErrors.vacancyBand ? true : undefined}
          aria-describedby={fieldErrors.vacancyBand ? "vacancyBand-error" : undefined}
          onChange={(e) => {
            setVacancyBand(e.target.value);
            if (fieldErrors.vacancyBand) setFieldErrors((p) => ({ ...p, vacancyBand: undefined }));
          }}
        >
          {VACANCY_BANDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        {fieldErrors.vacancyBand ? (
          <p className="error-text" id="vacancyBand-error">
            {fieldErrors.vacancyBand}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          className="input"
          placeholder="Shift timings, machines, location notes…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="btn-row">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Posting…" : "Post job"}
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
    </form>
  );
}
