---
name: bb-api-design
description: Design a NestJS endpoint the BadaBhai way — Zod DTOs, repository/service split, DI, and a validated event for every important action. Use during the API stage before implementation.
---

# Skill: API Design

**Goal.** Define an endpoint's contract and event behavior before building it, so
it's consistent with the existing modules and never silently skips an event.

**Inputs.** The settled architecture decision; the DB schema; the
[event registry](../../../packages/event-schema/src/registry.ts); the DTO and
module conventions in `apps/api/src`.

**Process.**
1. Define the contract: method, path, request/response Zod DTOs.
2. Decide the event(s) this endpoint emits. Reuse a registered event if one fits;
   otherwise design a new one (name, domain, payload — **no PII in the payload**).
3. Specify the service/repository split and where validation runs (the Zod pipe).
4. Define error cases and how they surface (exceptions filter + request id).
5. If a new event: plan the registry entry, payload schema, and its test.

**Checklist.**
- [ ] Request/response are Zod DTOs validated at the boundary.
- [ ] Important action emits exactly one correct, registered event.
- [ ] New events have a payload schema + test; no PII in the payload.
- [ ] Repository/service separation and DI respected.
- [ ] Error paths defined; pagination bounded where lists are returned.
- [ ] No secret or service-role detail exposed in the response.

**Expected Output.** An endpoint spec: DTOs, event(s) emitted, service/repo
shape, error behavior, and any new event-schema work.

**Failure Conditions.** An important endpoint that emits no event; PII in an event
payload or response; validation skipped at the boundary; a new event used before
it's registered + tested.
