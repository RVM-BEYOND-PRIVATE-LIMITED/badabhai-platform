/**
 * The closed vocabularies of the numbers screen (#2884, API #2755).
 *
 * Client-safe on purpose: the filter bar and the action forms are `"use client"` modules, so the
 * labels they render cannot come from `lib/numbers.ts` (which imports `server-only`). The values
 * here are the API's own closed sets, named once so a page, a form and a test cannot drift.
 */

export const NUMBERS_CITY_GROUPS = [
  "all",
  "ncr",
  "pune",
  "ahmedabad",
  "other",
  "unknown",
] as const;
export type NumbersCityGroup = (typeof NUMBERS_CITY_GROUPS)[number];

export const NUMBERS_CITY_LABELS: Readonly<Record<NumbersCityGroup, string>> = {
  all: "All cities",
  ncr: "NCR",
  pune: "Pune",
  ahmedabad: "Ahmedabad",
  other: "Other cities",
  unknown: "Unknown city",
};

export const NUMBERS_TRADE_GROUPS = [
  "all",
  "cnc_operator",
  "cnc_cam_programmer",
  "sheet_metal",
  "cad_3d_designer",
  "other",
  "unknown",
] as const;
export type NumbersTradeGroup = (typeof NUMBERS_TRADE_GROUPS)[number];

export const NUMBERS_TRADE_LABELS: Readonly<Record<NumbersTradeGroup, string>> = {
  all: "All trades",
  cnc_operator: "CNC operator",
  cnc_cam_programmer: "CNC/CAM programmer",
  sheet_metal: "Sheet metal",
  cad_3d_designer: "3D CAD designer",
  other: "Other trades",
  unknown: "Unknown trade",
};

/** The numbers' own trade labels, without the `all` roll-up (launch test A records a real one). */
export const LAUNCH_TEST_CITY_GROUPS = ["ncr", "pune", "ahmedabad", "other"] as const;
export type LaunchTestCityGroup = (typeof LAUNCH_TEST_CITY_GROUPS)[number];

export const LAUNCH_TEST_TRADE_GROUPS = [
  "cnc_operator",
  "cnc_cam_programmer",
  "sheet_metal",
  "cad_3d_designer",
  "other",
] as const;
export type LaunchTestTradeGroup = (typeof LAUNCH_TEST_TRADE_GROUPS)[number];

/** Why a company is a test company (the PUT body's closed reasons). */
export const TEST_COMPANY_REASONS = [
  "synthetic_sign_in",
  "staff",
  "rehearsal",
  "pilot_test",
] as const;
export type TestCompanyReason = (typeof TEST_COMPANY_REASONS)[number];

export const TEST_COMPANY_REASON_LABELS: Readonly<Record<TestCompanyReason, string>> = {
  synthetic_sign_in: "Synthetic sign-in",
  staff: "Staff or internal",
  rehearsal: "Rehearsal",
  pilot_test: "Pilot test",
};

/** What a call to an out-of-credits company came to (the POST body's closed results). */
export const CREDIT_CALL_RESULTS = [
  "reached_will_buy",
  "reached_not_now",
  "reached_declined",
  "no_answer",
  "wrong_number",
] as const;
export type CreditCallResult = (typeof CREDIT_CALL_RESULTS)[number];

export const CREDIT_CALL_RESULT_LABELS: Readonly<Record<CreditCallResult, string>> = {
  reached_will_buy: "Reached — will buy",
  reached_not_now: "Reached — not now",
  reached_declined: "Reached — declined",
  no_answer: "No answer",
  wrong_number: "Wrong number",
};

/** Launch test A's recorded result for one factory. */
export const LAUNCH_TEST_RESULTS = ["pending", "paid", "declined", "no_response"] as const;
export type LaunchTestResult = (typeof LAUNCH_TEST_RESULTS)[number];

export const LAUNCH_TEST_RESULT_LABELS: Readonly<Record<LaunchTestResult, string>> = {
  pending: "Pending",
  paid: "Paid",
  declined: "Declined",
  no_response: "No response",
};

export const UNLOCK_OUTCOMES = ["hired", "not_hired", "still_talking", "not_reached"] as const;
export type UnlockOutcome = (typeof UNLOCK_OUTCOMES)[number];

export const UNLOCK_OUTCOME_LABELS: Readonly<Record<UnlockOutcome, string>> = {
  hired: "Hired",
  not_hired: "Not hired",
  still_talking: "Still talking",
  not_reached: "Not reached",
};

/** Why launch test B's report has no contact count for a hire. */
export const CONTACTS_PER_HIRE_REASONS = ["agency_job", "posting_deleted"] as const;
export type ContactsPerHireReason = (typeof CONTACTS_PER_HIRE_REASONS)[number];

export const CONTACTS_PER_HIRE_REASON_LABELS: Readonly<Record<ContactsPerHireReason, string>> = {
  agency_job: "An agency job — a company unlock never names it.",
  posting_deleted: "The posting was deleted, so its contacts cannot be told apart.",
};
