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
ai-service certifier (the names and employers the privacy gateway detects, and placeholders in any shape) and
by the API (hard identifiers, PII shapes, URLs, organisation names, generic words, grounding in the worker's own
message), then de-duplicated. The stage stops when the worker says
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
- **Open before flag-ON** (recorded while building the chat engine, Phase 2):
  - ~~An ended, handed-over chat session re-serves the general-form card to every later message and reopen.~~
    **Closed in Phase 3:** saving the brief (answered or declined) merges `general_form_completed_at` beside the
    stamp. From then on that session serves the résumé menu, and `GET /profiling/general-form` reports `complete` from
    the same mark, per handover, so a chat redo that hands the form over again starts incomplete. Residual: a handover
    whose flush failed is still active, and a later re-flush replaces the whole column and drops the mark; the card
    then returns until the brief is saved again.
  - The voice form can re-attach to an ACTIVE chat session. If that session is armed and on the skills lane, the voice
    surface runs the skills stage and its handover has no card on that surface. The voice form is hidden by default;
    before flag-ON either refuse to continue an armed skills-lane envelope on the voice surface or give it a step.
  - The lane, gate and handover events are emitted inside the turn's retry loop with once-per-session (or per-round)
    keys, like `profile.form_offered`, so a lost attempt's outcome can be the one recorded.

## 6. Defaults approved with the plan (overridable)

16 skills questions, 30 skills, 2 answers in a row with nothing new, 4 gate rounds; an unclear gate answer counts as
Nahi; zero certified skills skip the gate and go to the form; single-select skill chips (max 4); the brief is 1–160
characters, typed only; salary is monthly only; education gains "Postgraduate" and "Doctorate" (the shared validator
accepts both slugs, but only the general form's schema offers them — the trade forms' choices are unchanged);
work-history polish is unchanged; voice-form sessions are never armed.

Added while building (Phase 2a, 2026-09-26), both in the safe direction:

- **Adjacent families count as "one of the 21".** A worker pinned to a generic sibling family whose members are
  overwhelmingly the 21's trades — machining/CNC, fitting, tool and die, sheet metal, assembly, rubber/plastic,
  welding — stays on today's path, as do generic manufacturing words ("CNC operator", "machine operator"), which read
  as "not yet known". This keeps the 5 polymer roles (whose own families are never pinned) and likely members of the
  21 off the general road. Domestic electricians and house painters are still outside the 21.
- **A skill must be grounded in the worker's own words**, with typo tolerance, except when the message has no Latin
  letters at all (Devanagari from voice): the model returns Latin labels there, so grounding is skipped and only the
  privacy walls apply.

Added while building the general form (Phase 3, 2026-09-26):

- **The brief refuses the worker's own name.** The employer copy prints only the name's initials, so a brief carrying
  the stored name (the whole name or any token of 3+ characters, matched as `redactKnownName` matches it) or a
  self-introduction ("mera naam", "my name is", "मेरा नाम") is refused as `brief_name`. If the stored name cannot
  be decrypted, the brief is refused as `brief_unscreenable`. There is no gazetteer: a Latin-stored name typed in
  Devanagari with no cue still passes. The brief also refuses identifiers, contact routes, links, legal-entity names,
  emoji and brackets.
- **The salary band keeps the worker's latest word.** A body with both ends inverted is refused (400). One end sent
  alone that crosses the stored other end clears the stored end, so a page that shows only the top of the band can
  still save.

Added while building the profile build (Phase 4, 2026-09-27):

- **The profile's `experience.total_years` is fixed at build time.** It is the dated-employment sum when the profile is
  extracted, and matching's tenure reads it from there. A later Work History edit re-renders the résumé (which
  recomputes the years live) but does not refresh the profile, and because the completion mark is write-once, a later
  extract dedupes onto the job that ran after completion. Open: re-extract on employment writes for a handed-over
  session (model-free), or judge staleness against the newest employment write instead of the mark.
- **The extraction reads its session once, and fails closed.** The source, the résumé facts and the road all come from
  one `chat_sessions` read. If that read fails, the attempt throws and BullMQ retries it before any model call — for
  every session, since without the row a handed-over session cannot be told from any other. Before, a failed read fell
  to the legacy model path and could build a handed-over session with model years and canonical skills.
- **A session-less extract prefers a finished general handover over a later plain chat**, but never over a later form
  handover (trade `form_kind` or another general handover). Open: a worker who finished the general form and then
  fills a trade form through the CV-import fallback has no session carrying that form, so a session-less extract still
  goes to the general handover and the trade-form answers do not become the profile.

Added while building the résumé (Phase 5, 2026-09-27). The first four are owner rulings of that day:

