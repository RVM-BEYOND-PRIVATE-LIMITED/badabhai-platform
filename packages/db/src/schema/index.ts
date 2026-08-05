/**
 * BadaBhai Drizzle schema (Supabase Postgres).
 *
 * Conventions:
 * - All ids are uuid (gen_random_uuid()).
 * - All timestamps are `timestamptz`.
 * - Status-like columns are `text` with a TS `$type<...>()` for type-safety
 *   (kept as text rather than pg enums to keep migrations simple for a lean team;
 *   add CHECK constraints later if needed — see infra/supabase/migration-plan.md).
 * - JSONB columns default to '{}' / '[]'.
 *
 * PRIVACY: PII (phone, name) lives ONLY in `workers`. It must never be copied
 * into `events`, `audit_logs`, `ai_jobs`, or sent to an LLM. RLS will lock these
 * tables down (see infra/supabase/rls-plan.md) — Phase 1 access is via the
 * backend service role only.
 */

export * from "./worker";
export * from "./chat";
export * from "./profile";
export * from "./payer";
export * from "./job";
export * from "./skill";
export * from "./occupation";
export * from "./match";
export * from "./referral";
export * from "./ops";

// Re-export TradeKey for downstream consumers (seed files, etc.)
export type { TradeKey, SkipReason, SourceSurface } from "@badabhai/taxonomy";

import {
  workers,
  workerConsents,
  workerProfiles,
  workerDevices,
  pushDeliveries,
  workerCredentials,
} from "./worker";
import { chatSessions, voiceNotes, chatMessages, generatedResumes } from "./chat";
import { profiles, questions, profileQuestions, workerAnswers } from "./profile";
import {
  payers,
  unlocks,
  payerCredits,
  creditLedger,
  unlockRouting,
  pricingCatalog,
  postingPlans,
  postingBoosts,
  resumeDisclosures,
  payerCapacity,
  payerOrgs,
  payerMembers,
  paymentOrders,
  referralBonusAccruals,
  payerJobPostingChatSessions,
  payerJobPostingChatMessages,
  payerFormDrafts,
} from "./payer";
import { jobPostings, jobs, applications, paceStates } from "./job";
import { skills, skillAliases, skillRelated, unresolvedPhrases } from "./skill";
import { jobDomains, jobDomainAliases } from "./occupation";
import { workerSkills, workerIndustryTenure, jobReach, matchConfig } from "./match";
import {
  invites,
  agencyInvites,
  agencyKyc,
  agencyPayoutRequests,
  agencyPayoutAccruals,
  referralLinks,
  referralClicks,
} from "./referral";
import { events, aiJobs, auditLogs, adminUsers, workerFlags } from "./ops";

/** All tables, handy for migrations/tests. */
export const schema = {
  workers,
  workerConsents,
  payers,
  workerProfiles,
  chatSessions,
  voiceNotes,
  chatMessages,
  generatedResumes,
  events,
  aiJobs,
  auditLogs,
  profiles,
  questions,
  profileQuestions,
  workerAnswers,
  jobPostings,
  jobs,
  applications,
  unlocks,
  payerCredits,
  creditLedger,
  unlockRouting,
  pricingCatalog,
  postingPlans,
  postingBoosts,
  resumeDisclosures,
  payerCapacity,
  invites,
  paceStates,
  agencyInvites,
  agencyKyc,
  agencyPayoutRequests,
  agencyPayoutAccruals,
  adminUsers,
  workerFlags,
  workerDevices,
  pushDeliveries,
  workerCredentials,
  payerOrgs,
  payerMembers,
  skills,
  skillAliases,
  skillRelated,
  workerSkills,
  workerIndustryTenure,
  jobDomains,
  jobDomainAliases,
  jobReach,
  matchConfig,
  paymentOrders,
  referralBonusAccruals,
  unresolvedPhrases,
  payerJobPostingChatSessions,
  payerJobPostingChatMessages,
  payerFormDrafts,
  referralLinks,
  referralClicks,
};
