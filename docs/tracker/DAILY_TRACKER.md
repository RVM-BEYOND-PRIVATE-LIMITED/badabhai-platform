# Daily Tracker

Newest day on top. Copy the template block each working day. Every % move needs a
[QA_EVIDENCE.md](QA_EVIDENCE.md) row.

---

# Daily Tracker — 2026-07-17

## BadaBhai Progress Snapshot
- **No % moves** (cap rule: no staging/handset evidence added today)
- **P0 — TWO MIGRATIONS ARE APPLY-BEFORE-DEPLOY.** `0042_taxonomy_version_stamp` and
  `0043_…price_inr` are both **named explicitly by their writers/readers** — deploying
  either without applying it first breaks extraction INSERTs (0042) and *every* credit
  purchase + the history read (0043). Not silently-ignorable additive columns.
- **Deploy pipeline is GREEN** (CD-1/CD-1b: ephemeral GITHUB_TOKEN login verified live,
  env→box secret bridge working, `environment: staging` gate). GitHub **secret scanning +
  push protection ENABLED**. Repo is now **PUBLIC** — every dev-literal stake is raised.

## The ten owner rulings (2026-07-17) — recorded in [team-decisions.md](../registers/team-decisions.md)
All ten context-drift decisions answered in one pass; see that register for the verbatim
mapping. Headline: **A-1 city instruction WITHDRAWN** · **A-2 the 06-19 CEO weight ledger IS
operative** (supersedes ADR-0006's code-wins direction) · **B-7 docs adopt the code's real
caps** · **B-2 keep the gated LLM résumé path as an add-on** · **D-2 build async STT properly**
· **D-3 gated test-login approved** · B-1/B-9/§13.1/§13.2 deferred to near-production.

## Merged today (10)
| PR | What |
| -- | ---- |
| #387 | The ten rulings, recorded before any builder cited them |
| #388 | **B-6** taxonomy version stamped on profile skill writes (**migration 0042 — apply first**) |
| #390 | **DEP-2 + CI-6 + LINT-1**: postcss/esbuild overrides (pnpm 11 reads them from `pnpm-workspace.yaml`, **not** package.json — the package.json route installs clean and silently no-ops), actions/cache v4→**v6** (latest major, not the assumed v5), last `any` gone → **lint is now zero-warning repo-wide** |
| #391 | **D-3** gated test-login mint seam — prod-arm proven impossible across 11 env combos; synthetic-phone `+9100000XXXXX` (a real Indian mobile starts 6-9, so a five-zero prefix is *unassignable*); staging smoke rewritten (its old `dev_otp` assertion was permanently red by design) |
| #392 | **D-1/B-4/B-5** — salary carve-out, location split, one-ask-per-turn. **Closed a REAL pre-existing gateway leak**: `_PHONE_RE` spanned only `[digits, space, dash]`, so `9876.543.210` egressed *and wasn't even blocked*. Took **two review rounds** — the first fix was a regression in disguise (narrowed separator COUNT to one → `98765 - 43210`, ordinary typing, leaked where main masked). Now **13/13 shapes, 0 regressions** (main was 8/13) |
| #393 | **D-6** portal renders the LIVE pricing catalog; review caught that it *newly created* a display-vs-charge divergence (ops edit → promise 60 credits, grant 50) → charge path now reads the same catalog; **migration 0043** stamps the charged amount so history stops re-pricing the past |
| #394 | **ADR-0033** deterministic skills-overlap factor at weight 15. Review CRITICAL: the "byte-identical today" claim was **false** — measured **5000/5000 scores changed, 200/200 fleets reordered, 8.3% pushEligible flips**. Retracted; the re-rank is the ruling's intent, now stated plainly + pinned by a golden test |
| #395 | **D-2** 30-120s notes transcribe (chunked sync; batch API not derivable from the repo, so not guessed). Review HIGH: a crafted 200KB `.m4a` bought **6,780 Sarvam calls (₹1,695)** against a ₹0.50 reservation → now **0**; memory amplification **320MB → 2KB** |
| #396 | **R31** unauthenticated `PUT`/`GET /pricing/catalog` + **TD79** `topUpAction` owner gate |
| #397 | **Gateway Indic/CJK separators** — the **Hindi danda `।` leaked**, found post-merge by #395's review. A *separator*, i.e. #392's "13/13 closed" class; its unicode sweep was Latin-centric. Matters because Hindi ASR ends utterances with a danda and #395's seams *are* utterance boundaries |

## Owner queue (ordered)
1. **SECRET-1** (10 min, not delegable) — restrict the Google API key in the Console (live-validated; repo is public). Restrict, don't rotate, unless metrics show abuse.
2. **Apply 0042 then 0043** — both apply-before-deploy (above).
3. **STAGING-SECRETS-1 residual** — real secrets in env `staging`. `CORS_ALLOWED_ORIGINS` is set to an explicit **sentinel** (`https://no-browser-frontend-deployed-yet.invalid`) because no browser frontend is deployed and the worker app is native; replace when payer-web/ops-web get a staging host.
4. **D1 ruling** — is the Lightsail box prod or staging? If prod: `environment: production` + required reviewer. Also gates CD-2 (with the 0031 sign-off).
5. **R30 gates `AI_ENABLE_REAL_CALLS`** — the word-split residual (`98765 aur 43210`) is OPEN by design: every proximity net tested destroys `15000 se 18000`, a real salary pair. It's an honest negative in the suite, not a silent gap.
6. **R31 gates `PAYMENTS_ENABLE_REAL`** — `PUT /pricing/catalog` is unauthenticated and rewrites what payers are **charged**, not just what they see.
7. **TD59 gates arming Sarvam** — the worker-app polls ~14s; a real 120s note now takes ~4 minutes.
8. **B-1** (a/b/c) · **R28** · **TD70(3)** employer-suffix over-drop · **B-9** cost claim · WA-6..10 · move the ~70 repo-scope secrets (incl. `ANTHROPIC_API_KEY`) into env scope now that the repo is public.

## Lesson worth keeping
Three of four reviews caught claims that were **asserted rather than measured** — "byte-identical", "test-locked", "masks byte-identically". Each was disproved by executing the code. The A-2 golden test then immediately caught two of its own author's hand-predicted numbers. And the danda leaked because the *shape matrix itself* was Latin-centric — the tests were only as good as our imagination about input, in a Hindi-first product. Worth a standing Hindi/Hinglish/Devanagari ASR corpus for the gateway rather than per-finding character sweeps.

---

# Daily Tracker — 2026-07-16

## BadaBhai Progress Snapshot
- **No % moves** (cap rule holds: Lightsail CD landed but the box runs dev secrets — see P0)
- **P0: staging/deploy** — Lightsail CD EXISTS (owner commits + #253 hardening) but is **blocked on STAGING-SECRETS-1 (owner-only)**: the next main push's deploy job goes RED at compose interpolation until real secrets are set; the currently-running container still holds **dev JWT/PII secrets (forgeable sessions — treat as compromised)** and its own throwaway Postgres (R27, TD72(c))

## Merged today
| PR | What |
| -- | ---- |
| #244 | **RATIFY-1 — ADR-0030 gate (d) CLOSED**: all 22 wedge aliases ratified (owner rulings: Q-A chhilai→`skill_deburring`, Q-B drawing padhna→`skill_cad_interpretation`); 22 rows seeded (NULL embeddings); sweep recall stays 0.350 until SR-1 real-embed + re-sweep |
| #245 | **Q14 DECIDED + LIVE**: worker-confirmed raw skill labels render on the résumé — additive `skill_labels` on DraftProfile (Zod↔Pydantic, no migration), **certify-at-rest** (pseudonymize-certified at population → snapshot/PDF/disclosure/fallback safe by construction), TAX-8 locks intact; review found + fixed dead-code wiring pre-merge; security verify 7/7 PASS |
| #247/#250 | **TD22-1**: PII token v2 `kid` + keyring + read-both + boot validation (zero rows touched; v2 only when operator opts in); #250 carried the 2 review LOWs (#247 merged early) — rollback diagnosability + duplicate-kid boot-fail |
| #248 | **TD25a**: reverse-proxy harness + TRUST_PROXY_HOP_COUNT regression suite (12 tests incl. main.ts source tether; hop table pinned empirically; forged-XFF loses at hop=1, wins at hop=2 — documented why the count must be exact) |
| #251 | **CI-5 + CI-4a**: turbo + pip caches; security-scan post-merge push dropped + weekly full-history cron (CI-4b deliberately NOT built — post-merge main CI is the #233-class net and the deploy keys off it) |
| #252 | **TD70 item 5**: `POST /resume/generate` worker-authed (session-derived id, XB-A), no-oracle 404s, confirmed-gate; worker-app bearer wired (was tokenless on this one call); risks R26 |
| #253 | **CD-3/0/4/5**: health-gated deploy (was unconditional-green) + staging compose overlay (NODE_ENV=production, 12 fail-loud `${VAR:?}` secrets, `--no-deps` kills the box-local PG) + immutable sha tags (real rollback) + buildx layer cache; CD-2 HELD (0031 sign-off + D1) |
| #254 | **WA-5**: interview-kit download 500→503 on storage/renderer outage (root cause: StorageService raw `Error`s escaped the mapping; ran even before the render-enabled check) |
| #326 | **WA-1..4**: applied-jobs destruction closed (feed excludes applied + in-session deck prune; root cause = `/feed` re-serves decided jobs × upsert last-write-wins), applied-CTA gate, kit routes moved to the Profile branch (back-nav fixed, no tab hack), honest strength meter (count, no fabricated %) |
| (concurrent) | #249 TD70 row · #255 **R28 Critical launch gate** (unauthenticated decrypted-name read on `GET /workers/:id/profile`) · #256 in-app PDF download (→TD71 lock drift) · #341 R29+TD71+TD72 · Lightsail CD commits |

## Owner queue (ordered)
1. **STAGING-SECRETS-1** (owner-only, non-delegable) — provision the staging GitHub Environment secrets (generated fresh, never `--env-file .env`); unblocks every deploy. Include `CORS_ALLOWED_ORIGINS` (TD72(a)).
2. **Box triage + remediation** — run the triage commands on the box; stop the dev-secret container + throwaway postgres/redis; treat sessions minted under `DEV_JWT_SECRET` as forgeable (R27).
3. **D1 ruling** — is the Lightsail box prod or staging? If prod: `environment:` + required reviewer on deploy. Also blocks CD-2 arming (with the 0031 human sign-off).
4. **R28** (from #255) — Critical launch gate on the unauthenticated decrypted-name read.
5. **WA-6..10 decisions** — (a) account-delete dialog copy: honest-immediate vs real 7-day soft delete; (b) notifications: in-app Alerts toggle now vs FCM as its own ADR; (c) WA-6 profile photo = ADR + §2 ruling; (d) WA-8 DPDP policy copy; (e) WA-9 device-list scope (read-only vs revoke).
6. **TD70(3) product call** — employer-suffix over-drop eats real trade vocabulary ("Sheet Metal Fabrication"); relaxing `_EMPLOYER_RE` touches the pseudonymize gateway.
7. Standing: SR-1 embed loop (recall 0.350 → re-sweep after real vectors) · TD67 token flip · TD76 (read one failing gitleaks/semgrep run — standing-red advisory is coverage theater) · payer login functionally dead on the box until `PAYER_LOGIN_METHOD` decision (TD72/#253 note).

---

# Daily Tracker — 2026-07-15

## BadaBhai Progress Snapshot
- **No % moves** (cap rule: no staging/handset evidence added today)
- **P0: 1** (staging past deadline) · Owner queue: ~~migration 0038 apply~~ **APPLIED today** · vernacular ratification (Q-A/Q-B) · SR-1 step-7 activation env · **Q14** (off-wedge résumé raw phrases — product)

## Merged today
| PR | What |
| -- | ---- |
| #225 | **TAX-5**: floor calibrated 0.82→0.75 on REAL vectors — precision 1.000; recall 0.800 ORACLE vs **0.350 shipped anchor-path** (both pinned by `pytest -k wedge`); 22 vernacular aliases PROPOSED (RVM gate) |
| #226 | **TAX-6**: job side shares the skill id space (`skill_phrases`/`skill_ids`, migration 0038 — **applied by owner same day**); review M1/M2/M3 fixed (parallel-bounded canonicalize, widened RANK lock, outage backfill retry) |
| #227 | **TAX-8**: off-wedge résumé guard locked (canonicalization can't raise into résumés); raw-phrase gap → Q14 |
| #229 | Register/tracker sync to #225–#227 |
| #230 | **TAX-7**: growth loop — `/growth/cluster` (pure compute, SG-5: NO id minted) + `db:growth:cluster` runner (sanitized human packet, `--apply`/`--reopen-clustered` status machine, PARTIAL-embed refusal, mock-persist guard). Adversarial review: 13 raised / 9 confirmed **fixed in-PR** (markdown-injection HIGH, one-way-door HIGH) / 4 refuted; TD67 logged (ai-service-wide auth posture) |
| #232 | **TAX-9 — SERIES COMPLETE**: `skill.replaced_by` crosswalk (migration **0039 — owner apply pending**), corpus-homed state machine (reactivation-safe seed), `/skills/retag-plan` + `db:retag:skills` (dry-run default; ids-only audit report). Review: 13 raised / 8 **fixed in-PR** (headline: the jsonb `?|` discovery query was UNEXECUTABLE under drizzle — caught before any run; DB-derived SG-5 gate; cycle-safe alias moves; seed deadlock live-repro'd) / 5 refuted |
| #235 | **TD67**: ONE service-level bearer for the ai-service (`AI_INTERNAL_TOKEN`, launch-gated — unset = today's posture; /health trimmed under lock). Review: 7 raised / 5 fixed in-PR (HIGH: empty-token VACUOUS ARM — compare_digest('','') passed tokenless requests while /health claimed auth on; killed via min_length=16 startup failure) / 2 refuted. TD67 → Mitigated, flip = env action |
| #238 | **TD68 + COST-4**: real-embed spend joins the SpendLedger on all 3 live surfaces (reserve→reconcile-in-finally; per-user attribution; halving partial-reserve so corpus embeds never starve); COST-4 clarify now re-serves the CONFUSING question with answer-trumps-clarify + bounded clarify_count (review HIGH: the first cut ate short answers like "2 saal?" in an unbounded loop — caught + fixed pre-merge) |
| #239 | **PIN residuals + F4 + A5 re-mint**: 2 stranded fixes recovered from a never-PR'd branch (ladder honors K=5; monotonic GREATEST() kills the multi-device un-latch race); NEW worker.otp_send_failed v1 + runbook §7 (F4 closed — every Fast2SMS failure now on the spine via issueAndSendWithSignals, incl. the delete step-up); WorkerAuthGuard half-life re-mint consent-gated with fail-safe degradation (PG blip can't 500 logout); TD69 logged (revoke⇒revokeAll coupling for future withdrawal) |
| #240 | **TD62 (HIGH) + payer honesty**: consent_accepted (optional) on both verify responses + worker-app tri-state router gate — authenticated-but-unconsented workers now forced to /consent (old servers pass through; compose-blip omits the field, never 500s a paid login); payer credits error-channel (never masks outage as 0); disclose 429-cap gets non-retry "limit reached" copy vs outage retry |

## Notes
- **TD62 RESOLVED (P1 → closed)** on `fix/td62-consent-routing-and-payer-fastfollows` (production-residuals PR C, pushed — PR pending): additive `consent_accepted` on `/auth/otp/verify` + `/auth/pin/verify`, tri-state client parse, router consent gate, ConsentCubit release; plus the #189 payer-app fast-follows (fetchCredits 0-mask MEDIUM, disclose outage-vs-deny LOW).
- Root-caused yesterday's "CI dispatch stall": #226 went CONFLICTING after #225 merged — GitHub silently skips PR workflows when the merge ref can't build. Not a billing/incident issue.
- ADR-0030 series: **COMPLETE — TAX-0..9 all merged** (#211–#232). Owner queue gains: apply migration 0039.
- New ops capability (dormant until queue volume): `pnpm db:growth:cluster` — proposals land in `docs/registers/skill-growth-proposals.md`, activation stays human-only via the ratification flow.

---

# Daily Tracker — 2026-07-14

## BadaBhai Progress Snapshot
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%** — **NO % moves** (code breadth grew again, but the evidence posture is unchanged: no staging, no handset proof; the cap rule holds)
- **P0: 1** (staging PAST DEADLINE — 10 days) · **P1: 2** (TD62 consent-routing before handset GA; unlock/reveal LC-1 residual)
- **Decisions:** D9 (ADR-0030 accepted) + D10 (fork-B runner) DECIDED 2026-07-14 — see [DECISION_LOG](DECISION_LOG.md)

## Merged since 2026-07-10 (code catch-up — verification posture unchanged)
| PRs | What landed |
| --- | ----------- |
| #193–#196 | ai-contracts parity tests; payer-web all-seams-live (LC-1 closed on main); interview-kit read routes; worker self profile-summary |
| #197–#199 | auth throttle residuals (TD25 trust-proxy, TD60 per-phone OTP daily cap); voice pipeline end-to-end (ADR-0029, mock STT, DORMANT until bucket); register sync |
| #201–#202 | worker-app kPersistentAuth ON (W1) + payer P1/P2/P3/P5 REAL mode; TD61/TD62 logged |
| #203–#210 | AI cost/persona series: PERSONA-1/2 (bada-bhai voice + {{worker_name}} seam), COST-2 (prompt caching), COST-3 (stateless turns), COST-4 (templated questions, LLM-skip straight path) |
| #211–#215 | **ADR-0030 skills taxonomy TAX-0..4**: ADR accepted; skill/skill_alias/unresolved_phrase (migration 0037, applied); curated ESCO/O\*NET/NCO corpus + `db:seed:skills`; mock-default embeddings (pseudonymize-first); `canonicalize_skill` floor-gated (flag OFF, TD65) |
| #216–#218 | worker-app liberal jobs feed (concurrent session); TAX-5..9 roadmap pinned; **CI-1** Node-24 action bumps + Dependabot (0 deprecation annotations verified) |
| #219 (open) | fork-B embed runner + `POST /embeddings/skill-alias` — in adversarial review |

## Blockers
- **P0 staging unchanged** — nothing above adds runtime proof; the alpha gap remains verification + staging, not code.
- New launch gates logged: **TD64** (embed spend outside SpendLedger — precondition for the §7 staging embed run) · **TD65** (SKILL_CANONICALIZE_ENABLED stays OFF until staging verify + TAX-5 calibration).

---

# Daily Tracker — 2026-07-10

## BadaBhai Progress Snapshot
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%**
- Payer Web 78% · Worker App 69% · Backend/API 84% · OTP/Auth/Security 80% · Agency 70% · AI-Service 80% · Infra/Staging 45% · Docs/Process 85%
- **P0: 1** (staging PAST DEADLINE) · **P1: 2** (FE wiring, LC-1 unlock/reveal) · **Decisions Needed: 0**

## Progress Movement
| Area | Yesterday | Today | Change | Reason |
| ---- | --------: | ----: | -----: | ------ |
| Worker App | 67% | 69% | **+2%** | PR #189 merged: A1 applied-jobs + A3 referral + A4 delete wired real; emulator run audited ([QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md)) |
| Overall Project | 75% | 75% | 0 | +0.4 weighted from Worker App — rounds to 75% |
| Alpha Readiness | 58% | 58% | 0 | Evidence refreshed (60 shots) but emulator+local, not handset+staging — B1 families unchanged |
| Infra/Staging | 45% | 45% | 0 | **Staging STILL not deployed — 6 days past deadline** |

## Developer Progress
| Developer | Assigned | Status | Blocker |
| --------- | -------- | ------ | ------- |
| Prakash | Staging provisioning (P0 — past deadline) | OVERDUE | AWS instance not provisioned |
| Divyanshu | FE wiring batch FE-1..FE-7 | READY | Local DB stale (fresh migrate first) |
| Rishi | B1 handset run when staging lands; payer-app real-seam verification | WAITING | Needs `STAGING_API_BASE_URL` |

## What moved today
- **PR #189 merged** — worker-app backend wiring (A1 applied-jobs, A3 referral, A4 DPDP delete, resume reuse, error-UX sweep) + **NEW role-aware Flutter payer-app** (Company + Agency, 14 screens, mock/real seam). Client-only; 1 HIGH (empty referral link) fixed pre-merge.
- **PR #190 merged** — `docs/qa/evidence/b1` refreshed: 60 PNGs from the 2026-07-09 emulator session replace the 9 JPEGs.
- **All 60 screenshots audited** (10-reader visual audit) → indexed in [QA_EVIDENCE.md](QA_EVIDENCE.md) + flow map in [`docs/qa/evidence/README.md`](../qa/evidence/README.md). Worker-app local wiring proven; payer-app confirmed mock-mode UI evidence.
- **Stranded tracker re-score recovered** — the 2026-07-09 re-score commit (`ba625ab`, 72→75%) was committed on the old ai-service fix branch and never reached main; cherry-picked onto this docs branch.
- **Zod↔Pydantic parity fix** (invariant #7) on branch `fix/ai-contracts-zod-pydantic-parity`: `AICallMetadata` diagnostics trio + `WorkerProfileDraft.canonical_role_id` mirrored into `packages/ai-contracts`; gates green. Awaiting merge decision.

## What did NOT move
- **Staging (P0)** — still not provisioned; every B1 family (staging /health, events chain, clean logcat, PDF-open) still missing.
- **B1 verdict** — PARTIAL/NO-GO unchanged: emulator ≠ handset, local ≠ staging.
- Payer-app real-seam verification — screenshots are mock-mode; live payer API round-trip unproven.

## Evidence-hygiene follow-ups (from the audit)
- Tester's real phone visible in 4 committed shots → redact/re-shoot next capture.
- Payer unlocked-candidate screen shows a raw phone (dummy) → align with ADR-0010 in-app relay before real data.
- "Razorpay" checkout copy while payments are mock → soften copy.
- Payer-app mock credits toast/balance bug (199→2199 vs "+1,000").

## Tests run today
- ai-contracts: build ✅ · 10 tests ✅ · eslint ✅ · api typecheck ✅ · 30 consuming api tests ✅ (parity branch). No staging tests possible.

## Decisions needed
- None new. Staging execution (P0) remains the only gate.

## Tomorrow's target
- **Prakash:** staging `/health` 200 → evidence row. Only gate to B1.
- **Rishi:** re-shoot evidence with masked test number once staging lands (real handset).
- **Divyanshu:** FE wiring FE-1..FE-5 against local API.

---

# Daily Tracker — 2026-07-09

## BadaBhai Progress Snapshot
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%**
- Payer Web 78% · Worker App 67% · Backend/API 84% · OTP/Auth/Security 80% · Agency 70% · AI-Service 80% · Infra/Staging 45% · Docs/Process 85%
- **P0: 1** (staging PAST DEADLINE) · **P1: 2** (FE wiring, LC-1 unlock/reveal) · **Decisions Needed: 0**

## Progress Movement
| Area | Last Snapshot (Jun 30) | Today | Change | Reason |
| ---- | ---------------------: | ----: | -----: | ------ |
| Overall Project | 72% | 75% | **+3%** | 16 PRs merged Jun 30–Jul 8 |
| Backend/API | 80% | 84% | **+4%** | A-batch (#173–#176) + B-batch (#177–#180) + B5 org API (#182–#184) + ai-service (#187) |
| Payer Web | 74% | 78% | **+4%** | B5 Team wired (#186); plan/boost (#179); pause/resume (#178); quota (#180); ledger (#177) |
| OTP/Auth/Security | 78% | 80% | **+2%** | PIN throttle hardened (#175); consent-on-resume (#176) |
| Agency | 68% | 70% | **+2%** | B5 org structure + payer invites (#185) |
| AI Service | 75% | 80% | **+5%** | Retry storm fixed (#187); Hinglish city aliases; rich→legacy mapper; ADR-0028 |
| Docs/Process | 80% | 85% | **+5%** | ADR-0027 (#181) + ADR-0028 (#188); tracker files added |
| Worker App | 67% | 67% | 0 | No new code; 9 MOCK screenshots; B1 staging-blocked |
| Infra/Staging | 45% | 45% | 0 | **Staging STILL not deployed — PAST deadline 2026-07-04** |
| Alpha Readiness | 57% | 58% | **+1%** | MOCK screenshots added; but 0 staging/handset proof |

## Developer Progress
| Developer | Assigned | Status | Blocker |
| --------- | -------- | ------ | ------- |
| Prakash | Staging provisioning (P0 — past deadline) | OVERDUE | AWS instance not provisioned |
| Divyanshu | FE wiring batch FE-1..FE-7 (executable now, no staging needed) | READY | Local DB stale (fresh migrate first) |
| Rishi | Flutter analyze/test; B1 handset when staging lands | WAITING | Needs `STAGING_API_BASE_URL` |

## What moved (tracker sync — based on git log review, commits Jun 30–Jul 8)
- **16 PRs merged** (#173–#188 + signup fix): A-batch, B-batch, B5 org-tenancy, AI-service storm fix, ADR-0028.
- **LC-1 CLOSED for money routes** — plan/boost now payer-authed (#179). Unlock/reveal LC-1 still open.
- **RT-1 CLOSED** — posting-plans IDOR resolved (#174 + #179).
- **B5 org-tenancy fully shipped** — payer_orgs, payer_members, PayerOrgRoleGuard, invite accept, Team page wired (#182–#186, ADR-0027).
- **AI-service retry storm fixed** — transport failure reason surfaced, Hinglish city aliases, rich→legacy canonical mapper (#187, security PASS, ruff✅ pytest✅).
- **ADR-0028 accepted** — international occupation taxonomy, TD56/TD57 registered (#188).
- All tracker files (BLOCKERS, PROJECT_STATUS, ROADMAP, RISK_REGISTER, OWNER_TASKS, DAILY_TRACKER) updated to current state.

## What did NOT move
- **Staging (P0)** — STILL not provisioned. Deadline was Jul 4 — now 5 days overdue.
- **FE wiring (FE-1..FE-7)** — all endpoints live, payer-web still calls mock shims.
- **B1 evidence** — 9 MOCK screenshots only; no staging health, no logcat, no PDF, no staging events.

## Tests run today
- Tracker sync only. Last known: `pnpm test` ✅ (1289/1289 api) · `ruff` ✅ · `pytest` ✅ (per PR #187).

## Decisions needed
- None. D1–D8 all closed.

## Tomorrow's target
- **Prakash:** Staging `/health` 200 → evidence in `docs/qa/evidence/staging/`. This is the only gate.
- **Divyanshu:** FE wiring FE-1..FE-5 (masked-résumé, pause/resume, quota, credit history, plan/boost UI) against local API.
- **Rishi:** When staging URL arrives → B1 real handset → 4 evidence artifacts in `docs/qa/evidence/b1/`.

---

# Daily Tracker — 2026-06-30

## BadaBhai Progress Snapshot
- **Overall Project: 72%** · **Alpha Readiness: 57%** · **Release Readiness: 28%**
- Payer Web 74% · Worker App 67% · Backend/API 80% · OTP/Auth/Security 78% · Agency Demand 68% · Infra/Staging 45%
- **P0: 1** · **P1: 1** · **Decisions Needed: 0**

## Progress Movement
| Area | Yesterday | Today | Change | Reason |
| ---- | --------: | ----: | -----: | ------ |
| Overall Project | 72% | 72% | 0 | Evidence verified, but no staging event/logcat proof yet |
| Alpha Readiness | 57% | 57% | 0 | `docs/qa/evidence/b1` screenshots are present; B1 still needs staging events + clean logcat + PDF-open proof |
| Docs/Process | 80% | 82% | +2 | Evidence folder is now canonical and documented; 200% owner board added |

## Developer Progress
| Developer | Assigned Today | Status | Blocker |
| --------- | -------------- | ------ | ------- |
| Prakash | Provision staging, wire secrets, `/health`, OTP-7 prep, WeasyPrint/PDF enablement | ACTIVE | AWS host + staging secrets |
| Divyanshu | Guard posting-plans `/plan` + `/boost`, add tests, record evidence | ACTIVE | None |
| Rishi | Run Flutter analyze/test, prepare real-mode handset build, attempt B1 if staging lands | ACTIVE | Needs `STAGING_API_BASE_URL` |

## What moved today
- Verified `docs/qa/evidence/b1` contains 9 screenshots.
- Added `docs/qa/evidence/README.md` as the canonical artifact index.
- Updated [QA_EVIDENCE.md](QA_EVIDENCE.md), [TEST_MATRIX.md](TEST_MATRIX.md), [PROJECT_STATUS.md](PROJECT_STATUS.md), [ROADMAP.md](ROADMAP.md), and [OWNER_TASKS.md](OWNER_TASKS.md) to use the evidence folder.
- Issued the **200% Mode — 2026-06-30** task board in [OWNER_TASKS.md](OWNER_TASKS.md).

## What did NOT move
- B1 is **not GO**: screenshots exist, but staging events, clean logcat, and PDF-open proof are still missing.
- No progress percentage moved from screenshots alone.

## Tests run today
- Not run; docs/evidence verification only.

## Decisions needed
- None. D1-D8 are already closed.

## Today’s target
- Prakash: staging `/health` 200 evidence in `docs/qa/evidence/staging/`.
- Divyanshu: posting-plans guard evidence in `docs/qa/evidence/backend/`.
- Rishi: Flutter analyze/test plus real-mode B1 evidence under `docs/qa/evidence/b1/` if staging lands.

---

# Daily Tracker — 2026-06-29

## BadaBhai Progress Snapshot
- **Overall Project: 69%** · **Alpha Readiness: 55%**
- Payer Web 74% · Worker App 62% · Backend/API 77% · OTP/Auth/Security 70% · Agency Demand 68% · Infra/Staging 45%
- **P0: 1** · **P1: 2** · **Decisions Needed: 6**

## Progress Movement
| Area | Yesterday | Today | Change | Reason |
| ---- | --------: | ----: | -----: | ------ |
| Overall Project | — | 69% | baseline | First evidence-based audit (Phases 1–4 run) |
| Alpha Readiness | — | 55% | baseline | Strong unit coverage; **zero staging/handset proof**; B1 NO-GO |
| Payer Web | — | 74% | baseline | 517 tests green; flows live; Team/Account stubs |
| Worker App | — | 62% | baseline | Core path real+tested; B1 handset run not done |
| Backend/API | — | 77% | baseline | 1141 tests green; ADMIN-3b committed clean; posting-plans IDOR |
| Infra/Staging | — | 45% | baseline | Staging CD inert/unwired |

## Developer Progress
| Developer | Assigned Main Tasks | Yesterday | Today | Change | Blocker |
| --------- | ------------------- | --------: | ----: | -----: | ------- |
| Prakash | Payer Web / Agency Demand / staging decisions | — | 74% / 68% | baseline | D1 staging, D2 OTP-7 |
| Divyanshu | Backend / OTP / posting-plans guard | — | 77% | baseline | posting-plans IDOR (P1) |
| Utkarsh | Payer Web UI / Resume web | — | 74% | baseline | Team/Account stubs |
| Flutter dev | Worker App alpha | — | 62% | baseline | B1 handset (needs staging) |
| QA / reviewer | e2e + click-throughs | — | n/a | baseline | e2e needs local PG+Redis |
| Founder/CEO | D1/D2/D5 decisions | — | n/a | baseline | spend + alpha date |

## What moved today
- Tracker stood up; full read-only audit completed (Phases 1–4).
- ADMIN-3b committed + merged by a concurrent session (`0635aee` → `14378c0` #164); re-verified branch green (lint+typecheck+test+build).
- **Payer/Agency go-live + Android API delivered:** verified API-surface workflow (17 agents) → [PAYER_WEB_GO_LIVE_PLAN.md](PAYER_WEB_GO_LIVE_PLAN.md) + [Android API reference](../api/payer-agency-api-reference.md). Headline: payer mobile auth works today via Bearer.
- **Worker-auth ADR-0026 workstream registered** ([WORKER_AUTH_ADR0026.md](WORKER_AUTH_ADR0026.md)) — Divyanshu, Phase 2+3 in progress; **conflict surfaced ([D7](DECISION_LOG.md)): Argon2id+KMS vs the accepted scrypt+env**.

## What did NOT move (and why)
- Nothing on real infra — **no staging exists yet** (D1 open).
- posting-plans IDOR still open (P1).

## ⚠️ Incident note
- A **concurrent session in the same working tree** committed ADMIN-3b mid-audit and **deleted 7 untracked tracker files** (re-created). Mitigation: one session per tree; commit the tracker for durability. Logged in [QA_EVIDENCE.md](QA_EVIDENCE.md) + [BLOCKERS.md](BLOCKERS.md).

## Tests run today
- `pnpm test` ✅ (api 1141, payer-web 517) · `pnpm build` ✅ · `pnpm lint` ✅ (0 err, 1 warn) · `pnpm typecheck` ✅ (23/23) · `pytest` ✅ · e2e ⏭️ skipped (no infra) · flutter ⚠️ not installed. Full detail: [QA_EVIDENCE.md](QA_EVIDENCE.md).

## Decisions needed
D1 staging deploy · D2 OTP-7 activation · D3 money-route auth · D4 ADMIN-3b process conditions · D5 resume render · D6 RLS deferral. See [DECISION_LOG.md](DECISION_LOG.md).

## What will move tomorrow (targets)
- Backend → 79%: add a guard to `posting-plans` (closes the open IDOR). Evidence: guard test + api suite green.
- Infra → 55%: stand up local PG+Redis, run e2e (143) green locally.
- Worker app pre-stage: `flutter analyze && test` locally + emulator mock run (pre-B1).

---

## Template (copy for the next day)
```
# Daily Tracker — YYYY-MM-DD
## BadaBhai Progress Snapshot
- Overall: XX% · Alpha: XX% · [per-phase…] · P0:n · P1:n · Decisions:n
## Progress Movement
| Area | Yesterday | Today | Change | Reason |
## Developer Progress
| Developer | Assigned | Yesterday | Today | Change | Blocker |
## What moved / didn't move / why
## Tests run (link QA_EVIDENCE rows)
## Decisions needed
## Tomorrow's target %
```
