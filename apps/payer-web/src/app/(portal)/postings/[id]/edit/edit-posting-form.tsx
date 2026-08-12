"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import { Button, Input, Textarea } from "../../../../../components/ds";
import { updatePostingAction } from "./actions";

/**
 * Client form for EDITING a posting (EMPLOYER self-serve; LIVE
 * `PATCH /payer/job-postings/:id`). Fields are EXACTLY the PATCHable set the wire
 * carries (role_title / vacancies / location_label? / description?; see
 * `toPayerJobPostingPatchBody`) — no trade/pay/experience here because the PATCH
 * schema does not accept them (parity, never invented). Runs in the BROWSER and sees
 * NO secret; the session payer is stamped server-side (XB-A). The inline validation is
 * UX parity only — `updatePostingInputSchema` in the action stays the authority.
 */

export function EditPostingForm({
  postingId,
  initial,
}: {
  postingId: string;
  initial: {
    roleTitle: string;
    locationLabel: string | null;
    /** Band lower bound — the stored row keeps only the BAND; adjust if needed. */
    vacanciesHint: number;
    description: string | null;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [roleTitle, setRoleTitle] = useState(initial.roleTitle);
  const [locationLabel, setLocationLabel] = useState(initial.locationLabel ?? "");
  const [vacancies, setVacancies] = useState(String(initial.vacanciesHint));
  const [description, setDescription] = useState(initial.description ?? "");
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if ([...roleTitle.trim()].length < 2) return "Role title must be at least 2 characters.";
    const count = Number(vacancies);
    if (!Number.isInteger(count) || count <= 0) return "Vacancies must be a positive number.";
    if (description.trim() !== "" && looksLikePii(description)) {
      return "Remove contact details (phone/email) from the description.";
    }
    return null;
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const clientError = validate();
    if (clientError !== null) {
      setError(clientError);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await updatePostingAction({
        postingId,
        roleTitle: roleTitle.trim(),
        // OMIT the count when untouched: the stored row keeps only the BAND, and
        // re-submitting the prefill hint would make the backend re-derive (and for a
        // "25+" posting DOWNGRADE) the band on an unrelated edit.
        vacancies: vacancies === String(initial.vacanciesHint) ? undefined : Number(vacancies),
        locationLabel: locationLabel.trim() === "" ? undefined : locationLabel.trim(),
        description: description.trim() === "" ? undefined : description.trim(),
      });
      if (res.ok) {
        router.push(`/postings/${postingId}`);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <section className="panel">
      <div className="panel__body">
        <form onSubmit={onSubmit} noValidate>
          <div className="form__section">
            <p className="form__legend">The role</p>
            <Input
              label="Role title"
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              required
            />
            <div className="form-grid">
              <Input
                label="Location (optional)"
                value={locationLabel}
                onChange={(e) => setLocationLabel(e.target.value)}
                hint="Leaving this blank keeps the current value (clearing is not supported yet)."
              />
              <Input
                label="Vacancies"
                type="number"
                min={1}
                value={vacancies}
                onChange={(e) => setVacancies(e.target.value)}
                hint="Left unchanged, the stored vacancy band is kept as-is; a new count re-derives the band server-side."
                required
              />
            </div>
          </div>

          <div className="form__section">
            <p className="form__legend">Description</p>
            <Textarea
              label="Description (optional — no phone/email)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              hint="Leaving this blank keeps the current description (clearing is not supported yet)."
            />
          </div>

          {/* Announceable, retryable error region — the form never blanks on failure.
              The aria-live node is the INNER div and is always in the tree: `.form-status`
              carries the layout but must never be the live region itself, because its
              `:empty { display: none }` rule would drop the region out of the
              accessibility tree while idle and the first error would go unannounced. */}
          <div className="form-status">
            <div aria-live="polite">
              {error !== null ? (
                <div className="alert alert--danger">
                  <i className="ph ph-warning-circle alert__icon" aria-hidden="true" />
                  <div className="alert__text">
                    <p className="alert__title">Your changes were not saved</p>
                    <p className="alert__body">{error}</p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="form-actions">
            <Button type="submit" loading={pending} disabled={pending}>
              Save changes
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
