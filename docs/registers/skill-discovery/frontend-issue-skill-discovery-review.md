# Frontend Issue — Admin Portal: Skills → Skill Discovery review queue

> **Owner: Frontend Platform (Rishi).** `apps/admin-web` is Frontend Platform per CLAUDE.md §5/§6;
> the backend half (schema, pipeline, APIs, audit) is Backend Platform and is complete.
> This document is the issue body — copy it to GitHub, or tell the backend agent to build it and
> the ownership rule is explicitly overridden.

## Context in one paragraph

`job_domain_alias` holds 9,121 rows of published occupation vocabulary. A discovery pipeline
measures which of them carry evidence of skills the canonical `skill` table does not have, and
files each finding as a **candidate**. A candidate is a *claim*, never a skill: nothing in the
request path can create a canonical skill, and an approval only RECORDS a decision — the actual
corpus write stays in the offline, gated `packages/db` chain. This screen is where a human turns
6,673 claims into decisions, and the whole design goal is that a reviewer resolves one in
seconds without ever seeing an embedding or a cosine score.

Full measurement: `docs/registers/skill-discovery/coverage-report-2026-08-26.md`.

---

## What exists already (do not rebuild)

**Four routes**, all under `@Controller("admin")`:

| method | path | capability | request | response |
|---|---|---|---|---|
| `GET` | `/admin/skill-discovery` | `read_entities` | `AdminSkillDiscoveryQuerySchema` | `AdminSkillDiscoveryPage` |
| `GET` | `/admin/skill-discovery/metrics` | `read_entities` | — | metrics tiles |
| `GET` | `/admin/skill-discovery/:id` | `read_entities` | uuid path param | `AdminSkillDiscoveryDetail` |
| `POST` | `/admin/skill-discovery/:id/decision` | `review_skill_candidates` | `AdminSkillDecisionSchema` | `AdminSkillDecisionResult` |

**Every type is already exported** from `apps/api/src/admin/admin-skill-discovery.dto.ts`. Mirror
it in `apps/admin-web/src/lib/skill-discovery.ts` the way `lib/feedback.ts` mirrors its API — do
not re-derive shapes from sample JSON.

The DTO also ships **display maps you should use rather than writing your own**:
`SKILL_MATCH_RELATION_LABELS`, `SKILL_MATCH_STRENGTH_LABELS`, `SKILL_PHRASE_CLASS_LABELS`. They
exist so the reviewer-facing wording lives in one place and cannot drift between the API's
meaning and the screen's.

---

## Screens

### 1. Dashboard tiles — `Skills → Skill Discovery`

```
Pending Review  599        Direct   82        Ambiguous  517       Derived  6,074
Approved  0                Rejected 0         Mapped  0            Held  0
```

Tiles come from `GET /admin/skill-discovery/metrics`. **Do not compute them client-side by
paging the queue** — the queue is 6,673 rows.

### 2. Queue

Two view modes over the same data. **Grouped is the default**, because the whole point is that
6,673 candidates become 3,009 review screens.

**Grouped view.** One card per review group: a batch of candidates sharing a trade family and an
anchor term. Header reads like `metal — Plant and Machine Operators · 60 candidates · 18 trades`.
Expanding lists the members; each member still gets its own decision. A group is **a lens, not a
merge** — there is no group id in any table and no group-level decision. If you offer a
"decide all in this group" affordance it must issue N individual decision calls, each with its
own reason, because each one gets its own audit row.

**Flat view.** Priority-ordered rows.

**Filters** (all backed by the query schema): status · review tier · confidence band · proposed
action · trade family · source type · run id · created-date range.

**Search**: raw alias, normalized phrase, proposed skill, canonical skill, job domain.

**Tier sequencing is a product rule, not a preference.** `direct` is reviewed and validated
first; `derived` (6,074) stays closed until then. Make that visible — a banner or a disabled
tab with a reason, not a silent default filter.

### 3. Detail / review screen

The target, from the owner's own brief:

```
────────────────────────────────────────────────────────────
SKILL CANDIDATE

Suggested skill      Sanitary Fixture Installation
Description          Operation and fitting of sanitary fixtures…
Confidence           HIGH
Classification       DIRECT

Source aliases (4)   sanitary fixture installation
                     sanitary fitting
                     sanitary installer
                     नल फिटिंग
Source job domains   12   [Plumbers and Pipe Fitters, Building Electricians, …]

Existing related skills
  Plumbing            exact match          — this phrase is already a name for it
  Pipe Installation   same words, reordered
  Drain Laying        shares "installation" only — weak, shown for context

Why this was surfaced
  An occupation title whose modifier names the work. The title is not a skill;
  what the modifier describes may be one.

Suggested action     CREATE NEW SKILL
────────────────────────────────────────────────────────────
DECISION

[ CREATE NEW SKILL ]  [ ADD AS ALIAS ]  [ MERGE ]  [ REJECT ]  [ HOLD ]

Reviewer reason  ________________________________  (required, min 12 chars)
────────────────────────────────────────────────────────────
```

**Hard rules for this screen:**

