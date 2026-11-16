"use client";

import { useRef, useState, useTransition } from "react";
import {
  Button,
  Checkbox,
  InlineNotice,
  Input,
  Select,
  Textarea,
} from "../../../../components/ds";
import { usePortalNavigation } from "../../../../components/portal-navigation";
import { campusDriveErrorCopy, missingStepLabel } from "../../../../lib/campus-drive-messages";
import type {
  AudienceBranchOption,
  PostingSummary,
} from "../../../../lib/contracts";
import { createCampusDriveAction, type CreateCampusDriveResult } from "../actions";

/**
 * #2813 — the campus-drive create form.
 *
 * ONE Idempotency-Key PER FORM SUBMISSION, not per retry: the key is minted on the first submit
 * and kept in a ref until a request actually succeeds (then the page navigates away). Pressing
 * Submit again after a timeout therefore replays the same request instead of creating a second.
 *
 * A `403 company_not_verified` lists the missing steps; a 400 `roles_note_has_identifier` says how
 * to fix the note; a 409 `idempotency_key_reused` says the key was already used for other details.
 * The server decides; this form only displays.
 */
export function CampusDriveForm({
  postings,
  branches,
  minDate,
  maxDate,
}: {
  postings: PostingSummary[];
  branches: AudienceBranchOption[];
  minDate: string;
  maxDate: string;
}) {
  const [jobPostingId, setJobPostingId] = useState("");
  const [branchIds, setBranchIds] = useState<number[]>([]);
  const [preferredFrom, setPreferredFrom] = useState("");
  const [preferredTo, setPreferredTo] = useState("");
  const [openings, setOpenings] = useState("1");
  const [rolesNote, setRolesNote] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [error, setError] = useState<CreateCampusDriveResult | null>(null);
  const [pending, startTransition] = useTransition();
  const { navigate } = usePortalNavigation();
  // Minted once per submission; reused by every retry until one succeeds.
  const idempotencyKey = useRef<string | null>(null);

  const toggleBranch = (id: number) =>
    setBranchIds((prev) =>
      prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id],
    );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (idempotencyKey.current === null) idempotencyKey.current = crypto.randomUUID();
    const count = Number.parseInt(openings, 10);
    startTransition(async () => {
      const res = await createCampusDriveAction({
        jobPostingId: jobPostingId === "" ? undefined : jobPostingId,
        branchIds,
        preferredFrom,
        preferredTo,
        openings: Number.isFinite(count) ? count : 0,
        rolesNote: rolesNote.trim() === "" ? undefined : rolesNote,
        contactName,
        contactPhone,
        idempotencyKey: idempotencyKey.current!,
      });
      if (res.ok) {
        // A success means the key's job is done; the page navigates to the request.
        idempotencyKey.current = null;
        navigate(`/campus-drives/${res.request.id}`, {
          pendingLabel: "Campus drive request",
          refresh: true,
        });
      } else {
        setError(res);
      }
    });
  }

  const failure = error && !error.ok ? error : null;

  return (
    <form className="form" onSubmit={submit}>
      {failure ? (
        <InlineNotice tone="danger">
          <p>{campusDriveErrorCopy(failure)}</p>
          {failure.reason === "company_not_verified" && failure.missing?.length ? (
            <ul>
              {failure.missing.map((step) => (
                <li key={step}>{missingStepLabel(step)}</li>
              ))}
            </ul>
          ) : null}
        </InlineNotice>
      ) : null}

      <Select
        id="jobPostingId"
        label="Own posting (optional)"
        value={jobPostingId}
        hint="Context for the roles. Any audience is allowed; the drive is separate from the posting."
        onChange={(e) => setJobPostingId(e.target.value)}
      >
        <option value="">— no posting —</option>
        {postings.map((posting) => (
          <option key={posting.id} value={posting.id}>
            {posting.roleTitle}
          </option>
        ))}
      </Select>

      {branches.length > 0 ? (
        <div className="form__section">
          <p className="form__legend">Branches (optional)</p>
          <p className="mw-card__sub">Leave every box unticked to accept any branch.</p>
          <div className="trade-fields__chips">
            {branches.map((branch) => (
              <Checkbox
                key={branch.id}
                label={branch.label}
                checked={branchIds.includes(branch.id)}
                onChange={() => toggleBranch(branch.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="form-grid">
        <Input
          id="preferredFrom"
          label="Preferred from"
          type="date"
          required
          min={minDate}
          max={maxDate}
          value={preferredFrom}
          onChange={(e) => setPreferredFrom(e.target.value)}
        />
        <Input
          id="preferredTo"
          label="Preferred to"
          type="date"
          required
          min={minDate}
          max={maxDate}
          value={preferredTo}
          onChange={(e) => setPreferredTo(e.target.value)}
        />
      </div>

      <Input
        id="openings"
        label="Openings"
        inputMode="numeric"
        required
        min={1}
        max={1000}
        value={openings}
        onChange={(e) => setOpenings(e.target.value)}
      />

      <Textarea
        id="rolesNote"
        label="Roles note (optional)"
        hint="No phone numbers or emails here — put the contact person in the fields below. Write ranges in words, e.g. “15,000 to 18,000”."
        value={rolesNote}
        onChange={(e) => setRolesNote(e.target.value)}
        rows={4}
        maxLength={1000}
      />

      <Input
        id="contactName"
        label="Contact name"
        required
        maxLength={120}
        value={contactName}
        onChange={(e) => setContactName(e.target.value)}
        hint="The person RVM's placement team calls."
      />
      <Input
        id="contactPhone"
        label="Contact phone"
        type="tel"
        required
        placeholder="+919876543210"
        value={contactPhone}
        onChange={(e) => setContactPhone(e.target.value)}
        hint="E.164 format, e.g. +919876543210."
      />

      <div className="posting-layout__end">
        <Button type="submit" loading={pending} iconRight="rocket-launch">
          {pending ? "Sending request…" : "Send request"}
        </Button>
      </div>
    </form>
  );
}
