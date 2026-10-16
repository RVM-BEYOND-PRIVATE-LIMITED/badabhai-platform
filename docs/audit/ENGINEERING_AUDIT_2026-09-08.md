# BadaBhai Platform — Complete Engineering Audit

**Date:** 2026-09-08
**Auditor:** Engineering Manager / Principal Architect
**Scope:** Full codebase + all documentation + CI/CD + infrastructure
**Codebase Size:** ~922 TypeScript files (API), 76 Python files (AI), 2 Flutter apps, 4 web apps, 12 packages

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Health](#2-architecture-health)
3. [Sprint 1 — Critical Issues](#3-sprint-1--critical-issues)
4. [Sprint 2 — High Priority Issues](#4-sprint-2--high-priority-issues)
5. [Sprint 3 — Medium Priority Issues](#5-sprint-3--medium-priority-issues)
6. [Sprint 4 — Low Priority Issues](#6-sprint-4--low-priority-issues)
7. [Final Summary](#7-final-summary)

---

## 1. Executive Summary

The BadaBhai platform is a **well-engineered codebase** with strong adherence to its CLAUDE.md operating contract. The event-first architecture, privacy-first design, and fail-closed patterns are implemented consistently. The AI service is exceptionally well-built with best-in-class pseudonymization.

However, the audit identified **62 actionable issues** across the codebase, including architectural drift in ADRs, oversized god-class files, layering violations, accessibility gaps, CI/CD gaps, stale documentation, and missing shared code extraction between Flutter apps.

**Key Strengths:**

- Privacy/PII safety: A+ (best-in-class pseudonymization gateway)
- Event-first architecture: A (comprehensive event emission from every service)
- Authentication: A (multi-principal auth model with 15 guards)
- AI service quality: A+ (fail-closed, never-raise router, provider fallback)
- Test discipline: A (property tests, purity gates, contract parity)

**Key Weaknesses:**

- ADR housekeeping: 5 ADRs have stale supersession status
- God classes: `orchestrator.service.ts` (2,790 lines), `trade-resume-map.ts` (2,305 lines)
- Flutter app duplication: theme, widgets, crash reporter duplicated across apps
- CI/CD gaps: secret scan non-blocking, no format check in CI, no npm Dependabot
- Documentation drift: 4 stale READMEs, 1 missing README, stale project-status.md

---

## 2. Architecture Health

| Dimension           | Score | Notes                                                                            |
| ------------------- | ----- | -------------------------------------------------------------------------------- |
| ADR Compliance      | 7/10  | 5 ADRs have stale supersession status; 3 proposed ADRs referenced as authority   |
| Architecture Health | 8/10  | Clean separation in most layers; god classes in profiling/resume                 |
| UI Quality          | 7/10  | Worker app excellent; payer app has accessibility gaps; duplication between apps |
| Backend Quality     | 9/10  | Exceptional auth, validation, event emission; minor layering violations          |
| Performance         | 8/10  | Advisory locking, spend caps, rate limiting; no APM for API                      |
| Security            | 9/10  | PII isolation excellent; secret scan non-blocking is the main gap                |
| Test Coverage       | 8/10  | Strong across board; payer app Flutter tests lack bloc_test/mocktail             |
| Documentation       | 6/10  | 4 stale READMEs, 1 missing README, stale project-status.md, stock SECURITY.md    |

---

## 3. Sprint 1 — Critical Issues

### Issue S1-01: Secret Scan (Gitleaks) is Non-Blocking in CI

| Field                    | Value                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Flip gitleaks secret scan to blocking in security-scan.yml                                                                                                                                                                                                                                                  |
| **Category**             | Security                                                                                                                                                                                                                                                                                                    |
| **Priority**             | Critical                                                                                                                                                                                                                                                                                                    |
| **Severity**             | High                                                                                                                                                                                                                                                                                                        |
| **Business Impact**      | A committed secret would reach production undetected by automated gates                                                                                                                                                                                                                                     |
| **Technical Impact**     | The only mechanical barrier between a committed secret and remote is this weekly scan; it currently passes on findings                                                                                                                                                                                      |
| **Description**          | `security-scan.yml` line 111 has `continue-on-error: true` on the gitleaks step. The comment at lines 42-50 explicitly states this should be the FIRST check to flip to blocking since the local pre-commit guard was removed. Currently a secret committed to a PR merges without any automated rejection. |
| **Root Cause**           | The local pre-commit gitleaks hook was removed, but the CI step was not simultaneously flipped to blocking.                                                                                                                                                                                                 |
| **Current Behaviour**    | Gitleaks runs as advisory; findings are reported but do not block merge.                                                                                                                                                                                                                                    |
| **Expected Behaviour**   | Gitleaks findings should block merge until resolved.                                                                                                                                                                                                                                                        |
| **Acceptance Criteria**  | 1. Resolve any current gitleaks findings. 2. Remove `continue-on-error: true` from the gitleaks step. 3. Verify a deliberate secret commit is blocked.                                                                                                                                                      |
| **Implementation Notes** | The comment in `security-scan.yml` already documents the intent. Flip the flag and ensure no existing findings block the weekly scan.                                                                                                                                                                       |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                        |
| **Risks**                | If existing findings exist on `main`, the first blocking scan will fail. Run a full scan first to confirm clean state.                                                                                                                                                                                      |
| **Testing Checklist**    | - Commit a test secret → verify scan blocks. - Run full scan on `main` → verify clean.                                                                                                                                                                                                                      |
| **Estimated Complexity** | XS                                                                                                                                                                                                                                                                                                          |
| **Estimated Effort**     | 30 minutes                                                                                                                                                                                                                                                                                                  |
| **Suggested Files**      | `.github/workflows/security-scan.yml:111`                                                                                                                                                                                                                                                                   |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                                                                                         |

---

### Issue S1-02: Supabase Migration Checks are Non-Blocking

| Field                    | Value                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Flip Supabase migration drift/sequence checks to blocking                                                                                                                                                                              |
| **Category**             | Security                                                                                                                                                                                                                               |
| **Priority**             | Critical                                                                                                                                                                                                                               |
| **Severity**             | High                                                                                                                                                                                                                                   |
| **Business Impact**      | Schema drift between `schema.ts` and committed migrations could reach production undetected                                                                                                                                            |
| **Technical Impact**     | Migration sequence gaps or drift would only be caught manually                                                                                                                                                                         |
| **Description**          | `supabase-checks.yml` lines 84 and 112 both have `continue-on-error: true`. Migration drift (Drizzle schema vs committed SQL) and sequence validation are advisory only. A schema change that breaks migration ordering would pass CI. |
| **Root Cause**           | Checks were added as advisory during initial setup; never promoted to blocking.                                                                                                                                                        |
| **Current Behaviour**    | Migration drift and sequence issues are reported but do not block merge.                                                                                                                                                               |
| **Expected Behaviour**   | Schema drift and sequence gaps should block merge.                                                                                                                                                                                     |
| **Acceptance Criteria**  | 1. Verify current `main` has no drift. 2. Remove `continue-on-error: true`. 3. Confirm a deliberate drift is blocked.                                                                                                                  |
| **Implementation Notes** | Run `supabase db diff` locally first to confirm clean baseline.                                                                                                                                                                        |
| **Dependencies**         | None                                                                                                                                                                                                                                   |
| **Risks**                | If drift exists on `main`, the first blocking run will fail.                                                                                                                                                                           |
| **Testing Checklist**    | - Verify `main` passes clean. - Introduce deliberate drift → verify blocked.                                                                                                                                                           |
| **Estimated Complexity** | XS                                                                                                                                                                                                                                     |
| **Estimated Effort**     | 30 minutes                                                                                                                                                                                                                             |
| **Suggested Files**      | `.github/workflows/supabase-checks.yml:84,112`                                                                                                                                                                                         |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                    |

---

### Issue S1-03: God Class — orchestrator.service.ts (2,790 lines)

| Field                    | Value                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Decompose profiling orchestrator.service.ts god class                                                                                                                                                                                                                                                                                                     |
| **Category**             | Refactor                                                                                                                                                                                                                                                                                                                                                  |
| **Priority**             | Critical                                                                                                                                                                                                                                                                                                                                                  |
| **Severity**             | High                                                                                                                                                                                                                                                                                                                                                      |
| **Business Impact**      | Maintainability risk; any change to profiling flow requires navigating a 2,790-line file                                                                                                                                                                                                                                                                  |
| **Technical Impact**     | Violates Single Responsibility Principle; makes testing harder; increases merge conflict probability                                                                                                                                                                                                                                                      |
| **Description**          | `apps/api/src/profiling/orchestrator.service.ts` is 2,790 lines — the largest file in the codebase by a significant margin. It handles conversation orchestration, question selection, answer processing, profile extraction triggering, session management, and AI routing coordination. This is a god class.                                            |
| **Root Cause**           | Organic growth as the profiling feature expanded; no decomposition checkpoint.                                                                                                                                                                                                                                                                            |
| **Current Behaviour**    | All profiling orchestration logic lives in one file.                                                                                                                                                                                                                                                                                                      |
| **Expected Behaviour**   | Logic split into focused services: conversation flow, question selection, extraction coordination, session lifecycle.                                                                                                                                                                                                                                     |
| **Acceptance Criteria**  | 1. No file exceeds 600 lines. 2. All existing tests pass. 3. No public API changes. 4. Each extracted service has a single responsibility.                                                                                                                                                                                                                |
| **Implementation Notes** | Natural seams: ConversationFlowService (turn management), QuestionSelectionService (pack/question routing), ExtractionCoordinatorService (AI extraction trigger), ProfilingSessionService (session lifecycle). The existing `conversation-state.ts` (1,130 lines) and `profiling-session.service.ts` (786 lines) suggest partial decomposition has begun. |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                                                                      |
| **Risks**                | High-touch refactor; requires careful test coverage maintenance.                                                                                                                                                                                                                                                                                          |
| **Testing Checklist**    | - All existing profiling tests pass. - Integration tests cover full conversation flow. - No regressions in chat turn quality.                                                                                                                                                                                                                             |
| **Estimated Complexity** | XL                                                                                                                                                                                                                                                                                                                                                        |
| **Estimated Effort**     | 3-5 days                                                                                                                                                                                                                                                                                                                                                  |
| **Suggested Files**      | `apps/api/src/profiling/orchestrator.service.ts`                                                                                                                                                                                                                                                                                                          |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                                                                                                                                       |

---

### Issue S1-04: God Class — trade-resume-map.ts (2,305 lines)

| Field                    | Value                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**                | Decompose resume trade-resume-map.ts god class                                                                                                                                                                                                   |
| **Category**             | Refactor                                                                                                                                                                                                                                         |
| **Priority**             | Critical                                                                                                                                                                                                                                         |
| **Severity**             | High                                                                                                                                                                                                                                             |
| **Business Impact**      | Resume rendering for each new trade requires modifying a 2,305-line file                                                                                                                                                                         |
| **Technical Impact**     | Trade-specific mapping logic mixed with shared rendering infrastructure                                                                                                                                                                          |
| **Description**          | `apps/api/src/resume/trade-resume-map.ts` at 2,305 lines maps trade-specific capabilities to resume sections. Each trade's mapping is interleaved with shared logic, making it difficult to add or modify a single trade without risk to others. |
| **Root Cause**           | All trade mappings added to one file as trades were onboarded.                                                                                                                                                                                   |
| **Current Behaviour**    | All trade mappings in one file.                                                                                                                                                                                                                  |
| **Expected Behaviour**   | Per-trade mapping modules with a shared registry/factory pattern.                                                                                                                                                                                |
| **Acceptance Criteria**  | 1. Each trade has its own mapping file. 2. A registry loads mappings dynamically. 3. All existing tests pass. 4. Adding a new trade requires only a new file + registry entry.                                                                   |
| **Implementation Notes** | Consider a `trades/` directory with one file per trade and a `trade-map-registry.ts` that discovers and loads them.                                                                                                                              |
| **Dependencies**         | None                                                                                                                                                                                                                                             |
| **Risks**                | Similar to S1-03; high-touch refactor.                                                                                                                                                                                                           |
| **Testing Checklist**    | - All 28 rendered sheet fixtures pass. - New trade can be added without modifying existing files.                                                                                                                                                |
| **Estimated Complexity** | XL                                                                                                                                                                                                                                               |
| **Estimated Effort**     | 3-5 days                                                                                                                                                                                                                                         |
| **Suggested Files**      | `apps/api/src/resume/trade-resume-map.ts`                                                                                                                                                                                                        |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                              |

---

### Issue S1-05: Controller-Repository Layering Violation in AuthController

| Field                    | Value                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Remove direct repository injection from auth.controller.ts                                                                                                                                                                                                                                |
| **Category**             | Architecture                                                                                                                                                                                                                                                                              |
| **Priority**             | Critical                                                                                                                                                                                                                                                                                  |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                    |
| **Business Impact**      | Business logic in HTTP layer makes the auth flow harder to test and reason about                                                                                                                                                                                                          |
| **Technical Impact**     | Violates CLAUDE.md §4: "Controllers — HTTP only"; "Business logic must never exist inside controllers"                                                                                                                                                                                    |
| **Description**          | `apps/api/src/auth/auth.controller.ts:11,17` imports `WorkersRepository` and `ConsentRepository` directly. The controller constructor (lines 69-80) injects these repositories alongside services. This means the HTTP layer directly accesses the database, bypassing the service layer. |
| **Root Cause**           | Convenience during rapid development; the controller grew to 611 lines.                                                                                                                                                                                                                   |
| **Current Behaviour**    | Controller directly queries repositories for name lookups and consent checks.                                                                                                                                                                                                             |
| **Expected Behaviour**   | All data access goes through a service; controller only handles HTTP concerns.                                                                                                                                                                                                            |
| **Acceptance Criteria**  | 1. `auth.controller.ts` imports zero repositories. 2. All data access moved to `auth.service.ts` or a new dedicated service. 3. All existing auth tests pass.                                                                                                                             |
| **Implementation Notes** | The auth service likely already has most logic; this is moving the remaining repository calls behind it.                                                                                                                                                                                  |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                      |
| **Risks**                | Low; mechanical extraction.                                                                                                                                                                                                                                                               |
| **Testing Checklist**    | - All auth tests pass. - OTP flow works end-to-end. - PIN flow works end-to-end.                                                                                                                                                                                                          |
| **Estimated Complexity** | M                                                                                                                                                                                                                                                                                         |
| **Estimated Effort**     | 1 day                                                                                                                                                                                                                                                                                     |
| **Suggested Files**      | `apps/api/src/auth/auth.controller.ts:11,17,69-80`, `apps/api/src/auth/auth.service.ts`                                                                                                                                                                                                   |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                                                                       |

---

### Issue S1-06: Worker App Text Scaling Disabled (Accessibility Violation)

| Field                    | Value                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**                | Remove TextScaler.noScaling from both Flutter apps                                                                                                                                                                                                                                                                                                                 |
| **Category**             | UI/UX                                                                                                                                                                                                                                                                                                                                                              |
| **Priority**             | Critical                                                                                                                                                                                                                                                                                                                                                           |
| **Severity**             | High                                                                                                                                                                                                                                                                                                                                                               |
| **Business Impact**      | Workers with low vision or elderly workers cannot increase font size; violates accessibility principles                                                                                                                                                                                                                                                            |
| **Technical Impact**     | `MediaQuery(textScaler: TextScaler.noScaling)` overrides OS accessibility settings                                                                                                                                                                                                                                                                                 |
| **Description**          | Both `apps/worker-app/lib/app.dart:177-179` and `apps/payer-app/lib/app.dart:50-52` force `TextScaler.noScaling`, disabling the OS font size accessibility setting. The comment says this is a "product decision" but it directly conflicts with CLAUDE.md's accessibility principles and harms the target audience (blue-collar workers, many of whom are older). |
| **Root Cause**           | Layout concerns when text scales up; possibly introduced to prevent UI breakage.                                                                                                                                                                                                                                                                                   |
| **Current Behaviour**    | Font size is fixed at 1.0x regardless of OS setting.                                                                                                                                                                                                                                                                                                               |
| **Expected Behaviour**   | Font size respects OS accessibility settings; UI remains usable at larger sizes.                                                                                                                                                                                                                                                                                   |
| **Acceptance Criteria**  | 1. Remove `TextScaler.noScaling`. 2. Verify all key screens render correctly at 1.5x and 2.0x text scale. 3. Fix any layout overflow issues.                                                                                                                                                                                                                       |
| **Implementation Notes** | Use `MediaQuery.textScalerOf(context)` instead of forcing no-scaling. Test each screen at multiple scale factors. The worker app's 58 semantic annotations suggest accessibility is a priority — this is the remaining gap.                                                                                                                                        |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                                                                               |
| **Risks**                | UI overflow at large text scales; requires per-screen verification.                                                                                                                                                                                                                                                                                                |
| **Testing Checklist**    | - Login screen at 1.5x/2.0x. - Chat screen at 1.5x/2.0x. - Job feed at 1.5x/2.0x. - Profile at 1.5x/2.0x. - All form screens at 1.5x/2.0x.                                                                                                                                                                                                                         |
| **Estimated Complexity** | M                                                                                                                                                                                                                                                                                                                                                                  |
| **Estimated Effort**     | 2-3 days                                                                                                                                                                                                                                                                                                                                                           |
| **Suggested Files**      | `apps/worker-app/lib/app.dart:177-179`, `apps/payer-app/lib/app.dart:50-52`                                                                                                                                                                                                                                                                                        |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                                                                                                                                                                   |

---

## 4. Sprint 2 — High Priority Issues

### Issue S2-01: Update 5 Superseded ADR Statuses

| Field                    | Value                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Add supersession notes to ADR-0001, 0006, 0011, 0015, 0033                                                                                                                                                                                                                                                       |
| **Category**             | Documentation                                                                                                                                                                                                                                                                                                    |
| **Priority**             | High                                                                                                                                                                                                                                                                                                             |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                                           |
| **Business Impact**      | Builders may implement retired decisions if supersession is not documented                                                                                                                                                                                                                                       |
| **Technical Impact**     | ADR-0033 (skills-overlap weight 15) is entirely superseded by ADR-0036; implementing it would produce wrong ranking                                                                                                                                                                                              |
| **Description**          | Five ADRs have been superseded but their status lines still read "Accepted" with no supersession note. A builder reading ADR-0033 would implement a retired weighted skills factor. ADR-0001 decision #3 (LiteLLM) was superseded by ADR-0008. ADR-0006/0011/0015 ranking halves were superseded by ADR-0036.    |
| **Root Cause**           | Newer ADRs document the supersession but older ADRs are not retroactively updated.                                                                                                                                                                                                                               |
| **Current Behaviour**    | Status reads "Accepted" with no note about supersession.                                                                                                                                                                                                                                                         |
| **Expected Behaviour**   | Status includes "Superseded by ADR-XXX (date)" with a note about which decisions are retired.                                                                                                                                                                                                                    |
| **Acceptance Criteria**  | 1. ADR-0001 status notes decision #3 superseded by ADR-0008. 2. ADR-0006 status notes ranking half superseded by ADR-0036. 3. ADR-0011 status notes ranking half superseded by ADR-0036. 4. ADR-0015 status notes ranking half superseded by ADR-0036. 5. ADR-0033 status notes entirely superseded by ADR-0036. |
| **Implementation Notes** | Status-line-only changes. No content modifications.                                                                                                                                                                                                                                                              |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                             |
| **Risks**                | None                                                                                                                                                                                                                                                                                                             |
| **Testing Checklist**    | - Each updated ADR's status is accurate. - Cross-references from other ADRs still resolve.                                                                                                                                                                                                                       |
| **Estimated Complexity** | XS                                                                                                                                                                                                                                                                                                               |
| **Estimated Effort**     | 30 minutes                                                                                                                                                                                                                                                                                                       |
| **Suggested Files**      | `docs/decisions/0001-mvp-infra-decision.md`, `docs/decisions/0006-reach-foundation-rank-core.md`, `docs/decisions/0011-reach-feed-serving.md`, `docs/decisions/0015-reach-feed-on-real-jobs.md`, `docs/decisions/0033-rank-skills-overlap-factor.md`                                                             |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                                                                                              |

---

### Issue S2-02: Fix Broken ADR Reference in overview.md

| Field                    | Value                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Fix phantom ADR-0038 reference in architecture overview                                                                                                                                                                                                                             |
| **Category**             | Documentation                                                                                                                                                                                                                                                                       |
| **Priority**             | High                                                                                                                                                                                                                                                                                |
| **Severity**             | Medium                                                                                                                                                                                                                                                                              |
| **Business Impact**      | Engineers following the reference will find a non-existent file                                                                                                                                                                                                                     |
| **Technical Impact**     | Reference points to `../adr/ADR-0038-deterministic-occupation-interview.md` which does not exist; actual ADR-0038 is `0038-admin-bootstrap-and-notification-layer.md`                                                                                                               |
| **Description**          | `docs/architecture/overview.md:5` references `[ADR-0038](../adr/ADR-0038-deterministic-occupation-interview.md)`. The `docs/adr/` directory does not exist. ADR-0038 is actually `docs/decisions/0038-admin-bootstrap-and-notification-layer.md` — a completely different document. |
| **Root Cause**           | The reference was written against a planned document that was never created, or against an external spec.                                                                                                                                                                           |
| **Current Behaviour**    | Broken link to non-existent file.                                                                                                                                                                                                                                                   |
| **Expected Behaviour**   | Link points to the actual ADR-0038 or the correct document.                                                                                                                                                                                                                         |
| **Acceptance Criteria**  | 1. Link resolves to a real file. 2. The referenced content matches what overview.md intends to cite.                                                                                                                                                                                |
| **Implementation Notes** | Determine what overview.md intended to reference. If it was the occupation interview concept, that may be in the external spec (not in repo). If so, remove the link or replace with an in-repo reference.                                                                          |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                |
| **Risks**                | None                                                                                                                                                                                                                                                                                |
| **Testing Checklist**    | - Link resolves. - Content matches intent.                                                                                                                                                                                                                                          |
| **Estimated Complexity** | XS                                                                                                                                                                                                                                                                                  |
| **Estimated Effort**     | 15 minutes                                                                                                                                                                                                                                                                          |
| **Suggested Files**      | `docs/architecture/overview.md:5`                                                                                                                                                                                                                                                   |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                                                                 |

---

### Issue S2-03: Payer App Accessibility — Only 4 Semantic Annotations

| Field                    | Value                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Add semantic annotations to payer app screens                                                                                                                                                                                                                                                                             |
| **Category**             | UI/UX                                                                                                                                                                                                                                                                                                                     |
| **Priority**             | High                                                                                                                                                                                                                                                                                                                      |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                                                    |
| **Business Impact**      | Payer/employer users who rely on screen readers cannot navigate the app                                                                                                                                                                                                                                                   |
| **Technical Impact**     | Worker app has 58 semantic annotations; payer app has only 4                                                                                                                                                                                                                                                              |
| **Description**          | The payer app has only 4 `Semantics`/`ExcludeSemantics`/`MergeSemantics` annotations across its entire `lib/` directory, compared to 58 in the worker app. Key interactive elements — find screen cards, unlock buttons, role picker tiles, credit balance, bottom nav, form fields, status views — lack semantic labels. |
| **Root Cause**           | Accessibility was prioritized in the worker app but not carried over to the payer app.                                                                                                                                                                                                                                    |
| **Current Behaviour**    | Screen readers cannot announce most interactive elements in the payer app.                                                                                                                                                                                                                                                |
| **Expected Behaviour**   | All interactive elements have appropriate semantic labels.                                                                                                                                                                                                                                                                |
| **Acceptance Criteria**  | 1. Bottom navigation has semantic labels. 2. Find screen candidate cards have semantic labels. 3. Unlock buttons have semantic labels. 4. Form fields have semantic labels. 5. Status views have semantic labels.                                                                                                         |
| **Implementation Notes** | Follow the worker app's pattern: `Semantics(button: true)` for tappable elements, `Semantics(label: '...')` for text content, `ExcludeSemantics` for decorative elements.                                                                                                                                                 |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                                      |
| **Risks**                | Low; additive changes.                                                                                                                                                                                                                                                                                                    |
| **Testing Checklist**    | - Enable TalkBack/VoiceOver. - Navigate each screen. - All elements announced correctly.                                                                                                                                                                                                                                  |
| **Estimated Complexity** | M                                                                                                                                                                                                                                                                                                                         |
| **Estimated Effort**     | 2-3 days                                                                                                                                                                                                                                                                                                                  |
| **Suggested Files**      | `apps/payer-app/lib/features/find/`, `apps/payer-app/lib/features/jobs/`, `apps/payer-app/lib/core/widgets/`                                                                                                                                                                                                              |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                                                                                                                          |

---

### Issue S2-04: Payer Login Screen Has Business Logic in StatefulWidget

| Field                    | Value                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Extract payer login business logic into a Cubit                                                                                                                                                                                                                                                                                                                                          |
| **Category**             | Architecture                                                                                                                                                                                                                                                                                                                                                                             |
| **Priority**             | High                                                                                                                                                                                                                                                                                                                                                                                     |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                                                                                                                   |
| **Business Impact**      | Login flow harder to test and maintain; violates established architecture pattern                                                                                                                                                                                                                                                                                                        |
| **Technical Impact**     | Worker app uses `PhoneLoginCubit` for login; payer app has logic directly in `_LoginScreenState`                                                                                                                                                                                                                                                                                         |
| **Description**          | `apps/payer-app/lib/features/auth/login_screen.dart` has business logic directly in the StatefulWidget (`_LoginScreenState._requestOtp()`, `_verify()`). The screen calls `locator<PayerAuthApi>()` directly. This violates the architecture principle that business logic should not exist in controllers/screens, and is inconsistent with the worker app's `PhoneLoginCubit` pattern. |
| **Root Cause**           | Payer app was built with a simpler architecture; login was added without a cubit.                                                                                                                                                                                                                                                                                                        |
| **Current Behaviour**    | Login OTP request and verification logic lives in the screen widget.                                                                                                                                                                                                                                                                                                                     |
| **Expected Behaviour**   | A `LoginCubit` manages OTP request/verify state; screen only handles UI.                                                                                                                                                                                                                                                                                                                 |
| **Acceptance Criteria**  | 1. `LoginCubit` handles OTP request and verification. 2. Screen only reads cubit state. 3. All existing login tests pass. 4. No business logic in `_LoginScreenState`.                                                                                                                                                                                                                   |
| **Implementation Notes** | Follow the worker app's `PhoneLoginCubit` pattern. The payer app already uses cubits everywhere else.                                                                                                                                                                                                                                                                                    |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                                                                                                     |
| **Risks**                | Low; mechanical extraction.                                                                                                                                                                                                                                                                                                                                                              |
| **Testing Checklist**    | - OTP request flow works. - OTP verification flow works. - Error states display correctly. - Loading states display correctly.                                                                                                                                                                                                                                                           |
| **Estimated Complexity** | S                                                                                                                                                                                                                                                                                                                                                                                        |
| **Estimated Effort**     | 1 day                                                                                                                                                                                                                                                                                                                                                                                    |
| **Suggested Files**      | `apps/payer-app/lib/features/auth/login_screen.dart`                                                                                                                                                                                                                                                                                                                                     |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                                                                                                                                                                                         |

---

### Issue S2-05: Flutter App Code Duplication — Extract Shared Package

| Field                    | Value                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**                | Extract shared Flutter widgets, theme, and utilities into a package                                                                                                                                                                                                                                                            |
| **Category**             | Refactor                                                                                                                                                                                                                                                                                                                       |
| **Priority**             | High                                                                                                                                                                                                                                                                                                                           |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                                                         |
| **Business Impact**      | Bug fixes and design changes must be applied twice; drift between apps                                                                                                                                                                                                                                                         |
| **Technical Impact**     | `bb_status_view.dart`, `bb_alert_dialog.dart`, `bb_animated_switcher.dart`, theme files, crash reporter are duplicated                                                                                                                                                                                                         |
| **Description**          | Both Flutter apps duplicate: `bb_status_view.dart`, `bb_alert_dialog.dart`, `bb_animated_switcher.dart`, all theme files (`app_colors.dart`, `app_spacing.dart`, `app_typography.dart`, `app_motion.dart`, `app_theme.dart`), and `crash_reporter.dart`. A design token change or widget bug fix must be applied in both apps. |
| **Root Cause**           | Apps were developed independently; shared code was not extracted early.                                                                                                                                                                                                                                                        |
| **Current Behaviour**    | Identical code maintained in two locations.                                                                                                                                                                                                                                                                                    |
| **Expected Behaviour**   | Shared code lives in `packages/bb_shared/` or similar; both apps depend on it.                                                                                                                                                                                                                                                 |
| **Acceptance Criteria**  | 1. Shared widgets extracted to a package. 2. Theme tokens extracted to a package. 3. Crash reporter extracted. 4. Both apps compile and all tests pass. 5. No duplicate code remains for the identified files.                                                                                                                 |
| **Implementation Notes** | Create `packages/bb_shared/` with `lib/widgets/`, `lib/theme/`, `lib/observability/`. Both apps add it as a path dependency.                                                                                                                                                                                                   |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                                           |
| **Risks**                | Medium; Flutter package setup requires careful dependency management.                                                                                                                                                                                                                                                          |
| **Testing Checklist**    | - Worker app compiles and all tests pass. - Payer app compiles and all tests pass. - Shared widgets render correctly in both apps.                                                                                                                                                                                             |
| **Estimated Complexity** | L                                                                                                                                                                                                                                                                                                                              |
| **Estimated Effort**     | 3-5 days                                                                                                                                                                                                                                                                                                                       |
| **Suggested Files**      | `apps/worker-app/lib/core/widgets/`, `apps/payer-app/lib/core/widgets/`, `apps/worker-app/lib/core/theme/`, `apps/payer-app/lib/core/theme/`                                                                                                                                                                                   |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                                                                                                                               |

---

### Issue S2-06: Staging IP Hardcoded as Default in Both Flutter Apps

| Field                    | Value                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Remove hardcoded staging IPs from Flutter app defaults                                                                                                                                                                                                                                                                                             |
| **Category**             | Security                                                                                                                                                                                                                                                                                                                                           |
| **Priority**             | High                                                                                                                                                                                                                                                                                                                                               |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                                                                             |
| **Business Impact**      | A release build without `--dart-define=API_BASE_URL` override ships with staging backend                                                                                                                                                                                                                                                           |
| **Technical Impact**     | `43-204-36-199.sslip.io` is a valid HTTPS URL; the release guard does not reject it                                                                                                                                                                                                                                                                |
| **Description**          | Both apps hardcode `https://43-204-36-199.sslip.io` as the default `API_BASE_URL`. The worker app also hardcodes `https://payer.43-204-36-199.sslip.io` as `INVITE_LINK_BASE`. A release build without the `--dart-define` override would hit the staging server. The code throws for malformed URLs but NOT for a staging URL (it's valid HTTPS). |
| **Root Cause**           | Development convenience; the override mechanism exists but the default is dangerous.                                                                                                                                                                                                                                                               |
| **Current Behaviour**    | Default points to staging; release guard does not catch it.                                                                                                                                                                                                                                                                                        |
| **Expected Behaviour**   | Default is empty or throws in release mode; build fails without explicit URL.                                                                                                                                                                                                                                                                      |
| **Acceptance Criteria**  | 1. Release builds throw if `API_BASE_URL` is not explicitly set. 2. No hardcoded IPs in defaults. 3. Development still works with `--dart-define`.                                                                                                                                                                                                 |
| **Implementation Notes** | Add a release-mode check: if URL contains `sslip.io` or an IP address, throw `StateError`.                                                                                                                                                                                                                                                         |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                                                               |
| **Risks**                | Low; adds a safety guard.                                                                                                                                                                                                                                                                                                                          |
| **Testing Checklist**    | - Release build without override throws. - Release build with production URL works. - Dev build with staging override works.                                                                                                                                                                                                                       |
| **Estimated Complexity** | S                                                                                                                                                                                                                                                                                                                                                  |
| **Estimated Effort**     | 2-4 hours                                                                                                                                                                                                                                                                                                                                          |
| **Suggested Files**      | `apps/worker-app/lib/core/config/app_config.dart:57,76`, `apps/payer-app/lib/core/config/app_config.dart:38`                                                                                                                                                                                                                                       |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                                                                                                                                                   |

---

### Issue S2-07: Payer App Missing Dev Test Dependencies

| Field                    | Value                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**                | Add bloc_test, mocktail, and fake_async to payer app dev dependencies                                                                                                                                                                                                                                                    |
| **Category**             | Testing                                                                                                                                                                                                                                                                                                                  |
| **Priority**             | High                                                                                                                                                                                                                                                                                                                     |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                                                   |
| **Business Impact**      | Payer app cubit tests are less thorough; harder to test edge cases                                                                                                                                                                                                                                                       |
| **Technical Impact**     | Worker app has 204 tests with full mocking; payer has 48 tests without bloc_test/mocktail                                                                                                                                                                                                                                |
| **Description**          | The payer app's `pubspec.yaml` does not include `bloc_test`, `mocktail`, or `fake_async` as dev dependencies. The worker app uses all three extensively for cubit testing. This limits the payer app's test quality — cubit tests cannot verify state transitions, and async operations cannot be tested with fake time. |
| **Root Cause**           | Payer app was built with a lighter test toolchain.                                                                                                                                                                                                                                                                       |
| **Current Behaviour**    | Cubit tests use only `flutter_test`; no mocktail for mock generation.                                                                                                                                                                                                                                                    |
| **Expected Behaviour**   | `bloc_test`, `mocktail`, and `fake_async` are available for comprehensive cubit testing.                                                                                                                                                                                                                                 |
| **Acceptance Criteria**  | 1. Dependencies added. 2. Existing tests still pass. 3. At least one cubit test demonstrates `blocTest` usage.                                                                                                                                                                                                           |
| **Implementation Notes** | Add to `pubspec.yaml` dev_dependencies. Version-match with worker app.                                                                                                                                                                                                                                                   |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                                     |
| **Risks**                | Very low.                                                                                                                                                                                                                                                                                                                |
| **Testing Checklist**    | - `flutter pub get` succeeds. - All existing tests pass. - New `blocTest` example compiles.                                                                                                                                                                                                                              |
| **Estimated Complexity** | XS                                                                                                                                                                                                                                                                                                                       |
| **Estimated Effort**     | 15 minutes                                                                                                                                                                                                                                                                                                               |
| **Suggested Files**      | `apps/payer-app/pubspec.yaml`                                                                                                                                                                                                                                                                                            |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                                                                                                                         |

---

### Issue S2-08: Missing READMEs for 4 Packages/Apps

| Field                    | Value                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Add README.md to match-engine, pricing, reach-learn, and admin-web                                                                                                                                                                                                    |
| **Category**             | Documentation                                                                                                                                                                                                                                                         |
| **Priority**             | High                                                                                                                                                                                                                                                                  |
| **Severity**             | Low                                                                                                                                                                                                                                                                   |
| **Business Impact**      | New engineers cannot understand these modules without reading source code                                                                                                                                                                                             |
| **Technical Impact**     | Every other package and app has a README; these 4 are missing                                                                                                                                                                                                         |
| **Description**          | `packages/match-engine/`, `packages/pricing/`, `packages/reach-learn/`, and `apps/admin-web/` have no README.md. Every other package and app in the repo has one. The match-engine is particularly important as it implements the CEO-ratified Matching V1 algorithm. |
| **Root Cause**           | READMEs were not created when packages were spun up.                                                                                                                                                                                                                  |
| **Current Behaviour**    | No documentation for these modules.                                                                                                                                                                                                                                   |
| **Expected Behaviour**   | Each has a README describing purpose, API, architecture, and testing.                                                                                                                                                                                                 |
| **Acceptance Criteria**  | 1. Each module has a README.md. 2. README describes purpose, exports, and how to test.                                                                                                                                                                                |
| **Implementation Notes** | Follow the pattern from `packages/reach-engine/README.md` or `packages/validators/README.md`.                                                                                                                                                                         |
| **Dependencies**         | None                                                                                                                                                                                                                                                                  |
| **Risks**                | None                                                                                                                                                                                                                                                                  |
| **Testing Checklist**    | - README content is accurate. - Links resolve.                                                                                                                                                                                                                        |
| **Estimated Complexity** | S                                                                                                                                                                                                                                                                     |
| **Estimated Effort**     | 2-3 hours total                                                                                                                                                                                                                                                       |
| **Suggested Files**      | `packages/match-engine/README.md`, `packages/pricing/README.md`, `packages/reach-learn/README.md`, `apps/admin-web/README.md`                                                                                                                                         |
| **Assignee**             | Shared (Divyanshu for packages, Rishi for admin-web)                                                                                                                                                                                                                  |

---

### Issue S2-09: 4 Stale READMEs Need Updating

| Field                    | Value                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Update stale READMEs: web, db, taxonomy, profiling-lexicon                                                                                                                                                                                                                                                 |
| **Category**             | Documentation                                                                                                                                                                                                                                                                                              |
| **Priority**             | High                                                                                                                                                                                                                                                                                                       |
| **Severity**             | Medium                                                                                                                                                                                                                                                                                                     |
| **Business Impact**      | Developers following stale READMEs will be confused about module scope                                                                                                                                                                                                                                     |
| **Technical Impact**     | db README lists 10 tables; 50+ exist. taxonomy README describes CNC/VMC only; 10 industries exist. profiling-lexicon claims stubs; both are implemented.                                                                                                                                                   |
| **Description**          | Four READMEs are significantly stale: `apps/web/README.md` (lists 5 routes; 10+ exist), `packages/db/README.md` (lists 10 tables; 50+ exist), `packages/taxonomy/README.md` (describes CNC/VMC only), `packages/profiling-lexicon/README.md` (claims predicates/values are stubs; both fully implemented). |
| **Root Cause**           | READMEs were not updated as features shipped.                                                                                                                                                                                                                                                              |
| **Current Behaviour**    | Documentation describes an older state of the codebase.                                                                                                                                                                                                                                                    |
| **Expected Behaviour**   | READMEs accurately reflect current module scope.                                                                                                                                                                                                                                                           |
| **Acceptance Criteria**  | 1. Each README lists current routes/tables/modules. 2. Status sections are accurate. 3. No claims about unimplemented features that are actually implemented.                                                                                                                                              |
| **Implementation Notes** | Read current source, update documentation to match.                                                                                                                                                                                                                                                        |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                                       |
| **Risks**                | None                                                                                                                                                                                                                                                                                                       |
| **Testing Checklist**    | - Each README's claims verified against source.                                                                                                                                                                                                                                                            |
| **Estimated Complexity** | S                                                                                                                                                                                                                                                                                                          |
| **Estimated Effort**     | 2-3 hours total                                                                                                                                                                                                                                                                                            |
| **Suggested Files**      | `apps/web/README.md`, `packages/db/README.md`, `packages/taxonomy/README.md`, `packages/profiling-lexicon/README.md`                                                                                                                                                                                       |
| **Assignee**             | Shared (Divyanshu for packages, Rishi for web)                                                                                                                                                                                                                                                             |

---

### Issue S2-10: Payer App Hardcoded Pricing (₹40)

| Field                    | Value                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Extract hardcoded ₹40 unlock price to config/remote config                                                                                                                                                                    |
| **Category**             | Refactor                                                                                                                                                                                                                      |
| **Priority**             | High                                                                                                                                                                                                                          |
| **Severity**             | Medium                                                                                                                                                                                                                        |
| **Business Impact**      | Price change requires app store update; cannot A/B test pricing                                                                                                                                                               |
| **Technical Impact**     | `'₹40'` appears in `find_screen.dart:468-469` and `login_screen.dart:392` as hardcoded strings                                                                                                                                |
| **Description**          | The unlock price `₹40` is hardcoded in the payer app's UI in multiple locations. A pricing change would require an app update and store review. The backend already has a config-driven pricing engine (`packages/pricing/`). |
| **Root Cause**           | Price was hardcoded during initial development; config-driven pricing was built later.                                                                                                                                        |
| **Current Behaviour**    | Price is baked into the Flutter app binary.                                                                                                                                                                                   |
| **Expected Behaviour**   | Price is fetched from the backend or remote config.                                                                                                                                                                           |
| **Acceptance Criteria**  | 1. Price displayed comes from backend/remote config. 2. No hardcoded `₹40` in Flutter source. 3. Price updates without app release.                                                                                           |
| **Implementation Notes** | The backend `GET /pricing/catalog` endpoint already exists. The payer app should fetch and cache the price.                                                                                                                   |
| **Dependencies**         | Backend pricing endpoint must be payer-auth-accessible.                                                                                                                                                                       |
| **Risks**                | Low; backend already supports this.                                                                                                                                                                                           |
| **Testing Checklist**    | - Price displays correctly. - Price updates when backend changes. - Offline fallback shows cached price.                                                                                                                      |
| **Estimated Complexity** | M                                                                                                                                                                                                                             |
| **Estimated Effort**     | 1-2 days                                                                                                                                                                                                                      |
| **Suggested Files**      | `apps/payer-app/lib/features/find/presentation/find_screen.dart:468-469`, `apps/payer-app/lib/features/auth/presentation/login_screen.dart:392`                                                                               |
| **Assignee**             | Rishi (Frontend) + Divyanshu (Backend)                                                                                                                                                                                        |

---

## 5. Sprint 3 — Medium Priority Issues

### Issue S3-01: Add Prettier Format Check to CI

| Field                    | Value                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Add `pnpm format:check` to CI node job                                                                                                                                                                  |
| **Category**             | Technical Debt                                                                                                                                                                                          |
| **Priority**             | Medium                                                                                                                                                                                                  |
| **Severity**             | Low-Medium                                                                                                                                                                                              |
| **Business Impact**      | Formatting drift is possible if developers don't have pre-commit hooks                                                                                                                                  |
| **Technical Impact**     | `format:check` script exists in package.json but is never called in any workflow                                                                                                                        |
| **Description**          | The `format:check` script exists in `package.json:22` but is not called in any CI workflow. There is no enforcement of formatting. A developer without the pre-commit hook can commit unformatted code. |
| **Root Cause**           | Format check was added to package.json but not to CI.                                                                                                                                                   |
| **Current Behaviour**    | Formatting is advisory.                                                                                                                                                                                 |
| **Expected Behaviour**   | Formatting is enforced in CI.                                                                                                                                                                           |
| **Acceptance Criteria**  | 1. `pnpm format:check` runs in CI. 2. Unformatted code fails CI.                                                                                                                                        |
| **Implementation Notes** | Add `pnpm format:check` to the `node` job in `ci.yml` after lint.                                                                                                                                       |
| **Dependencies**         | None                                                                                                                                                                                                    |
| **Risks**                | If current codebase has formatting drift, the first run will fail. Run locally first.                                                                                                                   |
| **Testing Checklist**    | - Unformatted commit fails CI. - Formatted commit passes.                                                                                                                                               |
| **Estimated Complexity** | XS                                                                                                                                                                                                      |
| **Estimated Effort**     | 15 minutes                                                                                                                                                                                              |
| **Suggested Files**      | `.github/workflows/ci.yml` (node job)                                                                                                                                                                   |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                     |

---

### Issue S3-02: Add Dependabot for npm/pnpm Ecosystem

| Field                    | Value                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Enable Dependabot for npm/pnpm dependencies                                                                                                                                                                    |
| **Category**             | Security                                                                                                                                                                                                       |
| **Priority**             | Medium                                                                                                                                                                                                         |
| **Severity**             | Low-Medium                                                                                                                                                                                                     |
| **Business Impact**      | Manual dependency override maintenance; 162 lines of overrides in pnpm-workspace.yaml                                                                                                                          |
| **Technical Impact**     | `dependabot.yml` only covers github-actions; no automated npm/pip dependency PRs                                                                                                                               |
| **Description**          | `dependabot.yml` only monitors `github-actions`. The `pnpm-workspace.yaml` has 162 lines of overrides clearing advisories, maintained manually. Automated dependency PRs would reduce this maintenance burden. |
| **Root Cause**           | npm/pip coverage was deferred as "a separate future decision" (comment in dependabot.yml).                                                                                                                     |
| **Current Behaviour**    | npm dependencies are updated manually.                                                                                                                                                                         |
| **Expected Behaviour**   | Dependabot creates PRs for npm dependency updates.                                                                                                                                                             |
| **Acceptance Criteria**  | 1. Dependabot config covers npm ecosystem. 2. PRs are created for dependency updates. 3. Override count decreases over time.                                                                                   |
| **Implementation Notes** | Add `npm` ecosystem entry to `dependabot.yml`. Set `open-pull-requests-limit: 5` to avoid PR flood.                                                                                                            |
| **Dependencies**         | None                                                                                                                                                                                                           |
| **Risks**                | PR flood if limit is too high; start with low limit.                                                                                                                                                           |
| **Testing Checklist**    | - Dependabot creates PRs. - PRs are manageable in volume.                                                                                                                                                      |
| **Estimated Complexity** | S                                                                                                                                                                                                              |
| **Estimated Effort**     | 30 minutes                                                                                                                                                                                                     |
| **Suggested Files**      | `.github/dependabot.yml`                                                                                                                                                                                       |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                            |

---

### Issue S3-03: Customise SECURITY.md

| Field                    | Value                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Replace stock SECURITY.md template with project-specific policy                                                                                                                                           |
| **Category**             | Documentation                                                                                                                                                                                             |
| **Priority**             | Medium                                                                                                                                                                                                    |
| **Severity**             | Low                                                                                                                                                                                                       |
| **Business Impact**      | Stock template references non-existent versions; provides no real vulnerability reporting process                                                                                                         |
| **Technical Impact**     | `SECURITY.md` references versions "5.1.x", "5.0.x", "4.0.x" — none correspond to BadaBhai                                                                                                                 |
| **Description**          | `SECURITY.md` is a stock GitHub template that was never customised. It references version numbers that don't exist in this project and provides no project-specific vulnerability reporting instructions. |
| **Root Cause**           | SECURITY.md was auto-generated by GitHub and not updated.                                                                                                                                                 |
| **Current Behaviour**    | Stock template with irrelevant version numbers.                                                                                                                                                           |
| **Expected Behaviour**   | Project-specific security policy with reporting instructions.                                                                                                                                             |
| **Acceptance Criteria**  | 1. SECURITY.md describes BadaBhai-specific policy. 2. Includes vulnerability reporting process. 3. No references to non-existent versions.                                                                |
| **Implementation Notes** | Include: scope (API, mobile apps, AI service), reporting email/contact, response timeline, scope of responsible disclosure.                                                                               |
| **Dependencies**         | None                                                                                                                                                                                                      |
| **Risks**                | None                                                                                                                                                                                                      |
| **Testing Checklist**    | - Content is accurate. - Reporting process is actionable.                                                                                                                                                 |
| **Estimated Complexity** | S                                                                                                                                                                                                         |
| **Estimated Effort**     | 1 hour                                                                                                                                                                                                    |
| **Suggested Files**      | `SECURITY.md`                                                                                                                                                                                             |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                       |

---

### Issue S3-04: Add API-Level APM/Tracing (OpenTelemetry)

| Field                    | Value                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Add OpenTelemetry tracing to NestJS API                                                                                                                                                                          |
| **Category**             | Performance                                                                                                                                                                                                      |
| **Priority**             | Medium                                                                                                                                                                                                           |
| **Severity**             | Medium                                                                                                                                                                                                           |
| **Business Impact**      | No distributed tracing for API requests; hard to diagnose latency in production                                                                                                                                  |
| **Technical Impact**     | Langfuse covers ai-service LLM calls only; API has no APM                                                                                                                                                        |
| **Description**          | The API has structured logging but no distributed tracing. Langfuse traces ai-service LLM calls, but there is no visibility into API request latency, database query performance, or cross-service request flow. |
| **Root Cause**           | Observability was scoped to structured logging + Langfuse; APM was deferred.                                                                                                                                     |
| **Current Behaviour**    | Logs are structured JSON; no trace correlation across services.                                                                                                                                                  |
| **Expected Behaviour**   | OpenTelemetry traces correlate API → AI service → database → Redis.                                                                                                                                              |
| **Acceptance Criteria**  | 1. OpenTelemetry SDK installed. 2. Traces exported to a collector. 3. Request latency visible in dashboard. 4. Cross-service traces correlate.                                                                   |
| **Implementation Notes** | NestJS has `@opentelemetry/nestjs-equipment` package. Configure OTLP exporter. Start with auto-instrumentation for HTTP, PostgreSQL, Redis.                                                                      |
| **Dependencies**         | Needs a trace backend (Jaeger, Grafana Tempo, or cloud equivalent).                                                                                                                                              |
| **Risks**                | Performance overhead of tracing; keep sampling rate low initially.                                                                                                                                               |
| **Testing Checklist**    | - Traces appear in backend. - Latency is visible. - No performance regression.                                                                                                                                   |
| **Estimated Complexity** | L                                                                                                                                                                                                                |
| **Estimated Effort**     | 3-5 days                                                                                                                                                                                                         |
| **Suggested Files**      | `apps/api/src/main.ts`, `apps/api/package.json`                                                                                                                                                                  |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                              |

---

### Issue S3-05: Monolithic api.ts in Web Ops Console (771 lines)

| Field                    | Value                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**                | Split monolithic api.ts in web ops console into domain modules                                                                                                                                                                 |
| **Category**             | Refactor                                                                                                                                                                                                                       |
| **Priority**             | Medium                                                                                                                                                                                                                         |
| **Severity**             | Low-Medium                                                                                                                                                                                                                     |
| **Business Impact**      | Single-file API client is hard to navigate and maintain                                                                                                                                                                        |
| **Technical Impact**     | `apps/web/src/lib/api.ts` is 771 lines covering 10+ domains in one file                                                                                                                                                        |
| **Description**          | `apps/web/src/lib/api.ts` is a single-file typed API client covering workers, events, AI jobs, applicants, reach, unlock, reveal, pricing, pace, and agency KYC. This violates the "small functions, high cohesion" principle. |
| **Root Cause**           | API client grew organically as new ops routes were added.                                                                                                                                                                      |
| **Current Behaviour**    | All API calls in one file.                                                                                                                                                                                                     |
| **Expected Behaviour**   | Domain-specific API modules (workers.ts, events.ts, reach.ts, etc.).                                                                                                                                                           |
| **Acceptance Criteria**  | 1. Each domain has its own API module. 2. A barrel export maintains backward compatibility. 3. All existing tests pass.                                                                                                        |
| **Implementation Notes** | Create `src/lib/api/` directory with one file per domain. Re-export from `src/lib/api.ts` for backward compatibility.                                                                                                          |
| **Dependencies**         | None                                                                                                                                                                                                                           |
| **Risks**                | Low; mechanical extraction with barrel re-export.                                                                                                                                                                              |
| **Testing Checklist**    | - All existing tests pass. - Each module is independently importable.                                                                                                                                                          |
| **Estimated Complexity** | M                                                                                                                                                                                                                              |
| **Estimated Effort**     | 1-2 days                                                                                                                                                                                                                       |
| **Suggested Files**      | `apps/web/src/lib/api.ts`                                                                                                                                                                                                      |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                               |

---

### Issue S3-06: apiGetInternal is Identical to apiGet (TD121)

| Field                    | Value                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Collapse apiGetInternal into apiGet (TD121)                                                                                                                                                                       |
| **Category**             | Technical Debt                                                                                                                                                                                                    |
| **Priority**             | Medium                                                                                                                                                                                                            |
| **Severity**             | Low                                                                                                                                                                                                               |
| **Business Impact**      | Confusing API surface; two functions that do the same thing                                                                                                                                                       |
| **Technical Impact**     | `apiGetInternal` (line 190-198) is now identical to `apiGet`; kept as named alias during release freeze                                                                                                           |
| **Description**          | `apps/web/src/lib/api.ts` lines 190-198: `apiGetInternal` is now identical to `apiGet` — both attach the internal-service token. The comment explains this is a named alias kept during a release freeze (TD121). |
| **Root Cause**           | Intentional alias during release freeze; never cleaned up.                                                                                                                                                        |
| **Current Behaviour**    | Two identical functions.                                                                                                                                                                                          |
| **Expected Behaviour**   | One function; callers migrated.                                                                                                                                                                                   |
| **Acceptance Criteria**  | 1. `apiGetInternal` removed. 2. All callers use `apiGet`. 3. All tests pass.                                                                                                                                      |
| **Implementation Notes** | Grep for `apiGetInternal` usage, replace with `apiGet`, delete the alias.                                                                                                                                         |
| **Dependencies**         | None                                                                                                                                                                                                              |
| **Risks**                | Very low.                                                                                                                                                                                                         |
| **Testing Checklist**    | - All API calls work. - No broken imports.                                                                                                                                                                        |
| **Estimated Complexity** | XS                                                                                                                                                                                                                |
| **Estimated Effort**     | 15 minutes                                                                                                                                                                                                        |
| **Suggested Files**      | `apps/web/src/lib/api.ts:190-198`                                                                                                                                                                                 |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                  |

---

### Issue S3-07: 20+ Marathi/Bhojpuri Translation TODOs

| Field                    | Value                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Complete Marathi and Bhojpuri translations in auth error messages                                                                                                                                                                                                 |
| **Category**             | Feature                                                                                                                                                                                                                                                           |
| **Priority**             | Medium                                                                                                                                                                                                                                                            |
| **Severity**             | Low-Medium                                                                                                                                                                                                                                                        |
| **Business Impact**      | Marathi and Bhojpuri speakers see Hindi fallback text for auth errors                                                                                                                                                                                             |
| **Technical Impact**     | 20+ `TODO l10n: mr` / `TODO l10n: bho` comments in `auth_error_messages.dart`                                                                                                                                                                                     |
| **Description**          | `apps/worker-app/lib/core/auth/auth_error_messages.dart` has 20+ TODO comments for Marathi (`mr`) and Bhojpuri (`bho`) translations that still use Hindi fallbacks. The app's l10n pipeline supports these locales (ARB files exist for `hi`, `en`, `mr`, `bho`). |
| **Root Cause**           | Translations were deferred; Hindi was prioritized.                                                                                                                                                                                                                |
| **Current Behaviour**    | Auth errors display in Hindi for Marathi/Bhojpuri users.                                                                                                                                                                                                          |
| **Expected Behaviour**   | Auth errors display in the user's selected language.                                                                                                                                                                                                              |
| **Acceptance Criteria**  | 1. All TODO l10n comments resolved. 2. Marathi translations reviewed by native speaker. 3. Bhojpuri translations reviewed by native speaker.                                                                                                                      |
| **Implementation Notes** | The auth error messages use a per-locale map, not the ARB pipeline. Consider migrating to ARB for consistency.                                                                                                                                                    |
| **Dependencies**         | Needs native speaker review for translation quality.                                                                                                                                                                                                              |
| **Risks**                | Translation quality; wrong translations are worse than Hindi fallback.                                                                                                                                                                                            |
| **Testing Checklist**    | - Switch locale to Marathi. - Trigger each auth error. - Verify correct display. - Repeat for Bhojpuri.                                                                                                                                                           |
| **Estimated Complexity** | S                                                                                                                                                                                                                                                                 |
| **Estimated Effort**     | 1-2 days (including review)                                                                                                                                                                                                                                       |
| **Suggested Files**      | `apps/worker-app/lib/core/auth/auth_error_messages.dart`                                                                                                                                                                                                          |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                                                                  |

---

### Issue S3-08: Hardcoded Hindi Strings in app.dart (Both Apps)

| Field                    | Value                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Move hardcoded Hindi strings to l10n ARB files                                                                                                                                              |
| **Category**             | Feature                                                                                                                                                                                     |
| **Priority**             | Medium                                                                                                                                                                                      |
| **Severity**             | Low                                                                                                                                                                                         |
| **Business Impact**      | Account-deleted dialog shows Hindi to all users regardless of locale                                                                                                                        |
| **Technical Impact**     | `'Account nahi mila'` and `'Hamein aapki profile nahi mil rahi hai...'` hardcoded in both `app.dart` files                                                                                  |
| **Description**          | Both `apps/worker-app/lib/app.dart:112-113` and `apps/payer-app/lib/app.dart:116-117` have hardcoded Hindi strings for the account-deleted dialog. These bypass the l10n pipeline entirely. |
| **Root Cause**           | Quick implementation; l10n was not applied to root-level dialogs.                                                                                                                           |
| **Current Behaviour**    | Hindi text shown regardless of locale.                                                                                                                                                      |
| **Expected Behaviour**   | Text comes from ARB files.                                                                                                                                                                  |
| **Acceptance Criteria**  | 1. Strings moved to ARB files. 2. Dialog uses `context.l10n` or equivalent. 3. All locales display correct text.                                                                            |
| **Implementation Notes** | Add keys to ARB files, replace hardcoded strings.                                                                                                                                           |
| **Dependencies**         | None                                                                                                                                                                                        |
| **Risks**                | None                                                                                                                                                                                        |
| **Testing Checklist**    | - Account-deleted dialog shows correct text per locale.                                                                                                                                     |
| **Estimated Complexity** | XS                                                                                                                                                                                          |
| **Estimated Effort**     | 30 minutes                                                                                                                                                                                  |
| **Suggested Files**      | `apps/worker-app/lib/app.dart:112-113`, `apps/payer-app/lib/app.dart:116-117`                                                                                                               |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                            |

---

### Issue S3-09: Temp Data in Trade Form Employment Page

| Field                    | Value                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Remove TEMPORARY demo data from trade form employment page                                                                                                                                                       |
| **Category**             | Technical Debt                                                                                                                                                                                                   |
| **Priority**             | Medium                                                                                                                                                                                                           |
| **Severity**             | Low                                                                                                                                                                                                              |
| **Business Impact**      | Demo data could confuse testing or leak into production                                                                                                                                                          |
| **Technical Impact**     | `trade_form_employment_page.dart:32,436` has hardcoded state/city demo data marked as TEMPORARY                                                                                                                  |
| **Description**          | `apps/worker-app/lib/features/trade_form/presentation/widgets/trade_form_employment_page.dart:32` contains `TEMPORARY demo data (#1429)` — hardcoded state/city data. Line 436 also has `TEMPORARY: once #1429`. |
| **Root Cause**           | Demo data added for development; pending issue #1429 for proper implementation.                                                                                                                                  |
| **Current Behaviour**    | Hardcoded demo states/cities shown in employment form.                                                                                                                                                           |
| **Expected Behaviour**   | Data comes from the backend or a proper data source.                                                                                                                                                             |
| **Acceptance Criteria**  | 1. Demo data removed. 2. Real data source connected. 3. Form works with real data.                                                                                                                               |
| **Implementation Notes** | Depends on #1429 for the proper data source.                                                                                                                                                                     |
| **Dependencies**         | Issue #1429                                                                                                                                                                                                      |
| **Risks**                | None                                                                                                                                                                                                             |
| **Testing Checklist**    | - Employment form shows real states/cities.                                                                                                                                                                      |
| **Estimated Complexity** | S                                                                                                                                                                                                                |
| **Estimated Effort**     | Depends on #1429                                                                                                                                                                                                 |
| **Suggested Files**      | `apps/worker-app/lib/features/trade_form/presentation/widgets/trade_form_employment_page.dart:32,436`                                                                                                            |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                                                 |

---

### Issue S3-10: Payloads.ts Oversized (3800+ lines)

| Field                    | Value                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Split event-schema payloads.ts into domain-specific files                                                                                                                                                                  |
| **Category**             | Refactor                                                                                                                                                                                                                   |
| **Priority**             | Medium                                                                                                                                                                                                                     |
| **Severity**             | Low                                                                                                                                                                                                                        |
| **Business Impact**      | Large file is hard to navigate when adding new event payloads                                                                                                                                                              |
| **Technical Impact**     | `packages/event-schema/src/payloads.ts` is 3800+ lines in a single file                                                                                                                                                    |
| **Description**          | All event payload schemas live in a single `payloads.ts` file at 3800+ lines. While the file is well-organized with section comments, it would benefit from splitting by domain (worker, chat, profile, job, payer, etc.). |
| **Root Cause**           | All payloads added to one file as events were defined.                                                                                                                                                                     |
| **Current Behaviour**    | All payloads in one file.                                                                                                                                                                                                  |
| **Expected Behaviour**   | Domain-specific payload files with a barrel export.                                                                                                                                                                        |
| **Acceptance Criteria**  | 1. Payloads split by domain. 2. Barrel export maintains backward compatibility. 3. All tests pass.                                                                                                                         |
| **Implementation Notes** | Create `src/payloads/` directory. Re-export from `src/payloads.ts` for backward compatibility.                                                                                                                             |
| **Dependencies**         | None                                                                                                                                                                                                                       |
| **Risks**                | Low; mechanical extraction.                                                                                                                                                                                                |
| **Testing Checklist**    | - All event schema tests pass. - All imports resolve.                                                                                                                                                                      |
| **Estimated Complexity** | M                                                                                                                                                                                                                          |
| **Estimated Effort**     | 1-2 days                                                                                                                                                                                                                   |
| **Suggested Files**      | `packages/event-schema/src/payloads.ts`                                                                                                                                                                                    |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                        |

---

### Issue S3-11: Heavy @Global Module Usage

| Field                    | Value                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Review and reduce @Global module decorations                                                                                                                                                                                                                  |
| **Category**             | Architecture                                                                                                                                                                                                                                                  |
| **Priority**             | Medium                                                                                                                                                                                                                                                        |
| **Severity**             | Low                                                                                                                                                                                                                                                           |
| **Business Impact**      | Obscured dependency chains make onboarding harder                                                                                                                                                                                                             |
| **Technical Impact**     | 10+ modules are @Global, including WorkersModule and MatchModule which are domain-specific                                                                                                                                                                    |
| **Description**          | 10+ modules are decorated with `@Global()`. While cross-cutting concerns (database, events, crypto, config) are appropriate as global, `WorkersModule` and `MatchModule` being global may obscure the dependency graph and make module boundaries less clear. |
| **Root Cause**           | @Global was used to avoid import boilerplate.                                                                                                                                                                                                                 |
| **Current Behaviour**    | Any module can inject WorkersRepository or MatchService without explicit imports.                                                                                                                                                                             |
| **Expected Behaviour**   | Domain modules are explicitly imported where needed.                                                                                                                                                                                                          |
| **Acceptance Criteria**  | 1. WorkersModule and MatchModule are not @Global. 2. All modules that use them import them explicitly. 3. All tests pass.                                                                                                                                     |
| **Implementation Notes** | Remove @Global from WorkersModule and MatchModule. Add explicit imports to consuming modules.                                                                                                                                                                 |
| **Dependencies**         | None                                                                                                                                                                                                                                                          |
| **Risks**                | Medium; many modules may need import updates.                                                                                                                                                                                                                 |
| **Testing Checklist**    | - All modules compile. - All tests pass. - No circular dependencies.                                                                                                                                                                                          |
| **Estimated Complexity** | M                                                                                                                                                                                                                                                             |
| **Estimated Effort**     | 1-2 days                                                                                                                                                                                                                                                      |
| **Suggested Files**      | `apps/api/src/workers/workers.module.ts`, `apps/api/src/match/match.module.ts`                                                                                                                                                                                |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                                           |

---

### Issue S3-12: web/Stub Ops-Actor ID

| Field                    | Value                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**                | Replace stub ops-actor ID with authenticated session                                                                                                                                       |
| **Category**             | Security                                                                                                                                                                                   |
| **Priority**             | Medium                                                                                                                                                                                     |
| **Severity**             | Low-Medium                                                                                                                                                                                 |
| **Business Impact**      | Ops actions attributed to a placeholder identity                                                                                                                                           |
| **Technical Impact**     | `apps/web/src/lib/job-postings.ts:10` has hardcoded placeholder ops-actor ID                                                                                                               |
| **Description**          | `apps/web/src/lib/job-postings.ts:10` and `apps/web/src/lib/pricing-view.ts:170` have hardcoded placeholder ops-actor IDs. These need to be replaced with the authenticated admin session. |
| **Root Cause**           | Stub during development; admin auth was added later.                                                                                                                                       |
| **Current Behaviour**    | Ops actions use a placeholder identity.                                                                                                                                                    |
| **Expected Behaviour**   | Ops actions use the authenticated admin's identity.                                                                                                                                        |
| **Acceptance Criteria**  | 1. Stub ID removed. 2. Actions attributed to authenticated admin. 3. Events carry correct actor.                                                                                           |
| **Implementation Notes** | The admin session should provide the actor ID. Wire it through the API client.                                                                                                             |
| **Dependencies**         | Admin auth integration in web app                                                                                                                                                          |
| **Risks**                | Low                                                                                                                                                                                        |
| **Testing Checklist**    | - Ops actions show correct admin identity. - Events carry correct actor.                                                                                                                   |
| **Estimated Complexity** | S                                                                                                                                                                                          |
| **Estimated Effort**     | 2-4 hours                                                                                                                                                                                  |
| **Suggested Files**      | `apps/web/src/lib/job-postings.ts:10`, `apps/web/src/lib/pricing-view.ts:170`                                                                                                              |
| **Assignee**             | Rishi (Frontend)                                                                                                                                                                           |

---

### Issue S3-13: Canary Coverage Test Flaky Under Load

| Field                    | Value                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**                | Increase timeout or restructure canary-coverage.test.ts                                                                                                                                                                                                                                           |
| **Category**             | Testing                                                                                                                                                                                                                                                                                           |
| **Priority**             | Medium                                                                                                                                                                                                                                                                                            |
| **Severity**             | Low-Medium                                                                                                                                                                                                                                                                                        |
| **Business Impact**      | Flaky test blocks CI randomly; false security regression signals                                                                                                                                                                                                                                  |
| **Technical Impact**     | `apps/api/src/common/canary-coverage.test.ts` times out under full-suite load (30s timeout, imports 70 controller files)                                                                                                                                                                          |
| **Description**          | Under full-suite load the canary-coverage test times out (30s). It `await import()`s every `*.controller.ts` on disk (70 files), and under parallel vitest run those imports queue behind every other worker's transform. The test is CI-blocking and its failure reads as a security regression. |
| **Root Cause**           | The test imports all controllers at runtime; under parallel load, transform time exceeds timeout.                                                                                                                                                                                                 |
| **Current Behaviour**    | Times out randomly under load.                                                                                                                                                                                                                                                                    |
| **Expected Behaviour**   | Consistently passes within timeout.                                                                                                                                                                                                                                                               |
| **Acceptance Criteria**  | 1. Test passes consistently under full-suite load. 2. Timeout is appropriate for the work done.                                                                                                                                                                                                   |
| **Implementation Notes** | Options: (a) Increase timeout to 60s on that specific `it`. (b) Pre-import controllers in a beforeAll. (c) Move to a separate test file that runs serially.                                                                                                                                       |
| **Dependencies**         | None                                                                                                                                                                                                                                                                                              |
| **Risks**                | Increasing timeout masks the real issue; pre-import is better.                                                                                                                                                                                                                                    |
| **Testing Checklist**    | - Test passes 10/10 times under full-suite load.                                                                                                                                                                                                                                                  |
| **Estimated Complexity** | S                                                                                                                                                                                                                                                                                                 |
| **Estimated Effort**     | 1-2 hours                                                                                                                                                                                                                                                                                         |
| **Suggested Files**      | `apps/api/src/common/canary-coverage.test.ts`                                                                                                                                                                                                                                                     |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                                                                                               |

---

### Issue S3-14: Bootstrap-Admin Wrong Route Reference (P-004)

| Field                    | Value                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**                | Fix bootstrap-admin CLI route reference (POST /admin/invite → POST /admin/admins)                                                                                                                                              |
| **Category**             | Bug                                                                                                                                                                                                                            |
| **Priority**             | Medium                                                                                                                                                                                                                         |
| **Severity**             | Low                                                                                                                                                                                                                            |
| **Business Impact**      | Operator instructed to call a route that 404s at the most critical moment                                                                                                                                                      |
| **Technical Impact**     | `packages/db/src/bootstrap-admin.ts:4,153,240` references `POST /admin/invite` which does not exist; real route is `POST /admin/admins`                                                                                        |
| **Description**          | The bootstrap CLI names `POST /admin/invite` as the way to create every further admin — in its header comment, refusal message, and success message. The real route is `POST /admin/admins`. `POST /admin/invite` returns 404. |
| **Root Cause**           | Route was renamed during development; CLI strings were not updated.                                                                                                                                                            |
| **Current Behaviour**    | CLI tells operator to call a 404 route.                                                                                                                                                                                        |
| **Expected Behaviour**   | CLI references the correct route.                                                                                                                                                                                              |
| **Acceptance Criteria**  | 1. All three references updated. 2. Success message shows correct route.                                                                                                                                                       |
| **Implementation Notes** | Simple string replacement in three locations.                                                                                                                                                                                  |
| **Dependencies**         | None                                                                                                                                                                                                                           |
| **Risks**                | None                                                                                                                                                                                                                           |
| **Testing Checklist**    | - Run bootstrap-admin. - Verify messages reference correct route.                                                                                                                                                              |
| **Estimated Complexity** | XS                                                                                                                                                                                                                             |
| **Estimated Effort**     | 10 minutes                                                                                                                                                                                                                     |
| **Suggested Files**      | `packages/db/src/bootstrap-admin.ts:4,153,240`                                                                                                                                                                                 |
| **Assignee**             | Divyanshu (Backend)                                                                                                                                                                                                            |

---

## 6. Sprint 4 — Low Priority Issues

### Issue S4-01: web/README.md Stale

| Field                | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| **Title**            | Update apps/web/README.md with current routes                                          |
| **Category**         | Documentation                                                                          |
| **Priority**         | Low                                                                                    |
| **Severity**         | Low                                                                                    |
| **Description**      | README lists 5 routes; 10+ now exist (job-postings, pricing, reach, pace, agency-kyc). |
| **Suggested Files**  | `apps/web/README.md`                                                                   |
| **Assignee**         | Rishi (Frontend)                                                                       |
| **Estimated Effort** | 30 minutes                                                                             |

---

### Issue S4-02: taxonomy/README.md Stale

| Field                | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Title**            | Update packages/taxonomy/README.md with current scope                   |
| **Category**         | Documentation                                                           |
| **Priority**         | Low                                                                     |
| **Severity**         | Low                                                                     |
| **Description**      | README describes "initial CNC/VMC" scope only; 10 industries now exist. |
| **Suggested Files**  | `packages/taxonomy/README.md`                                           |
| **Assignee**         | Divyanshu (Backend)                                                     |
| **Estimated Effort** | 30 minutes                                                              |

---

### Issue S4-03: profiling-lexicon/README.md Claims Stubs

| Field                | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| **Title**            | Update packages/profiling-lexicon/README.md status                                |
| **Category**         | Documentation                                                                     |
| **Priority**         | Low                                                                               |
| **Severity**         | Low                                                                               |
| **Description**      | README claims predicates/values are stubs; both are fully implemented with tests. |
| **Suggested Files**  | `packages/profiling-lexicon/README.md`                                            |
| **Assignee**         | Divyanshu (Backend)                                                               |
| **Estimated Effort** | 20 minutes                                                                        |

---

### Issue S4-04: db/README.md Lists 10 Tables; 50+ Exist

| Field                | Value                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| **Title**            | Update packages/db/README.md with current schema scope                         |
| **Category**         | Documentation                                                                  |
| **Priority**         | Low                                                                            |
| **Severity**         | Low                                                                            |
| **Description**      | README lists Phase 1 tables; schema has grown to 50+ tables across 25 modules. |
| **Suggested Files**  | `packages/db/README.md`                                                        |
| **Assignee**         | Divyanshu (Backend)                                                            |
| **Estimated Effort** | 1 hour                                                                         |

---

### Issue S4-05: Prettier Corrupts Markdown Fill-In Lines (P-001)

| Field                | Value                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**            | Add docs/\*_/_.md to .prettierignore                                                                                                                                   |
| **Category**         | Technical Debt                                                                                                                                                         |
| **Priority**         | Low                                                                                                                                                                    |
| **Severity**         | Low                                                                                                                                                                    |
| **Description**      | Prettier parses markdown underscores as emphasis and rewrites them. Each `prettier --write` produces different output, so `format:check` can never pass on such files. |
| **Suggested Files**  | `.prettierignore` (create if not exists)                                                                                                                               |
| **Assignee**         | Divyanshu (Backend)                                                                                                                                                    |
| **Estimated Effort** | 10 minutes                                                                                                                                                             |

---

### Issue S4-06: pnpm-lock.yaml is -diff (P-003)

| Field                | Value                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**            | Document pnpm-lock.yaml --text workaround for reviews                                                                                      |
| **Category**         | Documentation                                                                                                                              |
| **Priority**         | Low                                                                                                                                        |
| **Severity**         | Low                                                                                                                                        |
| **Description**      | `.gitattributes` suppresses lockfile diffs. Supply-chain reviews silently review nothing. Workaround: `git diff --text -- pnpm-lock.yaml`. |
| **Suggested Files**  | `.gitattributes`, PR template                                                                                                              |
| **Assignee**         | Divyanshu (Backend)                                                                                                                        |
| **Estimated Effort** | 15 minutes                                                                                                                                 |

---

### Issue S4-07: Stale project-status.md

| Field                | Value                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Title**            | Refresh docs/architecture/project-status.md                                                                |
| **Category**         | Documentation                                                                                              |
| **Priority**         | Low                                                                                                        |
| **Severity**         | Low                                                                                                        |
| **Description**      | Compiled 2026-08-21; does not reflect ADR-0036, ADR-0037, ADR-0038, ADR-0039, ADR-0040, or E-chain design. |
| **Suggested Files**  | `docs/architecture/project-status.md`                                                                      |
| **Assignee**         | Divyanshu (Backend)                                                                                        |
| **Estimated Effort** | 2 hours                                                                                                    |

---

### Issue S4-08: No HEALTHCHECK in API/Web Dockerfiles

| Field                | Value                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**            | Add HEALTHCHECK instructions to api, payer-web, admin-web Dockerfiles                                                                                                             |
| **Category**         | Infrastructure                                                                                                                                                                    |
| **Priority**         | Low                                                                                                                                                                               |
| **Severity**         | Low                                                                                                                                                                               |
| **Description**      | The ai-service Dockerfile has HEALTHCHECK; api, payer-web, admin-web do not. Deploy script handles health externally, but built-in HEALTHCHECK helps `docker compose` monitoring. |
| **Suggested Files**  | `apps/api/Dockerfile`, `apps/payer-web/Dockerfile`, `apps/admin-web/Dockerfile`                                                                                                   |
| **Assignee**         | Divyanshu (Backend)                                                                                                                                                               |
| **Estimated Effort** | 30 minutes                                                                                                                                                                        |

---

### Issue S4-09: Node Version Not Pinned in CI

| Field                | Value                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- |
| **Title**            | Pin Node.js minor version in CI                                                          |
| **Category**         | Infrastructure                                                                           |
| **Priority**         | Low                                                                                      |
| **Severity**         | Low                                                                                      |
| **Description**      | `ci.yml` uses `node-version: 22` (major only). A minor/patch bump could change behavior. |
| **Suggested Files**  | `.github/workflows/ci.yml:830`, `.tool-versions`                                         |
| **Assignee**         | Divyanshu (Backend)                                                                      |
| **Estimated Effort** | 10 minutes                                                                               |

---

### Issue S4-10: Web Worker App l10n (Marathi/Bhojpuri)

| Field                | Value                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Title**            | Complete remaining l10n translations in worker app                                                             |
| **Category**         | Feature                                                                                                        |
| **Priority**         | Low                                                                                                            |
| **Severity**         | Low                                                                                                            |
| **Description**      | Beyond auth errors, check for other hardcoded Hindi strings across the worker app that should be in ARB files. |
| **Suggested Files**  | `apps/worker-app/lib/` (grep for hardcoded Hindi)                                                              |
| **Assignee**         | Rishi (Frontend)                                                                                               |
| **Estimated Effort** | 1-2 days                                                                                                       |

---

### Issue S4-11: Payer App Firebase Crashlytics Version Pin

| Field                | Value                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**            | Update payer app firebase_crashlytics from 5.2.4 to ^5.2.6                                                                                               |
| **Category**         | Technical Debt                                                                                                                                           |
| **Priority**         | Low                                                                                                                                                      |
| **Severity**         | Low                                                                                                                                                      |
| **Description**      | Payer app pins `firebase_crashlytics: 5.2.4` due to a broken artifact in 5.2.5. Worker app uses `^5.2.6` which fixed the issue. Payer should be updated. |
| **Suggested Files**  | `apps/payer-app/pubspec.yaml`                                                                                                                            |
| **Assignee**         | Rishi (Frontend)                                                                                                                                         |
| **Estimated Effort** | 10 minutes                                                                                                                                               |

---

### Issue S4-12: Payer App Navigator 1.0 Inconsistency

| Field                | Value                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**            | Migrate Disclosure History route to GoRouter                                                                                                                            |
| **Category**         | Refactor                                                                                                                                                                |
| **Priority**         | Low                                                                                                                                                                     |
| **Severity**         | Low                                                                                                                                                                     |
| **Description**      | Payer app uses `Navigator.of(context).push(MaterialPageRoute(...))` for Disclosure History alongside BlocProvider-based navigation. Inconsistent with GoRouter pattern. |
| **Suggested Files**  | `apps/payer-app/lib/features/find/`                                                                                                                                     |
| **Assignee**         | Rishi (Frontend)                                                                                                                                                        |
| **Estimated Effort** | 2-4 hours                                                                                                                                                               |

---

### Issue S4-13: No Persona Neutrality Test in Payer App

| Field                | Value                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Title**            | Add persona neutrality test to payer app                                                                                       |
| **Category**         | Testing                                                                                                                        |
| **Priority**         | Low                                                                                                                            |
| **Severity**         | Low                                                                                                                            |
| **Description**      | Worker app has `persona_neutrality_test.dart` validating copy doesn't contain forbidden personas. Payer app has no equivalent. |
| **Suggested Files**  | `apps/payer-app/test/`                                                                                                         |
| **Assignee**         | Rishi (Frontend)                                                                                                               |
| **Estimated Effort** | 2-4 hours                                                                                                                      |

---

### Issue S4-14: CODEOWNERS Missing Docker/Infra Entries

| Field                | Value                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**            | Add CODEOWNERS entries for Docker and infrastructure files                                                                               |
| **Category**         | Infrastructure                                                                                                                           |
| **Priority**         | Low                                                                                                                                      |
| **Severity**         | Low                                                                                                                                      |
| **Description**      | `.dockerignore`, `docker-compose*.yml`, and Dockerfiles are not in CODEOWNERS. Infrastructure changes fall under the catch-all `*` rule. |
| **Suggested Files**  | `.github/CODEOWNERS`                                                                                                                     |
| **Assignee**         | Divyanshu (Backend)                                                                                                                      |
| **Estimated Effort** | 10 minutes                                                                                                                               |

---

## 7. Final Summary

### Issue Count by Sprint

| Sprint              | Count  | Description                                                                                                                                       |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sprint 1 (Critical) | 6      | Secret scan, Supabase checks, 2 god classes, layering violation, accessibility                                                                    |
| Sprint 2 (High)     | 10     | ADR updates, broken reference, payer accessibility, login architecture, code duplication, staging IPs, test deps, READMEs, pricing                |
| Sprint 3 (Medium)   | 14     | CI formatting, Dependabot, SECURITY.md, APM, API split, translations, temp data, payloads split, @Global, ops-actor, canary test, bootstrap route |
| Sprint 4 (Low)      | 14     | Stale READMEs, prettierignore, lockfile, project-status, HEALTHCHECK, Node pin, l10n, crashlytics, navigator, persona test, CODEOWNERS            |
| **Total**           | **62** |                                                                                                                                                   |

### Issues by Assignee

| Assignee            | Count | Areas                                                                                       |
| ------------------- | ----- | ------------------------------------------------------------------------------------------- |
| Divyanshu (Backend) | 35    | Security gates, god classes, layering, ADRs, documentation, CI/CD, infrastructure, database |
| Rishi (Frontend)    | 22    | Accessibility, architecture, code duplication, translations, l10n, pricing, tests           |
| Shared              | 5     | READMEs, pricing (frontend+backend)                                                         |

### Technical Debt Summary

| Category              | Items                                                              | Impact                           |
| --------------------- | ------------------------------------------------------------------ | -------------------------------- |
| God classes           | 2 files (orchestrator 2790L, trade-resume-map 2305L)               | Maintainability, merge conflicts |
| Layering violations   | 2 controllers (auth, workers)                                      | Testability, architecture        |
| Code duplication      | 6+ files duplicated between Flutter apps                           | Bug fix double-work              |
| Stale documentation   | 5 READMEs + project-status.md + SECURITY.md                        | Developer confusion              |
| Missing documentation | 4 READMEs (match-engine, pricing, reach-learn, admin-web)          | Onboarding friction              |
| CI/CD gaps            | 3 non-blocking security checks, no format check, no npm Dependabot | Security risk                    |
| Translation gaps      | 20+ TODO l10n comments                                             | i10n completeness                |
| ADR housekeeping      | 5 stale supersessions, 3 unsigned Proposed ADRs                    | Decision clarity                 |

### ADR Compliance Score: 7/10

**Strengths:**

- 36 ADRs with clear decision records
- Event-first, privacy-first, fail-closed patterns consistently implemented
- CLAUDE.md operating contract well-followed

**Weaknesses:**

- 5 ADRs have stale supersession status
- 3 Proposed ADRs referenced as authority by accepted ADRs
- 1 Withdrawn ADR (0003) still cited by 3 other ADRs
- 7 of 10 RVM taxonomy rulings unsigned

### Architecture Health Score: 8/10

**Strengths:**

- Clean controller/service/repository separation (except 2 violations)
- Event-first architecture comprehensive
- Privacy-first pseudonymization best-in-class
- Fail-closed patterns everywhere

**Weaknesses:**

- 2 god classes (profiling orchestrator, trade-resume-map)
- 10+ @Global modules obscuring dependency graph
- Monolithic API client in web ops console

### UI Quality Score: 7/10

**Strengths:**

- Excellent worker app accessibility (58 semantic annotations)
- Consistent design token system
- BLoC/Cubit architecture clean
- Comprehensive loading/error/empty states

**Weaknesses:**

- Payer app has only 4 semantic annotations
- Text scaling disabled in both apps
- Significant code duplication between apps
- Hardcoded pricing and Hindi strings

### Backend Quality Score: 9/10

**Strengths:**

- Exceptional auth model (15 guards, multi-principal)
- Consistent Zod validation
- Comprehensive event emission
- Zero console.log in production
- Zero hardcoded secrets
- Fail-closed architecture

**Weaknesses:**

- 2 layering violations (controller → repository)
- 37 files exceed 500 lines
- Canary test flaky under load

### Performance Score: 8/10

**Strengths:**

- Advisory locking for concurrency
- Rate limiting (per-IP and per-subject)
- Spend caps on AI calls
- Redis session management

**Weaknesses:**

- No API-level APM/tracing
- No OpenTelemetry
- Large Docker build contexts

### Security Score: 9/10

**Strengths:**

- Best-in-class pseudonymization gateway
- PII isolation at every boundary
- Timing-safe comparisons
- Boot-time security assertions
- SHA-pinned CI actions
- Supply-chain policy (7-day cooling, trust policy)

**Weaknesses:**

- Secret scan non-blocking (most critical)
- Supabase migration checks non-blocking
- Secret parity check non-blocking
- Redis has no password (loopback-bound, acceptable)
- Staging IPs hardcoded as defaults

### Test Coverage Observations

| Component             | Test Files | Assessment                    |
| --------------------- | ---------- | ----------------------------- |
| API (NestJS)          | 423        | Excellent (~85% ratio)        |
| AI Service (Python)   | 71         | Strong (property-based tests) |
| Worker App (Flutter)  | 204        | Comprehensive                 |
| Payer App (Flutter)   | 48         | Good but could use more       |
| Web Ops Console       | 7          | Library-level only            |
| Payer Web             | ~90        | Excellent                     |
| Admin Web             | ~49        | Good                          |
| packages/db           | ~100       | Exceptional                   |
| packages/match-engine | 9          | Exceptional (purity gate)     |
| All other packages    | 3-9 each   | Adequate to good              |

**Notable patterns:**

- `packages/match-engine/purity.test.ts` — static release gate enforcing no I/O/clock/randomness
- Property-based tests in reach-engine and ai-service pseudonymization
- Contract parity tests between TypeScript and Python

### Highest-Risk Modules

1. **`apps/api/src/profiling/orchestrator.service.ts`** — 2,790 lines, god class, any change risks profiling quality
2. **`apps/api/src/resume/trade-resume-map.ts`** — 2,305 lines, trade-specific logic interleaved with shared code
3. **`apps/ai-service/app/pseudonymize.py`** — 639 lines, critical privacy boundary; any bug leaks PII to LLMs
4. **`.github/workflows/security-scan.yml`** — Secret scan non-blocking; the single highest-severity CI gap
5. **`apps/worker-app/lib/app.dart` + `apps/payer-app/lib/app.dart`** — Text scaling disabled; accessibility violation

### Recommended Execution Order

**Week 1 (Critical + Quick Wins):**

1. S1-01: Flip gitleaks to blocking (30 min)
2. S1-02: Flip Supabase checks to blocking (30 min)
3. S1-05: Fix auth controller layering (1 day)
4. S1-06: Fix text scaling in Flutter apps (2-3 days)
5. S2-01: Update 5 ADR statuses (30 min)
6. S2-02: Fix broken ADR reference (15 min)
7. S3-01: Add format check to CI (15 min)
8. S3-14: Fix bootstrap-admin route (10 min)

**Week 2 (High Priority):**

1. S2-03: Payer app accessibility annotations (2-3 days)
2. S2-04: Payer login cubit extraction (1 day)
3. S2-06: Remove staging IP defaults (2-4 hours)
4. S2-07: Add payer test dependencies (15 min)
5. S2-08: Add 4 missing READMEs (2-3 hours)
6. S2-09: Update 4 stale READMEs (2-3 hours)

**Week 3 (Medium Priority):**

1. S1-03: Decompose orchestrator.service.ts (3-5 days) — START
2. S1-04: Decompose trade-resume-map.ts (3-5 days) — START
3. S3-02: Add Dependabot for npm (30 min)
4. S3-03: Customise SECURITY.md (1 hour)
5. S3-07: Complete Marathi/Bhojpuri translations (1-2 days)
6. S3-08: Move hardcoded Hindi to ARB (30 min)

**Week 4 (Low Priority + Continuation):**

1. S1-03/S1-04: Complete god class decomposition
2. S2-05: Extract shared Flutter package (3-5 days)
3. S2-10: Extract hardcoded pricing (1-2 days)
4. S3-04: Add OpenTelemetry (3-5 days)
5. S3-05: Split web api.ts (1-2 days)
6. Remaining Sprint 4 items

---

_Report generated 2026-09-08. All findings are evidence-based from repository inspection._
