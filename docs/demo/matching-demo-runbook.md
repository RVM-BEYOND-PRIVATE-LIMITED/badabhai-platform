# Matching V1 demo — runbook

The demo shows that with `MATCH_V1_ENABLED=true` each worker's feed holds only the jobs their
skills reach. That means jobs naming one of their skills (tier 1, "direct") and jobs naming a
related skill (tier 2, "related"). Every other trade is hidden.

Script: `packages/db/src/seed-demo-matching.ts` (plan: `demo-matching-plan.ts`).
CI gate: `apps/api/src/match/demo-matching-seed.db.test.ts`.

The seed writes:

- 25 synthetic employers;
- **1,200 open postings** across the **16 role kinds that have a real match skill**, spread over
  5 cities (Pune, Manesar, Chennai, Ahmedabad, Bengaluru);
  - `published_at` is spread over 30 days, in per-employer batches minutes apart, so the
    max-2-per-employer interleave is visible;
  - about 3% are boosted;
  - the other 5 role kinds (moulding and plastics) get **no** postings (see Known gaps);
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
- **Cleanup deletes everything hanging off demo postings.** `--cleanup` deletes every `de30…`
  posting. The cascade covers:
  - `job_reach`;
  - `applications`, including any a real worker made;
  - `learn_labels`, `job_posting_skill`, `job_reach_widen`, `posting_plans`, `posting_boosts`;
  - `resume_disclosures.job_posting_id`, which is set to null.

  The `application.*` / `feed.shown_v2` events those actions emitted stay in the audit trail.

- **Pause learn exports and training while the demo is live.** Real workers' impressions of demo
  jobs become `learn_labels` until cleanup. Anything exported in that window keeps the synthetic
  signal.
- **Personas get no `employer_sharing` consent on production.** Without it, a real employer whose
  posting reaches a persona cannot spend a credit unlocking a worker who does not exist. Local
  seeds still grant it.
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
pnpm --filter @badabhai/db db:seed:match:vocabulary --apply     # the 26 match skills + skill_related + match_config
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

   First, **soft**: close every demo posting. They leave every feed at once and nothing is
   deleted, so a real worker's application row and its events stay consistent.

   ```bash
   OPS_ALLOW_PRODUCTION=seed:demo-matching \
     pnpm --filter @badabhai/db db:unseed:demo-matching -- --apply --close-only --target=production \
       --i-am-authorised-to-write-to-production
   ```

   Then, **hard** (deletes every `de30…` row). It **refuses while any real worker has applied** to
   a demo posting, because those application rows would be deleted and their `application.*`
   events orphaned. Pass `--delete-real-applications` only if the owner decides they go.

   ```bash
   OPS_ALLOW_PRODUCTION=seed:demo-matching \
     pnpm --filter @badabhai/db db:unseed:demo-matching -- --apply --target=production \
       --i-am-authorised-to-write-to-production
   ```

   Then check `SELECT count(*) FROM job_postings WHERE id::text LIKE 'de30%'` returns 0.

Re-running the seed is idempotent: it upserts and removes `de30…` rows outside the current plan.
`published_at` and boosts are computed from `--anchor` (default: now). **On production, re-run
with the anchor the answer key recorded** (`"anchor"` field) so a re-run does not push the demo
jobs back to the top of real workers' feeds.

---

## Live onboarding

The owner creates a worker live through the chat. The chat's profile → `worker_skill` path
reconciles reach against every open posting, so the demo postings appear without re-running
the seed.

