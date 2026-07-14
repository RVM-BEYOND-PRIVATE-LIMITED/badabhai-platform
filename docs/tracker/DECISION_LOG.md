# Decision Log

Human decisions that gate engineering. Each has options, a recommendation, an owner, a
deadline, and a **safe default** so engineering can proceed without stalling.

Status: `OPEN · DECIDED · DEFERRED`.

---

### D1 — Deploy a persistent staging host + publish `API_BASE_URL`
- **Why needed:** Staging CD is built but INERT until a host + `staging` GitHub Environment + secrets exist. Without it, the alpha NO-GO blocker (B1 handset run) cannot be attempted. **This is the critical path to alpha.**
- **Options:** (a) Render/Railway/Fly/Coolify managed host; (b) a small VM; (c) keep local-only (no alpha).
- **Recommendation:** (a) managed host — fastest, matches the staging-cd webhook seam.
- **Impact:** Business: unblocks alpha pilot. Tech: enables all runtime/staging proof. Security: staging must be synthetic-data-only + team-restricted.
- **Owner:** DevOps + Prakash · **Deadline:** ASAP (blocks Phase 1 alpha-gate verification)
- **Status:** ✅ DECIDED (2026-06-29) — **AWS Lightsail or EC2 instance**. Prakash to provision the instance, create the `staging` GitHub Environment + secrets set, and publish `STAGING_API_BASE_URL`. Next action: infra setup + staging-cd wiring.
- **Can engineering proceed partially?** Yes — local e2e via scoop PG+Redis + guard fix. **Safe default:** keep all real-provider gates OFF; do nothing irreversible.

### D2 — Activate real-send OTP on staging (OTP-7 gate)
- **Why needed:** Real Fast2SMS (worker SMS) + ZeptoMail (payer email) = real spend; sends real messages. App fails closed without creds.
- **Options:** (a) activate on staging with synthetic numbers/emails + team allowlist; (b) keep mock-equivalent (not possible — OTP is real-only); (c) wait.
- **Recommendation:** (a) per [otp-real-send-staging-runbook.md](../ops/otp-real-send-staging-runbook.md), staging-first, small caps.
- **Impact:** Business: proves the real login funnel. Security: must cap `OTP_*` limits + restrict recipients. Cost: small but real.
- **Owner:** Prakash (spend approval) + DevOps · **Deadline:** with/after D1
- **Status:** ✅ DECIDED (2026-06-29) — **Real OTP send approved for staging**. Activate per [otp-real-send-staging-runbook.md](../ops/otp-real-send-staging-runbook.md): team phones/emails only, OTP daily caps enforced. RT-5 risk mitigated.

### D3 — Money-route authorization model (close LC-1) before any prod payer surface
- **Why needed:** `unlocks` unlock/reveal + capacity ride `InternalServiceGuard` + body `payer_id`; `posting-plans` `/plan` + `/boost` are **unguarded** (IDOR). Documented interim, but unsafe for production payer self-serve.
- **Options:** (a) move all money routes behind `PayerAuthGuard` + derive `payer_id` from session (drop body id); (b) at minimum add `InternalServiceGuard` to posting-plans now (alpha interim); (c) defer (not acceptable for real money).
- **Recommendation:** (b) immediately (stops the open IDOR), then (a) before real-money / prod payer surface.
- **Impact:** Security: closes IDOR/money-theft vector. Business: required before charging.
- **Owner:** Divyanshu + security-engineer · **Deadline:** (b) this week; (a) before prod payer
- **Status:** ✅ DECIDED (2026-06-29) — **(b) add `InternalServiceGuard` to `posting-plans` this week** (Divyanshu); **(a) `PayerAuthGuard` + session-derived `payer_id`** before any real-money / prod payer surface (LC-1 close, tracked as D3a). RT-1 mitigation confirmed.

