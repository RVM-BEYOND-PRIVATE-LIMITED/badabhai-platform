"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Drawer } from "../../../components/drawer";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { OneTimeSecret } from "../../../components/one-time-secret";
import { FieldError } from "../../../components/form-feedback";
import {
  AdminActionResultBanner,
  timelineLink,
} from "../../../components/admin-action-result-banner";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import { customerHref } from "../../../lib/customer";
import { createCompanyAction, type CreateCompanySuccess } from "./actions";
import {
  COMPANY_AGENCY_TYPES,
  COMPANY_AGENCY_TYPE_LABELS,
  COMPANY_KINDS,
  COMPANY_KIND_LABELS,
  COMPANY_REASON_CATEGORIES,
  COMPANY_SIZE_BANDS,
  COMPANY_VERIFICATION_STATUSES,
  type CompanyAgencyType,
  type CompanyKind,
  type CompanyProfilePayload,
  type CompanySizeBand,
  type CompanyVerificationStatus,
} from "../../../lib/company-vocabulary";

interface Draft {
  kind: CompanyKind;
  orgName: string;
  email: string;
  phone: string;
  gst: string;
  website: string;
  address: string;
  contactPerson: string;
  verification: string;
  industry: string;
  companySize: string;
  hiringLocations: string;
  agencyType: string;
  operatingCities: string;
  recruiterCount: string;
}

const EMPTY: Draft = {
  kind: "employer",
  orgName: "",
  email: "",
  phone: "",
  gst: "",
  website: "",
  address: "",
  contactPerson: "",
  verification: "pending",
  industry: "",
  companySize: "",
  hiringLocations: "",
  agencyType: "",
  operatingCities: "",
  recruiterCount: "",
};

