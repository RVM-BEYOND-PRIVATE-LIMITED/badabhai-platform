# Title-case backfill — employer name, role label, education field (#1432)

**Why this exists.** Since worker-app f55a020f, first shipped as the `worker-app-sha-f55a020` APK
release, the trade form title-cases `employer_name`, `role_label` and the education `field` before
it saves, so rows saved there arrive as "Recursive Global Infotech Pvt Ltd". Rows saved before that
fix are stuck as typed ("recursive global infotech pvt ltd"), and a worker has no screen that can
re-save them. This backfill brings every stored value to the value the app would have sent. It is
one-time only once every writer cases these fields; some still do not (see Residuals).

**What it does.** `packages/db/src/title-case-backfill.ts` (`db:backfill:title-case`) reads three
columns and applies the app's own rule, `titleCaseWords` in `@badabhai/validators`. That is an
exact port of `title_case.dart`. Its tests hold it to the app's own test cases and to a recording
of the app's function on the Dart VM over every Unicode scalar value.

| Column                                | Stored as                      | What the run does             |
| ------------------------------------- | ------------------------------ | ----------------------------- |
| `worker_employment.employer_name_enc` | AES-256-GCM token              | decrypt, case, **re-encrypt** |
| `worker_employment_role.role_label`   | text                           | case                          |
| `worker_education.field`              | text, nullable (nulls skipped) | case                          |

- **The rule only raises letters.** It uppercases the first letter of each whitespace-separated
  word and touches nothing else, so "RVM CAD" and "CNC Operator" stay byte-identical. It is **not**
  Postgres `INITCAP()`, which would print "Rvm Cad".
- **Dry run by default.** Without `--apply` nothing is written. The dry run does decrypt, because
  whether an employer name would change depends on its plaintext. It prints counts only, never a
  value.
- **`--apply` writes in batches**, one transaction per batch. Each update applies only if the row
  still holds the value that was read, so a row the worker re-saved mid-run is skipped and counted,
  never overwritten. A row that does not change is never written, so its `updated_at` stays put.
- **Idempotent.** A second run changes 0 rows. An interrupted run resumes by running it again.
- **A token that will not decrypt is skipped and counted**, and the run exits 1. The API already
  treats such a row as unreadable and leaves it alone; the backfill does the same.
- **The token it writes is the one the API would write.** With the keyring set it writes v2 under
  the active kid, otherwise legacy v1. A re-cased v1 row therefore moves onto the active kid, the
  same as when a worker re-saves it. The header and the summary say which, as
  `writes v2 (keyring armed, …)` or `writes v1 (legacy key, no keyring)`. The kid is never printed.
- **It will not write v2 under a key the API has not written with.** Before an `--apply` writes
  v2, the run decrypts a few tokens the API wrote under the active kid, from `workers.phone_e164`
  and `workers.full_name`. It never uses `employer_name_enc`, because this run writes that column,
  and a run with the wrong key would otherwise prove that key to every run after it. If no such
  token is under the kid, it refuses unless you pass `--keyring-is-newly-armed`. If any sampled
  token does not decrypt, it refuses whatever the flags. A dry run prints the same verdict as a
  WARN and exits 1. The check cannot see a wrong key that another ops runner (`db:reencrypt:pii`)
  also used, so step 3 reads back through the API.
- **No event and no audit row.** No `packages/db` runner writes either (`reencrypt-pii-backfill`,
  `retag-skills`): the process has no event pipeline and no actor to attribute the write to. The
  printed counts are the record, and step 4 says where to file them.

## Before you run it

- **Production needs the owner's explicit go-ahead.** The authorisation flags below make the write
  deliberate. They are not the approval.
- **Confirm a restorable backup or PITR window.** The run keeps no copy of the old casing, and the
  old value cannot be worked out from the new one ("Cnc Turner" could have been "cnc turner" or
  "Cnc turner"). The backup is the only rollback.
