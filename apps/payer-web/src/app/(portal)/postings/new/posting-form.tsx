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
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await createPostingAction({
        roleTitle,
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
          onChange={(e) => setRoleTitle(e.target.value)}
        />
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
          onChange={(e) => setVacancyBand(e.target.value)}
        >
          {VACANCY_BANDS.map((b) => (
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
