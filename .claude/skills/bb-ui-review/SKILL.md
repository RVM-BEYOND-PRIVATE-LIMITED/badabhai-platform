---
name: bb-ui-review
description: Review UI for the Next.js ops console and the Flutter worker app — correctness of data display, no-PII-leak, resilience to backend errors, and accessibility for low-literacy worker users. Use during implementation/review of any UI change.
---

# Skill: UI Review

**Goal.** Ensure a UI change is correct, resilient, privacy-safe, and usable by its
audience — ops (Next.js) or low-literacy workers (Flutter).

**Inputs.** The UI change; the API/data contracts it consumes; the audience
(ops vs. worker); design intent.

**Process.**
1. Confirm the data shown matches the API contract and the intended audience.
2. Privacy: no raw PII surfaced beyond what the API authorizes; web reads only
   `NEXT_PUBLIC_*`; no secrets in the client bundle.
3. Resilience: loading, empty, and error states all handled; no crash on a missing
   or slow backend.
4. Accessibility (worker app especially): large touch targets, minimal text, voice
   affordance, regional-language readiness, works on low bandwidth.
5. Consistency with existing components and states.

**Checklist.**
- [ ] No raw PII rendered beyond what the API intends.
- [ ] No secret reaches the client; web uses only public env.
- [ ] Loading / empty / error states handled; resilient to backend failure.
- [ ] Worker-app UX works for a first-time low-literacy user.
- [ ] Ops console Phase-1 actions are read-only (no unplanned mutations).
- [ ] Consistent with existing UI patterns.

**Expected Output.** A UI review verdict with specific findings (privacy,
resilience, accessibility, consistency) and required fixes.

**Failure Conditions.** Leaks PII or a secret to the client; crashes on backend
error; inaccessible to the target user; introduces an unplanned mutating action in
the read-only ops console.
