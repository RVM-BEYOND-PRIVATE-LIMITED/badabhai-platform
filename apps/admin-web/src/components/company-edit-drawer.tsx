"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "./drawer";
import { ConfirmDialog, type ConfirmChange } from "./confirm-dialog";
import { FieldError } from "./form-feedback";
import { successToast, timelineLink } from "./admin-action-result-banner";
import { useToast } from "./toast";
import type { CompanyDetail } from "../lib/companies";
import {
  COMPANY_AGENCY_TYPES,
  COMPANY_AGENCY_TYPE_LABELS,
  COMPANY_KIND_LABELS,
  COMPANY_REASON_CATEGORIES,
  COMPANY_SIZE_BANDS,
  COMPANY_VERIFICATION_STATUSES,
  type CompanyAgencyType,
  type CompanyChangesPayload,
  type CompanySizeBand,
  type CompanyVerificationStatus,
} from "../lib/company-vocabulary";
import { displayName } from "../lib/identity";
import { updateCompanyAction } from "../app/(portal)/companies/actions";
import type { AdminActionOutcome } from "../lib/admin-action-result";

interface Draft {
  orgName: string;
  gst: string;
  address: string;
  website: string;
  phone: string;
  email: string;
  contactPerson: string;
  verification: string;
  industry: string;
  companySize: string;
  hiringLocations: string;
  agencyType: string;
  operatingCities: string;
  recruiterCount: string;
}