- **Never render a raw cosine score, a vector, or an embedding model name.** The API deliberately
  serves a *relation*, a *strength* (`strong`/`weak`) and a human sentence. Use
  `SKILL_MATCH_RELATION_LABELS` for the wording.
- **Show every competing match, not the top one.** This repository has measured false matches —
  `ducting_installation → plumber`, `visual_defect_identification → quality_inspector`,
  `split_unit_installation → fitter`. A single "best match" is exactly what hides them. Render
  `weak` matches visually subordinate but present, and label them as context rather than options.
- **The suggested action is a suggestion.** Do not pre-select it in a way that makes Enter approve
  it. All five buttons are equally reachable.
- **The provenance block is a record, not a form.** `run_id`, `cluster_key`, `classifier_rule`,
  `phrase_class`, `model`, `prompt_version`, `corpus_fingerprint`, `provenance_digest` are
  read-only. There is no request field that can address any of them.

### 4. The `CREATE` sub-form — the one non-obvious requirement

`create` requires **`approved_job_domain_ids` (min 1)** and optionally `approved_requirement`
(`required` | `preferred`, default `preferred`).

Why it is mandatory: `validateTaxonomyCorpus` refuses a skill with zero `job_domain_skill` edges
— *"Nothing reaches this skill: it is not on any trade's picker and no posting can be built from
it. It seeds, it embeds, and it is invisible."* The pipeline may not infer which trades a skill
belongs to; the reviewer names them.

**UI**: pre-tick the candidate's own source job domains (they are already on screen), let the
reviewer untick or add. Ticking zero must be a blocked submit with that reason, not a 400 the
user has to decode.

---

## Decision → status mapping

| button | status recorded | extra body fields |
|---|---|---|
| CREATE NEW SKILL | `approved_create` | `proposed_skill_name` (required), `proposed_description`, `approved_job_domain_ids` (min 1), `approved_requirement` |
| ADD AS ALIAS | `approved_map` | `resulting_skill_id` |
| MERGE | `approved_merge` | `resulting_skill_id` |
| REJECT | `rejected` | — |
| HOLD | `deferred` | — |

Every decision also sends `expected_status` (optimistic concurrency) and `review_reason`
(≥ 12 chars). The reviewer and the timestamp are **not** in the body — the server takes them from
the session.

The request body is a **discriminated union with `.strict()`**: sending `resulting_skill_id` on a
`create`, or `proposed_skill_name` on an `alias`, is a 400. That is deliberate — build the form so
it cannot.

---

## States to handle

| state | what to show |
|---|---|
| **409 conflict** | Somebody else decided this candidate, or it moved since you loaded it. The body carries a closed conflict code — render its meaning and offer *Reload*, never a silent retry. |
| **Terminal candidate** | `approved_*` / `rejected` cannot be re-decided. Show the decision, the reviewer, the timestamp and the reason as a record. No buttons. |
| **Deferred candidate** | Re-openable. Show the previous reason and who held it. |
| **Empty queue** | Distinguish "no candidates match these filters" from "no discovery run has been persisted yet" — the second one is an ops state, not an empty result. |
| **Loading / error** | Follow `lib/admin-http.ts`'s error mapping and the existing `(portal)` section patterns. |
| **Capability denied** | An admin without `review_skill_candidates` can still READ the queue (`read_entities`). Render the decision controls as absent, not as broken. |

---

## Acceptance criteria

1. Dashboard tiles render from the metrics route in one request; no client-side aggregation.
2. Grouped view is the default and renders 3,009 groups without loading 6,673 rows at once
   (server-paged, keyset cursor).
3. Every filter and search field in the query schema is reachable from the UI.
4. The detail screen renders in **one** request — no N+1 for sources or matches.
5. No cosine score, vector, or embedding model name appears anywhere in the UI.
6. All competing matches are shown, with `weak` visually subordinate and labelled as context.
7. `CREATE` cannot be submitted with zero job domains; the source domains are pre-ticked.
8. Reason is required on every decision, with the ≥12-character rule enforced before submit.
9. A 409 renders the conflict code's meaning and a reload affordance.
10. Terminal candidates render as a record with no decision controls.
11. Tier sequencing is visible: `derived` is not the default working set.
12. `page.render.test.tsx` covers: empty, loading, error, grouped, flat, terminal, 409, and
    capability-denied.
13. `lib/skill-discovery.ts` mirrors the API types with a schema test, as `lib/feedback.ts` does.

---

## Explicitly out of scope

- Any client-side write to `skill`, `skill_alias`, or `job_domain_skill`. There is no such route.
- Any UI for `MATCH_SKILLS` / `mskill_*`. A discovered skill is an attribute and stays unmapped
  until a separate owner decision.
- Any UI that runs a discovery run. That is a `packages/db` CLI and stays one.
- Editing provenance. It is frozen and digested.

---

## Backend contact points

- Types + display maps: `apps/api/src/admin/admin-skill-discovery.dto.ts`
- Routes: `apps/api/src/admin/admin-skill-discovery.controller.ts`
- Capability: `review_skill_candidates` in `apps/api/src/admin/admin-capabilities.ts`
- Measurement: `docs/registers/skill-discovery/coverage-report-2026-08-26.md`
- Activation sequence: `docs/operations/skill-discovery-activation-plan.md`
