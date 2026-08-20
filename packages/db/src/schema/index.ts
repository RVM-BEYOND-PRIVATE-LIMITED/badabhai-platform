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

import {
  workerConsents,
  workerCredentials,
  workerDevices,
  workers,
} from "./worker";
import {
  skillAliases,
  skillRelated,
  skills,
  unresolvedPhrases,
} from "./skill";
import {
  jobDomainAliases,
  jobDomains,
} from "./occupation";
import {
  jobDomainSkills,
  jobPostingSkills,
  workerProfileSkills,
} from "./taxonomy";
import {
  profilingFamilies,
  profilingFamilyBindings,
  questionPackItems,
  questionPackOptions,
  questionPacks,
} from "./question-pack";
import {
  chatMessages,
  chatSessions,
  voiceNotes,
} from "./chat";
import {
  workerPackAnswers,
} from "./pack-answer";
import {
  profilingVoiceAnswers,
  workerAttributes,
} from "./profiling";
import {
  generatedResumes,
  profileQuestions,
  profiles,
  questions,
  workerAnswers,
  workerProfiles,
} from "./profile";
import {
  applications,
  jobPostings,
  jobs,
} from "./job";
import {
  creditLedger,
  payerCapacity,
  payerCredits,
  payerFormDrafts,
  payerJobPostingChatMessages,
  payerJobPostingChatSessions,
  payerMembers,
  payerOrgs,
  payers,
  paymentOrders,
  postingBoosts,
  postingPlans,
  pricingCatalog,
  resumeDisclosures,
  unlockRouting,
  unlocks,
} from "./payer";
import {
  jobReach,
  matchConfig,
  workerIndustryTenure,
  workerSkills,
} from "./match";
import {
  agencyInvites,
  agencyKyc,
  agencyPayoutAccruals,
  agencyPayoutRequests,
  invites,
  referralBonusAccruals,
  referralClicks,
  referralLinks,
} from "./referral";
import {
  adminUsers,
  aiJobs,
  auditLogs,
  events,
  paceStates,
  pushDeliveries,
  workerFlags,
} from "./ops";
import {
  agencyProfiles,
  employerProfiles,
  payerCapabilities,
  payerMemberInvites,
} from "./payer-onboarding";
import { platformAiCostTotals, sessionAiCostTotals, workerAiCostTotals } from "./ai-cost";
import { workerFeedback } from "./feedback";
import { aiCallTraces } from "./ai-trace";

export * from "./worker";
export * from "./skill";
export * from "./occupation";
export * from "./taxonomy";
export * from "./question-pack";
export * from "./chat";
export * from "./pack-answer";
export * from "./profiling";
export * from "./profile";
export * from "./job";
export * from "./payer";
export * from "./match";
export * from "./referral";
export * from "./ops";
export * from "./payer-onboarding";
export * from "./ai-cost";
export * from "./feedback";
export * from "./ai-trace";

// ---------------------------------------------------------------------------
// Inferred row types (select / insert) for use across services.
// ---------------------------------------------------------------------------
export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
export type Payer = typeof payers.$inferSelect;
export type NewPayer = typeof payers.$inferInsert;
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type WorkerConsent = typeof workerConsents.$inferSelect;
export type NewWorkerConsent = typeof workerConsents.$inferInsert;
export type WorkerDevice = typeof workerDevices.$inferSelect;
export type NewWorkerDevice = typeof workerDevices.$inferInsert;
export type PushDelivery = typeof pushDeliveries.$inferSelect;
export type NewPushDelivery = typeof pushDeliveries.$inferInsert;
export type WorkerCredential = typeof workerCredentials.$inferSelect;
export type NewWorkerCredential = typeof workerCredentials.$inferInsert;
export type WorkerProfile = typeof workerProfiles.$inferSelect;
export type NewWorkerProfile = typeof workerProfiles.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type VoiceNote = typeof voiceNotes.$inferSelect;
export type NewVoiceNote = typeof voiceNotes.$inferInsert;
export type WorkerAttribute = typeof workerAttributes.$inferSelect;
export type NewWorkerAttribute = typeof workerAttributes.$inferInsert;
export type ProfilingVoiceAnswer = typeof profilingVoiceAnswers.$inferSelect;
export type NewProfilingVoiceAnswer = typeof profilingVoiceAnswers.$inferInsert;
export type GeneratedResume = typeof generatedResumes.$inferSelect;
export type NewGeneratedResume = typeof generatedResumes.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type AiJob = typeof aiJobs.$inferSelect;
export type NewAiJob = typeof aiJobs.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type ProfileQuestion = typeof profileQuestions.$inferSelect;
export type NewProfileQuestion = typeof profileQuestions.$inferInsert;
export type WorkerAnswer = typeof workerAnswers.$inferSelect;
export type NewWorkerAnswer = typeof workerAnswers.$inferInsert;
export type JobPosting = typeof jobPostings.$inferSelect;
export type NewJobPosting = typeof jobPostings.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type Unlock = typeof unlocks.$inferSelect;
export type NewUnlock = typeof unlocks.$inferInsert;
export type PayerCredit = typeof payerCredits.$inferSelect;
export type NewPayerCredit = typeof payerCredits.$inferInsert;
export type CreditLedger = typeof creditLedger.$inferSelect;
export type NewCreditLedger = typeof creditLedger.$inferInsert;
export type UnlockRouting = typeof unlockRouting.$inferSelect;
export type NewUnlockRouting = typeof unlockRouting.$inferInsert;
export type PricingCatalogRow = typeof pricingCatalog.$inferSelect;
export type NewPricingCatalogRow = typeof pricingCatalog.$inferInsert;
export type PostingPlan = typeof postingPlans.$inferSelect;
export type NewPostingPlan = typeof postingPlans.$inferInsert;
export type PostingBoost = typeof postingBoosts.$inferSelect;
export type NewPostingBoost = typeof postingBoosts.$inferInsert;
export type ResumeDisclosure = typeof resumeDisclosures.$inferSelect;
export type NewResumeDisclosure = typeof resumeDisclosures.$inferInsert;
export type PayerCapacity = typeof payerCapacity.$inferSelect;
export type NewPayerCapacity = typeof payerCapacity.$inferInsert;
export type PaceState = typeof paceStates.$inferSelect;
export type NewPaceState = typeof paceStates.$inferInsert;
export type AgencyInvite = typeof agencyInvites.$inferSelect;
export type NewAgencyInvite = typeof agencyInvites.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
export type WorkerFlag = typeof workerFlags.$inferSelect;
export type NewWorkerFlag = typeof workerFlags.$inferInsert;
export type PayerOrg = typeof payerOrgs.$inferSelect;
export type NewPayerOrg = typeof payerOrgs.$inferInsert;
export type PayerMember = typeof payerMembers.$inferSelect;
export type NewPayerMember = typeof payerMembers.$inferInsert;

