# Real-LLM extraction flip — GO/NO-GO (staging gate result)

- **Date:** 2026-06-16 (NO-GO) · **Updated 2026-06-17 (GO — maintainer-confirmed)**
- **Verdict:** **✅ GO** — the maintainer (human gate, the only authority for this call —
  CLAUDE.md §7) confirms the real-LLM validation is **complete** on 2026-06-17. The prior
  blocker — a clean full-gold-set accuracy run, previously throttled on a Gemini **free-tier**
  key — is **resolved**; the passing staging validation is recorded in **TD27** (per-field
  aggregate ≥ 90%, clean full run, spend within caps). All safety controls were and remain
  GREEN. The contaminated free-tier local re-run below is **superseded** and kept for history.
- **Scope:** the GO authorizes the maintainer to perform the **actual prod flip** (staging
  first) per the env diff in "When the flip IS authorized" below. This document does **not**
  itself change any prod env — the flip remains the maintainer's manual, human-gated action.
- **Pre-flip action still required:** rotate the dev-box keys (Finding 3) before/at the flip.
- **Runbook + threshold:** [enable-real-llm-extraction.md](enable-real-llm-extraction.md)
  (canonicalization ≥90%, per-field ≥90%, cost/profile ≤ target ₹4, cap-never-breached,
  no mock-fallback contamination).

## Measured vs threshold

| Criterion | Threshold | Measured | Result |
|-----------|-----------|----------|--------|
| Controls: pseudonymization fail-closed upstream | must hold | suite green; blocked input never reaches LLM | ✅ |
| Controls: TD27 caps fire **before** network | must hold | daily/total/per-user (₹6) unit tests pass | ✅ |
| Controls: kill-switch hard-disables independently | must hold | `error_code=kill_switch_engaged` | ✅ |
| Cap-never-breached (live) | spend < cap | ₹0.276 of ₹200 daily / ₹1000 total | ✅ |
| PII-free spend snapshots + error codes | must hold | asserted by tests | ✅ |
| Cost / profile | ≤ ₹4 target | **₹0.023 / call** (Gemini 2.5 Flash-Lite) | ✅ (well under) |
| Latency / call | sane | **~2.2–3.8 s** | ✅ |
| Canonicalization (role) accuracy | ≥ 90% | **PASS on staging** (clean full run, TD27); the contaminated free-tier local re-run is superseded | ✅ (maintainer-confirmed 2026-06-17) |
| Per-field aggregate accuracy | ≥ 90% | **PASS on staging** — per-field aggregate ≥ 90% (TD27 record) | ✅ (maintainer-confirmed 2026-06-17) |
| No mock-fallback contamination | 0 fallbacks | clean `N/N succeeded` on the staging key (the free-tier 46/68→mock run is superseded) | ✅ (staging) |

## Resolution — GO (2026-06-17)

The original NO-GO had **one** blocker: the decisive **full-gold-set ≥90% (role + per-field)**
could not be cleanly measured on the throttled **Gemini free-tier** key (46/68 calls 429'd →
mock; the contamination guard correctly invalidated that run). That blocker is now **closed**:
the maintainer ran/validated the gate on a paid/staging key and **confirms PASS** (2026-06-17),
consistent with the staging validation recorded in **TD27** (per-field ≥ 90%, clean full run,
spend within the daily/total/per-user caps). Every safety control was GREEN throughout
(pseudonymization fail-closed, TD27 caps fire before network, kill-switch independent), so the
machinery never needed re-architecting — only the clean accuracy evidence, which now exists.

> The superseded free-tier local run (NO-GO, 2026-06-16, ₹0.28 total, no prod env changed)
> is retained above and below purely as history.

## Findings to fix before the flip

1. **Configured primary `claude-haiku-4-5` fails 100%** (RuntimeError every call) — extraction
   only works via Gemini fallback, wasting 3 attempts/call and risking the retry budget under
   load. Fix the Anthropic key/config or drop it; the runbook intends **Gemini primary**.
2. **Local config deviates from the runbook** — `DEFAULT_CAPABLE_MODEL=claude-haiku-4-5` vs
   the runbook's `gemini-2.5-flash`. Pin the exact extraction model at the staging flip.
3. **🔒 Security (rotate):** the local `apps/ai-service/.env` holds **real Gemini + Anthropic
   keys with `AI_ENABLE_REAL_CALLS=true`** on a dev laptop — gitignored (not committed, no
   leak) but against the runbook's "real keys never on a dev laptop." **Rotate both keys and
   remove them from the dev box;** keep real keys only in staging/prod secret stores.

## When the flip IS authorized (for the maintainer)

- **Prod env diff:** `AI_ENABLE_REAL_CALLS=true`, `AI_REAL_CALL_TASKS=profile_extraction`,
  `GEMINI_FLASH_API_KEY=<staging-validated paid key>`, `DEFAULT_CAPABLE_MODEL=<pinned
  Gemini>`; keep `AI_REAL_CALLS_KILL_SWITCH=false`, caps at policy. Staging first.
- **Rollback (instant, no deploy):** set `AI_ENABLE_REAL_CALLS=false` **or** clear
  `AI_REAL_CALL_TASKS` **or** `AI_REAL_CALLS_KILL_SWITCH=true` → extraction returns to mock.
- **Kill-switch runbook:** flip `AI_REAL_CALLS_KILL_SWITCH=true` to hard-stop all real calls
  independently of the master flag; verify `GET /health` → `real_calls_enabled:false`.

## Q&A — anticipated questions (answers ready)

- **Q: Are we unsafe right now?** A: No. Default is mock; the dev-box key is gitignored (not
  shipped). The only action item is rotating that key.
- **Q: Is the accuracy actually bad?** A: Unknown at the gate bar — we couldn't complete a
  clean full run on a throttled free key. Partial real results were 100%; the offline
  heuristic clears core+negative at 100% and (as expected) needs the LLM for the hard tier.
- **Q: Why not just keep retrying locally?** A: The free-tier quota is exhausted; more
  retries only produce more mock fallbacks (INVALID). The runbook's clean path is **paid
  billing** or **staging**.
- **Q: How much did this cost?** A: ₹0.28 total, cap never approached.
- **Q: What's the single thing standing between us and GO?** A: ~~One clean full-gold-set real
  run on a paid/staging key meeting ≥90% role + per-field with zero fallbacks.~~ **DONE
  (2026-06-17)** — that run passed on staging (TD27); verdict is now **GO**. The only remaining
  action is the maintainer's manual prod flip (staging-first) + rotating the dev-box keys.
