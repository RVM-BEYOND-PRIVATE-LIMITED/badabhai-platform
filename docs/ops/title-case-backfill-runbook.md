# Title-case backfill — employer name, role label, education field (#1432)

**Why this exists.** Since worker-app f55a020f, first shipped as the `worker-app-sha-f55a020` APK
release, the trade form title-cases `employer_name`, `role_label` and the education `field` before
it saves, so rows saved there arrive as "Recursive Global Infotech Pvt Ltd". Rows saved before that
fix are stuck as typed ("recursive global infotech pvt ltd"), and a worker has no screen that can
re-save them. This backfill brings every stored value to the value the app would have sent.

**One-time, column by column (#1940).** Since #1940 the API cases `employer_name` and the
education `field` on every write, whichever client sent them. So for those two columns, one run
after the #1940 deploy catches up everything stored before it, and nothing new arrives uncased.
`role_label` is still stored exactly as received, because casing it is an open owner question (see
Open questions). See "When to run it" and Residuals.

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
  employer name this run will re-case. That has to be a name saved uncased before #1940 deployed:
  since then the API cases every employer name it stores, so a new save cannot give you one. Note its
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
   - **Then run step 1 again.** Expect `change` to be 0 in every column you processed, and
     `undecryptable` unchanged from step 1. On a build with #1940, a non-zero count is expected
     only for `role_label`, from rows saved uncased since step 2 (see Residuals). A non-zero count
     for an employer name or an education field means a writer bypassed the API's casing:
     investigate it rather than re-running.

4. **Record it.** Paste both summaries (counts only) and the read-back result (the two
   `unreadable_count` values, no employer name) on #1432.

## Safe to re-run

Yes. The rule is idempotent and unchanged rows are never written, so a re-run touches only what
is still lowercase.

## When to run it

- **Once after the #1940 deploy, for the two columns the API now cases.** Rows saved between the
  first run and that deploy were stored as received. Run steps 1–4 with
  `--column=worker_employment.employer_name_enc,worker_education.field`. After that, those two
  columns need no further runs. Every writer stores the value this run would write, with the same
  `titleCaseWords`, so a later run of step 1 reports `change` 0 for both.
- **`role_label` only after the owner rules on it** (see Open questions). Until the API cases it
  on write too, a run catches up only to that moment, and uncased role labels keep arriving behind
  it.

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
  Cards expire after `CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS`. Since #1940, a card proposed after
  the run holds the cased value as its `before`, and its `after` is already the cased value the
  writer will store. So a run has nothing left to change under it.
- **Nothing derived lives in the same rows.** There is no blind index, search column or hash of
  any of the three values. The only other column a write moves is that row's `updated_at`, which
  nothing reads.
- **Writers that send these fields uncased (#1940).** Only the app's trade form cases on the
  client. These writers send the value as typed:
  - **The chat companion v2 edit card** (server-side).
  - **The worker app's finishing form** (`/finishing`, `finishing_models.dart`). It trims
    `employer_name` and `role_label` but does not case them.
  - **The worker app's extracted-review education form** (`/resume/review`,
    `extracted_review_screen.dart`). It trims `field` but does not case it.
  - **An extracted-profile correction** (`POST /profile/corrections`, the education list).
  - **App builds older than the `worker-app-sha-f55a020` release.** Their trade form saves as typed.

  **Employer names and education fields: closed by #1940.** The API cases them on write, with
  `titleCaseWords`, before anything is stored. `WorkerEmploymentService.replaceForWorker` cases the
  employer name before encrypting it, and `WorkerQualificationsService.replaceForWorker` cases the
  education field. Every writer above goes through one of those two services, and nothing else
  writes either column. The rule lives in `apps/api/src/profiles/title-case-on-write.ts`. The
  companion card's `normaliseValue` reads the same rule, so a card shows the value that will be
  stored.
  - **Side effect.** A save re-sends the whole history (employment) or the whole list
    (educations), so it also cases any older uncased value riding along in it. That is the same
    value this run would write.
  - **`role_label` is still uncased.** The API stores role labels exactly as received, so every
    writer above except the trade form still sends them uncased. This waits on the owner question
    below.

- **`Contract work`.** The renderer exempts this exact literal from its own casing
  (`SYSTEM_EMPLOYER_LABELS`). The app's rule has no such exemption, so a stored "Contract work"
  becomes "Contract Work" here, just as it does on a new save from the app.
  - Since #1940 the API stores "Contract Work" on every new save too. So the renderer's exemption
    only matches rows that are both older than #1940 and not yet backfilled. The API does not
    exempt the literal on write, because this run would then re-case every such row each time it
    runs.

## Open questions for the owner

- **Should `role_label` be in scope?** The issue asks for it, and the app's trade form has cased it
  since f55a020f. The API's own casing rule deliberately leaves role labels alone: "cnc turner"
  becomes "Cnc Turner", which reads as a misspelt trade (`resume-text-case.ts`). The backfill
  applies the app's rule. Use `--column=` to leave role labels out until this is decided.
  - If it is ruled in scope, the API's write-time casing needs the same change, in
    `title-case-on-write.ts` and the employment service (#1940 left both alone on purpose).
    Without it, this run is never one-time for role labels.