const asText = (value: string | null | undefined) => value ?? "";
const cityText = (values: string[]) => values.join(", ");
const cities = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The Edit drawer for a company record (A9, #2579; API #2564 PATCH).
 *
 * Only CHANGED fields are sent. The review step is a T2 confirmation: a field-by-field diff and a
 * required reason, which the API commits to `audit_logs` with one `admin.action_performed`.
 * Contact fields are only offered when the API disclosed them — an undisclosed value is not
 * replaced with an empty string.
 */
export function CompanyEditDrawer({
  company,
  open,
  onClose,
  mayReadIdentity,
  timelineHref,
}: {
  company: CompanyDetail;
  open: boolean;
  onClose: () => void;
  mayReadIdentity: boolean;
  timelineHref: string | null;
}) {
  const router = useRouter();
  const { show } = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(company));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [attempted, setAttempted] = useState(false);
  const ids = useId();
  const contact = company.contact;
  const nameKnown = mayReadIdentity && company.org_name !== undefined;
  const nameValid = draft.orgName.trim().length > 0;

  const changes = changesOf(company, draft, contact !== undefined);
  const diff = diffOf(company, changes);
  const noun = COMPANY_KIND_LABELS[company.kind].toLowerCase();
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  function close() {
    if (reviewOpen) return;
    onClose();
    setDraft(draftOf(company));
    setOutcome(null);
    setAttempted(false);
  }

  async function save(reason: { category: string; text: string }): Promise<AdminActionOutcome> {
    const result = await updateCompanyAction(company.id, changes, {
      reasonCode: reason.category as never,
      reasonText: reason.text,
    });
    setOutcome(result);
    if (result.ok) {
      show(successToast(result, timelineLink(timelineHref)));
      setReviewOpen(false);
      router.refresh();
      onClose();
    }
    return result;
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={close}
        title={`Edit ${displayName(company.org_name) ?? "company"}`}
        description="Only the fields you change are sent, with the reason you confirm on the next step."
        footer={
          <>
            <button className="btn btn--ghost" type="button" onClick={close}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => {
                setAttempted(true);
                if ((nameKnown ? nameValid : true) && diff.length > 0) setReviewOpen(true);
              }}
              disabled={diff.length === 0}
            >
              Review and save
            </button>
          </>
        }
      >
        <form className="form" onSubmit={(e) => e.preventDefault()} noValidate>
          <label className="field" htmlFor={`${ids}-name`}>
            <span className="field__label">
              Registered name<span className="req">*</span>
            </span>
            <input
              id={`${ids}-name`}
              className="field__input"
              value={draft.orgName}
              onChange={(e) => set({ orgName: e.target.value })}
              disabled={!nameKnown}
              aria-invalid={attempted && nameKnown && !nameValid ? true : undefined}
            />
            {!nameKnown ? (
              <span className="field__help">
                The registered name is not disclosed to your role, so it cannot be edited here.
              </span>
            ) : (
              <FieldError>
                {attempted && !nameValid ? "Enter the company's registered name." : null}
              </FieldError>
            )}
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

          {company.kind === "employer" ? (
            <div className="form-grid">
              <label className="field" htmlFor={`${ids}-industry`}>
                <span className="field__label">Industry</span>
                <input
                  id={`${ids}-industry`}
                  className="field__input"
                  value={draft.industry}
                  onChange={(e) => set({ industry: e.target.value })}
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
              {company.kind === "employer" ? "Hiring locations" : "Operating cities"}
            </span>
            <input
              id={`${ids}-cities`}
              className="field__input"
              value={company.kind === "employer" ? draft.hiringLocations : draft.operatingCities}
              onChange={(e) =>
                company.kind === "employer"
                  ? set({ hiringLocations: e.target.value })
                  : set({ operatingCities: e.target.value })
              }
              placeholder="e.g. Pune, Nashik"
              autoComplete="off"
            />
            <span className="field__help">Comma-separated cities.</span>
          </label>

          <label className="field" htmlFor={`${ids}-website`}>
            <span className="field__label">Website</span>
            <input
              id={`${ids}-website`}
              className="field__input"
              value={draft.website}
              onChange={(e) => set({ website: e.target.value })}
              placeholder="e.g. https://acme.example"
            />
          </label>

          {contact ? (
            <>
              <div className="form-grid">
                <label className="field" htmlFor={`${ids}-gst`}>
                  <span className="field__label">GSTIN</span>
                  <input
                    id={`${ids}-gst`}
                    className="field__input mono"
                    value={draft.gst}
                    onChange={(e) => set({ gst: e.target.value.toUpperCase() })}
                  />
                </label>
                <label className="field" htmlFor={`${ids}-contact`}>
                  <span className="field__label">Contact person</span>
                  <input
                    id={`${ids}-contact`}
                    className="field__input"
                    value={draft.contactPerson}
                    onChange={(e) => set({ contactPerson: e.target.value })}
                  />
                </label>
              </div>
              <div className="form-grid">
                <label className="field" htmlFor={`${ids}-phone`}>
                  <span className="field__label">Phone</span>
                  <input
                    id={`${ids}-phone`}
                    className="field__input mono"
                    value={draft.phone}
                    onChange={(e) => set({ phone: e.target.value })}
                  />
                </label>
                <label className="field" htmlFor={`${ids}-email`}>
                  <span className="field__label">Email</span>
                  <input
                    id={`${ids}-email`}
                    className="field__input"
                    type="email"
                    value={draft.email}
                    onChange={(e) => set({ email: e.target.value })}
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
                />
              </label>
            </>
          ) : (
            <p className="field__help">
              Contact fields are encrypted at rest and are not disclosed to your role, so they
              are left unchanged.
            </p>
          )}

          {diff.length === 0 ? (
            <p className="field__help">Change a field to review the edit.</p>
          ) : (
            <p className="field__help">
              {diff.length} field{diff.length === 1 ? "" : "s"} will change.
            </p>
          )}
          {outcome && !outcome.ok ? (
            <p className="field__error">{outcome.error}</p>
          ) : null}
        </form>
      </Drawer>

      <ConfirmDialog
        open={open && reviewOpen}
        onClose={() => setReviewOpen(false)}
        tier="consequential"
        title={`Save this ${noun} record?`}
        description="The changed fields and the reason below are committed together, with one admin action on the timeline."
        changes={diff}
        categories={COMPANY_REASON_CATEGORIES}
        confirmLabel="Save changes"
        onConfirm={save}
      />
    </>
  );
}

function draftOf(company: CompanyDetail): Draft {
  const contact = company.contact;
  return {
    orgName: asText(company.org_name),
    gst: asText(contact?.gst_number),
    address: asText(contact?.address),
    website: asText(company.website),
    phone: asText(contact?.phone),
    email: asText(contact?.email),
    contactPerson: asText(contact?.contact_person),
    verification: company.verification_status,
    industry: asText(company.industry),
    companySize: asText(company.company_size),
    hiringLocations: cityText(company.hiring_locations),
    agencyType: asText(company.agency_type),
    operatingCities: cityText(company.operating_cities),
    recruiterCount: company.recruiter_count === null ? "" : String(company.recruiter_count),
  };
}

function changesOf(
  company: CompanyDetail,
  draft: Draft,
  contactKnown: boolean,
): CompanyChangesPayload {
  const changes: CompanyChangesPayload = {};
  const name = asText(company.org_name);
  if (name !== "" && draft.orgName.trim() !== name.trim()) changes.org_name = draft.orgName.trim();
  if (draft.verification !== company.verification_status)
    changes.verification_status = draft.verification as CompanyVerificationStatus;
  if (draft.website.trim() !== asText(company.website).trim())
    changes.website = draft.website.trim() || null;
  if (company.kind === "employer") {
    if (draft.industry.trim() !== asText(company.industry).trim())
      changes.industry = draft.industry.trim() || null;
    if (draft.companySize !== asText(company.company_size))
      changes.company_size = (draft.companySize || null) as CompanySizeBand | null;
    if (draft.hiringLocations.trim() !== cityText(company.hiring_locations))
      changes.hiring_locations = cities(draft.hiringLocations);
  } else {
    if (draft.agencyType !== asText(company.agency_type))
      changes.agency_type = (draft.agencyType || null) as CompanyAgencyType | null;
    if (
      draft.recruiterCount.trim() !==
      asText(company.recruiter_count === null ? null : String(company.recruiter_count))
    ) {
      const count = draft.recruiterCount.trim() ? Number(draft.recruiterCount) : null;
      changes.recruiter_count = count !== null && Number.isFinite(count) ? count : null;
    }
    if (draft.operatingCities.trim() !== cityText(company.operating_cities))
      changes.operating_cities = cities(draft.operatingCities);
  }
  if (contactKnown) {
    const contact = company.contact!;
    if (draft.gst.trim().toUpperCase() !== asText(contact.gst_number).trim())
      changes.gst_number = draft.gst.trim() ? draft.gst.trim().toUpperCase() : null;
    if (draft.address.trim() !== asText(contact.address).trim())
      changes.address = draft.address.trim() || null;
    if (draft.phone.trim() !== asText(contact.phone).trim())
      changes.phone = draft.phone.trim() || null;
    if (draft.email.trim().toLowerCase() !== asText(contact.email).trim().toLowerCase())
      changes.email = draft.email.trim().toLowerCase() || null;
    if (draft.contactPerson.trim() !== asText(contact.contact_person).trim())
      changes.contact_person = draft.contactPerson.trim() || null;
  }
  return changes;
}

const LABELS: Record<string, string> = {
  org_name: "Registered name",
  gst_number: "GSTIN",
  address: "Address",
  website: "Website",
  phone: "Phone",
  email: "Email",
  contact_person: "Contact person",
  verification_status: "Verification",
  industry: "Industry",
  company_size: "Company size",
  hiring_locations: "Hiring locations",
  agency_type: "Agency type",
  operating_cities: "Operating cities",
  recruiter_count: "Recruiters",
};

function diffOf(company: CompanyDetail, changes: CompanyChangesPayload): ConfirmChange[] {
  const contact = company.contact;
  const current = (key: string): string => {
    switch (key) {
      case "org_name":
        return asText(company.org_name);
      case "gst_number":
        return asText(contact?.gst_number);
      case "address":
        return asText(contact?.address);
      case "website":
        return asText(company.website);
      case "phone":
        return asText(contact?.phone);
      case "email":
        return asText(contact?.email);
      case "contact_person":
        return asText(contact?.contact_person);
      case "verification_status":
        return company.verification_status;
      case "industry":
        return asText(company.industry);
      case "company_size":
        return asText(company.company_size);
      case "hiring_locations":
        return cityText(company.hiring_locations);
      case "agency_type":
        return company.agency_type ?? "";
      case "operating_cities":
        return cityText(company.operating_cities);
      case "recruiter_count":
        return company.recruiter_count === null ? "" : String(company.recruiter_count);
      default:
        return "";
    }
  };
  const shown = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "—";
    if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
    return String(value);
  };
  return Object.entries(changes).map(([key, value]) => ({
    label: LABELS[key] ?? key,
    before: shown(current(key)),
    after: shown(value),
  }));
}
