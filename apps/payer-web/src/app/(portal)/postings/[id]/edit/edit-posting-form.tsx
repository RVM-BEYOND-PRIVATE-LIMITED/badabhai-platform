"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import { Button, Card, Input, Textarea } from "../../../../../components/ds";
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
        vacancies: Number(vacancies),
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
    <Card padding="md" className="posting-card">
      <form onSubmit={onSubmit} noValidate>
        <Input
          label="Role title"
          value={roleTitle}
          onChange={(e) => setRoleTitle(e.target.value)}
          required
        />
        <Input
          label="Location (optional)"
          value={locationLabel}
          onChange={(e) => setLocationLabel(e.target.value)}
        />
        <Input
          label="Vacancies"
          type="number"
          min={1}
          value={vacancies}
          onChange={(e) => setVacancies(e.target.value)}
          hint="The stored posting keeps a vacancy BAND — this count re-derives it server-side."
          required
        />
        <Textarea
          label="Description (optional — no phone/email)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
        />
        {/* Announceable, retryable error region — the form never blanks on failure. */}
        <div aria-live="polite">{error !== null && <p className="posting-card__soon">{error}</p>}</div>
        <Button type="submit" loading={pending} disabled={pending}>
          Save changes
        </Button>
      </form>
    </Card>
  );
}