Which skills a live worker gets (traced 2026-10-06; trade forms per #2019):

- **Free-text chat:**
  - "welder" / "welding" → `role_welder` → `mskill_mig_welder` (plus arc / TIG if they say TIG or
    arc). MIG jobs are direct; arc and TIG are related.
  - "CNC turner" → `mskill_cnc_turner`.
  - "CNC operator" → `mskill_cnc_operator_general`. General-CNC jobs are direct; grinding, turner
    and HMC are related.
- **Trade form, or a structured-answer chat on the same role pack** (#2019, `PACK_ANSWER_SKILLS`
  in `@badabhai/taxonomy`):
  - welder → MIG / TIG / arc, by the processes ticked;
  - CNC turning → turner (+ programmer / CAM);
  - VMC → VMC / HMC (+ programmer / CAM);
  - CNC grinding, CAM, CAD, fitter and QC → their own skills.
  - Since #2022 (owner ruling 2026-10-06) the other eight forms derive their **own** skill:
    manual machining → `mskill_conventional_machinist` (a manual lathe / mill also reaches CNC
    turner / VMC), tool & die → `mskill_tool_die_maker`, sheet metal →
    `mskill_sheet_metal_worker`, press → `mskill_press_operator`, coating →
    `mskill_painter_coater`, maintenance tech → `mskill_maintenance_technician`, electrician →
    `mskill_industrial_electrician`, assembly → `mskill_assembly_line_worker`. A manual grinder
    (`grinding_type=conventional`) reaches CNC grinding. `PACKS_WITHOUT_MATCH_SKILL` is empty.
  - Free-text chat does **not** reach those eight skills yet: they have no role or corpus
    anchor, so a chat-only electrician still derives nothing.

Run `--report-trades` before the demo and pick a trade with a full feed. Form rows show a
**fully-answered** form, an upper bound; a real worker derives the subset his chips claim.
**Welder and CNC turner** are proven by both chat and form.

**Re-running a live onboarding.** Extraction is skipped for a worker who already has a profile.
`--reset-live-worker` deletes **only** that worker's `worker_profiles`, `worker_skill` and
`job_reach` rows, so the chat extracts again. The worker row, consents, chat history and
applications stay. The phone must be well-formed E.164.

- **Local stack.**
  - Onboard the live worker with a phone from the demo block, `+910000026101`–`…26999`, via
    test-login.
  - The phone must be in the demo block (never the E4 or smoke numbers) **and** in the allow-list
    file.

  ```bash
  pnpm --filter @badabhai/db db:seed:demo-matching -- --reset-live-worker \
    --phone=+910000026101 --allow-phones=demo-phones.txt --apply
  ```

- **Production server** (owner decision, 2026-10-06): the allow-list file is the **only**
  authority.
  - The owner creates it on the server: one E.164 per line, `#` comments allowed.
  - A real number may be reset **only if it is listed**. Every other number is refused.
  - Personas keep the reserved demo block.

  ```bash
  OPS_ALLOW_PRODUCTION=seed:demo-matching \
    pnpm --filter @badabhai/db db:seed:demo-matching -- --reset-live-worker --target=production \
      --phone=+91XXXXXXXXXX --allow-phones=/path/on/server/demo-phones.txt --apply \
      --i-am-authorised-to-write-to-production
  ```

  This deletes that real worker's profile and skills. List only the owner's own demo handset(s).

> Also: an SSH tunnel to the production database on `localhost` would be classified LOCAL by the
> guard. Run the seed **on** the server with its own `DATABASE_URL`, never through a tunnel.

---

## Who counts as a demo worker (shared definition)

Owner ruling 2026-10-06: demo tooling and demo views act only on:

- the reserved **demo block** `+910000026xxx` (personas, and live demo workers on the local stack);
- phones the owner lists in an **allow-list file**.

The definition lives in one place: `packages/db/src/demo-phones.ts`, exported from `@badabhai/db`
as `DEMO_PHONE_PATTERN`, `parseAllowPhones`, `isDemoWorkerPhone` and `E164_PATTERN`. The seed's
`--reset-live-worker` and the engine view (W4) both gate on it.

**Allow-list file format:**

- UTF-8 text, one E.164 number per line (`+` then 8–15 digits, no spaces);
- blank lines are ignored;
- `#` starts a comment;
- any other line makes the whole file fail closed, with an error naming the line number.

---

## Showcase personas

| Persona                                   | Phone           | Skills             | Story                                                                                               |
| ----------------------------------------- | --------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| ★ `showcase-welder-pune` (Ravi Demo)      | `+910000026001` | MIG welder, 48 mo  | What "welder" in the chat yields. MIG jobs direct; arc and TIG related; no machining or design jobs |
| ★ `showcase-fitter-manesar` (Suresh Demo) | `+910000026002` | fitter, 60 mo      | Maintenance-tech, plumbing and QC jobs related. Electrician jobs are seeded but **not** related     |
| `cnc-turner-pune`                         | `+910000026003` | CNC turner, 36 mo  | Side-by-side with a live CNC turner                                                                 |
| `cnc-operator-ahmedabad`                  | `+910000026004` | general CNC, 12 mo | Side-by-side with a live "CNC operator"                                                             |
| … 6 more                                  | `…005`–`…010`   | see the answer key |                                                                                                     |

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

- **Role kinds without a real match skill are skipped** (owner decision, 2026-10-06: a worker must
  never see an irrelevant job).
  - The vocabulary has 26 match skills and none for these 5 kinds, so they get **no demo
    postings**: `mould_die_maker` and the four plastics/rubber kinds.
  - The other 16 kinds post only their own real skills. Since #2022 that includes
    `industrial_electrician`, `maintenance_technician`, `assembly_line_worker`, `press_operator`,
    `painter_coating`, `sheet_metal_worker`, `tool_die_maker` and `conventional_machinist`, each
    under its own minted skill — never a "nearest" one (an electrician job is not a fitter job).
    Before #2022 those eight were skipped; no seeded posting ever carried a proxy skill.
  - General-CNC-operator postings (`mskill_cnc_operator_general`) use the `cnc_turner` card
    illustration. The role vocabulary has no general-CNC kind; the match skill itself is real.
  - Closing the gap is a taxonomy change.
- **Form onboarding** was fixed on main by #2019 (welder, grinding, VMC, CAM, CAD, fitter, QC)
  and #2022 (the other eight trade forms). Every shipped trade form now derives a real skill.
- **Seed-job conversion (`TRADE_TO_MATCH_SKILL`)** still lands `maintenance_technician` and
  `assembly_technician` on `mskill_fitter`. It is a one-time conversion of the ADR-0009 fixtures,
  not a runtime path, and is left unchanged by #2022; re-pointing it is a separate decision.
- **Carpenter and delivery rider** have match skills but no role kind, so they get no demo
  postings. A live "carpenter" sees 0.