- **Money in the brief is refused when it is saved.** A new refusal, `brief_salary`, sits after the contact and link
  walls and before the name wall. It refuses any currency sign; a rupee word in any common spelling (`rs`, `inr`,
  `rupees`, `rupaye`, `rupaya`, `रुपये`, `रुपए`, `रूपये`, `रुपया`, `रू`, `रु`, …) next to a number; a number followed by `k`,
  `hazar`, `thousand`, `lakh`, `LPA` or `/-` (a spaced "k" before a postposition, "2019 k baad", is "ke" and passes); a
  salary-sized figure (four or more digits) beside a pay period or an ask ("15000 per month", "18000 mahina",
  "15000 chahiye"), or a three-digit day rate ("500 per day"); a salary word anywhere, misspellings included (salary,
  sallary, salery, tankhwah, pagar, vetan, CTC, सैलरी, वेतन, तनख्वाह, पगार); and a pay word beside a figure ("18000 ka
  package", "wage 15000", "income 20000"). "10 saal", "2015 se 2023 tak", "5 log ki team" and "6 mahine ka course"
  pass. A bare figure with no cue at all ("1500 parts roz") still passes: it cannot be told from a count. The résumé
  re-runs the same predicate on the stored text, so a brief saved before this wall prints the fixed line.
- **A brief that fails the render-time re-check prints the fixed line on both copies**, so the two copies always
  agree. The re-check runs once per render, before the mapper: the stored text must still pass the résumé's PII screen,
  be at most 160 characters, carry no money shape, and not contain the worker's **current** name (whole or any 3+
  character token, as `redactKnownName` matches it). A name that cannot be decrypted fails every brief. The name is
  checked where each copy already decrypts it — the render worker for the worker copy, and the disclosure's single
  decrypt for the employer copy. It never enters the render context, which the disclosure's leak guard scans.
- **A worker with leftover trade-pack rows loses the road — a known limit.** If his newest pack-bearing row belongs to
  one of the 21 (an earlier trade form, then a chat outside the 21), the sheet elects that pack and renders `bb_trade`,
  and the road's rules switch off: no brief, and the stated-figure and machines-first rules apply. Pack election and
  template resolution are unchanged.
- **The app's résumé document gains `layout` and the three lists.** Every `trade_sheet` document now carries `layout`
  (`bb_trade` / `bb_general`, the template the PDF was drawn with, or null for a legacy layout) and `skills`,
  `machines` and `controllers` (#1736's server half). A road résumé is forced to `trade_sheet` even with no pack,
  with `trade: "trade"`, and it alone carries `brief` (the line printed, or null). Generic documents are unchanged,
  and no document carries `source`. The worker app needs a release to show `brief`.
- **The road is decided by the résumé's own provenance, not by "the newest handover".** The résumé names its
  profile, the profile its extraction job, and the job's `input_ref.session_id` the chat session it read; that
  session's stamp says whether it handed over (`handed_over`). Every read is scoped to the résumé's worker. An abandoned
  later chat cannot take the road off a résumé built on it, and a flag flip does not either. It is checked only when
  the template resolves to `bb_general`, and any failure is today's sheet.
- **On the road, the sheet changes as §3.4 says, and each rule replaces the old one.** Years are the dated-jobs sum
  alone (a job with no dates means no total), never the profile's frozen figure, a stated figure or a tier's years.
  "Fresher" prints only when no job is stored **and** the history was read. The headline's tools are the skills
  first, then the machines, so the history card's tools line shows skills too. The salary band comes from
  `salary_expected_min` / `_max` on the worker copy only; one end alone prints as a single figure. "Available from"
  prints "From 12 Oct 2026" for a date still ahead, "Immediately" for a past date or `immediate`, "Serving notice
  (30 days)" for a notice period, and the status label otherwise; with no answer the row keeps its old value. The Shift
  row is "{shift} · {work types}". None of this touches a worker off the road.
- **The fixed line is null when the work-history read failed.** §4.3's grammar is not widened: "{Role} with skills
  in {S}." stays licensed only for jobs that exist but are not all dated, never for jobs nobody could read. The
  worker's own line does not depend on his history and still prints.
- **The two copies are rendered at different times.** The worker copy is a stored PDF, drawn when the résumé renders.
  The employer copy renders live at disclosure, from the brief and the name as they are then. A disclosure reused
  within its TTL re-signs the cached PDF, so that copy keeps its brief until the TTL runs out.
- **The brief belongs to the worker, not the handover.** After a second handover, the sheet prints the brief he saves
  last; until he saves a new one, the previous handover's brief prints.

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