const cities = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * "Add company" (A9, #2579): create a company or agency AND its first login, in one drawer.
 *
 * The drawer collects the record; "Review and create" opens the T2 confirmation with the new
 * record as a before/after diff and the required reason. On success the server's one-time
 * temporary password is shown ONCE, with a copy button and an acknowledgement before the drawer
 * can close — exactly the credential contract #2578 established.
 */
export function AddCompany({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [created, setCreated] = useState<CreateCompanySuccess | null>(null);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [shared, setShared] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ids = useId();

  if (!canCreate) return null;

  const emailValid = draft.email === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email);
  const phoneValid = draft.phone === "" || /^\+[1-9][0-9]{7,14}$/.test(draft.phone);
  const hasLogin = draft.email !== "" || draft.phone !== "";
  const nameValid = draft.orgName.trim().length > 0;
  const ready = nameValid && hasLogin && emailValid && phoneValid;

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  function close() {
    if (created && !shared) return;
    setOpen(false);
    setDraft(EMPTY);
    setCreated(null);
    setOutcome(null);
    setShared(false);
    setSubmitAttempted(false);
    if (triggerRef.current) triggerRef.current.focus();
  }

  function profileOfDraft(): Omit<CompanyProfilePayload, "org_name"> {
    const profile: Omit<CompanyProfilePayload, "org_name"> = {};
    if (draft.gst.trim()) profile.gst_number = draft.gst.trim().toUpperCase();
    if (draft.website.trim()) profile.website = draft.website.trim();
    if (draft.address.trim()) profile.address = draft.address.trim();
    if (draft.contactPerson.trim()) profile.contact_person = draft.contactPerson.trim();
    if (draft.verification)
      profile.verification_status = draft.verification as CompanyVerificationStatus;
    if (draft.kind === "employer") {
      if (draft.industry.trim()) profile.industry = draft.industry.trim();
      if (draft.companySize) profile.company_size = draft.companySize as CompanySizeBand;
      if (cities(draft.hiringLocations).length > 0)
        profile.hiring_locations = cities(draft.hiringLocations);
    } else {
      if (draft.agencyType) profile.agency_type = draft.agencyType as CompanyAgencyType;
      if (cities(draft.operatingCities).length > 0)
        profile.operating_cities = cities(draft.operatingCities);
      if (draft.recruiterCount.trim()) profile.recruiter_count = Number(draft.recruiterCount);
    }
    return profile;
  }

  async function create(reason: { category: string; text: string }): Promise<AdminActionOutcome> {
    const result = await createCompanyAction({
      kind: draft.kind,
      orgName: draft.orgName.trim(),
      email: draft.email.trim() || undefined,
      phone: draft.phone.trim() || undefined,
      reasonCode: reason.category as never,
      reasonText: reason.text,
      profile: profileOfDraft(),
    });
    if (result.ok) {
      setCreated(result);
      setOutcome(result);
      router.refresh();
    }
    return result;
  }

  const noun = COMPANY_KIND_LABELS[draft.kind].toLowerCase();

  return (
    <>
      <button
        ref={triggerRef}
        className="btn btn--primary"
        type="button"
        onClick={() => setOpen(true)}
      >
        <Icon name={ACTION_ICON.add} />
        Add company
      </button>

      <Drawer
        open={open}
        onClose={close}
        title={created ? "Company created" : "Add a company"}
        description={
          created
            ? "The company and its first login exist. The temporary password below is shown once."
            : "Create the organisation record and its first login together."
        }
        footer={
          created ? (
            <button className="btn btn--primary" type="button" onClick={close} disabled={!shared}>
              Done
            </button>
          ) : (
            <>
              <button className="btn btn--ghost" type="button" onClick={close}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => {
                  setSubmitAttempted(true);
                  if (ready) setConfirmOpen(true);
                }}
                disabled={submitAttempted && !ready}
              >
                <Icon name={ACTION_ICON.approve} />
                Review and create
              </button>
            </>
          )
        }
      >
        {created ? (
          <>
            {outcome ? (
              <AdminActionResultBanner
                outcome={outcome}
                eventsLink={timelineLink(`${customerHref(created.companyId)}/timeline`)}
              />
            ) : null}
            <OneTimeSecret
              title="First login — temporary password"
              body={
                <>
                  Login <strong className="mono">{created.loginId}</strong> must change this
                  password at first sign-in. It cannot be shown again.
                </>
              }
              value={created.temporaryPassword ?? ""}
              inputLabel={`Temporary password for ${created.loginId}`}
              copyLabel="Copy password"
              mono
            />
            <label className="field field--check">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              <span className="field__label">
                I have shared this password securely with the company
              </span>
            </label>
          </>
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitAttempted(true);
              if (ready) setConfirmOpen(true);
            }}
            noValidate
          >
            <label className="field" htmlFor={`${ids}-kind`}>
              <span className="field__label">
                Kind<span className="req">*</span>
              </span>
              <select
                id={`${ids}-kind`}
                className="field__input"
                value={draft.kind}
                onChange={(e) => set({ kind: e.target.value as CompanyKind })}
              >
                {COMPANY_KINDS.map((kindValue) => (
                  <option key={kindValue} value={kindValue}>
                    {COMPANY_KIND_LABELS[kindValue]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field" htmlFor={`${ids}-name`}>
              <span className="field__label">
                Registered name<span className="req">*</span>
              </span>
              <input
                id={`${ids}-name`}
                className="field__input"
                value={draft.orgName}
                onChange={(e) => set({ orgName: e.target.value })}
                autoComplete="organization"
                aria-invalid={submitAttempted && !nameValid ? true : undefined}
              />
              <FieldError>
                {submitAttempted && !nameValid ? "Enter the company's registered name." : null}
              </FieldError>
            </label>

            <div className="form-grid">
              <label className="field" htmlFor={`${ids}-email`}>
                <span className="field__label">Login email</span>
                <input
                  id={`${ids}-email`}
                  className="field__input"
                  type="email"
                  autoComplete="off"
                  value={draft.email}
                  onChange={(e) => set({ email: e.target.value })}
                  aria-invalid={!emailValid ? true : undefined}
                />
                <FieldError>{!emailValid ? "Enter a valid email address." : null}</FieldError>
              </label>
              <label className="field" htmlFor={`${ids}-phone`}>
                <span className="field__label">Login phone</span>
                <input
                  id={`${ids}-phone`}
                  className="field__input mono"
                  type="tel"
                  autoComplete="off"
                  value={draft.phone}
                  onChange={(e) => set({ phone: e.target.value })}
                  placeholder="e.g. +919876543210"
                  aria-invalid={!phoneValid ? true : undefined}
                />
                <FieldError>
                  {!phoneValid ? "Use an E.164 phone number, for example +919876543210." : null}
                </FieldError>
              </label>
            </div>
            {submitAttempted && !hasLogin ? (
              <p className="field__help">Enter an email or a phone number for the first login.</p>
            ) : null}

            <div className="form-grid">
              <label className="field" htmlFor={`${ids}-gst`}>
                <span className="field__label">GSTIN</span>
                <input
                  id={`${ids}-gst`}
                  className="field__input mono"
                  value={draft.gst}
                  onChange={(e) => set({ gst: e.target.value.toUpperCase() })}
                  placeholder="e.g. 27AAPFU0939F1ZV"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field" htmlFor={`${ids}-website`}>
                <span className="field__label">Website</span>
                <input
                  id={`${ids}-website`}
                  className="field__input"
                  value={draft.website}
                  onChange={(e) => set({ website: e.target.value })}
                  placeholder="e.g. https://acme.example"
                  autoComplete="off"
                />
              </label>
            </div>

            <label className="field" htmlFor={`${ids}-address`}>
              <span className="field__label">Address</span>
              <textarea
                id={`${ids}-address`}
                className="field__input"
                rows={2}
                value={draft.address}
                onChange={(e) => set({ address: e.target.value })}
                autoComplete="street-address"
              />
            </label>

            <label className="field" htmlFor={`${ids}-contact`}>
              <span className="field__label">Contact person</span>
              <input
                id={`${ids}-contact`}
                className="field__input"
                value={draft.contactPerson}
                onChange={(e) => set({ contactPerson: e.target.value })}
                autoComplete="name"
              />
            </label>

            {draft.kind === "employer" ? (
              <div className="form-grid">
                <label className="field" htmlFor={`${ids}-industry`}>
                  <span className="field__label">Industry</span>
                  <input
                    id={`${ids}-industry`}
                    className="field__input"
                    value={draft.industry}
                    onChange={(e) => set({ industry: e.target.value })}
                    placeholder="e.g. Fabrication"
                  />
                </label>
                <label className="field" htmlFor={`${ids}-size`}>
                  <span className="field__label">Company size</span>
                  <select
                    id={`${ids}-size`}
                    className="field__input"
                    value={draft.companySize}
                    onChange={(e) => set({ companySize: e.target.value })}
                  >
                    <option value="">Not set</option>
                    {COMPANY_SIZE_BANDS.map((band) => (
                      <option key={band} value={band}>
                        {band}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <div className="form-grid">
                <label className="field" htmlFor={`${ids}-agency-type`}>
                  <span className="field__label">Agency type</span>
                  <select
                    id={`${ids}-agency-type`}
                    className="field__input"
                    value={draft.agencyType}
                    onChange={(e) => set({ agencyType: e.target.value })}
                  >
                    <option value="">Not set</option>
                    {COMPANY_AGENCY_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {COMPANY_AGENCY_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" htmlFor={`${ids}-recruiters`}>
                  <span className="field__label">Recruiters</span>
                  <input
                    id={`${ids}-recruiters`}
                    className="field__input"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={draft.recruiterCount}
                    onChange={(e) => set({ recruiterCount: e.target.value })}
                  />
                </label>
              </div>
            )}

            <label className="field" htmlFor={`${ids}-cities`}>
              <span className="field__label">
                {draft.kind === "employer" ? "Hiring locations" : "Operating cities"}
              </span>
              <input
                id={`${ids}-cities`}
                className="field__input"
                value={draft.kind === "employer" ? draft.hiringLocations : draft.operatingCities}
                onChange={(e) =>
                  draft.kind === "employer"
                    ? set({ hiringLocations: e.target.value })
                    : set({ operatingCities: e.target.value })
                }
                placeholder="e.g. Pune, Nashik"
                autoComplete="off"
              />
              <span className="field__help">Comma-separated cities.</span>
            </label>

            <label className="field" htmlFor={`${ids}-verification`}>
              <span className="field__label">Verification</span>
              <select
                id={`${ids}-verification`}
                className="field__input"
                value={draft.verification}
                onChange={(e) => set({ verification: e.target.value })}
              >
                {COMPANY_VERIFICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </form>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        tier="consequential"
        title={`Create this ${noun}?`}
        description="The company record and its first login are created in one transaction. The temporary password is shown once afterwards."
        changes={[
          { label: "Kind", before: "—", after: COMPANY_KIND_LABELS[draft.kind] },
          { label: "Registered name", before: "—", after: draft.orgName.trim() || "not set" },
          {
            label: "First login",
            before: "—",
            after: draft.email.trim() || draft.phone.trim() || "not set",
          },
          { label: "Verification", before: "—", after: draft.verification },
        ]}
        categories={COMPANY_REASON_CATEGORIES}
        confirmLabel="Create company"
        onConfirm={create}
        onSettled={(result) => {
          if (result.ok) setConfirmOpen(false);
        }}
      />
    </>
  );
}
