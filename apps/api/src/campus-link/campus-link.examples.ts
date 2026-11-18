import type { z } from "zod";
import type {
  CampusApplicationPageSchema,
  CampusApplicationSchema,
  CampusApplyBodySchema,
  CampusCompanyResponseSchema,
  CampusDriveDecisionBodySchema,
  CampusDriveDecisionResponseSchema,
  CampusDriveRequestPageSchema,
  CampusDriveRequestSchema,
  CampusPostForCompanyBodySchema,
  CampusPostForCompanyResponseSchema,
  CampusPostingPageSchema,
  CampusPostingSchema,
  CampusReviewBodySchema,
  CampusReviewResponseSchema,
  CampusSearchGrantBodySchema,
  CampusSearchGrantSchema,
  CampusTargetingOptionsBodySchema,
  CampusTargetingOptionsResponseSchema,
  CampusUnlinkResponseSchema,
  CampusWaiverBodySchema,
  CampusWaiverPageSchema,
  CampusWaiverResponseSchema,
  CampusWaiverSchema,
} from "./campus-link.contract";

/**
 * One worked example per Campus contract shape (#2752 item 1). `campus-link.contract.test.ts`
 * parses each against its schema, the mock server answers with them, and the API reference
 * quotes them, so the three cannot drift apart. Fictional throughout: no real company, phone or
 * student.
 */

const COMPANY_ID = "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10";
const STUDENT_REF = "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718";
const STAFF_REF = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
/** A fictional `content_hash`: BadaBhai computes the real one; Campus only echoes it. */
const CONTENT_HASH = "dae961f775f42c5205c320f1bc9eed1046f92b7856b4f97b1e3a1eed94300fc9";

export const POSTING_EXAMPLE: z.input<typeof CampusPostingSchema> = {
  id: "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5",
  company: { id: COMPANY_ID, name: "Sharma Precision Works" },
  title: "CNC Operator",
  description: "Run a 3-axis CNC lathe on day shift. Fanuc control preferred.",
  location: { label: "Sector 24 industrial area", city: "Faridabad", state: "Haryana", area: null },
  pay: { min: 16000, max: 22000, type: "in_hand" },
  vacancy_band: "2-5",
  shift: "day",
  experience_years: { min: 0, max: 2 },
  requirements: ["ITI or diploma"],
  benefits: ["PF", "ESI"],
  status: "open",
  audience: "both",
  branch_ids: [1],
  courses: [{ id: "cnc-programming", name: "CNC Programming" }],
  review_state: "approved",
  changed_at: "2026-11-13T09:30:00.000+05:30",
  content_hash: CONTENT_HASH,
};

export const POSTING_PAGE_EXAMPLE: z.input<typeof CampusPostingPageSchema> = {
  postings: [POSTING_EXAMPLE],
  next_cursor: null,
};

export const REVIEW_BODY_EXAMPLE: z.input<typeof CampusReviewBodySchema> = {
  state: "approved",
  reviewer_ref: STAFF_REF,
  branch_ids: [1],
  content_hash: CONTENT_HASH,
  decided_at: "2026-11-13T10:00:00.000+05:30",
};

export const REVIEW_RESPONSE_EXAMPLE: z.input<typeof CampusReviewResponseSchema> = {
  posting_id: POSTING_EXAMPLE.id,
  review_state: "approved",
  reviewed_at: "2026-11-13T10:00:00.000+05:30",
};

/** #2746 — the whole current list; list position is the order companies see. */
export const TARGETING_OPTIONS_BODY_EXAMPLE: z.input<typeof CampusTargetingOptionsBodySchema> = {
  as_of: "2026-11-13T08:00:00.000+05:30",
  branches: [
    { id: 1, name: "Faridabad" },
    { id: 2, name: "Pune" },
    { id: 3, name: "Ahmedabad" },
    { id: 4, name: "Lucknow" },
  ],
  courses: [
    { id: "cnc-programming", name: "CNC Programming" },
    { id: "cad-design", name: "CAD Design" },
  ],
};

export const TARGETING_OPTIONS_RESPONSE_EXAMPLE: z.input<
  typeof CampusTargetingOptionsResponseSchema
> = {
  branches: { listed: 4, added: 0, updated: 1, deactivated: 0 },
  courses: { listed: 2, added: 1, updated: 0, deactivated: 1 },
};

export const POST_FOR_COMPANY_BODY_EXAMPLE: z.input<typeof CampusPostForCompanyBodySchema> = {
  company: { phone: "9000000001", name: "Sharma Precision Works" },
  title: "CNC Operator",
  description: "Run a 3-axis CNC lathe on day shift.",
  city: "Faridabad",
  state: "Haryana",
  openings: 3,
  pay: { min: 16000, max: 22000, type: "in_hand" },
  branch_ids: [1],
  course_ids: ["cnc-programming"],
  staff_ref: STAFF_REF,
};

export const POST_FOR_COMPANY_RESPONSE_EXAMPLE: z.input<typeof CampusPostForCompanyResponseSchema> =
  {
    posting_id: POSTING_EXAMPLE.id,
    company_id: COMPANY_ID,
    company_created: false,
    review_state: "approved",
  };

export const COMPANY_RESPONSE_EXAMPLE: z.input<typeof CampusCompanyResponseSchema> = {
  company: { id: COMPANY_ID, name: "Sharma Precision Works", status: "active" },
};

