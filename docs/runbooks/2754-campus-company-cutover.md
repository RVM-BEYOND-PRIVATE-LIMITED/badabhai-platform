# Runbook: move companies from Campus to BadaBhai (#2754)

**Who:** the owner runs every production step (D15). The placement team resolves the exception
list. The Campus team runs the Campus side (RVMBeyond_jobportal#156 and #160).

**What moves:** each company's account, its live jobs, the applicants of those jobs (with their
stage), the contacts it had already opened, and its unused CV views as credits. The tool is
`apps/api/src/payers/import-campus-companies.cli.ts`. It reads Campus's export bundle (format v1,
`docs/api/company-export-bundle.md` in the jobportal repo), never the Campus database.

**What the tool never does:** print or store a name, phone, email or GSTIN. Its printouts and
report files carry Campus ids, BadaBhai ids, counts and reason codes only. The bundle itself does
carry personal data, so it lives only in a private folder and is deleted after the move.

## The five modes

| Mode | Command (after `pnpm --filter @badabhai/api build`) | Writes? |
|---|---|---|
| Dry run | `node apps/api/dist/payers/import-campus-companies.cli.js --bundle <folder> [--plan-quota <file>]` | No |
| Apply | `… --bundle <folder> --apply --batch <key> --run-by <name> [flags below]` | Yes |
| Report | `… --report --batch <key> --bundle <same folder> [--out <empty folder>]` | No |
| Rollback | `… --rollback --batch <key> --run-by <name>` | Yes |
| Notify (#2787) | `… --notify --batch <key> --signin-url <address> [--send --run-by <name>] [--sms-template-id <id>]` | Only with `--send` |

Apply flags:

- `--test` marks every placed company a test account (`pilot_test`). Use it for the dummy-company
  pilot. `--rehearsal` does the same with reason `rehearsal`.
- `--agents <file>` is a JSON array of Campus company ids the placement team named as agencies or
  contractors.
- `--plan-quota <file>` is a JSON object of Campus plan code to CV-view quota. It is used only for
  plans paid for and never posted against. A plan code missing from it becomes an exception; the
  tool never guesses.
- `--credit-validity-days <30–365>` (default 30). Bundle v1 carries no plan expiry.
- `--worker-hold-live` turns on the jobs and applications steps. See the precondition below.

A write to production also needs `--i-am-authorised-to-write-to-production` **and**
`OPS_ALLOW_PRODUCTION=import-campus-companies`. The shell needs the API's production `DATABASE_URL`,
`PII_ENCRYPTION_KEY` (or the key ring), `PII_HASH_PEPPER` and the rest of the server config. Use
the production values, or phones are hashed under the wrong pepper and no company can sign in by
phone.

Notify flags (#2787), after a clean report:

- Without `--send` it is a preview: counts of what would go out per channel, nothing sent.
- `--signin-url` is the company sign-in address on BadaBhai (payer-web), printed in the email. It
  must be `https`.
- `--sms-template-id` is the Fast2SMS id of the APPROVED welcome template. Without it every SMS is
  skipped as `template_missing`; email still goes. Only a proven phone gets an SMS.
- Each company is told once per channel, ever (`company_import_notices`). Running it again sends
  only what failed or was skipped before, so pass the template id later and run it again to send
  the SMS. Exit 2 when any delivery failed: run it again.
- It needs migration `company_import_notices` applied, and an `applied` batch.

**Batch keys:** lower-case letters, digits and dashes, for example `pilot-1` or `cutover-1`. Each
key binds to one bundle (its manifest sha256) and one `--test` setting. Running the same key again
over the same bundle resumes it and adds nothing twice. A rolled-back key is spent.

## Before the day

Every line must be true. Write down who checked it.

1. **Migrations** `0182_student_move`, `0183_company_import` and `0184_job_posting_worker_visibility`
   are applied **and recorded**. Check it with the read-only workflow (it should show all three
   recorded, with no hash mismatch):

   ```bash
   gh workflow run owner-db-ledger.yml -R RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform \
     -f tags=0182_student_move,0183_company_import,0184_job_posting_worker_visibility \
     -f mode=verify -f expect_host=aws-1-ap-south-1.pooler.supabase.com
   ```

2. **The deployed API holds imported jobs back from workers.** `--worker-hold-live` is allowed only
   when the production build contains #2903. Read `build` from
   `https://52-66-102-53.sslip.io/health`, then run:

   ```bash
   git fetch origin && git merge-base --is-ancestor fdabdc17b4167deaaf26f3c297fb1ffba797ec78 <build sha> && echo ok
   ```

   Without `ok`, do not pass the flag. A moved job could otherwise reach BadaBhai workers.
3. **The deployed API contains the whole import** (#2904, #2907, #2908, #2915, #2916, #2917). Build the
   CLI from a tree equal to that build.
4. **Shared phones are resolved.** Run the read-only
   `pnpm --filter @badabhai/api report:shared-payer-phones`. The placement team decides each group
   by hand. A phone two BadaBhai accounts share stops that company with `phone_shared_on_badabhai`.
5. **The owner has decided:**
   - the plan-quota file;
   - the agents list;
   - the credit validity (30 days unless ruled otherwise);
   - the sign-in change for companies (SMS needs its DLT template; e-mail sign-in stays for
     companies with no usable phone).
6. **The Campus side is ready:**
   - the freeze;
   - the final export (#156);
   - the sign-in redirect and plans-off switch (#160).
7. **Payments are ready** on BadaBhai (#2749).
8. **Rehearsed.** The local rehearsal (next section) has passed on the current build, and the
   dummy-company pilot has passed on production.

## Rehearsal on the local stack

On a throwaway local database migrated to `origin/main`, never production:

```bash
CLI="node apps/api/dist/payers/import-campus-companies.cli.js"
$CLI --write-synthetic /tmp/rehearsal-bundle --companies 3 --seed rehearsal-1
$CLI --bundle /tmp/rehearsal-bundle                                   # dry run
$CLI --bundle /tmp/rehearsal-bundle --apply --batch rehearsal-1 --run-by <name> --rehearsal --worker-hold-live
$CLI --report --batch rehearsal-1 --bundle /tmp/rehearsal-bundle --out /tmp/rehearsal-report-1
$CLI --rollback --batch rehearsal-1 --run-by <name>
$CLI --report --batch rehearsal-1 --bundle /tmp/rehearsal-bundle --out /tmp/rehearsal-report-2
```

**Pass:**

- the first report exits 0, or exits 2 only for differences you can explain;
- the rollback prints the accounts archived, the postings closed and the credits taken back;
- the second report shows 0 companies on BadaBhai and 0 credits.

The DB gate `campus-company-import.db.test.ts` runs the same round trip and checks that the counts
return to their starting values.

## Pilot: our own dummy companies (ruling of 17 Nov 2026)

1. Write a synthetic bundle with real team phones, so SMS codes reach us:
   `--write-synthetic <folder> --companies 3 --seed pilot-1 --phones team-phones.json` (a JSON array
   of 10-digit numbers).
2. Apply it on production with `--test` under batch `pilot-1`.
3. Run the report.
4. Each team member signs in on the payer app with their phone, then checks:
   - the moved live job, held from workers;
   - its applicants;
   - the converted credits.
5. Turn the job's worker visibility on and off from the admin portal (#2891).
6. Send the first sign-in message (#2787): `--notify --batch pilot-1 --signin-url <address>`, then
   the same with `--send --run-by <name>`. Synthetic e-mails end in `.invalid` and are skipped; give
   the bundle real team e-mails to read the message. Check it reaches each team member.
7. Roll back `pilot-1`, then run the report again.

## The day, in order

1. **Freeze** company writes on Campus (Campus team, #156).
2. **Final export.** The Campus team writes the bundle and hands it over through the agreed private
   channel. Copy it, unchanged, into a private folder on the machine that runs the CLI.
3. **Dry run** on the bundle. Read the totals and the exceptions per company. The placement team
   takes the exception list. Stop if a count is far from what Campus shows.
4. **Apply:**

   ```bash
   OPS_ALLOW_PRODUCTION=import-campus-companies $CLI --bundle <folder> --apply --batch cutover-1 \
     --run-by <name> --worker-hold-live --plan-quota <file> --agents <file> \
     --i-am-authorised-to-write-to-production
   ```

   The order inside one run is companies, balances, jobs, then applications. It ends with
   `batch cutover-1 applied`. If it stops part-way, run the same command again: it continues and
   adds nothing twice.
5. **Report:** `--report --batch cutover-1 --bundle <folder> --out <empty private folder>`.
   - Exit 0: go on.
   - Exit 2: read `differences.csv` where `explained=false`, and decide **before** step 6. An
     unexplained difference is a rollback trigger.
   - `explained=true` rows are the placement team's work list (for example, an applicant held for
     consent, or a company kept back by a shared phone). They are not failures.
6. **Switch Campus:** sign-in redirect on and plans off (Campus team, #156 and #160).
7. **Payments on** in BadaBhai (#2749).
8. **First sign-in messages** to the moved companies (#2787):

   ```bash
   $CLI --notify --batch cutover-1 --signin-url <address>            # preview
   OPS_ALLOW_PRODUCTION=import-campus-companies $CLI --notify --send --batch cutover-1 \
     --run-by <name> --signin-url <address> [--sms-template-id <approved id>] \
     --i-am-authorised-to-write-to-production
   ```

   Exit 2: some deliveries failed; run the `--send` command again. It never messages a company twice
   on the same channel.
9. **Delete the bundle.** Keep the report files privately; they hold no personal data.

## Watch, first hours

- Company sign-ins: successes and failures, by phone and by e-mail.
- Payment failures.
- Admin portal: imported jobs held from workers until an admin opens them (#2891).
- Run the report again at the end of the day. It must not show new unexplained differences.

## Roll back when

- sign-in failures pass the share agreed with the owner before the day;
- the report shows an unexplained difference that cannot be fixed forward;
- payments fail.

## Rollback steps

1. **Campus first:** sign-in and plans back on (Campus team). Campus is the record again from this
   moment.
2. **BadaBhai:**

   ```bash
   OPS_ALLOW_PRODUCTION=import-campus-companies $CLI --rollback --batch cutover-1 --run-by <name> \
     --i-am-authorised-to-write-to-production
   ```

   Record by record, it:
   - ends the contacts the import opened;
   - removes the applications it moved, with their Campus record and stage;
   - closes its postings (`job_posting.closed`);
   - takes back what each converted lot still holds (`campus_conversion_reversed`);
   - archives the accounts it created (`payer.archived`).

   It keeps:
   - accounts that existed before the move (it only matched them);
   - accounts in use on their own: a posting of their own, or a paid order. The count is printed.
     Look at each one;
   - credits already spent, which stay spent. The count is printed.

   If it stops, run it again: it continues. A finished rollback prints "already rolled back".
3. **Confirm:** run the report again. It should show no company on BadaBhai and no converted
   credits for the batch.
4. A later attempt needs a **new batch key**. A company archived by the rollback then shows as
   `matched_account_archived` and needs a person to decide.

## Not in this runbook

- Welcome credits on move day (#2754 item 10) follow #2750's rule. They are a separate step.
- The money defaults and seller details are kept in the private notes, not in this repository.
