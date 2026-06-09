# Technical Debt Register

A deliberate shortcut is fine **if it's logged with a payback trigger**. An
unlogged shortcut is a bug waiting to surprise someone. Status: **Open** ·
**Paying down** · **Paid**.

Seeded 2026-06-09 from the Phase-1 sprint plan and ADR-0001.

| ID | Debt | Why it exists | Payback trigger | Status |
| -- | ---- | ------------- | --------------- | ------ |
| TD1 | ~~Extraction~~ & **transcription** run inline on the request, not as BullMQ jobs | Phase-1 simplicity | Before enabling real STT/LLM | **Paying down** — extraction moved to BullMQ ([ADR-0002](../decisions/0002-async-extraction-and-action-recording.md)); transcription still inline (no STT contract yet) |
| TD2 | **Mock OTP** for worker identity | No real provider wired yet | Before onboarding real workers | Open |
| TD3 | **Pseudonymization is heuristic** (regex + gazetteers), not NER | Fast, safe-by-over-masking start | Before enabling real LLM in production | Open |
| TD4 | **RLS not enforced**; API uses the service role | RLS plan not finalized | Before any direct client→DB access or multi-tenant exposure | Open |
| TD5 | **Resume generation is a placeholder** (name-less, templated) | Phase-1 stub | When real resume output is a product requirement | Open |
| TD6 | **Sarvam STT is a placeholder**; voice notes upload but aren't transcribed | No STT contract yet | When voice profiling becomes a real flow | Open |
| TD7 | **Flutter CI job is `continue-on-error`** | Scaffold authored without a local SDK | Once the app is validated on a real SDK | Open |
| TD8 | `@badabhai/reach-engine` is an **empty placeholder package** | Phase 2+ feature | Start of Reach Engine work | Open (intentional) |
| TD9 | **No coverage threshold** in CI | Suite still young | When the suite is mature enough to set a floor | Open |
| TD10 | **No secrets manager**; secrets live in `.env` | Single-dev Phase-1 setup | Before multi-environment / multiple engineers handle prod secrets | Open |
| TD11 | **Action `context` PII guard is best-effort** (phone/email regex on keys+values); names/addresses not detectable | `context` is for non-PII signals, not free text | If clients start putting free text in `context` — tighten to an allow-list/enum | Open (ADR-0002) |
| TD12 | **Profile-extraction worker runs in-process** (same Nest app) | Phase-1 simplicity; queue boundary already in place | When extraction load needs independent scaling | Open (ADR-0002) |
| TD13 | **Flutter `ApiClient` async-extract change is UNVERIFIED** (no Flutter SDK in build env) | Toolchain absent locally | Run `flutter analyze` + `flutter test` in CI before the app ships | Open |
| TD14 | **Partial-success retry can duplicate a profile** (create OK, then markCompleted fails → retry re-creates); idempotency guard only covers already-`completed` redelivery | Full fix needs an `ai_job_id` column on `worker_profiles` or a txn | Before high extraction volume / real LLM | Open (ADR-0002) |
| TD15 | **`GET /ai-jobs/:id` passes `output_ref` through untyped + no authz** | Only `{profile_id}` today; authz is the platform-wide RLS gap (TD4) | Type the projection when a 2nd job type lands; close authz with TD4 | Open |
| TD16 | **Root `clean` script (`rimraf … *.tsbuildinfo`) fails on Windows** (glob not enabled) + `nest-cli deleteOutDir` + stale `.tsbuildinfo` can empty `dist` | rimraf 6 needs `--glob`; incremental tsc emits nothing after wipe | Quick fix: `rimraf --glob` or split the patterns | Open |

> When you pay debt down, mark it **Paid** with the PR link and date — don't
> delete the row. When you take *new* debt, add a row in the same PR that creates it.
