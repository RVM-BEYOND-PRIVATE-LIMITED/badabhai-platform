# SR-1 — Staging skill-embedding enablement runbook (ADR-0030 / fork-B / FORK-B-1)

> **Ordered; do not skip; STAGING ONLY until green.** Real spend is §7-gated (SG-4) and
> production is a separate go/no-go with the same order. Owner directive 2026-07-14.

## Preconditions (before step 1)

- **TD64:** SpendLedger wiring for the embed path (the endpoint's per-request
  `AI_MAX_CALL_COST_INR` ceiling bounds ONE request, not day/user totals).
- **FORK-B-1 shipped:** request-path DB-backed store + runner verified. Without it, the
  backfill works but `canonicalize_skill` stays UNRESOLVED for everything (NullSkillStore).

## Steps

1. **Migrate + seed the staging DB.** `pnpm db:migrate` (through 0037) →
   `pnpm db:seed:skills` (vocabulary in; `skill_alias.embedding = NULL`). Confirm row
   counts; re-run the seed → identical counts (idempotent).
2. **Verify the corpus is NULL-embedded.**
   `SELECT count(*) FROM skill_alias WHERE embedding IS NULL;` must equal the alias total.
   If any non-NULL rows exist from a prior MOCK run → `pnpm db:embed:skills --reset-embeddings`
   first. **Mixed mock/real vector spaces = garbage matches** (mock vectors are
   deterministic hashes, indistinguishable at rest — the reset NULLs ALL embeddings).
3. **Confirm FORK-B-1 is deployed** (request-path store + verified runner).
4. **Set the staging ai-service env** — the §7 gate. Staging service env, NOT a committed
   file: `AI_ENABLE_REAL_CALLS=true`, `GEMINI_FLASH_API_KEY=<staging key>`, and
   `AI_REAL_CALL_TASKS` **empty or containing `skill_embedding`**.
   ⚠️ The staging default pin `AI_REAL_CALL_TASKS=profile_extraction` makes an embed run
   **silently MOCK** — and those hash vectors persist (recovery = step 2's reset).
5. **Throwaway 768/model check.** One gated `embedContent` call (single-row batch:
   `EMBED_BATCH_SIZE=1 pnpm db:embed:skills`); confirm the runner log shows
   `mock=false`, `model=gemini-embedding-001`, and a successful 768-dim write.
   `_real_embedding` raises on dim/model mismatch — good, but check BEFORE the full run.
6. **Backfill.** `EMBED_BATCH_SIZE=20 pnpm db:embed:skills` → fills real vectors into
   NULL rows only. Bounded one-time job; the endpoint stops each request at
   `AI_MAX_CALL_COST_INR` (`budget_stopped` → the runner halts; re-run resumes), and the
   runner aborts on any malformed response or zero-progress batch.
   **Assert the final report shows `mock=false` before accepting the run.**
7. **Enable the request path.** On the ai-service env set ALL THREE —
   `BACKEND_API_URL` (the NestJS api base), `SKILLS_INTERNAL_TOKEN` (the SCOPED skills
   secret, same value as the api's `SKILLS_INTERNAL_TOKEN` — deliberately NOT
   `INTERNAL_SERVICE_TOKEN`), and `SKILL_CANONICALIZE_ENABLED=true` — then restart. The
   flag alone is inert (the factory returns NullSkillStore without url+token; TD65).
8. **Verify.** In-vocab phrase ("VMC operator") → correct `skill_id` ≥ floor; a novel
   phrase → UNRESOLVED + a pseudonymized `unresolved_phrase` row; domain mismatch → no
   cross-domain match. Confirm the ai-service made **no direct DB connection** (seam A).
9. **Then TAX-5** — floor sweep on the labeled wedge set + RVM ratification of the
   vernacular aliases (kharad=lathe, chhilai=milling). Real vectors UNBLOCK calibration,
   they don't finish it: **floor 0.82 is uncalibrated until TAX-5 completes.**

Only after staging is green consider production — separate go/no-go, same order.