- **Use the API's exact PII configuration.** Set `PII_ENCRYPTION_KEY`, and set
  `PII_ENCRYPTION_KEYS` + `PII_ENCRYPTION_ACTIVE_KID` **if and only if the deployed API has them**.
  - A keyring the API lacks writes v2 tokens the API cannot read. Every re-cased employer would
    vanish from the résumé and the edit page. The pre-write check above refuses this case, but
    `--keyring-is-newly-armed` skips it, so pass that flag only when you know the API's keyring.
  - Missing a keyring the API has writes v1, which is readable but undoes rotation progress. Rows
    already stored as v2 show up as `undecryptable`.
  - **The root `.env` fills any gap the shell leaves.** The runner loads `../../.env`, and dotenv
    supplies every variable you did not export, including a dev keyring. The header says where the
    keyring came from (`from the shell` / `from the root .env, not the shell`).
- **Use the API's database role.** All three tables are FORCE row-level security with no policy, so
  only a superuser or BYPASSRLS role can see their rows. The runner refuses any other role rather
  than reporting "nothing to change".
- **Run from a tree equal to `origin/main`.**
- **Run the DB-backed suite on that tree first.** CI does not run
  `packages/db/src/title-case-backfill.db.test.ts`, and it is the only test of the write path. Its
  header gives the commands: a local scratch database, migrated from empty, never a shared one.
  Paste its `Tests … passed` line on #1432 with the commit it ran on. Do not apply on a red or
  skipped run.
- **Pick a read-back worker for step 3.** You need a worker account you can sign in as, whose
  employer name this run will re-case (the companion edit card stores one as typed). Note its
  `GET /workers/me/employment` response before step 2: the cased employer will be missing from
  `employments` afterwards if the write key is wrong.

Production is identified by `DATABASE_URL`. A dry run against it is allowed and announced. An
`--apply` against it also needs `--i-am-authorised-to-write-to-production` **and**
`OPS_ALLOW_PRODUCTION=backfill:title-case`.

## Steps

1. **Size it (read-only).**

   ```bash
   pnpm --filter @badabhai/db db:backfill:title-case
   ```

   Per column it prints `scanned / unchanged / change / undecryptable`, plus how many workers have
   at least one changing value. If `change` is 0 everywhere, stop.

   **Compare the write format with the API's environment.** The header and the summary print
   `employer names: writes v1 …` or `writes v2 …`. It must be v2 if the deployed API has
   `PII_ENCRYPTION_KEYS` set and v1 if it does not. If they disagree, fix the environment before
   going on, even when every count looks clean.

   If a line says `an --apply would refuse`, the key configuration does not match what is stored.
   That line is a WARN and makes the run exit 1. Fix the configuration; do not reach for the flag.

   If `undecryptable` is above 0, check the key configuration first. A wrong or missing keyring
   makes every row in that column undecryptable. The first 10 row ids per column are printed for
   investigation; values never are.

2. **Apply** (production: owner go-ahead + both authorisation signals).

   ```bash
   OPS_ALLOW_PRODUCTION=backfill:title-case \
     pnpm --filter @badabhai/db db:backfill:title-case --apply --i-am-authorised-to-write-to-production
   ```

   `written` should equal `planned`. Rows in `skipped` changed while the run was going; run step 2
   again to pick them up.

   To leave a column out (see Open questions), pass the columns to process, comma-separated:
   `--column=worker_employment.employer_name_enc,worker_education.field`.

   `--batch-size=<1..10000>` overrides the default of 500.

   `--keyring-is-newly-armed` is only for the case where the API was just armed with exactly this
   keyring and has not yet written under its active kid. Nothing then proves the key, so the flag
   is your statement that you have checked it against the API's environment. The employer names
   this run writes never count as proof, so every later run refuses again until the API itself
   writes under the kid (a sign-up or a name save). Do not pass the flag again without checking
   again.

