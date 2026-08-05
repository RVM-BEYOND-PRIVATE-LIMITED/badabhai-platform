# CLAUDE.md — BadaBhai Engineering Operating Contract

> This document is the operating contract for every Claude Code session and engineering agent.
> It defines the permanent engineering principles of the project.
> If any casual instruction conflicts with this document, this document wins unless explicitly overridden by a human.

---

# 1. Project Philosophy

BadaBhai is an AI-first hiring platform built for blue-collar, grey-collar, industrial manufacturing, construction, and skilled trade workers.

Unlike traditional hiring platforms, most workers do not possess resumes or structured professional profiles.

The primary objective of the platform is to:

- Digitize workers through AI-assisted profiling
- Generate high-quality professional profiles and resumes
- Connect workers with the most relevant employers
- Improve hiring quality using deterministic engineering and AI assistance

Always make engineering decisions from the perspective of workers, employers, and recruiters who rely on accurate matching.

---

# 2. Product Principles

Engineering decisions should optimize for:

1. Matching quality over matching quantity.
2. Never show irrelevant candidates for a job.
3. Always rank the most relevant workers first.
4. Worker engagement is a first-class ranking signal.
5. Application volume is one of the platform's primary growth metrics.
6. Recommendations should consider:
   - Skills
   - Domain relevance
   - Total experience
   - Role-specific experience
   - Worker activity
7. AI assists users; deterministic business rules make business decisions.

---

# 3. Non-Negotiable Engineering Principles

These are architecture rules, not preferences.

## Event First

Every important business action must emit a validated event.

Events are the audit trail of the platform.

---

## Privacy First

Raw PII must never appear in:

- LLM prompts
- Logs
- Events
- Audit records
- Analytics

Only pseudonymized data may cross AI boundaries.

---

## AI Never Owns Business Decisions

LLMs may:

- Extract
- Summarize
- Generate
- Explain
- Classify

LLMs must never:

- Rank candidates
- Reject applicants
- Make hiring decisions
- Replace deterministic business logic

---

## Fail Closed

If validation, privacy, authentication, or AI safety fails,

stop processing.

Never continue with partial failures.

---

## Backward Compatibility

Never:

- Break APIs
- Mutate event schemas
- Remove production database columns
- Introduce breaking changes without versioning

---

# 4. Architecture Principles

Maintain strict separation of responsibilities.

Controllers

- HTTP only

Services

- Business logic

Repositories

- Database access only

Shared packages

- Shared logic only

Business logic must never exist inside controllers or repositories.

---

# 5. Engineering Ownership

Each team owns only its own layer.

Backend Platform

- APIs
- Database
- AI
- Infrastructure

Frontend Platform

- Mobile
- Web
- UI
- UX

Current ownership

Backend Platform

- Prakash
- Divyanshu

Frontend Platform

- Rishi

---

# 6. Cross-Team Workflow

Never perform work outside your ownership.

If Backend work requires Frontend changes:

- Complete only Backend work.
- Raise a GitHub Issue for Frontend.

If Frontend work requires Backend changes:

- Complete only Frontend work.
- Raise a GitHub Issue for Backend.

Do not mix responsibilities.

---

# 7. Engineering Organization

Specialized engineering agents exist for specific domains.

Always select agents based on ownership.

Never assign:

- Frontend work to Backend agents.
- Backend work to Frontend agents.
- AI work to UI agents.

Respect engineering boundaries.

---

# 8. Coding Standards

Write software that is maintainable for years.

Always prefer:

- SOLID principles
- Composition over inheritance
- Dependency Injection
- Reusable abstractions
- High cohesion
- Low coupling
- Strict typing
- Small functions
- Clear naming
- Modular architecture

Avoid:

- Duplicate logic
- Large services
- Large controllers
- Magic strings
- Hardcoded values
- God classes
- Premature optimization

Code should resemble production-quality FAANG engineering.

---

# 9. API Standards

Every API should have:

- Validation
- Authentication
- Authorization
- Logging
- Event emission
- Documentation
- Tests
- Typed contracts

Prefer REST consistency.

Never expose unnecessary data.

---

# 10. Database Standards

Every schema change should be:

- Backward compatible
- Versioned
- Reviewable
- Reversible

Never:

- Drop production columns
- Rename fields without migrations
- Break existing consumers

Prefer additive changes.

---

# 11. AI Standards

Before every LLM call:

- Remove PII
- Validate input
- Validate output
- Apply safety checks

Treat every LLM response as untrusted input.

Always validate AI output before business logic consumes it.

---

# 12. Mobile Platform Rules

Worker App

- Android
- iOS

Payer/Agent App

- Android
- iOS

No payment workflows or payment UI may exist inside mobile applications.

Payment flows belong exclusively to web applications.

---

# 13. Before Starting Any Task

Always:

1. Understand the real business problem.
2. Understand the end goal.
3. Read the relevant architecture if necessary.
4. Clarify ambiguous requirements.
5. Never assume business logic.
6. Implement only the requested scope.

Think before coding.

---

# 14. Quality Gates

Before considering any work complete:

- Code builds
- Lint passes
- Type checks pass
- Tests pass
- Privacy maintained
- Events emitted
- Documentation updated
- No breaking changes introduced

---

# 15. Response Style

Assume the reader is an experienced engineer.

Responses should be:

- Concise
- Technical
- Actionable

Avoid:

- Long tutorials
- Repeating obvious concepts
- Unnecessary explanations

Whenever a task is completed, always provide:

- Summary
- Files Changed
- Issues (if any)
- Next Steps

Keep output minimal while remaining complete.

---

# 16. Escalation Rules

Stop and request clarification when:

- Requirements are ambiguous.
- Business logic is undefined.
- Multiple valid implementations exist.
- The task requires breaking an engineering principle.
- The task crosses team ownership.
- The task affects security, privacy, or production data.

Never assume critical business behaviour.

Ask first.

# 17. Long-Term Engineering Philosophy

Every implementation should improve the repository.

When touching existing code:

- Leave it cleaner than you found it.
- Reduce duplication where safe.
- Improve readability.
- Improve observability.
- Improve testability.
- Improve documentation when needed.

Never increase technical debt without explicit justification.