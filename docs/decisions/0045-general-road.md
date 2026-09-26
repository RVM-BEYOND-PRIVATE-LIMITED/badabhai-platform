# ADR-0045: The general road — role → skills → offline general form, for roles outside the 21

- **Status:** **Accepted for build (ships OFF).** The rulings R1–R7 below were given by the owner on 2026-09-26; the
  defaults in §6 were approved with the plan. **Production flag-ON is gated on the owner's signature** at the foot and
  on the worker-app release that draws the card and the form.
- **Date:** 2026-09-26
- **Owner:** product owner (rulings relayed by Divyanshu, 2026-09-26)
- **Amends:** [ADR-0042](0042-profile-road-separation.md) D8 (chat-road completions no longer always go straight to
  the résumé — see §4.1)
- **Relates:** [ADR-0042](0042-profile-road-separation.md) (the roads, the trade-form offer) ·
  [ADR-0043](0043-resume-history-and-chat-update.md) (the update offer is not served on this road) ·
  [ADR-0039](0039-work-history-polish-section-8-override.md) (still the only model rewrite of résumé text) ·
  [ADR-0041](0041-resume-import-and-prefill.md) D4 (résumé-import text never prints — unchanged) ·
  the `bb_general` sheet (#1735, #1745; `apps/api/src/resume/templates/README.md`)
- **Flag:** `CHAT_GENERAL_ROAD_ENABLED` (default off; stamped per session)

---

## 1. Context

A worker whose role is **outside the 21 predefined roles** (`ROLE_FORM_DESCRIPTORS`) is profiled today by one model-led
stretch — domain, role, skills and experience together — then the universal pack's fixed questions, then a post-chat
model read of the whole transcript. The résumé that comes out is thin: skills only as the model's free text (and only
because the transcript read re-found them — the chat's own draft is never persisted), no real work history, education
or certificates, and no line in the worker's own words.

The owner wants these workers profiled in three clear steps: the model captures the **role**, then **only skills** —
as many as possible, specific to the role — and everything else is asked **offline**, by a form built like the trade
form, that asks exactly what the general résumé prints.

## 2. Rulings (owner, 2026-09-26)

| #   | Ruling                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Scope: only roles outside the 21.** "The 21" is all 21 declared roles, including the 5 whose forms are not built yet. The 21 keep today's path exactly: the trade-form offer; Haan → the trade form; Nahi → today's chat. The 5 without a form get no offer and continue today's chat.           |
| R2  | **Phase A** (model) captures the **role and trade** only.                                                                                                                                                                                                                                          |
| R3  | **Skills stage** (model) captures **skills only**, role-specific, as many as possible. It ends at a **deterministic gate**: the captured skills as bullets, then "Kya aur koi skill jodni hai?" [Haan] [Nahi]. Haan → more skills. Nahi → the chat closes with a card that opens the general form. |
| R4  | **General form** (offline, no model asks anything): Availability & Terms (salary, preferred locations, shift and work types, languages, availability/notice), Work History, Education, Certifications & Training, and a last optional **brief**. Skills are not asked again.                       |
| R5  | **Total experience comes only from the Work History** (employment dates). Whatever the chat opener captured never counts. **No work history ⇒ "Fresher"**, as on the form road.                                                                                                                    |
| R6  | **Brief:** the worker's own words, PII-screened, on **both** the worker and employer copies; if the worker skips it, a fixed deterministic line; otherwise nothing. **No model writes the brief.**                                                                                                 |
| R7  | The skills go on the **résumé only**. Matching is unchanged for now.                                                                                                                                                                                                                               |

## 3. Decision

### 3.1 The lane

Every chat session is stamped once, when its envelope is created, with whether the general road is armed
(`CHAT_GENERAL_ROAD_ENABLED` and `CHAT_LLM_INTERVIEW_ENABLED`). An unarmed session runs today's interview byte for byte.
An armed session runs today's Phase A unchanged until the role is known, then settles into one of two lanes:

- **classic** — the role is one of the 21 (any descriptor's occupation terms, a trade-form route, or a pin to one of
  their families), the trade-form offer went on screen, the model was unavailable, or Phase A ended without a role.
  Today's interview continues exactly.
- **skills** — the role is known and is none of the 21. Level words ("senior", "operator", "helper") and machine words
  are not evidence either way.

On entering the skills lane the chat forgets the opener's experience answer (R5) and stops cross-filling experience.

### 3.2 The skills stage and the gate

The model runs a skills-only prompt (`interview_mode: "skills_only"` on the existing turn route and task type — so no
real-call allow-list change). Every skill it returns is **certified** twice before it is echoed or stored: by the
ai-service certifier (names, employers, placeholders) and by the API (hard identifiers, PII shapes, URLs, organisation
names, generic words, grounding in the worker's own message), then de-duplicated. The stage stops when the worker says
there is nothing more, when two answers in a row add nothing, when the model reports done, or on a cap (16 questions,
30 skills, 4 gate rounds). The gate is built only from certified skills; its answers are read deterministically, and an
unreadable one is treated as Nahi (counted apart), like the experience gate and the form offer.

### 3.3 The handover and the general form

A Nahi closes the chat with `general_form_offer` — a separate response field from `form_offer`, whose closed trade
`kind` shipped apps route to the trade form. The chat persists the confirmed role and skills durably in
`conversation_state.general_road` (the chat's draft is Redis-only and would otherwise be lost), withholds extraction
exactly as the trade-form handover does, and never serves "Resume update kar doon?" on this handover.

The general form (`GET /profiling/general-form`, `POST /profiling/general-form/answer`) reuses the **existing page
endpoints** for terms, employment and qualifications, plus two questions of its own — "Kya pehle kaam kiya hai?" and
the brief — stored as pack-less `worker_attributes` rows (pack election reads only rows with a pack, so they can never
re-pick the sheet's trade). No migration, no pack.

### 3.4 The profile and the résumé

After the form the app runs extract → confirm → generate, as the trade-form road does. On this road the profile is
built **with zero model calls**: the answer map's deterministic projection plus the persisted role and skills; no
answer-map parse, no transcript read. The source stays `chat`. The profile's `experience.total_years` is the sum of
the dated `worker_employment` rows, and null when any stored job is undated (R5). The skills are written to
`skill_labels` only; the canonical `skills` column that matching reads is not touched (R7).

The résumé (`bb_general`) on this road: years from `worker_employment` only; **"Fresher" when no employment is
stored** — the one Fresher rule on this road (the "Kya pehle kaam kiya hai?" answer only decides whether the Work
History page is shown); the headline's tools are the worker's skills; salary from the form's band; an "Available from"
row; the shift row carries work types; and a brief under the headline, on **both** the worker and the employer copy
(R6).

## 4. What this changes in earlier decisions

### 4.1 ADR-0042 D8 — amended

D8 said chat-road completions go on to the résumé, never the form. For a chat worker on the **skills lane** that no
longer holds: the chat hands over to the general form, and the résumé follows it. Every other chat-road completion is
unchanged, and `POST /profile/confirm`'s `next` routing is unchanged (the source stays `chat`).

### 4.2 "The stated figure wins" (`renderedTotalYears`) — a road-scoped exception

Everywhere else a worker's stated total outranks the sum of their jobs. On the general road the total is the sum of
their dated jobs only (R5). An undated job makes the total unknown, exactly as today. No stored job means "Fresher" (§3.4).

### 4.3 The fabrication gate — two new licences, no new source

- **The brief as supplied**: the worker's own text, verbatim after a PII screen. Not a fourth source — it is the
  worker's own words, as their work-history lines are.
- **The fallback line**, a closed deterministic grammar over facts already on the page:
  - `{Role} with {Y} of experience in {S}.` / `{Role} with {Y} of experience.`
  - `Fresher {Role} with skills in {S}.` (no employment stored)
  - `{Role} with skills in {S}.` (jobs exist, none dated)

  where Role is the headline's role, Y is the employment total written as the headline writes it, and S is the first
  three headline skills. Anything else is null. The gate accepts a brief only if it is the supplied text or matches this
  grammar with every atom sourced. No model writes or rewrites the brief. ADR-0039's work-history polish applies on
  this road exactly as on every other, and remains the only model rewrite of résumé text.

## 5. Consequences

- **The 21 are untouched**, including the offer, the form, the sheet and every event. Flag off, everything is untouched.
- **Five new events**, ids and closed sets only: `profile.profiling_lane_decided`, `profile.skills_gate_answered`,
  `profile.general_form_mode_entered`, `profile.general_form_answered`, `profile.general_form_completed`.
- **Cost:** up to 16 extra model turns per outside-21 profile, recorded under `profiling_chat_turn`; the profile build
  on this road saves the parse and transcript-read calls.
- **Older app builds** have no card for the handover — the flag stays off until the release that draws it ships.
- **Matching** does not see these skills (R7). Revisit with the owner.

## 6. Defaults approved with the plan (overridable)

16 skills questions, 30 skills, 2 answers in a row with nothing new, 4 gate rounds; an unclear gate answer counts as
Nahi; zero certified skills skip the gate and go to the form; single-select skill chips (max 4); the brief is 1–160
characters, typed only; salary is monthly only; education gains "Postgraduate" and "Doctorate" (the shared validator
accepts both slugs, but only the general form's schema offers them — the trade forms' choices are unchanged);
work-history polish is unchanged; voice-form sessions are never armed.

## 7. Rollout

1. Backend in phases, each merged dark: contracts → ai-service skills mode → chat engine → general form API → profile
   build → résumé.
2. Worker-app issues (the gate's keyboard lock, the card, the general form screens, the brief on the Resume tab).
3. After the app release: set the GitHub `production` environment secret `CHAT_GENERAL_ROAD_ENABLED=true` and
   redeploy; verify on a device with an outside-21 role end to end.

---

```
Owner rulings R1–R7 taken 2026-09-26 in the planning session; production flag-ON requires this signature.
Signed (CEO / Prakash): ______________________          Date: __________
```
