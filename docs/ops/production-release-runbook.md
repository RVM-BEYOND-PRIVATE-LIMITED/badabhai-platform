# Production Release Runbook

> **There is no staging for this release** (owner ruling, 2026-07-31). Everything ships to
> production behind expand-only migrations and reversible flags, verified by a canary account.
> That is workable only if the discipline below is followed exactly: **one flip at a time, a
> named abort lever for each, and a canary smoke between every one.**
>
> Companion: [matching-v1-migration-runbook.md](matching-v1-migration-runbook.md) (the SQL train
> and its verify queries) · [rollback-guide.md](../rollback-guide.md) ·
> [observability-runbook.md](../observability-runbook.md).

---

## P0 — Owner actions. Code cannot do these, and some of them are legal gates.

Nothing in P4 may proceed past the item that depends on it.

| # | Action | Gates | Status |
| - | ------ | ----- | ------ |
| 1 | **Sarvam DPA + written terms signed** | The `stt_transcription` flip. Audio cannot be pseudonymized before the provider hears it — this is the compliance condition for real worker voice leaving the platform. **Hard legal gate.** | ☐ |
| 2 | **Google (Gemini) + Anthropic DPAs in place** | `AI_ENABLE_REAL_CALLS`. Pseudonymized text is still worker data. **Hard legal gate.** | **WAIVED, NOT MET (owner, Prakash, 2026-08-01)** — the flag was set true without the DPAs signed. This box stays UNCHECKED on purpose: the owner accepted the exposure, which is a decision, not a satisfied gate. Still to sign. |
| 3 | **Grievance Officer NAMED and published** | Public launch. Legally required under DPDP. **Hard legal gate.** | ☐ |
| 4 | **R32 decision recorded** — accept-at-launch in the risks register, or harden first | `AI_ENABLE_REAL_CALLS`. R32 (an un-cued name reaching LLM input) is NARROWED, not closed; the gazetteer approach was measured dead and reverted. Someone must own the residual in writing. | ☑ **DONE 2026-08-01** — owner ruling: **accept at launch**, recorded against R32 (and R30) in the risks register. The decision is owned; the leak is not fixed. |
| 5 | **Razorpay**: account, KYC, live key id + key secret, webhook secret, webhook URL registered | `PAYMENTS_ENABLE_REAL`. | ☐ |
| 6 | **`app.badabhai.in` DNS + TLS serving payer-web**, and the **Play App Signing SHA-256** exported from Play Console into `assetlinks.json` | App Links verification, therefore the whole attribution chain. Until this is real, shared links open a browser and fresh installs lose the referral code. | ☐ |
| 7 | **Play Console**: store listing, App Links domain verification, staged-rollout track ready | P5 client release. | ☐ |
| 8 | **Confirm `AGENCY_PAYOUTS_ENABLED` stays OFF** | ADR-0022 gate. Explicitly out of scope for this release; the agency ledger stays mock. | ☐ |
| 9 | **Production database backup/snapshot taken and its restore verified** | P1. A rehearsed restore, not an assumed one. | ☐ |
| 10 | **`INTERNAL_SERVICE_TOKEN` set — to the SAME value — on both the API and the ops console (`apps/web`)** | **The entire ops API.** See the note below; this one is new and it is load-bearing. | ☐ |
| 11 | **Ops API not publicly routable** (private network / VPN / IP allowlist in front of `apps/api`'s ops routes) | Defence in depth for the same surface. Owner ruling 2026-07-31: guard in code **and** infra, so a single misconfiguration on either side is not fatal. | ☐ |
| 12 | **Physically print and scan the agency invite QR sheet** (B5, batch invite minting) | The overflow + blank-print-sheet fixes are reasoned from box-model/`:has()` CSS logic, not observed — nobody running this build can open a browser or print a page. Confirm on a real phone camera against a real printed sheet before treating the QR flow as launch-ready. | ☐ |
| 13 | **`AI_RAW_PII_ENABLED` is armed by the merge ([ADR-0047](../decisions/0047-lift-pii-restriction.md) §5)** — the owner decided on 2026-09-30 and instructed a direct merge of the implementing change. The `production` secret already reads `true` (created 2026-09-30, value unreadable) and the deploy job exports it on every run, so the deploy that follows the merge arms production. A `security-engineer` review of that change ran before the merge (ADR-0047 §8). The output-side gaps (§6) are decided and ship in that change: **G1** a hard-identifier output floor that reads no flag (the four gap tests in `apps/ai-service/tests/test_llm_input_policy.py` §6 pass, as do the three outputs found by probing armed — the rich draft, companion edit rows, the résumé summary), **G2** `redactKnownName` with the flag on in profile extraction, the classic interview turn and the skills stage. **Just before the merge:** re-set the secret to the literal, `gh secret set AI_RAW_PII_ENABLED --env production --body true` — its value cannot be read back, and the deploy's preflight fails the job (every running container untouched) on anything but `true`, `false`, `1`, `0` or empty. **After the merge:** run ADR-0047 §5's _Verify_ (the deploy job green, the ai-service boot log's `AI_RAW_PII_ENABLED is ON` warning, one interview turn's trace); record both signatures on ADR-0047's foot (they ratify the decision and gate nothing). **Recommended owner follow-ups, not gates** (the decision accepts these as they stand): sign the Google (Gemini) and Anthropic DPAs or re-waive in writing for raw identity data (the #2 waiver was argued on pseudonymized text); record Langfuse as a processor (US-hosted by default, not reached by account deletion) with its retention terms; confirm Sarvam's terms cover the translate leg's raw transcript; the DPDP notice copy (R4). | Nothing further: the merge arms it. Armed, prompts and traces carry raw PII to every provider on the path; nothing already sent can be recalled. Abort lever: the secret set to `false` plus a redeploy (ADR-0047 §5). | ☐ |

### Status as of 2026-08-01

**Merged to `main` (`f28279f`):** the whole Matching V1 + B5 release — ranked feed on
`job_postings`, agency engagement view, batch invite minting (mutation-verified, 14 security
conditions closed, ADR-0022 Amendment 3), the R28 closure (`InternalServiceGuard` on the three
`Workers` ops routes, pinned in `guard-contract.test.ts`), and the prod-canary rewritten to
probe **all 43** `InternalServiceGuard` routes instead of 6, with a drift test failing CI in
both directions. Those are two different 43s — the canary's coverage, not a guard newly applied
to 43 routes; most already had one, which is precisely why nothing failed loudly. Branch protection is now live on `main` (`ci-required` + 1 review required).
`feat/matching-v1` deleted post-merge (true merge commit, nothing lost).

**Item 4 (R32) is NOT done — corrected 2026-08-01 before merge.** An earlier draft of this
section claimed it was, on the strength of #528 (`5028692`). It is not. #528 recorded R32 in
`team-decisions.md` under *"open at the time of ruling, to be answered at the relevant gate"* —
i.e. it recorded that the question is **unanswered**, which is the opposite of a decision. And
`risks-register.md` on `main` still reads **`R32 … OPEN — 2026-07-18`, Critical, "Must fix
before flag flip."** — the same register the draft cited as evidence it was closed.

Item 4 requires an owner **decision** in writing: accept-at-launch in the risks register, or
harden first. Nobody owns the residual yet, so the box stays **☐**. This matters more than a
status nit: item 4 gates `AI_ENABLE_REAL_CALLS`, and a runbook asserting a Critical
privacy gate is DONE is exactly how a real-provider flip gets made on a residual nobody
accepted. **No P0 item has moved.**

**Still open, blocking P1 onward:** items 1/2/3/5/6/7 (legal DPAs, Razorpay, DNS/Play Console —
all owner-only, untouched), **item 4 (R32 decision — see the correction above)**, item 9
(backup/restore rehearsal — no evidence found it has run,
and P1 cannot start without it), item 10 (`INTERNAL_SERVICE_TOKEN` — status still unconfirmed),
item 11 (ops API network restriction — infra, not done), item 12 (QR print/scan — added this
session, unchecked).

PR #525 (an earlier attempt at recording the R28 fix + owner rulings) was **closed**, superseded
by #528 (merged) — #525's code changes were redundant with what `main` already shipped, but its
docs content (the 8 owner rulings, and the fact that `risks-register.md`/`BLOCKERS.md`/
`.claude/project-memory.md` still read R28 as OPEN despite the fix being live) was real and
landed in #528.

**Staging contradiction — resolved, fix merged in #527** (`b467464`): `RELEASE_READINESS.md`'s
"NOT READY (not deployed)" was stale. Staging was deployed manually (owner-confirmed
2026-08-01), just never through `staging-cd.yml`, which has zero recorded runs — that pipeline
gap (automation exists, never exercised) is tracked as TD123, separately from the contradiction
itself.

**P1 (migration train) has not started.** The Matching V1 train (`0052`–`0059`) is authored,
not applied. Rehearsal against a restored snapshot is mandatory per this file's own P1 section,
and item 9 (backup/restore verified) is unconfirmed — so P1 cannot honestly start until item 9
is closed, even though nothing code-side blocks it.

### AI real calls went LIVE 2026-08-01 — what is actually armed

`AI_ENABLE_REAL_CALLS=true` was set by the owner on 2026-08-01, with R32 and R30 accepted at
launch (P0-4 done by the accept branch) and the DPA gate (P0-2) consciously waived. Two
consequences of *how* the flag works that are separate from that risk acceptance, and were not
part of it:

**1. An empty `AI_REAL_CALL_TASKS` — hardened to FAIL-CLOSED in code on 2026-08-01
(owner ruling), but the DEPLOYED build still runs the old semantics until the next
ai-service deploy.**

The shipped behavior at the time of the flip: empty = **no per-task restriction (ALL
tasks)**. Measured at runtime on 2026-08-01 with `ai_enable_real_calls=True`, a Gemini key
set and `ai_real_call_tasks=''` — `Settings.real_call_enabled_for(task)`:

| task | empty allowlist (OLD, deployed) | `AI_REAL_CALL_TASKS=profile_extraction` |
| --- | --- | --- |
| `profile_extraction` | **True** | True |
| `resume_generation` | **True** | False |
| `skill_embedding` | **True** | False |
| `stt_transcription` | **True** | False |
| `profiling_chat_turn` | **True** | False |

The staged sequence this runbook and the release plan both specify — `profile_extraction` first,
then widen one task at a time with a canary between each — is skipped entirely unless
`AI_REAL_CALL_TASKS` is set. To restore it: `AI_REAL_CALL_TASKS=profile_extraction`.

**Note `stt_transcription` in that first column.** Real speech-to-text is gated by **P0-1 (Sarvam
DPA + written terms — a hard legal gate)**, and on the deployed build that gate is currently open
at the config layer: the only thing preventing real worker audio leaving the platform is that no
Sarvam credential is set, not the allowlist. Setting a Sarvam key while the allowlist is empty
would flip STT live with no further decision. `profiling_chat_turn` is likewise permitted even
though the design intent is that it stays templated.

**The hardening (owner-ruled 2026-08-01, same day):** `real_call_enabled_for` now requires the
task to be **explicitly listed** — an empty allowlist blocks every task, with no wildcard
(`apps/ai-service/app/config.py`, pinned by `test_empty_allowlist_blocks_all_tasks_fail_closed`
and `test_an_empty_allowlist_blocks_stt_fail_closed`). The security review of that change found
**transcript translation** (the second Sarvam leg of `/voice/transcribe`) still reading the raw
flag + Sarvam key — bypassing both the allowlist **and** the kill switch, exactly the pre-fix STT
pattern. Closed in the same PR: translation now rides the `stt_transcription` allowlist key
(pinned by `test_empty_allowlist_blocks_translate_fail_closed` and
`test_kill_switch_blocks_translate`), so P4 #9 arms/disarms the whole voice→English leg as one
flip. Two operational consequences:

- **Until the ai-service deploy carrying it,** everything above remains live behavior — set
  `AI_REAL_CALL_TASKS=profile_extraction` in the prod env NOW rather than waiting for the deploy.
- **The deploy carrying it is itself a flip:** if it lands while `AI_REAL_CALL_TASKS` is still
  empty, real calls stop (everything returns to mock) until the env var is set. That is the
  intended fail-closed direction — set the env var first and the deploy is a no-op. This also
  makes the rollback lever long documented in `enable-real-llm-extraction.md` ("clear
  `AI_REAL_CALL_TASKS` → back to mock") true for the first time; under the old semantics,
  clearing it *armed* every task.

**2. Spend caps are PER-PROCESS unless `AI_SPEND_REDIS_URL` is set.**

`CostTracker` falls back to `InProcessSpendBackend` when that env var is absent, so the daily and
cumulative rupee caps apply per replica: N replicas means N x the intended ceiling. With Redis
configured the ledger is shared and, if Redis is unreachable, `would_exceed_spend` returns
`spend_store_unavailable` and fails CLOSED. Set `AI_SPEND_REDIS_URL` to make the caps mean what
they say.

**Abort lever, for both.** `AI_REAL_CALLS_KILL_SWITCH=true` is evaluated FIRST in
`real_calls_blocked_reason()` — before `AI_ENABLE_REAL_CALLS` (TD27) — so it hard-disables real
calls without touching the enable flag. That is the lever to pull if a name or phone leak is
observed in the wild, since R30 and R32 are both live-and-accepted rather than fixed.

### P0-10 — why this is suddenly load-bearing

Until 2026-07-31 the ops-internal API had **no guard at all**, and the ops console sent **no
credential**. Those two facts cancelled out, so nothing failed and nothing looked wrong — while on
a public internet an anonymous caller could `POST /job-postings` → `PATCH /:id {status:"open"}` →
`POST /:id/verify` and put a **verified** job into real workers' feeds, read the whole audit spine
via `GET /events`, and enumerate workers and ranked candidates.

Fifteen routes are now behind `InternalServiceGuard`, and the console authenticates on every call.
That guard **fails closed**: with the secret unset it denies every request. So:

- **If the token is missing on the API**, the ops console is completely dead (every page errors).
- **If the two values differ**, same outcome.

That is the intended failure mode — a missing secret breaks the console loudly instead of silently
re-opening the API — but it means the console is now a *hard* dependency on this env var, and a
deploy that forgets it looks like a total ops outage. Set it before P2, not during it.

`POST /consent/accept` is now worker-authed too, and takes the worker from the session rather than
the request body. Old worker-app builds still send `worker_id`; the field is **stripped**, not
rejected, so old and new clients both work and P5 can roll out at its own pace.

---

## P1 — Migrations. Applied manually by Divyanshu.

Locked convention: migrations are always manual; coding agents never run them. The full ordered
train, with a verify query and a rollback note per step, is in
[matching-v1-migration-runbook.md](matching-v1-migration-runbook.md).

Every migration in this release is **expand-only** — new tables, new nullable columns, new
indexes. Nothing is dropped or renamed, so the code can be rolled back independently of the
schema at any point. The contract phase (dropping the legacy path) is deliberately deferred.

**Rehearsal first, not optional:** restore the P0-9 snapshot into a local Postgres, run the whole
train plus the backfills against it, and record the real row counts and durations in the
migration runbook. Worker PII is application-layer ciphertext, so a local restore does not expose
plaintext — but treat the restore as production data regardless and destroy it afterwards.

**STOP if:** any verify query returns an unexpected count, any step takes materially longer than
the rehearsal predicted, or the backfill's ops worklist is non-empty in a way nobody has triaged.

---

## P2 — Deploy the code, dormant.

API, ai-service, payer-web deploy with **every new flag off**. `MATCH_V1_ENABLED=false`,
`AI_ENABLE_REAL_CALLS=false`, `PAYMENTS_ENABLE_REAL=false`, `SKILL_CANONICALIZE_ENABLED=false`.

Run the canary smoke against the **mock** paths. The point of this phase is to prove the new code
changed nothing while it is switched off. If anything moves here, the problem is not a flag.

---

## P3 — Backfills and seeders.

Data scripts D1–D6, then `verify-match-v1`. All are idempotent and re-runnable; each prints
counts. The one that matters most for cutover continuity is the seeded-jobs conversion — without
it, the worker feed is empty the moment `MATCH_V1_ENABLED` goes true.

### P3-0 — The occupation catalogue and the question packs. Run these on EVERY release.

**This section was missing until #1680, and the omission cost three weeks of silent breakage.**
The alias overlay's last two commits landed 2026-09-02 (#1395 CAD draughtsman + CAM programmer,
#1390 CNC grinding) and the rows never reached the database, because nothing in this runbook or
any workflow told anyone to put them there. Measured on 2026-09-23: 35 curated aliases absent,
`"cad draughtsman"` folding at L1 to a **golf caddie**, and a real draughtsman asked his trade
twice with mixed-script chips (#1675, #1679).

Unlike D1–D6 these are not a one-time cutover step. **Any release that changed
`packages/db/data/` needs them, and running them when nothing changed is a no-op** — every row
carries a deterministic, content-derived id, so a re-run inserts nothing.

**Build first on a fresh checkout.** All four commands reach `job-domain-corpus.ts`, which
imports `@badabhai/profiling-lexicon` through its `dist/`. An unbuilt tree fails with
`Cannot find module '@badabhai/profiling-lexicon/dist/index.js'` before it opens a connection —
which reads like a database problem and is not one.

```bash
pnpm install --frozen-lockfile
pnpm --filter "@badabhai/db..." build
```

```bash
# 1. Catalogue rows + aliases. Writes nothing that already exists.
OPS_ALLOW_PRODUCTION=seed:domains \
  pnpm --filter @badabhai/db db:seed:domains --apply --i-am-authorised-to-write-to-production

# 2. REQUIRED, and separately, between the seed and any retrieval. Without it the new aliases
#    have no `text_norm`, which verify-job-domains.ts calls "invisible to L0/L2 retrieval" —
#    the ladder silently degrades to trigram-only and nothing looks wrong.
#    It is ALSO the step that applies alias RETIREMENTS (rvm-alias-retirements.jsonl): a
#    retirement-only release seeds nothing new, and this is the only command that takes the
#    phrase out of retrieval. Its dry run prints `retired_still_searchable` — the rows it
#    will switch off.
OPS_ALLOW_PRODUCTION=normalize:aliases \
  pnpm --filter @badabhai/db db:normalize:aliases --apply --i-am-authorised-to-write-to-production

# 3. Question packs. Occupations FIRST: profiling_family_binding references ISCO unit codes
#    that only exist once the domains are in.
OPS_ALLOW_PRODUCTION=seed:packs \
  pnpm --filter @badabhai/db db:seed:packs --apply --i-am-authorised-to-write-to-production

# 4. The gates. Read-only, exit 1 on any FAIL. This is the verify step for 1–3.
pnpm --filter @badabhai/db db:verify:domains
pnpm --filter @badabhai/db db:verify:packs
```

**`--apply` IS REQUIRED.** Every script in this family is dry-run by default: without it they
print what they would write, exit 0, and touch nothing. A seed step that passes while seeding
nothing is worse than no seed step, because the green tick is the thing you would trust.

**Both authorisation signals are required, and they are separate on purpose.** `ops-guard.ts`
classifies any Supabase host as production-like from the connection string alone and refuses to
write without the CLI flag *and* `OPS_ALLOW_PRODUCTION` naming that specific runner — so the
variable cannot be left over from authorising a different one. Note each command above names a
different runner. Do not export it once for the whole block.

**STOP if:** `db:verify:domains` reports `curated (rvm) aliases` below the expected total, or
any check FAILs after step 3. A catalogue that half-applied routes workers to the wrong trade,
which is worse than one that is obviously empty.

**What watches this between releases:** `.github/workflows/catalogue-drift.yml` runs steps 4
daily against the live database and fails the job on drift. It never writes — applying the fix
is this section, by a human.

The skill-alias embedding seeder refuses to run under `NODE_ENV=production` by design. The
sanctioned override is two deliberate acts (an env var **and** a CLI flag), it logs an audit line,
and it requires `skill_embedding` to be allowlisted first — so it belongs *inside* P4, after that
step, not here.

---

## P4 — Flag flips. One at a time. Canary smoke between every one.

Order matters: each flip's precondition is the previous one. #13 is the exception: it does not
follow #12, and means anything only while #12 is off.

| # | Flip | Precondition | Abort lever |
| - | ---- | ------------ | ----------- |
| 1 | `AI_INTERNAL_TOKEN` set on **both** ai-service and api | — | Unset (both sides); service auth fails closed |
| 2 | `AI_SPEND_REDIS_URL` | Redis reachable | Unset → falls back to per-process caps (weaker, still capped) |
| 3 | Spend caps set **explicitly** (`AI_MAX_USER_DAILY_COST_INR=6`, `AI_MAX_DAILY_COST_INR=200`, `AI_MAX_TOTAL_COST_INR=1000`, `AI_MAX_CALL_COST_INR=10`) | #2 | Lower them; they are read per call |
| 4 | `AI_ENABLE_REAL_CALLS=true` + `AI_REAL_CALL_TASKS=profile_extraction` | P0-2, P0-4, #1–#3 | `AI_REAL_CALLS_KILL_SWITCH=true` (checked first, blocks everything) |
| 5 | `+resume_generation` in the allowlist | #4 canary clean | Remove from allowlist |
| 6 | `+skill_embedding` in the allowlist | #5 | Remove from allowlist |
| 7 | Run the embed-skill-aliases seeder in production (two-act override) | #6 | Re-runnable; `--reset-embeddings` to redo |
| 8 | `SKILL_CANONICALIZE_ENABLED=true` | #7, embedded-row count verified | Flag off → phrases stay free text, exactly as today |
| 9 | `+stt_transcription` in the allowlist | **P0-1 (Sarvam DPA)**, private voice bucket confirmed, **`GEMINI_FLASH_API_KEY` set** (see note) | Remove from allowlist, or the kill switch |
| 10 | `CHAT_ONE_SHOT_OPENER_ENABLED=true` | — | Flag off → client fallback copy |
| 11 | `PAYMENTS_ENABLE_REAL=true` + all three secrets | P0-5 | Flag off → mock purchases resume; captured real payments still honored via webhook |
| 12 | `MATCH_V1_ENABLED=true` | P1 + P3 complete and verified | **Flag off, then redeploy** → the legacy feed and payer list return (the legacy code is still present until the retirement change). **Not the pre-flip deck once D4 has run** _(corrected 2026-10-01)_: D4 converts and closes every open `jobs` row, agency vacancies included, and has no reverse, so the legacy jobs arm comes back without them. With #13 armed they return as postings, skill-gated for profiled workers. Before D4 the revert is clean |
| 13 | `FEED_POSTINGS_UNION_ENABLED=true` ([ADR-0049](../decisions/0049-interim-union-feed.md), #1823) | **Independent of #1–#11; arm only while #12 is off** (ignored once `MATCH_V1_ENABLED` is on). Its own pre-arm list is below | Secret `false` + redeploy → postings leave the deck. Applications written while armed stay (see below) |

**On STT (#9), an accepted coupling worth knowing before you hit it:** closing the STT gating
hole meant routing it through the single `real_calls_blocked_reason()` helper — which is what
finally puts real audio behind the kill switch and the allowlist. That helper also requires
`GEMINI_FLASH_API_KEY`, so **real STT now needs the LLM master credential even if you are
enabling nothing but transcription.** The direction is fail-closed and there is now exactly one
definition of "real calls are on", which is the point. But an environment that intended to run
voice without any LLM will refuse to transcribe until that key is present, and the error will
name the credential rather than the coupling.

**On canonicalization (#8), one honest number:** measured precision is 1.000 and anchor-domain
recall is 0.350. A miss leaves the raw phrase exactly as the flag-off path does, so enabling it is
strictly additive coverage with no correctness downside — and every miss feeds
`unresolved_phrase`, which is the growth loop. Accepted at launch; the multi-domain fix that lifts
recall is tracked separately. Do not quote 0.800 (the oracle-domain figure) anywhere.

### P4 #13 — `FEED_POSTINGS_UNION_ENABLED`: company postings on the legacy feed (ADR-0049, #1823)

The flag arms two things: the posting arm of the legacy `GET /feed`, and the posting branch of
apply/skip. It does nothing while `MATCH_V1_ENABLED` is on. Three related fixes are **not** behind
it and are live from their merge: the payer posting-applicants list, the ops
`GET /jobs/:jobId/applicants` read and the unlock job-context fix (#1903).

**Pre-arm. Arm only if every item holds.**

1. **ADR-0049 is signed.** Done 2026-10-01 (Divyanshu, Backend Platform). The other items remain.
2. **The code is live.** The api image running in production must be at or after the merge of
   the last #1823 change (the payer posting-applicants list), with the unlock job-context fix
   (#1903) merged and deployed. Canary step 5 needs both. Read the api container's image tag on the box
   (`badabhai-api:sha-<short7>`), or the head SHA of the last successful `deploy-lightsail` run on
   `main`. Check the api image, not the run's title: an incomplete deploy leaves a service on its
   previous image (`staging-deploy.sh` prints "DEPLOY INCOMPLETE"). On 2026-10-01 the
   `job_posting.created` payloads lacked the `role_kind` key that #1840 always writes, which
   suggests the running image lags `main`.
3. **The posting free-text screen (B3, defined in ADR-0049 §5) is merged and deployed.** It is
   built in its own PR under #1823 (merged as #1918). Posting `role_title`,
   `description` and the `benefits` / `requirements` chip arrays must be screened at write with
   `looksLikePii` + `looksLikeOrgName` + `looksLikeUrl`
   ([ADR-0024](../decisions/0024-worker-visible-job-fields-pii.md) addendum 2026-10-01). Without
   it, an employer name typed into a title reaches every unprofiled worker's deck. Posting
   `city` / `area` are not in B3 (item 7, #1848).
4. **Inventory hygiene (ADR-0049 O10).** Close or complete the thin open postings: seed
   `5eeded00…`; employer `8eb13cb2…`, `a512c822…`, `97fa0f89…`, `ade45d03…`; agent `865e9870…`.
   Close `865e9870…` under #1885. Open postings with a NULL `published_at` (`ade45d03…` today) stay
   off the deck and stay appliable from search and detail; that is accepted.
5. **The read-only probe.** Run it inside `BEGIN READ ONLY; … ROLLBACK;`:

   ```sql
   -- (1) The posting upsert names all six columns. Expect 6.
   SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name IN ('job_posting_id','match_tier','skill_months','industry_months',
                          'last_worked_at','engine_version');
   -- (2) ON CONFLICT (worker_id, job_posting_id) WHERE ... needs the partial unique index,
   --     else 42P10. Expect "... WHERE (job_posting_id IS NOT NULL)".
   SELECT indexdef FROM pg_indexes WHERE indexname = 'applications_worker_posting_uq';
   -- (3) The feed index. Expect 1 row.
   SELECT 1 FROM pg_indexes WHERE indexname = 'job_postings_feed_idx';
   -- (4) What arming will show: every open posting, whether it is published, and its reach.
   SELECT id::text, published_at IS NOT NULL AS published,
          jsonb_array_length(reach_skill_ids) AS reach_n
     FROM job_postings WHERE status = 'open';
   ```

6. **The feed-union e2e legs for the company loop pass.** `tests/e2e/feed-postings-union.e2e.test.ts`
   carries both legs (2026-10-05): the payer applicants list (`/payer/reach/jobs/:jobId/applicants`
   serving a posting while V1 is off) and the unlock grant from a posting with a NULL job context
   (#1903). Check they pass in the CI `e2e` job's union step on the `main` commit being deployed;
   both underlying changes must also be deployed (item 2).
7. **Posting `city` / `area` screening is decided.** Neither is screened at the server, though a
   worker sees both verbatim (pre-existing, #1848, outside B3). Decide before arming whether #1848
   is a precondition. Recommended: yes, with security-engineer's ruling on the pincode
   false-positive trade-off. _Status 2026-10-05: #1848 merged as #1973 (a server screen with a
   pincode waiver); the arming decision itself is unchanged._
8. **The payer-app parses the posting-applicant row (#1913).** The payer-app Find tab is a second
   consumer of `/payer/reach/jobs/:jobId/applicants`, called for each of the payer's open
   postings. Once the payer posting-applicants change merges, an owned company posting returns
   the V1 candidate shape (camelCase) instead of a 404. That reaches the payer-app on the
   change's deploy, armed or not.
9. **security-engineer decides to arm.** Arming widens the ADR-0024-protected surface: posting
   free text and unverified postings reach the worker deck (R51).

**Arm.** Run `gh secret set FEED_POSTINGS_UNION_ENABLED --env production --body true`, then re-run
the deploy. Use `--env production`: a repository secret of the same name is shadowed. The secret
alone reaches nothing until a deploy. Set the literal: the api refuses anything other than `true`,
`false`, `1`, `0` or empty at boot, and the #1823 plumbing adds a deploy preflight that refuses it
before any container moves.

**Canary**, in production, with the canary accounts:

1. The canary payer creates and publishes a posting on payer-web `/postings/new`, with every card
   field filled and a match skill.
2. The canary worker has no wanted `worker_skill` rows, or wants a skill in that posting's reach.
   A profiled worker whose extraction produced wanted skills is skill-gated (profile extraction
   rebuilds `worker_skill`; production had 0 rows on 2026-10-01).
3. His Jobs tab shows the posting at rank 1, counted in "Aaj N naye jobs". Compare every field with
   what the payer entered: title; place (area, city); pay band and pay-type pill; experience;
   shift; needed-by; requirements and benefits; description. A posting card has no trade line and
   no role line, by design (ADR-0049 O6).
4. Apply returns 200, and its `applications` row has `job_posting_id` set and `job_id` NULL.
5. The payer-web applicants page lists the worker, and the unlock is granted.
6. The spine has `feed.shown` and `application.submitted` with `subject_type = 'job_posting'`, and
   no `feed.shown_v2`.

**Confirm the flag is live from the spine**, never from the last local `gh secret set`:

```sql
SELECT count(*) FROM events
 WHERE event_name = 'feed.shown' AND subject_type = 'job_posting'
   AND occurred_at > now() - interval '1 hour';
```

**Abort lever.** Run `gh secret set FEED_POSTINGS_UNION_ENABLED --env production --body false`,
then re-run the deploy (minutes). Or revert the change.

**The rollback is asymmetric. That is expected, not a fault:**

- Postings leave the deck, and apply and skip on a posting return 404 again. A worker cannot
  re-apply to or re-skip a posting he acted on while armed.
- What was written while armed stays visible. The worker's Applied tab, the company's applicants
  page and the ops applicants read are not behind the flag.

**While armed:**

- D4 converts and closes **every open `jobs` row (agency vacancies included, today)**, not only
  seed rows. A converted row does not drain from the deck. It reappears through the posting arm in
  the same place (`published_at = jobs.created_at`) and keeps the worker's applied state, but it
  is now skill-gated for profiled workers (ADR-0049 O2). For a seed row that is intended. An
  agency row becomes an agent-owned posting, which #1885 forbids: do not run D4 against live
  agency inventory until the agency-at-cutover path is decided (ADR-0049 §8 step 1, #1904).
- Ad-hoc SQL that joins the `job_id` of a `feed.shown` or `application.*` payload to `jobs`
  silently drops company rows. Branch on `subject_type` (ADR-0049 §4).

---

## P5 — Clients last.

Worker-app Play release via staged rollout: 10% → observe → 50% → 100%. Every server change in
this release is additive, so **old clients keep working throughout** — that is what makes a staged
rollout safe rather than a coin flip. payer-web deploys continuously.

Ship in this build: the persona copy fixes, the voice transcript-confirmation turn, App Links +
Play Install Referrer, and Firebase Remote Config/Analytics. App Links verification only takes
effect at install time, so **P0-6 must be live before the release is promoted**, not after.

---

## Canary smoke

Run after every P2/P4 step.

**First, the automated posture check** — `PROD_API_BASE_URL=https://… node scripts/prod-canary.mjs`.
Read-only and write-free; safe to run as often as you like. It proves `/health` is up, that **all
43 routes behind `InternalServiceGuard` reject an anonymous caller**, and that the DPDP consent
gate holds. Set `PROD_CANARY_OPS_TOKEN` as well and it also proves the ops token is *accepted* —
which is the P0-10 failure mode, since the guard fails closed and a missing or mismatched token
presents as a total ops-console outage.

> The route list was measured against Nest's own metadata, not assembled by hand. An earlier
> version probed 6 routes while describing itself as the closure claim, so 37 guarded routes —
> including `PUT /pricing/catalog`, `POST /unlocks/:id/reveal` and the whole job-posting
> verify chain — were never checked. If you add a route behind `InternalServiceGuard`, add it to
> `OPS_ROUTES` in that script; an unprobed route is exactly how the original hole survived.

**Then the human steps** the script deliberately does not fake. They need a real OTP to a
team-held handset and a real card, and `TEST_LOGIN_ENABLED` cannot be armed in production, so
there is no honest way to automate them. Uses a synthetic canary worker (a team-held real phone —
Fast2SMS OTP is already live) and a canary payer account, both flagged in the database so
analytics can exclude them.

1. **Worker:** OTP → consent → chat opener from the server → answers → extraction completes →
   resume ready.
2. **Voice** (after #9): record → transcript shown → `Yeh theek hai?` confirm → merged into chat.
3. **Loop** (after #12): payer signs up → 50 free credits present → posts a job (form *and* AI
   chat) → related skills pre-ticked with a live reach count → publish → **the canary worker sees
   it in `/feed`** → applies → payer sees the ranked candidate list with the related badge →
   unlocks → credit decrements → drain to zero → `payer.credits_exhausted` observed in the event
   spine.
4. **Payment** (after #11): buy the smallest pack with a real card → ledger row, `payment.captured`
   event, balance correct.

Step 3 is the one that matters most: it is the first time in the product's life that a
payer-posted job reaches a worker. If it fails, flip #12 back and stop — nothing downstream is
worth debugging until the loop closes.

---

## What to watch in the first 48 hours

- **Spend** — `/ai/spend` against the ₹6/user/day and ₹200/day ceilings. The per-user cap is the
  one that catches an abusive or looping session.
- **Zero-reach postings** — a payer publishing into an empty list is the failure the pre-pay
  warning exists to prevent. If it fires often, the vocabulary bridges are wrong, not the payer.
- **Feed emptiness** — workers with no `job_reach` rows. Expected for off-wedge trades; alarming
  for CNC workers.
- **Repeat-unlock rate** — the hero metric, and the early-warning signal for over-contact. The
  caps (5/day, 10 payers/week, 3 attempts) hold numerically but concentrate on top-ranked
  profiles.
- **Resolved-source share on referrals** — target ≥95%. Below that, attribution is still leaking
  and agent payouts cannot be defended.

## Rollback posture

Every phase is reversible by a different mechanism, and they compose:

- **P4** — flip the flag back: set the `production` environment secret (or the box value) and
  re-run the deploy. **Minutes, not seconds** _(corrected 2026-10-01)_: a flag is an environment
  value, so nothing changes until the containers are recreated. This covers every provider. For
  the matching cutover (#12) it is a full revert only before D4 has run.
- **P2/P5** — redeploy the previous image / halt the staged rollout. The schema stays; expand-only
  means old code runs against new columns without noticing them.
- **P1** — the only phase that is not casually reversible. That is why the rehearsal and the
  snapshot are mandatory, and why the contract phase is deferred: as long as nothing is dropped,
  "rollback" means rolling back *code*, which is always safe.

If two things go wrong at once, flip **#12 first** — it is the widest blast radius and the
cheapest revert (cheapest only before D4; see #12).
