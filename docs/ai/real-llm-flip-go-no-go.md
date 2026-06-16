# Real-LLM extraction flip — GO/NO-GO (staging gate result)

- **Date:** 2026-06-16
- **Verdict:** **NO-GO (conditional)** — every safety control is GREEN; the **decisive
  accuracy number is not yet cleanly measured** because the eval key is on the Gemini **free
  tier**, whose quota throttled the full run. One paid/staging run unblocks a GO.
- **Scope:** the prod flip is a **human gate** (CLAUDE.md §7) — the maintainer flips prod.
  This run was **local only**, changed **no prod env**, and spent **₹0.28 total**.
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
| Canonicalization (role) accuracy | ≥ 90% | offline core+neg **100%**; real **partial 100%** (22 real calls) but **no clean full 56-case run** | ⚠️ **unmeasured (full set)** |
| Per-field aggregate accuracy | ≥ 90% | **not measured** (run contaminated) | ❌ **blocked** |
| No mock-fallback contamination | 0 fallbacks | **46 of 68 calls 429'd → fell back to mock** | ❌ **free-tier quota** |

## Why NO-GO (the one blocker)

The eval key is **Gemini free tier**. At sustained load it hit `429 RESOURCE_EXHAUSTED`; the
router **correctly** retried 3× then **failed closed to mock** (`real_call=true,
success=false`), and the contamination guard **correctly** invalidates any run with
fallbacks. So the machinery is sound — but the **full-gold-set ≥90% (role + per-field)**, the
heart of the gate, **cannot be cleanly measured on this key**. Every real call that *did*
complete scored 100% at ₹0.023/call, which is promising but not the threshold evidence.

**Unblock (owned + dated):**
- **Run the full 56-case eval on a PAID Gemini key (or staging with real quota):**
  `python -m app.profiling.eval_canonicalization --real` and `--per-field --real`; require a
  clean `real calls: N/N succeeded`, role ≥90%, per-field ≥90%. **Owner:** devops +
  ai-engineer. **Needs:** maintainer provisions a paid/staging key. **Target:** before any
  prod flip.

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
- **Q: What's the single thing standing between us and GO?** A: One clean full-gold-set real
  run on a paid/staging key meeting ≥90% role + per-field with zero fallbacks.
