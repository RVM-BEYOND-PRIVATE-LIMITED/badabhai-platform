STATUS: BLOCKED ON P8. Do not start.
The wizard renders from GET /payer/job-posting-drafts/schema. That route does not exist:
  git grep -nIiE "job-posting-drafts|drafts/schema" -- '*.ts' '*.tsx' '*.dart' '*.sql' -> exit 1
It is P8's deliverable (P8_BUILD:33). P8's chip option sets read matching_catalog, which is NOT
on main — open draft PR #1387 "[DO NOT MERGE — blocked on role-registry ruling]" — and its
function/collar sets need P3's columns. P8 must land and PASS first. docs/qa/evidence/ holds
only P0 and PX, so README:47 blocks P10 a second way.

PHASE P10 — the payer-web job-posting wizard renders from the server schema.

Build under apps/payer-web/src/app/(portal)/postings/new/wizard/. That directory IS the wizard
and the INVARIANT below is scoped to it.

WHAT IS HARDCODED ON THIS SURFACE TODAY — read, not assumed, and this is the whole target:
  new/posting-form.tsx:40-50        interface FormFields, nine job-posting fields
  new/posting-form.tsx:260          renders TRADE_KEYS (contracts.ts:70-86, fifteen values)
  [id]/edit/edit-posting-form.tsx:198,211
                                    renders SHIFTS (contracts.ts:109), NEEDED_BY (:101)
  ai/new/draft-preview.tsx:28-40    FIELD_LABELS, eleven job-posting field labels
There is no wizard today — three forms and a chat. No registry role name appears in
apps/payer-web (zero hits for the five displayNames at role-registry.ts:39-45). collar_tier has
zero hits in CODE (git grep over '*.ts' '*.tsx' '*.sql' -> exit 1; it lives only in briefs and
decision docs). The tier-looking strings in this app are substrings of trade keys —
contracts.ts:81,82,84. Chase neither.

THE PATTERN ALREADY SHIPS ON THIS PAGE. Copy it. Do not invent a second one.
MatchSkillPicker renders a closed option set it never declares — `vocabulary: MatchSkillWire[]`
(new/match-skill-picker.tsx:49) — fetched by listMatchSkills() (lib/payer-api.ts:1185) from
GET /payer/match/skills (apps/api/src/match/match-skills.controller.ts:34), typed by
matchSkillWireSchema (lib/contracts.ts:236-241). That control IS ADR-0036 §1's posting-form
breadth gate (0036-matching-algorithm-v1.md:32) and it is DONE. The wizard MOUNTS it and leaves
it on its own route. TWO SOURCES, no third: the skill vocabulary comes from
GET /payer/match/skills, every other step, field and option comes from GET /schema.

WRITE IT AS A PURE RENDER. Step selection, field emission, and both blocking screens below are
functions of (schema, draft, state) evaluated at render time — no useEffect, no post-fetch
state. payer-web's vitest env is node with no DOM (apps/payer-web/vitest.config.ts); the house
tests mock useState and walk the returned element tree (posting-form.test.tsx:17-18,
agency-job-form.test.tsx:156,191). A wizard that computes its shape in an effect cannot be
observed here and will fail its CHECK.

SHIP THESE ARTIFACTS — the CHECK reads them by name: a committed schema fixture, a test that
renders the wizard from that fixture, and a checkpoint seam test under lib/ that records the
POSTs (house convention: lib/posting-seam.test.ts).

Every step completion POSTs a checkpoint with expected_version and an Idempotency-Key. The
header already threads through the shared helper (lib/payer-http.ts:65) — reuse it. The typed
never-re-post 409 to copy is PurchaseConflictError (lib/payer-api.ts:344), but it sits on the
CREDITS path: `grep -rn idempotencyKey` over postings/ returns nothing, so the posting seam is
yours to write. On 409 render "Updated on another device" with a reload-or-overwrite choice.
Never retry silently.

Pin schema_version on the draft. If the served version differs, render "we have updated this
form" BEFORE any field. Never migrate the draft silently.

DELETED — "If you type one of the 22 role names into a .tsx file, you have failed this phase."
No brief may assert a role count. R4-d (RVM_TAXONOMY_WORKSHEET_2026-09.md:599) is unsigned,
blank signature at :616, and BUILD_RULES:31 makes settling R1-R7 a full stop.

DELETED — draft resume ("call drafts?status=in_progress and offer Resume — Step 4 of 7"). No
phase builds a drafts LIST route: P8_CHECK:4-6 names only the two migrations, the checkpoint
POST and GET /schema; P9_BUILD:5 adds only publish. P8_BUILD:18 DOES declare current_step_id
and completed_step_ids[], so resume is deferrable, not impossible. OPEN OWNER CALL — defer to
P11 or reopen P8 for a filtered GET. Do not build it in P10.

pnpm build cannot pass on this box — PARKED.md:140, admin-web EPERM on a standalone symlink.
Gate on `pnpm --filter @badabhai/payer-web test` and `pnpm typecheck`.

INVARIANT: no file under postings/new/wizard/ declares a step, a field id, or an option array.
Every one arrives at runtime — from the GET /schema payload, or from GET /payer/match/skills
for the skill vocabulary MatchSkillPicker already renders (match-skill-picker.tsx:49).
