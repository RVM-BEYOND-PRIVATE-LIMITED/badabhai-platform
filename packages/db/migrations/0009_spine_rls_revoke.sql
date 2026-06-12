-- Spine-wide RLS + REVOKE default grants (TD20) — extend the workers lock (0003/0004)
-- to every remaining application table.
--
-- 0003/0004 locked only `workers`. The rest of the spine still had default Supabase
-- grants and no RLS, so `worker_id` / correlation / linkage (and `worker_answers`,
-- which carries a worker FK) were readable via the PostgREST Data API with the
-- anon / authenticated / service_role keys. This applies the SAME proven lock to all
-- 13 remaining tables:
--   ENABLE + FORCE ROW LEVEL SECURITY, then REVOKE ALL from PUBLIC and the three
--   client-facing roles. No policies -> deny by default for every non-BYPASSRLS role.
--
-- The backend is unaffected: it connects on a DIRECT Postgres connection as the
-- `postgres` role (BYPASSRLS) and never via the Data API — exactly as for `workers`,
-- which has run under this lock in production without issue. The anon / authenticated
-- / service_role roles must exist for the REVOKEs to apply; they do on Supabase and
-- are pre-created in CI (same precondition 0004 already introduced).
--
-- Tables covered (workers already locked in 0003/0004):
--   spine:        worker_consents, worker_profiles, chat_sessions, voice_notes,
--                 chat_messages, generated_resumes, events, ai_jobs, audit_logs
--   questionnaire (added in 0008): profiles, questions, profile_questions, worker_answers
--
-- ENABLE/FORCE/REVOKE are idempotent (no-op when already applied), so this converges
-- a drifted DB in one pass.

-- worker_consents
ALTER TABLE "worker_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_consents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_consents" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_consents" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_consents" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_consents" FROM service_role;--> statement-breakpoint

-- worker_profiles
ALTER TABLE "worker_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM service_role;--> statement-breakpoint

-- chat_sessions
ALTER TABLE "chat_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_sessions" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_sessions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_sessions" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_sessions" FROM service_role;--> statement-breakpoint

-- voice_notes
ALTER TABLE "voice_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "voice_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "voice_notes" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "voice_notes" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "voice_notes" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "voice_notes" FROM service_role;--> statement-breakpoint

-- chat_messages
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_messages" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_messages" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_messages" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "chat_messages" FROM service_role;--> statement-breakpoint

-- generated_resumes
ALTER TABLE "generated_resumes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generated_resumes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "generated_resumes" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "generated_resumes" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "generated_resumes" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "generated_resumes" FROM service_role;--> statement-breakpoint

-- events
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "events" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "events" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "events" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "events" FROM service_role;--> statement-breakpoint

-- ai_jobs
ALTER TABLE "ai_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_jobs" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_jobs" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_jobs" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_jobs" FROM service_role;--> statement-breakpoint

-- audit_logs
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "audit_logs" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "audit_logs" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "audit_logs" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "audit_logs" FROM service_role;--> statement-breakpoint

-- profiles (questionnaire definition; PII-free reference data, locked for consistency)
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "profiles" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "profiles" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "profiles" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "profiles" FROM service_role;--> statement-breakpoint

-- questions (questionnaire definition; PII-free reference data, locked for consistency)
ALTER TABLE "questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "questions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "questions" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "questions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "questions" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "questions" FROM service_role;--> statement-breakpoint

-- profile_questions (questionnaire definition; PII-free reference data, locked for consistency)
ALTER TABLE "profile_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_questions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_questions" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_questions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_questions" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_questions" FROM service_role;--> statement-breakpoint

-- worker_answers (carries a worker FK — linkable; must be locked)
ALTER TABLE "worker_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_answers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_answers" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_answers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_answers" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_answers" FROM service_role;