### D4 — Admin worker-PII reveal (ADMIN-3b): operationalize the R24/OQ-7 conditions
- **Why needed:** ADMIN-3b (decrypt + return a worker phone to ONE admin) is **committed and green** (`0635aee`). ADR-0025 R24 signed off **"with conditions"**: reason-gating, rate-cap, **weekly review of the `admin.pii_viewed` audit stream**, **1-year retention**. The code controls exist; the **process** controls must be live before this is "production-ready".
- **Options:** (a) stand up the weekly-review + retention process now and treat reveal as available on staging; (b) keep the reveal route disabled/feature-flagged until the process is live; (c) leave as-is (code present, conditions unmet).
- **Recommendation:** (b) until the weekly-review owner + retention are confirmed; do not expose a live reveal path without them.
- **Impact:** Security/compliance: reason-gating is only meaningful with the review + retention. Tech: code is ready.
- **Owner:** Prakash + security-engineer · **Deadline:** before exposing reveal on any shared environment
- **Status:** ✅ DECIDED (2026-06-29) — **Process conditions confirmed: Prakash owns the weekly review of the `admin.pii_viewed` audit stream; 1-year retention confirmed.** ADMIN-3b can be enabled on staging once the weekly review cadence is operational. RT-4 partially mitigated (code ✅, process cadence to establish).

### D5 — Resume PDF render: enable, or keep TEXT-only for alpha?
- **Why needed:** `RESUME_RENDER_ENABLED=false` → resume returns text/null PDF. Alpha B1 acceptance is "resume **TEXT** preview", so PDF is optional for alpha.
- **Options:** (a) keep TEXT-only for alpha (render off); (b) enable PDF render on staging.
- **Recommendation:** (a) — matches B1; enable PDF post-alpha.
- **Owner:** Prakash · **Deadline:** before alpha gate sign-off
- **Status:** ✅ DECIDED (2026-06-29) — **PDF render is required for alpha. Set `RESUME_RENDER_ENABLED=true` on staging.** WeasyPrint must be installed on the staging instance. B1 acceptance now includes PDF download, not text-only.

### D6 — Confirm RLS stays deferred for alpha (service-role posture)
- **Why needed:** Backend uses Supabase service-role (BYPASSRLS); RLS policies are framed but deferred (R1/TD4). Acceptable while there is no direct client→DB, but it is a launch gate.
- **Options:** (a) keep deferred for alpha (no direct client DB access — true today); (b) finalize RLS now (large).
- **Recommendation:** (a) for alpha; finalize before production / any direct client DB.
- **Owner:** database-architect + Prakash · **Deadline:** before production
- **Status:** ✅ DECIDED (2026-06-29) — **RLS stays deferred. Service-role / BYPASSRLS posture confirmed for alpha.** No direct client→DB access today so this is safe. Finalize RLS before production (Phase 6 gate — R1/TD4).

