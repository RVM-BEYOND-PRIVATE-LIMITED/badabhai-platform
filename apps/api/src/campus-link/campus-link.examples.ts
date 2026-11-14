import type { z } from "zod";
import type {
  CampusApplicationPageSchema,
  CampusApplicationSchema,
  CampusApplyBodySchema,
  CampusCompanyResponseSchema,
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
};

export const REVIEW_RESPONSE_EXAMPLE: z.input<typeof CampusReviewResponseSchema> = {
  posting_id: POSTING_EXAMPLE.id,
  review_state: "approved",
  reviewed_at: "2026-11-13T10:00:00.000+05:30",
};

/** #2746 — the whole current list; list position is the order companies see. */
export const TARGETING_OPTIONS_BODY_EXAMPLE: z.input<typeof CampusTargetingOptionsBodySchema> = {
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

export const UNLINK_RESPONSE_EXAMPLE: z.input<typeof CampusUnlinkResponseSchema> = {
  student_ref: STUDENT_REF,
  state: "unlinked",
};
