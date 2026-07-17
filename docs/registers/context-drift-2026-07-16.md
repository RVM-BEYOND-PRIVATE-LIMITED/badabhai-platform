# Context Drift Register — 2026-07-16

Verification of **`BadaBhai_Latest_Context_2026-07-14.md`** (the strategy/context master) against the code.

> **Method.** Seven independent read-only verifiers, one per surface (taxonomy · model routing/cost ·
> persona/questions · pseudonymization/PII · reach weights · pricing/caps · résumé/kit/consent/voice).
> Every row below cites `file:line`. Claims that could not be settled from the repo are marked UNKNOWN
> rather than guessed.

## State of record

> **Branch:** `main` @ `2c850a5` (#340, ADR-0032 worker profile photo) — 2026-07-16
> **Migrations:** 41 (0000–0040) · **DB tables:** 39 (`pgTable` count)
> **PR range on main:** through **#342**
> **The context doc is NOT in this repo** — it cannot be edited here. This register is the reply to it.

⚠️ **Volatility warning.** This checkout is shared and was fast-forwarded **four times mid-verification**
(`git reflog`: `ce11aa0 → b208b52 → 95977c0 → d73e1b7 → 2c850a5`). Findings are true as of `2c850a5`.
Re-verify any row before acting on it days later.

## The governing rule

**Decisions flow doc → code. Build-state flows code → doc.**
Where the doc states a `[LOCKED]` decision the code contradicts → that is a **work item**, not a doc edit.
Where the doc describes build state → **the code wins** and the doc is corrected.
**Nothing in category A or B below was "reconciled" by editing either side. Those are owner calls.**

---

## A. 🔴 DANGEROUS IF EXECUTED — do not action without an owner ruling

| # | Doc instruction | Why it would cause harm |
|---|---|---|
| **A-1** | §0.5 / §9 / §15: **"Cities are NOT PII and must not be redacted"** | **The premise is false.** City is masked from LLM input *and already reaches matching* — read from **raw** text locally inside the trusted service (`apps/ai-service/app/profiling/signals.py:8-12`, no network), and `profile_extractor.merge_model_draft` (`:178-180`) **refuses** to overlay location/salary from the model precisely because the model only ever saw masked text. The Delhi/Bihar corruption was **dropped data** (gazetteer gap: `dilli` unknown, no state capture), **not** redaction — fixed and regression-locked at `apps/ai-service/tests/test_welder_repro.py:192-197`. **Un-redacting cities pushes PII into LLM input for zero matching gain — a CLAUDE.md §2 invariant-2 violation.** |
| **A-2** | §5: **RANK weight "Skills 15"** | No skills signal exists in RANK, and **TAX-6 deliberately locks it out**: `packages/reach-engine/src/no-skills-in-rank.test.ts` greps every non-test source in `reach-engine` + `apps/api/src/reach` for `/skill/i` and `/embedding/i` (comment-stripped, so prose can't satisfy it). **Implementing the doc's weight table breaks CI by design.** The test anticipates this: *"If a future ADR legitimately adds a skills factor, it must edit THIS test in the same diff."* Requires an ADR, not a code tweak. |

### A-2 has a governance problem underneath it
The doc says *"engineering reconciles the diverged code (ADR-0006)."* **ADR-0006 says the opposite** —
`docs/decisions/0006-reach-foundation-rank-core.md:82-83`: *"the implemented weights are the source of truth
and the ledger's columns are a draft (**the doc is reconciled to the code, not the reverse**)."* That divergence
was **ratified** (`docs/registers/team-decisions.md:36-47`, 2026-06-12).
A later **2026-06-19 CEO lock** reverses the direction (`.claude/project-memory.md:52`) — but it **never landed
as a decision row** (`team-decisions.md` stops at 06-15) and was **never implemented**.
**→ Owner call required: is the 06-19 lock operative? If yes, it needs an ADR + the CI lock edited in the same diff.**

---

## B. 🟠 CODE-VIOLATES-A-LOCKED-DECISION — real work items

| # | Locked decision | Code truth | Sev |
|---|---|---|---|
| **B-1** | §3.1 Company posting **"verification-gated"** | **No gate exists.** `payers.status` defaults `"pending"` (`packages/db/src/schema.ts:131`) but is **never read** on the auth guard or any posting path — only ops suspend/reinstate touches it. **An unverified `pending` payer can post and buy today.** | **P1** |
| **B-2** | §4 / §15 **"AI-generated résumé prose" is DEAD → deterministic template-fill** | **The LLM prose path is live code**, dormant only behind default-false `AI_ENABLE_REAL_CALLS`: `apps/ai-service/app/main.py:735-741` calls `router.run("resume_generation", …)` with `RESUME_SYSTEM_PROMPT` (*"You write a short, plain worker summary… 2-4 sentences"*, `prompts.py:58-62`). Deterministic `build_resume` is only the **mock fallback**. **The PDF is clean** (`resume-render-input.ts` never reads `resumeText`); **`generated_resumes.resume_text` is not.** Flip the flag → an LLM writes it. | **P1** |
| **B-3** | §9 DPDP consent gate before AI processing | **`POST /resume/generate` has no `ConsentGuard`** — `apps/api/src/resume/resume.controller.ts:55-57` carries `WorkerAuthGuard` only, yet `resume.service.ts:81` calls the AI service. Mitigated indirectly (needs `profileStatus === "confirmed"`) — but the `systemInitiated` path **skips that re-read** (`:73`). The only worker AI route missing the gate. | **P1** |
| **B-4** | §4 **"location (current AND preferred — do not conflate)"** | **Conflated.** One topic, one question asking both (`question_bank.py:61-65`), and `signals.py:437-438` marks it answered on **either** → `location` is an ESSENTIAL topic, so `extraction_ready` can flip **with preferred location never asked**. Schema splits them (`contracts.py:187-192`); the question layer doesn't. | **P1** |
| **B-5** | §4 **"ONE question per turn"** | 4 bank questions **bundle two asks** (`question_bank.py:56-57, 63, 72, 76`). The persona test counts **words, not questions**, so it passes. `main.py:516-523` returns the templated question directly — no LLM turn to split it. | P2 |
| **B-6** | §6 taxonomy **versioned; version stamped on every profile** | **Fiction.** `SKILL_TAXONOMY_VERSION` (`packages/taxonomy/src/skill-corpus.ts:28`) has **exactly one occurrence repo-wide: its own definition.** Never imported, never written. `worker_profiles.skills` (`schema.ts:362`) is a bare `string[]` with **no version column**. ADR-0030:60 asserts the vocabulary "carries a `taxonomyVersion`" — it does not. Batch re-tag ✓ and `skill_id` immutability ✓ are real. | P2 |
| **B-7** | §3 caps **5 unlocks/worker/7d · 50/day/account** | `5 per worker per **DAY**` (`packages/config/src/server.ts:455`) ≈ **35/week — 7× looser**. Account cap is **30/HOUR** (`server.ts:288`) with **no daily ceiling** → theoretical **720/day**. Undocumented extra: 10 distinct payers/worker/week (`server.ts:456`). Caps are real + config-driven; the numbers are not the doc's. | P2 |
| **B-8** | §2 attribution **"first-to-introduce by phone"** | Keyed on **invite code**, not phone (`agency_invites`, `schema.ts:1448-1486`, unique index on `code`). Two agencies linking the same worker have **no phone-level tie-break**. **No window column exists**, so the "90-day, no resets" clock isn't implemented. | P2 |
| **B-9** | §7 cost target **≤4 paise/profile** | Code target is `ai_target_profile_cost_inr = 4.0` = **₹4.00 = 400 paise — 100× looser** (`apps/ai-service/app/config.py:139`). Worse, `above_target`/`cost_alert` are computed on a **single call** (`cost_tracker.py:86`); **no per-profile rollup exists anywhere.** → **"83 paise → 4 paise" is not measurable by any code in this repo.** | **P1** |
| **B-10** | §7 **"₹6 alert and auto-downgrade remain"** | **Auto-downgrade does not exist** — no implementation anywhere. On cap breach the router falls back to the **deterministic mock** (`router.py:107-119`), never a cheaper model; the fallback chain is cross-**provider** and Haiku is *pricier*. The **₹6 alert is a boolean that goes nowhere** — `cost_tracker.py:84`: *"flagged but NOT sent anywhere externally in Phase 1."* Likely conflated with the **real** ₹6/user/day hard cap (`config.py:160`), which *is* enforced. | P2 |
| **B-11** | §3.7 **one branded template per trade-family** | **Does not exist.** 4 **generic layouts** (`resume/templates/registry.ts:30-39`); no trade-family→template mapping. `templateId` is **hard-coded `"classic"`** (`resume.service.ts:119,135`) — `modern`/`minimal` are unreachable dead code. | P2 |
| **B-12** | §9 **18-month inactive → anonymise** | **Not implemented.** No scheduled job, no anonymise routine, no last-active retention logic in `apps/api/src`, `packages/db`, or `docs`. | P2 (DPDP) |

---

## C. 🔵 DOC-STALE — code is current/better; correct the doc

**Build state (§11 — the doc already flags itself stale; here is the truth):**
| Doc | Reality |
|---|---|
| 72% / 57% / 28% @ 2026-06-29 | `2c850a5`, PRs → #342, **41 migrations**, 39 tables |
| **"P1 money-route auth (LC-1) open"** | **PHANTOM — closed.** `apps/api/src/payer-portal/payer-unlocks.controller.ts:40-41`: the **whole class** is `@UseGuards(PayerAuthGuard)`; `payer_id` from session (XB-A), reveal enforces ownership at the chokepoint. Residual is **ops-internal only** (TD33/TD50). CLAUDE.md §8 is correct. |
| §14 `[BUILD NEXT]` (embeddings, skill tables, ESCO, alias seed, whitelist strip, persona, caching) | **All shipped** 07-14/15: TAX-0..9 (#211–#232), AI-PERSONA-1/2 (#203/#205), COST-2/3/4 (#206/#208/#210). The doc was compiled mid-flight. |
| BUG-2 "staging DB 9 migrations behind" | Superseded — 0038+0039 owner-applied 2026-07-15 |

**Architecture / models:**
| Doc | Reality |
|---|---|
| §10 **"Vertex AI multilingual embeddings (768)"** | **Vertex is used nowhere** — no SDK, no client. Live path: **AI Studio + `gemini-embedding-001` @768** (`config.py:72`, `embeddings.py:49,86-120`). `text-embedding-004` **retired** (provider 404s). *In-repo drift to fix:* `packages/db/src/schema.ts:369,1737,1810`, `packages/db/README.md:15-16`, `.claude/project-memory.md:27`, `embeddings.py:16` still claim Vertex. |
| §10 **"Sarvam Saaras v3"** | **`saarika:v2.5`** (`config.py:180`). `:179` calls Saaras v3 *"future"*. |
| §7 **chat + extraction on Flash-Lite** | Chat ✓ flash-lite. **Extraction is `gemini-2.5-flash`** — pinned deliberately so the gold-set validation model == the flip model (`config.py:49-57`). |
| §0.5 **"Haiku serving ~86% of turns"** | Moot — straight-line chat now calls **no LLM at all** (`ai_profiling_rephrase_enabled=False`; templated questions). Whether a **deployed** `.env` overrides to Haiku-primary is **UNKNOWN from the repo** — check the host. |
| §7 prompt caching | Implemented + guarded, but **inert**: persona ≈200 tokens « the 1024/4096 minimums (`model_config.py:128-130`). Saves nothing today. |
| §6 floor **~0.80–0.85** | **0.75** (`config.py:92`), **calibrated on real vectors** (TAX-5, `tests/wedge_eval/scores_2026_07_14.json`; negatives ceiling 0.7263, next TP 0.7815). Code is evidence-based; **ADR-0030:54 still says 0.80–0.85 and should be corrected.** |
| §6 **11 domains, ~45 roles** | **7 roles** (test-pinned, `taxonomy.test.ts:6`); 5 occupation domains; 10 *skill* domains. No repo source for 11/45. |
| §6 **ESCO adopted** (~3k occ / ~14k skills) | **Curated starter subset, hand-authored**: 33 skills / 98 aliases; **zero ESCO/O*NET/NCO source files**. `packages/taxonomy/PROVENANCE.md:8-15` is honest and is the better artifact. |
| §4 **six questions** | **9 defined / 4 required** (`question_bank.py:38-82`, `interview_engine.py:28`). Git shows **9 since file creation — never 11, never 6.** The "11-question cost driver" has no origin in this repo. |
| §4 hybrid form **"built but unused"** | **Not built.** Design-system prototype only; explicitly registered as not built (`docs/registers/future-improvements.md:134-137`). |
| §5 adjacency **1.00/0.90/0.85/0.45/0.25/0.15** | **No such matrix.** 4-value ladder (`scoring.ts:60-66`: 1 / 0.6 / 0.4 / 0). The `reach-engine-config` draft it cites **is not in this repo**. |
| §5 **PACE = fill-to-quota, pause at quota** | **Different mechanism.** Shipped PACE (ADR-0021) is **supply-widening**, inert by default, and only ever **adds**. No pause-at-quota: the feed's `jobs` table has **no paused state** (`schema.ts:848`); `job_postings` (a *different* table) does. |
| §5 **boost reorders within relevance** | **Boost does not exist** (TD42). The invariant holds **vacuously**. |
| §6 **`function` modifier / per-experience tagging / "best tag wins"** | **None exist** (zero hits). The trainer case — the doc's showcase — has no code. `worker_profiles.skills` is one flat array per profile. |
| §3.6 / §7 **waitlist** | **No code.** Design prose only. (TAX-8 is a *different* guard: canonicalization can never block résumé generation.) |
| §10 **Razorpay** | **Zero lines of provider code** — a named intent behind a seam. `PAYMENTS_ENABLE_REAL=false`, fail-closed at boot. |
| §3 six billable objects | 4 exist under other names; **`agency_payout` absent**; **`assisted_hiring_order` is not a stub — zero hits.** |
| §3.3 **unlock ₹40 flat** | True as an anchor, but `UNLOCK_UNIT_PRICE_INR = 40` is **dead code** (one hit — its own definition); unlocks debit **1 credit**. 1000-pack is **₹32/credit** (correct per §3.3's own discount clause). |

**Verified as MATCHING (no action):** embeddings-not-LLM canonicalisation with SG-3 (an LLM can never inject an id the vector layer didn't assign) · human-gated growth loop (defended at 3 layers) · alias-not-label embedding · domain-scoped search · `skill_id` immutability + batch re-tag · name never crosses the LLM boundary (post-emit `{{worker_name}}`, #205) · pseudonymize fail-closed (4 paths) incl. the embedding path · no raw phone/name/employer to LLM · retry diagnostics (`attempt_count`/`candidates_tried`/`failure_reason`, both contracts) · never-reject (no reject path exists) · gender-neutral persona (banned terms appear only in NEVER-clauses) · sector never influences matching (not in the scorer's type surface) · no demographic inputs · RVM never an algorithmic input · LLM never ranks · sort-never-block (property-tested) · LEARN is offline-only (structurally — nothing depends on `reach-learn`) · **money never tilts worker visibility (structurally unrepresentable)** · packs 50/200/1000 with a real 20% discount · role-agnostic pricing · actor-agnostic payments · config-driven pricing · résumé free forever · safe-fields-only worker edit · `model_training` consent from day one · voice ≤2min + retain-indefinitely + storage class · actor-scoped deletion (business rows `set null`, not cascade) · async-only voice · trade content never-purge.

---

## D. 🐛 Real bugs the context doc did NOT find

| # | Bug | Evidence |
|---|---|---|
| **D-1** | **`salary 1000000` blocks the conversation.** The phone-regex story is dead (needs ≥9 digits), but the false positive **migrated** to `_RESIDUAL_DIGITS_RE = \d{7,}` (`pseudonymize.py:85`) → whole turn blocked with *"please rephrase without sharing personal details."* **Contradicts `signals.py:246`**, which accepts salaries to 10,000,000. **No regression test.** | P1 |
| **D-2** | **Voice notes 30–120s cannot transcribe.** Platform accepts **120s** (`MAX_VOICE_NOTE_SECONDS`); `stt.py:50` `SARVAM_SYNC_MAX_SECONDS = 30.0` and `:190-194` raises *"batch STT not implemented"*. **The 2-minute product promise and the STT transport disagree by 4×.** Fails closed, silently unusable. | P1 |
| **D-3** | **`scripts/staging-smoke.mjs` is architecturally obsolete.** Its **load-bearing assertion** is `dev_otp` present ⇒ *"PROVES SMS_PROVIDER=console"* (`:8,:12,:113`). But `SMS_PROVIDER: z.literal("fast2sms")` makes `console` **fail Zod parse at boot**. It asserts a posture the config forbids → **permanently red**. Rewrite, not a patch. (= ESC-1 in the 07-15 reconciliation, understated there as a stale line.) | **P0** |
| **D-4** | **Canonicalize recall is 0.350 shipped, not 0.800.** Oracle 0.800 vs shipped anchor-domain path **0.350** (`config.py:82-86`). The code says: *"Do not cite 0.800 for launch."* Per-label domain routing is unbuilt. | P2 |
| **D-5** | **The 0.75 floor is calibrated on a corpus that predates the wedge it justifies.** Backfill was 76/76 aliases on 07-14; the 22 wedge aliases were ratified **07-16** (`wedge-aliases.ts:5-8`). **Re-seed + re-embed + floor re-sweep outstanding.** | P2 |
| **D-6** | **Ops price edits don't reach the portal.** `payer-web` reads the **compile-time** `DEFAULT_CATALOG` (`pricing-config.ts:61,83,104`), not the live API — displayed tiers/quotas won't move without a rebuild. Also **₹0 is uneditable by ops** (`priceInrSchema.min(1)`), so "free posting" **cannot be modelled** as a price (the code flags this itself as ESCALATED). | P2 |

---

## E. ⚙️ Process findings

- **E-1 — `doc-reconciliation-2026-07-15.md` overstates itself.** Its **D-22** claims *"PROJECT_STATUS.md header + scores updated."* **It was not.** At `2c850a5`, `docs/tracker/PROJECT_STATUS.md` still carries the **phantom LC-1 in 4+ places** (lines 15, 32, 40, 90, 118 incl. *"Unlock/Reveal | 40% | BLOCKED | rides InternalServiceGuard"*), still dates itself **2026-07-10**, and still lists **FE-1..FE-7 as remaining** though its own D-08 records them closed by #194. **Treat that register's "Action Taken" column as a claim to verify, not a fact.** (Its D-04 fix to CLAUDE.md **was** real — verified at `CLAUDE.md:230`.)
- **E-2 — that register is already overtaken** on TD61: it lists Flutter CI as pinned 3.27.4 with no payer-app gate. As of #243 both `worker-app.yml` and `payer-app.yml` pin **3.35.7** and **both are blocking**.
- **E-3 — the shared checkout is unsafe for uncommitted work.** During this session, concurrent `pull origin main` fast-forwarded the tree four times, and an **uncommitted TEST_MATRIX rewrite was swept into an unrelated commit** (`3118f59 "ci: integrate lightsail deployment into main ci workflow"`) by a blanket `git add`. Docs work here must be committed promptly or it lands under someone else's message.

---

## Owner queue (decisions only I cannot make)

1. **A-1 — city ruling.** Confirm withdrawn. As written it is a §2 privacy regression for zero gain.
2. **A-2 — Skills-15.** Operative or aspirational? If operative: ADR + edit `no-skills-in-rank.test.ts` in the same diff. Also settle whether the **2026-06-19 CEO weight lock** supersedes ADR-0006's ratified doc→code direction — it has never been recorded as a decision row.
3. **B-1 — posting verification gate.** Unverified payers can post and buy today. Build the gate, or drop "verification-gated" from the decision.
4. **B-9/B-10 — cost.** Is the target 4 paise or ₹4? Per-profile measurement does not exist; auto-downgrade does not exist. Both need building before the cost claim can be made.
5. **B-7 — caps.** Ratify the real numbers (5/worker/day, 30/payer/hour, no daily account cap) or change the code.
6. **B-8 — attribution key.** Phone or invite code?
7. **§13.1 — Flutter IAP.** Unchanged and still open.
8. **§13.2 — Grievance Officer** still unnamed; production DPDP copy still pending.

---

_Compiled 2026-07-16 against `main` @ `2c850a5` by the control-room, from seven independent code verifiers.
Where this register and the 2026-07-14 context doc disagree on **build state**, this register wins — it is
evidence-cited. Where they disagree on a **decision**, the context doc wins and the gap is logged above as work._
