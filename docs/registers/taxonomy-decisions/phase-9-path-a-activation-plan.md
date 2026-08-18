# Path-A activation plan — staged, gated, and not yet started

> **Status: PLAN ONLY. Nothing here is authorized or executed.**
> `SKILL_CANONICALIZE_ENABLED=false` · `DOMAIN_MATCH_ENABLED=false` · both stay false until the
> activation gate in §6 is explicitly approved. `legacyAliasRows`, the legacy scope arm and
> `LEGACY_ANCHOR_SKILL_DOMAIN` all stay until §7's retirement criteria are met.
>
> Supersedes nothing. Implements the staged migration D0 called for, now that the offline
> shadow exists. Evidence: [`data/taxonomy/replay/`](../../../packages/db/data/taxonomy/replay/).

---

## 1. The intended architecture

```
  lexical scope  ──▶  job_domain_id  ──▶  Path A canonical retrieval  ──▶  evaluation  ──▶  activation
   (already live)      (already live)        (wired, returns nothing)        (offline)      (gated)
```

**`DOMAIN_MATCH_ENABLED` is not on this path and does not need to be true.** The scope comes
from the lexical pin (`identify.service.ts` → `pin(result, "matched_lexical", ctx)`), which
short-circuits *before* the `domain_match_enabled` check. That is why production already has a
worker profile carrying a pinned `job_domain_id` while the flag is off. Turning the flag on
would add a *second*, embedding-based scope source; it is a separate decision with its own
evidence requirement, and this plan does not need it.

**Correction to a claim in the D0 brief.** D0 said both live callers "hard-code" the legacy
anchor. `job-postings.service.ts:140-142` does not hard-code it — it is conditional:

```ts
jobDomainId != null ? { job_domain_id: jobDomainId } : { domain_id: LEGACY_ANCHOR_SKILL_DOMAIN }
```

So the canonical arm is **already wired and already reachable**; it switches on *data*, not on
config. The effect D0 described is real, but for a different reason: measured on production
2026-08-18, **0 of 8 `job_postings` carry a canonical `job_domain_id`**, so the branch never
fires. This matters for activation — there is no code switch to throw, and equally no config
guard preventing Path A from serving the moment a posting gains a `jd_*` domain.

## 2. What production actually has today

Read-only, measured 2026-08-18:

| | production | needed for Path A |
|---|---:|---|
| `job_domain_skill` edges | **0** | the join returns nothing without these |
| `skill` rows | 51 (all active) | dev corpus has 147 |
| `skill_alias` rows | 98 | dev has 335 |
| `skill_alias` embedded | 76 | |
| `skill_alias.embedding_model` | **NULL on all** | no provenance; model coherence unverifiable |
| `skill_alias.text_norm` | **0** | |
| `skill_alias.is_searchable` | **0** | |
| `job_postings` with canonical domain | **0 of 8** | the branch never fires |

**Path A in production today would return zero rows for every query.** Not because of TD-01 —
because the corpus it depends on was never deployed. That is the gating fact for this whole
plan, and it is why activation is a *deployment* problem before it is a retrieval problem.

## 3. Stages

Each stage states what must be true before it starts and how to undo it. No stage begins until
the previous one's exit criteria hold and are recorded.

| # | Stage | Mutates | Entry criteria | Rollback |
|---|---|---|---|---|
| **S0** | Offline shadow | nothing | — | n/a — **✅ DONE**, this replay |
| **S1** | Close the fixture gap: reviewed cases for drawing-reading + the generic aliases | fixture data | trainer availability | revert the fixture commit; `retrieval-v1` is hash-pinned and untouched |
| **S2** | Decide R19 (TD-01 edges) | `domain-skills.jsonl` + 14 rows, *if* option A | S1, and [`phase-9-td-01-edge-decision.md`](./phase-9-td-01-edge-decision.md) authorized | delete the 14 rows by captured id set |
| **S3** | Deploy the taxonomy corpus to production — additive only | `skill`, `skill_alias`, `job_domain_skill` | S2; TD-07 resolved or explicitly deferred with its aliases excluded | delete added rows by captured id set; **Path B's universe must be bit-identical before and after** |
| **S4** | Normalize + elect `skill_alias` in production | `text_norm`, `is_searchable` | S3 verified; manifest + sha256 + in-transaction guards, as the dev write used | restore from the manifest's rollback id set |
| **S5** | Embed the production alias corpus with provenance | `embedding`, `embedding_model` | S4; `--plan` output reviewed; quota confirmed | vectors are additive; re-embed or NULL by id set |
| **S6** | Live shadow: compute Path A alongside Path B, serve Path B, log both | nothing | S5; requires the dual-read code behind a flag | disable the shadow flag |
| **S7** | Parity gate | nothing | ≥ N shadow requests; threshold **derived from the shadow data**, not invented here | n/a |
| **S8** | Read switch: postings and profiles pass `job_domain_id` | data/config | S7 passed | stop populating `job_domain_id` — the conditional in §1 falls back to Path B on its own |
| **S9** | Enable `SKILL_CANONICALIZE_ENABLED` — its own PR, nothing else in it | flag | §6 gate | flip the flag back |
| **S10** | Retire the legacy arm | code | §7 criteria | restore the branch |