export const APPLY_BODY_EXAMPLE: z.input<typeof CampusApplyBodySchema> = {
  external_ref: "campus-app-000123",
  posting_id: POSTING_EXAMPLE.id,
  student_ref: STUDENT_REF,
  applied_at: "2026-11-13T11:15:00.000+05:30",
};

export const APPLICATION_EXAMPLE: z.input<typeof CampusApplicationSchema> = {
  application_id: "c0d1e2f3-a4b5-4c6d-9e8f-a0b1c2d3e4f5",
  external_ref: APPLY_BODY_EXAMPLE.external_ref,
  posting_id: POSTING_EXAMPLE.id,
  student_ref: STUDENT_REF,
  stage: "new",
  changed_at: "2026-11-13T11:15:01.000+05:30",
};

export const APPLICATION_PAGE_EXAMPLE: z.input<typeof CampusApplicationPageSchema> = {
  applications: [APPLICATION_EXAMPLE],
  next_cursor: null,
};

export const SEARCH_GRANT_BODY_EXAMPLE: z.input<typeof CampusSearchGrantBodySchema> = {
  company_id: COMPANY_ID,
  student_ref: STUDENT_REF,
  consent_ref: "consent-req-000456",
};

export const SEARCH_GRANT_EXAMPLE: z.input<typeof CampusSearchGrantSchema> = {
  grant_ref: "campus-grant-000789",
  company_id: COMPANY_ID,
  student_ref: STUDENT_REF,
  state: "active",
  changed_at: "2026-11-13T12:00:00.000+05:30",
};

export const WAIVER_BODY_EXAMPLE: z.input<typeof CampusWaiverBodySchema> = {
  scope: "company",
  company_id: COMPANY_ID,
  active: true,
  staff_ref: "7d0f6c1e-2b4a-4c8e-9f10-3a5b6c7d8e9f",
  staff_label: "Placement desk, Pune",
  reason: "Campus drive partner for the November batch",
};

export const WAIVER_EXAMPLE: z.input<typeof CampusWaiverSchema> = {
  waiver_id: "0b6e2a4c-8d1f-4e3a-9b5c-7d2e1f0a3b4c",
  scope: "company",
  company_id: COMPANY_ID,
  posting_id: null,
  active: true,
  source: "campus",
  set_by_ref: "7d0f6c1e-2b4a-4c8e-9f10-3a5b6c7d8e9f",
  set_by_label: "Placement desk, Pune",
  reason: "Campus drive partner for the November batch",
  set_at: "2026-11-17T12:00:00.000+05:30",
  cleared_at: null,
  cleared_by_ref: null,
  cleared_by_label: null,
  clear_reason: null,
  waived_opens: 3,
};

export const WAIVER_RESPONSE_EXAMPLE: z.input<typeof CampusWaiverResponseSchema> = {
  active: true,
  changed: true,
  waiver: WAIVER_EXAMPLE,
};

export const WAIVER_PAGE_EXAMPLE: z.input<typeof CampusWaiverPageSchema> = {
  waivers: [WAIVER_EXAMPLE],
  next_cursor: null,
};

export const UNLINK_RESPONSE_EXAMPLE: z.input<typeof CampusUnlinkResponseSchema> = {
  student_ref: STUDENT_REF,
  state: "unlinked",
};

/** #2746 — a company's campus-drive request, as the placement team's feed shows it. */
export const DRIVE_REQUEST_EXAMPLE: z.input<typeof CampusDriveRequestSchema> = {
  id: "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  company: { id: COMPANY_ID, name: "Sharma Precision Works" },
  company_withdrawn: false,
  job_posting_id: POSTING_EXAMPLE.id,
  branch_ids: [1],
  preferred_from: "2026-12-01",
  preferred_to: "2026-12-15",
  openings: 12,
  roles_note: "CNC operators and setters for two shifts. Fanuc experience a plus.",
  contact: { name: "Ravi Sharma", phone: "+919000000001" },
  status: "scheduled",
  scheduled_on: "2026-12-05",
  campus_drive_ref: "campus-drive:000417",
  decided_at: "2026-11-20T03:30:00.000Z",
  decided_by_ref: STAFF_REF,
  reason: null,
  is_test: false,
  requested_at: "2026-11-14T06:15:00.000Z",
  cancelled_at: null,
  changed_at: "2026-11-20T03:30:00.412851Z",
};

export const DRIVE_REQUEST_PAGE_EXAMPLE: z.input<typeof CampusDriveRequestPageSchema> = {
  drive_requests: [DRIVE_REQUEST_EXAMPLE],
  next_cursor: null,
};

export const DRIVE_DECISION_BODY_EXAMPLE: z.input<typeof CampusDriveDecisionBodySchema> = {
  decision: "scheduled",
  decided_by_ref: STAFF_REF,
  decided_at: "2026-11-20T09:00:00.000+05:30",
  scheduled_on: "2026-12-05",
  campus_drive_ref: "campus-drive:000417",
};

export const DRIVE_DECISION_RESPONSE_EXAMPLE: z.input<typeof CampusDriveDecisionResponseSchema> = {
  drive_request_id: DRIVE_REQUEST_EXAMPLE.id,
  status: "scheduled",
  scheduled_on: "2026-12-05",
  campus_drive_ref: "campus-drive:000417",
  decided_at: "2026-11-20T09:00:00.000+05:30",
  changed_at: "2026-11-20T03:30:00.412851Z",
};