export type PaymentOrder = typeof paymentOrders.$inferSelect;
export type NewPaymentOrder = typeof paymentOrders.$inferInsert;
export type ReferralBonusAccrual = typeof referralBonusAccruals.$inferSelect;
export type NewReferralBonusAccrual = typeof referralBonusAccruals.$inferInsert;

export type JobReach = typeof jobReach.$inferSelect;
export type NewJobReach = typeof jobReach.$inferInsert;

export type WorkerSkill = typeof workerSkills.$inferSelect;
export type NewWorkerSkill = typeof workerSkills.$inferInsert;
export type WorkerIndustryTenure = typeof workerIndustryTenure.$inferSelect;
export type NewWorkerIndustryTenure = typeof workerIndustryTenure.$inferInsert;

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillRelated = typeof skillRelated.$inferSelect;
export type NewSkillRelated = typeof skillRelated.$inferInsert;
export type SkillAlias = typeof skillAliases.$inferSelect;
export type NewSkillAlias = typeof skillAliases.$inferInsert;
export type UnresolvedPhrase = typeof unresolvedPhrases.$inferSelect;

export type JobDomain = typeof jobDomains.$inferSelect;
export type NewJobDomain = typeof jobDomains.$inferInsert;
export type JobDomainAlias = typeof jobDomainAliases.$inferSelect;
export type NewJobDomainAlias = typeof jobDomainAliases.$inferInsert;
export type JobDomainSkill = typeof jobDomainSkills.$inferSelect;
export type NewJobDomainSkill = typeof jobDomainSkills.$inferInsert;
export type WorkerProfileSkill = typeof workerProfileSkills.$inferSelect;
export type NewWorkerProfileSkill = typeof workerProfileSkills.$inferInsert;
export type JobPostingSkill = typeof jobPostingSkills.$inferSelect;
export type NewJobPostingSkill = typeof jobPostingSkills.$inferInsert;
export type ProfilingFamily = typeof profilingFamilies.$inferSelect;
export type NewProfilingFamily = typeof profilingFamilies.$inferInsert;
export type ProfilingFamilyBinding = typeof profilingFamilyBindings.$inferSelect;
export type NewProfilingFamilyBinding = typeof profilingFamilyBindings.$inferInsert;
export type QuestionPack = typeof questionPacks.$inferSelect;
export type NewQuestionPack = typeof questionPacks.$inferInsert;
export type QuestionPackItem = typeof questionPackItems.$inferSelect;
export type NewQuestionPackItem = typeof questionPackItems.$inferInsert;
export type QuestionPackOption = typeof questionPackOptions.$inferSelect;
export type NewQuestionPackOption = typeof questionPackOptions.$inferInsert;
export type WorkerPackAnswer = typeof workerPackAnswers.$inferSelect;
export type NewWorkerPackAnswer = typeof workerPackAnswers.$inferInsert;
export type NewUnresolvedPhrase = typeof unresolvedPhrases.$inferInsert;

export type WorkerAiCostTotal = typeof workerAiCostTotals.$inferSelect;
export type NewWorkerAiCostTotal = typeof workerAiCostTotals.$inferInsert;
export type SessionAiCostTotal = typeof sessionAiCostTotals.$inferSelect;
export type NewSessionAiCostTotal = typeof sessionAiCostTotals.$inferInsert;
export type PlatformAiCostTotal = typeof platformAiCostTotals.$inferSelect;
export type NewPlatformAiCostTotal = typeof platformAiCostTotals.$inferInsert;
export type WorkerFeedback = typeof workerFeedback.$inferSelect;
export type NewWorkerFeedback = typeof workerFeedback.$inferInsert;
export type AiCallTrace = typeof aiCallTraces.$inferSelect;
export type NewAiCallTrace = typeof aiCallTraces.$inferInsert;

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
  jobDomainSkills,
  workerProfileSkills,
  jobPostingSkills,
  profilingFamilies,
  profilingFamilyBindings,
  questionPacks,
  questionPackItems,
  questionPackOptions,
  workerPackAnswers,
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
  workerAttributes,
  profilingVoiceAnswers,
  workerAiCostTotals,
  sessionAiCostTotals,
  platformAiCostTotals,
  workerFeedback,
  aiCallTraces,
  // GAP-DB-21 — declared 2026-08-20 (owner ruling: keep and model). Nothing reads them.
  agencyProfiles,
  employerProfiles,
  payerCapabilities,
  payerMemberInvites,
};
