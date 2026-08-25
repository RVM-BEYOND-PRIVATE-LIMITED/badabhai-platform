"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import { Button, Input, Select, Textarea } from "../../../../../components/ds";
import { NEEDED_BY, SHIFTS } from "../../../../../lib/contracts";
import { neededByLabel, shiftLabel } from "../../../../../lib/agency-view";
import { updatePostingAction } from "./actions";

/**
 * Client form for EDITING a posting (EMPLOYER self-serve; LIVE
 * `PATCH /payer/job-postings/:id`). Fields are EXACTLY the PATCHable set the backend
 * `UpdateJobPostingSchema` accepts: role_title / vacancies / location_label? /
 * description? PLUS the worker-visible display fields the UPDATE schema is WIDER on than
 * create — city / pay_min / pay_max / shift / needed_by (migration 0054). This is the
 * ONLY self-serve place a payer edits those (create cannot take them). There is NO
 * trade/experience field here — the PATCH schema accepts neither, so they are never
 * invented. Runs in the BROWSER and sees NO secret; the session payer is stamped
 * server-side (XB-A). The inline validation is UX parity — `updatePostingInputSchema` in
 * the action stays the authority; pay rides straight through, never computed or defaulted.
 */

const PAY_MAX_INR = 10_000_000; // ₹/month sanity ceiling — parity with contracts.ts

/** Parse an optional non-negative integer field; "" → undefined; bad → NaN (caught in validate). */
function optInt(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

/** Seed a closed-enum <select> from a raw wire string, blank when it is null/off-enum. */
function seedEnum<T extends string>(value: string | null, allowed: readonly T[]): string {
  return value !== null && (allowed as readonly string[]).includes(value) ? value : "";
}

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
    city: string | null;
    payMin: number | null;
    payMax: number | null;
    /** Raw wire strings — only seed the <select> when they match the closed enum. */
    shift: string | null;
    neededBy: string | null;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // useState order (mirrored positionally by edit-posting-form.test.tsx): roleTitle,
  // locationLabel, vacancies, description, error — then the fields added for the wider
  // UPDATE schema. New hooks stay AFTER `error` so that test's positional seeding of the
  // first five keeps working unchanged.
  const [roleTitle, setRoleTitle] = useState(initial.roleTitle);
  const [locationLabel, setLocationLabel] = useState(initial.locationLabel ?? "");
  const [vacancies, setVacancies] = useState(String(initial.vacanciesHint));
  const [description, setDescription] = useState(initial.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [city, setCity] = useState(initial.city ?? "");
  const [payMin, setPayMin] = useState(initial.payMin !== null ? String(initial.payMin) : "");
  const [payMax, setPayMax] = useState(initial.payMax !== null ? String(initial.payMax) : "");
  const [shift, setShift] = useState(seedEnum(initial.shift, SHIFTS));
  const [neededBy, setNeededBy] = useState(seedEnum(initial.neededBy, NEEDED_BY));

  function validate(): string | null {
    if ([...roleTitle.trim()].length < 2) return "Role title must be at least 2 characters.";
    const count = Number(vacancies);
    if (!Number.isInteger(count) || count <= 0) return "Vacancies must be a positive number.";
    if (description.trim() !== "" && looksLikePii(description)) {
      return "Remove contact details (phone/email) from the description.";
    }
    // Pay: whole, non-negative, within the C10 ceiling, and ordered (parity with the server Zod).
    const min = optInt(payMin);
    const max = optInt(payMax);
    if (Number.isNaN(min) || (min !== undefined && min > PAY_MAX_INR)) {
      return "Min pay must be a whole number within the allowed range.";
    }
    if (Number.isNaN(max) || (max !== undefined && max > PAY_MAX_INR)) {
      return "Max pay must be a whole number within the allowed range.";
    }
    if (min !== undefined && max !== undefined && max < min) {
      return "Max pay must be greater than or equal to min pay.";
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
        // Blank → undefined (kept server-side, never sent as ""/0). Pay is passed straight
        // through from form state — the client never computes or defaults a price.
        city: city.trim() === "" ? undefined : city.trim(),
        payMin: optInt(payMin),
        payMax: optInt(payMax),
        shift: shift === "" ? undefined : shift,
        neededBy: neededBy === "" ? undefined : neededBy,
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
            <Input
              label="City (optional)"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              hint="A coarse city bucket workers filter on. Leaving this blank keeps the current value."
            />
          </div>

          <div className="form__section">
            <p className="form__legend">Pay and timing</p>
            <div className="form-grid">
              <Input
                label="Pay — min (₹ / month)"
                type="number"
                min={0}
                inputMode="numeric"
                value={payMin}
                onChange={(e) => setPayMin(e.target.value)}
                hint="Optional. Leaving this blank keeps the current value."
              />
              <Input
                label="Pay — max (₹ / month)"
                type="number"
                min={0}
                inputMode="numeric"
                value={payMax}
                onChange={(e) => setPayMax(e.target.value)}
                hint="Optional. Leaving this blank keeps the current value."
              />
            </div>
            <div className="form-grid">
              <Select
                label="Shift"
                optional
                value={shift}
                onChange={(e) => setShift(e.target.value)}
              >
                <option value="">— keep current —</option>
                {SHIFTS.map((s) => (
                  <option key={s} value={s}>
                    {shiftLabel(s)}
                  </option>
                ))}
              </Select>
              <Select
                label="Needed by"
                optional
                value={neededBy}
                onChange={(e) => setNeededBy(e.target.value)}
              >
                <option value="">— keep current —</option>
                {NEEDED_BY.map((n) => (
                  <option key={n} value={n}>
                    {neededByLabel(n)}
                  </option>
                ))}
              </Select>
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
