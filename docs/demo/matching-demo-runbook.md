# Matching V1 demo — runbook

The demo shows that with `MATCH_V1_ENABLED=true` each worker's feed holds only the jobs their
skills reach. That means jobs naming one of their skills (tier 1, "direct") and jobs naming a
related skill (tier 2, "related"). Every other trade is hidden.

Script: `packages/db/src/seed-demo-matching.ts` (plan: `demo-matching-plan.ts`).
CI gate: `apps/api/src/match/demo-matching-seed.db.test.ts`.

The seed writes:

- 25 synthetic employers;
- **1,200 open postings** across all **21 role kinds**, spread over 5 cities (Pune, Manesar,
  Chennai, Ahmedabad, Bengaluru), with `published_at` spread over 30 days and about 3% boosted;
- **10 personas**, each with 1–2 wanted skills.

Reach rows are then materialized with D5's own function. Every seeded id starts with `de30`.
Persona phones are reserved synthetic numbers (`+9100000 26xxx`).

---

## ⚠ Read before running on the production server

The owner decided the demo runs on the existing production server. Before running anything,
understand what that means:

- **Real workers will see the synthetic postings.** A demo posting reaches every worker in the
  database whose wanted skills it covers, not only the personas.
  - With `MATCH_V1_ENABLED=true`, real welders, turners, fitters and so on will see demo jobs.
  - **They can apply to them.** Those jobs do not exist.
  - Keep the window short and run `--cleanup` right after the demo.
- **Cleanup deletes applications to demo postings.** `--cleanup` deletes every `de30…` posting,
  which cascades to its `job_reach` and `applications` rows, including any a real worker made.
  The `application.*` / `feed.shown_v2` events those actions emitted stay in the audit trail.