3. **Verify — through the API, not by re-running.** A re-run of this runner cannot catch a wrong
   write key: it decrypts with the same keyring it wrote with, so its counts look clean either way.
   - **Read back through the API.** As the read-back worker, call `GET /workers/me/employment`
     (the app's work-history edit page). Expect the employer cased, in `employments`, and
     `unreadable_count` unchanged from before step 2.
   - **Watch the API log for other accounts.** Every such read logs
     `employment read for worker <id>: <n> readable, <m> unreadable`. A rise in `<m>` for any
     worker after step 2 is the same failure.
   - **If the employer is missing or `unreadable_count` rose,** the API does not hold the key this
     run wrote with. Do not re-run. Restore from the backup, or deploy the keyring the run used if
     that keyring is the intended one.
   - **Then run step 1 again.** Expect `change` to be 0 in every column, apart from rows saved
     uncased since step 2 (see Residuals), and `undecryptable` unchanged from step 1.

4. **Record it.** Paste both summaries (counts only) and the read-back result (the two
   `unreadable_count` values, no employer name) on #1432.

## Safe to re-run

Yes. The rule is idempotent and unchanged rows are never written, so a re-run touches only what
is still lowercase.

## Rollback

Code: nothing to roll back. There is no schema change, and the API reads the columns exactly as
before.

Data: restore from the backup or PITR confirmed above. The run itself keeps no undo record,
because that record would be a new place employer names are written.

## Residuals — not touched by this run

- **Rendered résumés.** `generated_resumes.resume_document` and `resume_text`, and the stored PDFs,
  keep the casing they were rendered with. The app's résumé tab reads `resume_document`.
  - **Employer names already print cased.** The renderer cases them at render time
    (`casedEmployer` in `apps/api/src/resume/resume-employment-rows.ts`).
  - **Role labels and education fields print as stored**, so résumés rendered before the run still
    show the old casing until the worker's next re-render.

  The "workers with at least one changed value" count sizes that set. Re-rendering is a separate
  decision; this run does not trigger one.

- **Staged résumé-import suggestions** (`worker_resume_import.suggestions_enc`) are inputs a worker
  has not accepted yet, not copies of these columns. They are left as parsed.
- **The interview profile** (`worker_profiles`: `education_field`, `experiences[].role`) is a
  separate, interview-derived source, not a copy of these columns. It is left as extracted.
- **An open companion edit card.** A card proposed before the run, over a row the run changed, may
  be refused as stale when the worker confirms it (`isStale` compares the stored `before` value).
  Nothing is written and the worker asks again.
  Cards expire after `CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS`.
- **Nothing derived lives in the same rows.** There is no blind index, search column or hash of
  any of the three values. The only other column a write moves is that row's `updated_at`, which
  nothing reads.
- **Writers that still store these fields uncased.** The API stores all three fields exactly as it
  receives them, and casing is a client-side rule. So lowercase rows keep arriving after this run,
  whatever the app adoption, from:
  - **The chat companion v2 edit card (server-side, live).** `normaliseValue` only trims
    `employer_name`, `role_label` and `education_field`
    (`apps/api/src/chat-companion/v2/edit-catalogue.ts`). `planEmployment`/`planQualifications`
    (`edit-plan.ts`) then write the value as the worker typed it.
  - **The worker app's finishing form** (`/finishing`, `finishing_models.dart`). It trims
    `employer_name` and `role_label` but does not case them.
  - **The worker app's extracted-review education form** (`/resume/review`,
    `extracted_review_screen.dart`). It trims `field` but does not case it.
  - **App builds older than the `worker-app-sha-f55a020` release.** Their trade form saves as typed.

  Re-running this backfill only catches up with them. The fix that makes it truly one-time is to
  case these fields on write in the API, with `titleCaseWords` from `@badabhai/validators`, in the
  employment and qualifications services every writer above goes through. That is a backend
  follow-up. For `role_label` it waits on the owner question below.

- **`Contract work`.** The renderer exempts this exact literal from its own casing
  (`SYSTEM_EMPLOYER_LABELS`). The app's rule has no such exemption, so a stored "Contract work"
  becomes "Contract Work" here, just as it does on a new save from the app.

## Open questions for the owner

- **Should `role_label` be in scope?** The issue asks for it, and the app's trade form has cased it
  since f55a020f. The API's own casing rule deliberately leaves role labels alone: "cnc turner"
  becomes "Cnc Turner", which reads as a misspelt trade (`resume-text-case.ts`). The backfill
  applies the app's rule. Use `--column=` to leave role labels out until this is decided.
