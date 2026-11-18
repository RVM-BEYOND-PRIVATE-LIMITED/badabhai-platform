# Moving RVM students in: the import CLI (#2887)

`apps/api/src/workers/import-campus-students.cli.ts` reads Campus's student export, bundle format v1 (RVMBeyond_jobportal `docs/api/student-export-bundle.md`, agreed on #2887). It moves each student into BadaBhai as a hidden, `pending` worker. The rules are in ADR-0067 §2.6.

## Before the first run

1. Migration `0182_student_move` is applied (Prakash).
2. `STUDENT_MOVE_ENABLED=true` is set for the API and for the shell that writes. A dry run needs neither.
3. The bundle folder holds `manifest.json`, `students.jsonl.enc` and `problems.jsonl.enc`, copied as Campus delivered them.
4. The passphrase arrives by its own channel. It goes ONLY in the environment variable `CAMPUS_EXPORT_PASSPHRASE`: never on the command line, in a file next to the bundle, or in a chat. The tool never prints it.

The shell also needs the API's database and PII settings: `DATABASE_URL`, `PII_ENCRYPTION_KEY` (or `PII_ENCRYPTION_KEYS` + `PII_ENCRYPTION_ACTIVE_KID`), `PII_HASH_PEPPER` and `PIN_PEPPER`. They must be the production values, or the phones and names are written under the wrong key and no student can sign in.

## 1. Dry run (always first)

```bash
pnpm --filter @badabhai/api build   # once, from a tree equal to origin/main
CAMPUS_EXPORT_PASSPHRASE='…' node apps/api/dist/workers/import-campus-students.cli.js \
  --bundle /secure/campus-students-2026-11-18 --report /secure/dry-run.json
```

This reads the bundle and the database and writes nothing. It prints:

- the totals: would create, update, leave unchanged, hold, plus bad lines;
- held students by reason;
- the problem list's kinds;
- every **unmapped** job role, domain, skill, CAD package and course, with how many students carry it.

The JSON file adds the per-student list, by Campus id only.

The owner rules on the unmapped list before the bulk run. A ruled value is one line in `campus-profile-mapping.ts`.

## 2. The bulk move

```bash
STUDENT_MOVE_ENABLED=true CAMPUS_EXPORT_PASSPHRASE='…' node apps/api/dist/workers/import-campus-students.cli.js \
  --bundle /secure/campus-students-2026-11-18 --apply --batch "bulk move 1" --report /secure/bulk-1.json
```

- Against production, the ops guard also needs `--i-am-authorised-to-write-to-production` and `OPS_ALLOW_PRODUCTION=import-campus-students`.
- The printed `batchId` is the run's id in `student_import_batches`. Keep it for a rollback.
- `--limit <n>` imports only the first n students. Use it for a first small run.

After the run every moved student is **hidden**: out of matching, and kept from companies by #2752's rules. An admin turns them visible with `PUT /admin/students/:workerId/visibility` or `POST /admin/students/visibility` (by batch, branch or course).

## 3. Nightly sync and weekly full run

- **Nightly:** Campus runs its export with `--since <previous manifest's next_since>`, and BadaBhai imports it with `--since`:

  ```bash
  … --bundle /secure/campus-since-2026-11-19 --since --apply --batch "nightly 2026-11-19"
  ```

  The tool refuses a `since` bundle without `--since`, and `--since` without a `since` bundle.

- **Weekly:** a full run, without `--since`, catches what a since export cannot: deleted rows, and students who left the RVM set.
- Re-running a bundle is safe. An unchanged record is `unchanged`.
- A changed record rewrites only the fields the student has not edited on BadaBhai.

## 4. Rollback

```bash
STUDENT_MOVE_ENABLED=true node apps/api/dist/workers/import-campus-students.cli.js --rollback <batch id>
```

- Removes every worker that run created who has **never signed in**. His profile, consent, markers and visibility go with him.
- A worker who signed in since is kept and listed.
- Updated students' changes are listed, not reverted.
- Running it again does nothing.

## What is held, and why

| Reason                                 | Meaning                                        | What to do                                                               |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `phone_missing`, `phone_not_mobile`    | no usable mobile                               | the placement team adds one on Campus                                    |
| `phone_shared`, `phone_company_number` | the phone is someone else's too                | the placement team resolves it; one phone is one person                  |
| `under_18`                             | Campus's date of birth says under 18           | not moved                                                                |
| `already_badabhai_worker`              | the phone already belongs to a BadaBhai worker | not moved; he is already on BadaBhai, and is never hidden or overwritten |
| `phone_changed`                        | his phone changed on Campus since he was moved | a login never moves without the person; resolve by hand                  |

A line Campus's schema refuses is reported with its line number and Campus id, and is never imported.