### D7 — ADR-0026 PIN hashing + pepper: follow the accepted `scrypt` + env decision, or amend to Argon2id + KMS?
- **Why needed:** Divyanshu's in-progress worker-auth PIN work (ADR-0026 Phase 2+3, [WORKER_AUTH_ADR0026.md](WORKER_AUTH_ADR0026.md)) is reported as **"Argon2id + KMS"**. The **accepted** ADR-0026 (R2/R3) explicitly chose **`crypto.scrypt` + env pepper** and **deferred Argon2id and AWS KMS to their own future ADRs** ([TD55](../registers/tech-debt-register.md): "un-defer trigger = its own ADR + sign-off"). [R25](../registers/risks-register.md) also pins the design to scrypt. So Argon2id/KMS **now** is a deviation from the decision of record.
- **Options:** (a) **build per ADR** — `crypto.scrypt` + per-user salt + env pepper, behind the hash interface (Argon2id is a future rehash-on-verify swap via the `pin_algo` column); (b) **amend ADR-0026** to adopt Argon2id and/or KMS now — requires a new ADR/amendment + security sign-off (Argon2id = new dependency / §3 locked-stack; KMS = §3 infra).
- **Recommendation:** (a) — ship the accepted scrypt + env design now (zero new dep, same security *properties*); schedule Argon2id/KMS as the TD55 hardening ADR later. Do **not** let Argon2id/KMS land silently in this PR.
- **Impact:** Security: scrypt + salt + pepper + throttle + device-binding already meets the spec's non-negotiables. Stack: Argon2id/KMS each trip CLAUDE.md §3 (escalate). Schedule: (a) unblocks immediately; (b) adds an ADR + sign-off cycle.
- **Owner:** Prakash + security-engineer (+ Divyanshu) · **Deadline:** before T2 (PIN hashing) lands.
- **Status:** ✅ RESOLVED (2026-06-29) — **Built on `crypto.scrypt` per the accepted ADR** (option a). Verified in the merged Phase 3 (#168): `apps/api/src/auth/pin-hasher.service.ts` uses scrypt + per-user salt + env pepper, behind a versioned interface (`pin_algo`), with Argon2id correctly **deferred to TD55** ("Argon2id stays TD55, NOT built here"). No §3 deviation merged. **Follow-up:** the 4 deferred MEDIUM PIN throttle/rate-limit findings (PR #168 fast-follows) must be fixed before real-SMS/prod.

### D9 — ADR-0030: embedding-based skill canonicalization (TAX program)
- **Why needed:** ADR-0028 OQ#1 — a standard-backed skill id space (ESCO + O\*NET + NCO-2015 + RVM wedge) with vector canonicalization; gates a new vocabulary layer + phased TAX-1..9.
- **Status:** ✅ DECIDED (2026-07-14) — **ACCEPTED** (owner ratified after the security BLOCK was corrected). TAX-1..4 merged same day (#212–#215), mock-default; real-provider/licensing/RVM gates still §7. Launch preconditions TD64/TD65.

### D10 — fork-B: where the skill_alias vector read/write lives
- **Why needed:** the ai-service is DB-free and `skill_alias` is REVOKE'd from the Data-API role — the real embed/vector-search runner needed a home: (A) psycopg inside the ai-service vs (B) a `packages/db` runner (owner connection) calling the ai-service over HTTP.
- **Status:** ✅ DECIDED (2026-07-14) — **B (db-side runner)**. Keeps the ai-service DB-free; runner = `pnpm db:embed:skills` + `POST /embeddings/skill-alias` (PR #219). Option A rejected.

### D8 — Alpha target date (B1 sprint deadline)
- **Why needed:** B1 handset run (staging onboarding→resume) is the alpha gate. A deadline forces the staging provisioning, OTP activation, and handset verification to run in parallel this week rather than sequentially over multiple weeks.
- **Owner:** Prakash · **Deadline:** 2026-07-04
- **Status:** ✅ DECIDED (2026-06-29) — **B1 sprint must be complete by Friday 2026-07-04 (end of week).** All 6 prior decisions are closed; staging provisioning + handset run is the only remaining critical path.

---
## Decided / historical (for reference)
- **D1 — Staging host:** AWS Lightsail or EC2 — decided 2026-06-29 (Prakash). Next: provision instance + GitHub Environment + secrets.
- **D2 — Real OTP on staging:** approved 2026-06-29 (Prakash). Activate per OTP-7 runbook after D1 is live.
- **D3 — posting-plans guard:** InternalServiceGuard this week (Divyanshu); PayerAuthGuard before prod — decided 2026-06-29 (Prakash).
- **D4 — Admin PII-reveal process:** Prakash owns weekly `admin.pii_viewed` review; 1-yr retention confirmed — decided 2026-06-29. ADMIN-3b enabled on staging once cadence is operational.
- **D5 — Resume PDF render:** PDF required for alpha — decided 2026-06-29 (Prakash). Set `RESUME_RENDER_ENABLED=true`; install WeasyPrint on staging instance.
- **D6 — RLS alpha posture:** RLS deferred confirmed — decided 2026-06-29 (Prakash). Service-role/BYPASSRLS acceptable for alpha; finalize before production (Phase 6).
- **OTP provider:** Fast2SMS (worker SMS) + ZeptoMail (payer email) — decided (Q1, ADRs).
- **AI routing:** Direct Gemini + Claude, no LiteLLM — decided (ADR-0008).
- **Dev/mock OTP:** removed, real-only — decided (commit `d2f228e`). `DEV_QUICK_LOGIN` is DEAD.
- **Worker router:** go_router stateful shell — decided (ADR-0023).
- **ADMIN-3b reveal direction:** accepted with conditions — decided (ADR-0025 R24); code landed `0635aee`.