**S3 is the only stage that is hard to undo cleanly**, and it is deliberately additive: nothing
existing is mutated, so rollback is a delete over a captured id set — the same discipline the
`text_norm` write used.

## 4. Why the shadow is offline and stays offline

The live endpoint returns `unresolved` *before* retrieval when canonicalization is disabled. So
a live shadow would require enabling `SKILL_CANONICALIZE_ENABLED` — which is the change the
shadow exists to de-risk. Enabling it to observe it is circular, and it is not done.

S6's dual-read is a different thing: it computes Path A and *discards* it, serving Path B. That
is safe because it changes no response. It is still gated behind its own flag and does not
require canonicalization to be on.

Until S6, **the offline replay is the shadow evidence**, and it is honest about its limits:

- 116 of 127 cases replayed. 11 excluded for want of a cached query vector, **all 11 reviewed**
  — 12.5% of the scoreable set. Two sit in TD-affected domains (`XD-06 @ jd_nco_7543_2001`,
  `US-04 @ jd_nco_7313_2601`), so the exclusion is not neutral. Closing it costs 11 provider
  requests and is not authorized.
- The corpus is the **dev/authoritative** one, not production's. Under the D0 vocabulary this
  is `CORPUS_ENVIRONMENT=local`, `RETRIEVAL_PATH=job_domain_skill`. It must never be quoted as
  production performance.
- R@1 0.9912 / MRR 0.9956 reproduces `EXP-P8-BASELINE` exactly through an independent code
  path. That corroborates the *baseline*; it does not promote it to a production number.

## 5. Measured starting point

116 cases (113 positive + 3 negative), k=5, pre-promotion semantics:

| path | resolved | R@1 | MRR | false pos | false neg | mean candidates |
|---|---:|---:|---:|---:|---:|---:|
| **Path A** | 116/116 | **0.9912** | **0.9956** | 0 | 0 | 17.5 |
| **Path B** | 116/116 | **0.0000** | **0.0000** | 0 | **113** | 32.0 |

Path-to-path agreement: **1 of 116**. Path B is not a degraded Path A — it retrieves from the
11 hand-minted legacy slugs while every fixture expectation lives in the growth corpus. The two
arms answer different questions, which is the strongest argument in the record for completing
the migration rather than maintaining both indefinitely.

## 6. Activation criteria — all must hold, none may be waived

`SKILL_CANONICALIZE_ENABLED=true` requires every one of:

1. **Corpus deployed and verified** in production (S3), with Path B's result set proven
   bit-identical before and after.
2. **Normalization + election applied and independently verified** (S4) — `db:verify:aliases`
   CLEAN against production, with `is_searchable` stored equal to expected and zero mismatches.
3. **Every reachable alias embedded with a recorded `embedding_model`** (S5). The 76 unstamped
   production vectors are re-embedded or explicitly excluded; `FULLY_EMBEDDED` cannot verify
   model coherence against NULL.
4. **R19 decided and applied or explicitly accepted** (S2), with the drawing-reading surface
   either reachable or recorded as deliberately unreachable.
5. **TD-07 resolved**, or its aliases explicitly excluded from the deployed corpus.
6. **Fixture v3 covers the merged skills** (S1) — at minimum, reviewed cases for
   drawing-reading and for each generic alias in the §5B risk list.
7. **A fresh evaluation on the production corpus**, recorded as a new immutable `EXP-*`, with
   `CORPUS_ENVIRONMENT=production` and `RETRIEVAL_PATH=job_domain_skill` stamped on it.
8. **`NO_REGRESSION` passes** against a baseline re-based on fixture v3 as an explicit reviewed
   act, and the corpus fingerprint is not stale.
9. **GP-04 resolves to `skill_coolant_management` at ≥ 0.75** on that evaluation.
10. **Live shadow parity** (S7) at a threshold derived from shadow data, every disagreement
    classified.
11. **Rollback rehearsed**, not merely written — §7.

CI being green is not on this list and is not evidence of any of it.

## 7. Rollback

**Flag-level (S9).** Set `SKILL_CANONICALIZE_ENABLED=false`. Takes effect on redeploy. No data
change; the endpoint returns to `unresolved` before retrieval. This is the fast path and the
reason the flag flip ships alone, with nothing else in the PR.

**Read-switch level (S8).** Stop populating `job_domain_id` on postings/profiles. The
conditional in §1 falls back to Path B automatically — no code change, no deploy.

**Data level (S3–S5).** Every write stage captures a manifest with a rollback id set and a
sha256 before it runs, and `writeArtifact()` refuses to overwrite one. Rollback is a delete or
restore over that id set. Vectors are additive and can be NULLed by id.

**What is NOT reversible cheaply:** a provider spend, and a re-embed after a NULL. Both are
quota, not data.

**The legacy arm stays until:** S9 has held for a full rollback window with no revert, Path A
has served correctly on production evidence, and this rollback procedure has been *rehearsed*
against staging. `legacyAliasRows`, the legacy scope arm and `LEGACY_ANCHOR_SKILL_DOMAIN` are
the only implemented fallback; removing them before then converts a config rollback into a
code-and-deploy rollback during an incident.

## 8. Still unauthorized

The 14-edge re-point · the §3 alias add/remove list · the §4 canonical-label writes · the
election · the retrieval predicate · any embedding run · promotion · canonicalization · the
GitHub Environment rename · removal of the legacy arm · the 4,071-domain surface.