- **`MATCH_V1_ENABLED` is global.** Turning it on switches **every real worker** to the V1 feed,
  and turning it off switches them all back (production-release-runbook #12). After D4 the
  revert is not clean.
- **Persona logins do not work in production.** `TEST_LOGIN_ENABLED` cannot be armed there, and
  a reserved synthetic phone cannot receive a real OTP.
  - In production, personas are a data-level proof: the answer key plus the feed SQL.
  - The live demo is a real handset going through onboarding.
- **Running it is the owner's action.** No agent session runs this against production.

---

## Commands

All commands run from the repo root, with `DATABASE_URL`, `PII_ENCRYPTION_KEY` and
`PII_HASH_PEPPER` set. Use the production values on the server so personas resolve by
`phone_hash` exactly as the API would.

### Local (docker-compose) first, every time

```bash
docker compose up -d
pnpm --filter @badabhai/db db:migrate
pnpm --filter @badabhai/db db:seed:match:vocabulary --apply     # the 18 match skills + skill_related + match_config
pnpm --filter @badabhai/db db:seed:demo-matching                 # dry run: plan + expected split per persona
pnpm --filter @badabhai/db db:seed:demo-matching --apply --answer-key=/tmp/demo-key.json
pnpm --filter @badabhai/db db:materialize:reach                  # D5 dry run over ALL open postings: expect 0 SKIPPED
pnpm --filter @badabhai/db db:seed:demo-matching --report-trades # what a fresh worker of each trade would see
```

Set `MATCH_V1_ENABLED=true` in the local `.env`, then restart the API.

### Production server

A production-like `DATABASE_URL` is refused unless `--target=production` is passed. A write also
needs both ops-guard signals (same as every Matching V1 runner).

1. **Dry run.** Read-only; prints the plan and each persona's expected split.

   ```bash
   pnpm --filter @badabhai/db db:seed:demo-matching -- --target=production
   ```

2. **Seed and materialize.**

   ```bash
   OPS_ALLOW_PRODUCTION=seed:demo-matching \
     pnpm --filter @badabhai/db db:seed:demo-matching -- --apply --target=production \
       --i-am-authorised-to-write-to-production --answer-key=/tmp/demo-key.json
   ```

3. **Verify.** All three steps are read-only.

   ```bash
   pnpm --filter @badabhai/db db:materialize:reach                         # 0 SKIPPED de30… postings
   pnpm --filter @badabhai/db db:seed:demo-matching -- --target=production --answer-key-only --answer-key=/tmp/demo-key.json
   pnpm --filter @badabhai/db db:seed:demo-matching -- --target=production --report-trades
   ```

   `--answer-key-only` re-runs the self-check. It fails loudly if any persona sees a demo posting
   outside its reach, misses one inside it, or has the wrong tier.

4. **Clean up** right after the demo.

   ```bash
   OPS_ALLOW_PRODUCTION=seed:demo-matching \
     pnpm --filter @badabhai/db db:unseed:demo-matching -- --apply --target=production \
       --i-am-authorised-to-write-to-production
   ```

   Then check `SELECT count(*) FROM job_postings WHERE id::text LIKE 'de30%'` returns 0.

Re-running the seed is idempotent: it upserts, refreshes `published_at` and boosts from "now",
and removes `de30…` rows outside the current plan.

---

## Live onboarding

The owner creates a worker live through the chat. The chat's profile → `worker_skill` path
reconciles reach against every open posting, so the demo postings appear without re-running
the seed.

Which skills a live worker gets (traced 2026-10-06):

| They say…                                    | Path                                    | Match skill                                           | Sees (from `--report-trades`)                                |
| -------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| "welder" / "welding"                         | free-text chat (`role_welder`)          | `mskill_mig_welder` (+ arc/tig if they say TIG/arc)   | MIG direct; arc + TIG related                                |
| "CNC turner"                                 | free-text chat, or the **turning form** | `mskill_cnc_turner`                                   | turner direct; VMC / setter / grinding / general CNC related |
| "CNC operator"                               | free-text chat                          | `mskill_cnc_operator_general`                         | general CNC direct; grinding / turner / HMC related          |
| any other **trade form** (welder, fitter, …) | form                                    | **none** — only `qp_cnc_turning` bridges today        | **nothing**                                                  |
| chat with **structured answers**             | chat                                    | **none** (`toExtractionOutput` writes no role/skills) | **nothing**                                                  |

Run `--report-trades` before the demo and pick a trade with a full feed. **Welder (free-text
chat) and CNC turner** are the proven paths.

**Re-running a live onboarding.** Extraction is skipped for a worker who already has a profile.
To reset one demo worker, list their phone in a file (one E.164 per line), then:

```bash
pnpm --filter @badabhai/db db:seed:demo-matching -- --reset-live-worker \
  --phone=+910000026101 --allow-phones=demo-phones.txt --apply
```

This deletes only that worker's `worker_profiles`, `worker_skill` and `job_reach` rows. The phone
must be in the reserved synthetic range **and** in the file.

> On production this cannot reset a worker created with a **real** handset, because the phone is
> outside the reserved range. That is deliberate: widening it to real phones means deleting a
> real worker's data, which needs an explicit owner decision.

---

## Showcase personas

| Persona                                   | Phone           | Skills             | Story                                                                                                    |
| ----------------------------------------- | --------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| ★ `showcase-welder-pune` (Ravi Demo)      | `+910000026001` | MIG welder, 48 mo  | What "welder" in the chat yields. MIG jobs direct; arc and TIG related; no machining, plastics or design |
| ★ `showcase-fitter-manesar` (Suresh Demo) | `+910000026002` | fitter, 60 mo      | Plumbing and QC jobs related. Stands in for an electrician: there is **no electrician match skill**      |
| `cnc-turner-pune`                         | `+910000026003` | CNC turner, 36 mo  | Side-by-side with a live CNC turner                                                                      |
| `cnc-operator-ahmedabad`                  | `+910000026004` | general CNC, 12 mo | Side-by-side with a live "CNC operator"                                                                  |
| … 6 more                                  | `…005`–`…010`   | see the answer key |                                                                                                          |

The answer key (`--answer-key=<file>`) holds, per persona:

- visible / direct / related / hidden counts;
- the boosted cards it sees;
- the **top 10 cards as served**: tier, boost and employer number, so the max-2-per-employer
  interleave is visible.

**How to log in as a persona.**

- Local: `POST /auth/test-login` with the persona's phone (`TEST_LOGIN_ENABLED` +
  `TEST_LOGIN_TOKEN`).
- Production: not possible (see the warning above).
- **TODO (S3):** confirm the presenter's login method and fill in the exact steps here.

---

## Known gaps (disclosed, not fixed here)

- **Proxy role kinds.**
  - The vocabulary has 18 match skills and none for an electrician, press work, coating or polymer
    trades.
  - `industrial_electrician`, `maintenance_technician` and `assembly_line_worker` post
    `mskill_fitter`.
  - `press_operator`, `painter_coating` and the plastics kinds post `mskill_cnc_operator_general`.
  - `tool_die_maker` and `mould_die_maker` post `mskill_cnc_setter_operator`.
  - `sheet_metal_worker` posts `mskill_mig_welder`.
  - So a fitter sees electrician cards as direct matches. Closing this is a taxonomy change.
- **Trade forms other than CNC turning derive no match skill**, so a form-onboarded welder sees an
  empty feed. This is a backend change in `pack-attribute-skills.ts`.
- **Carpenter and delivery rider** have match skills but no role kind, so they get no demo
  postings. A live "carpenter" sees 0.
