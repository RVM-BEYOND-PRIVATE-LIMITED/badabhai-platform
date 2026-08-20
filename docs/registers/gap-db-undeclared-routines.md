# #1110 — the routines nobody declared

> **Investigation, 2026-08-20. Every measurement on this page is read-only. NOTHING HAS BEEN
> CHANGED ON PRODUCTION.**
>
> Owner instruction: *"Treat this as a security/schema-integrity investigation. Do not remove or
> modify anything until the blast radius and intended ownership are documented and tested."*
> Then: *"Open a focused PR with the recommended remediation, but do not apply it to production
> until I approve the final decision."*
>
> **Where that leaves things.** One remediation is written and unapplied — migration
> `0085_revoke_execute_undeclared_routines`, which takes EXECUTE away from the Data-API roles on
> the three SECURITY DEFINER functions and does nothing else. It has an effect verifier and a
> `--strict` command that proves whether it took. It has **not been applied**, and the four other
> recommended changes have not been written at all, because each of them needs an answer this
> page exists to ask for.
>
> Re-run the measurement, and the verdict, at any time:
> ```
> pnpm --filter @badabhai/db db:audit:undeclared-routines
> pnpm --filter @badabhai/db db:audit:undeclared-routines --strict   # exit 1 until 0085 lands
> ```

---

## What is there, and who put it there

Production runs **three functions, two table triggers and one event trigger** in `public` that
**no migration creates and no schema file describes**. Ownership is what separates them from the
platform's own objects:

| object | kind | owner | declared? | SECURITY DEFINER |
|---|---|---|---|---|
| `_log_delete()` | function (plpgsql) | **`postgres`** | no | **yes** |
| `_t_log_del_workers` | trigger on `workers` | **`postgres`** | no | (inherits) |
| `_t_log_del_worker_profiles` | trigger on `worker_profiles` | **`postgres`** | no | (inherits) |
| `rls_auto_enable()` | function (plpgsql) | **`postgres`** | no | **yes** |
| `ensure_rls` | event trigger, `ddl_command_end` | **`postgres`** | no | (inherits) |
| `is_active_payer_member(uuid)` | function (sql) | **`postgres`** | no | **yes** |

Six other event triggers exist (`pgrst_ddl_watch`, `issue_pg_cron_access`, …). All six are owned
by **`supabase_admin`** — the platform's, not ours, and out of scope.

**`postgres` is this project's own connection role.** So all six rows above were created with
this project's credentials, out of band, and nobody wrote them down. That is the ownership
question, and only a person can answer it.

---

## 1. `_delete_forensics` + `_log_delete` — a deletion audit trail, and a PII question

### The mechanism

```
DELETE on workers / worker_profiles
  -> AFTER DELETE FOR EACH ROW  ->  _log_delete()   [SECURITY DEFINER]
       -> INSERT INTO public._delete_forensics
            (txid, table_name, row_id, worker_id, db_user, app_name,
             client_addr, backend_pid, query)
```

`row_id` is `old.id`; `worker_id` is `old.id` on `workers` and `old.worker_id` elsewhere. Both
triggers are `AFTER DELETE FOR EACH ROW`, enabled (`tgenabled = 'O'`), and fire on every delete
including a cascade.

### What it is doing right

The table is **RLS enabled, FORCED, and holds zero grants to any Data-API role** — `0082` locked
it along with everything else. There is no exposure through PostgREST. It is a
provenance-and-reproducibility problem first.

### ⚠ Two columns are a privacy question, and they are the reason this is not just a drift item

**`query` stores `current_query()` — the whole statement text, verbatim.**

- A parameterised delete (`DELETE FROM workers WHERE id = $1`) carries no values.
- A hand-typed one (`DELETE FROM workers WHERE phone_e164 = '+91…'`) carries them **literally**,
  into a table that is an audit record and therefore **outlives the row it describes**.

That is a direct tension with the platform's own rule — *raw PII must never appear in logs,
events or audit records* — and it is worse than a log line, because a log rotates and this does
not.

**`client_addr` stores the client IP.** An IP address is personal data under DPDP. Capturing the
operator's IP on an admin deletion is defensible as security telemetry; capturing it without a
retention policy, a declaration, or anyone knowing it exists is not a decision anybody made.

### Measured: no PII is captured **today**, and that is a fact rather than a hope

`db:audit:undeclared-routines` counts how many rows match a shape and **never prints the text**.
Production, 2026-08-20, all 147 rows:

| shape | rows | reading |
|---|---|---|
| `+91` followed by ten digits | **0** | no E.164 phone number in any captured statement |
| an email-shaped string | **0** | no address either |
| a ten-digit run anywhere | **35** | on its own this fires on a pid, a txid or a digit run inside a uuid |
| a ten-digit run **inside a quoted literal** | **35** | a value somebody wrote into the statement |
| **a whole literal that is exactly a bare Indian mobile** (`'[6-9]\d{9}'`) | **0** | **none of the 35 is a phone number** |

The last row is the one that settles it. The 35 are ten-digit runs inside quoted literals whose
whole content is *not* a mobile number — consistent with uuid literals, which routinely carry a
run of ten or more digits. **Nothing phone- or email-shaped has been captured.**

**The risk is structural, not realised.** The column stores whatever the statement contains, so
"clean today" is a property of how deletes have happened so far (parameterised, by uuid), not a
property of the mechanism. One hand-typed `DELETE FROM workers WHERE phone_e164 = '+91…'` at a
console changes the answer permanently, and nothing would report it.

**The rule the tool follows, and why it is enforced rather than intended.**
`selectsAValueColumn` refuses to run if any query in the file projects `query` or `client_addr`,
and a test drives it in both directions — it passes for the shipped queries and fails for a
query that adds `query` to a SELECT list. A guard nobody has seen fail is not a guard, and a
tool written to investigate a possible PII leak must not become the second copy of it.

### Blast radius

| | |
|---|---|
| rows | **147** (workers **104**, worker_profiles **43**), 2026-08-13 10:44Z → 2026-08-19 13:01Z |
| write path | live and firing — the most recent row was one day old when read |
| every row carries | the full statement text (`current_query()`, up to **1069** chars here) and the client IP |
| exposure | **none today**: RLS enabled + FORCED + 0 Data-API grants |
| a fresh database | has **no** deletion forensics at all, and nothing reports the difference |
| anything that rewrites `workers` | fires a trigger it cannot see from the repository — a migration, a backfill or a bulk delete all pay for it, silently |

### What needs an answer

1. **Was it deliberate, and is it permanent?** 104 rows keyed to `workers` deletions is not
   incidental. A deletion audit trail on the PII table is the artifact a DPDP erasure question
   gets answered from.
2. **Is `query` meant to be there?** It is the only column that can carry PII, and the trail
   works without it — `txid`, `row_id`, `db_user`, `app_name` and `backend_pid` already identify
   the statement. It is clean today (measured above), and that is a property of how deletes have
   happened so far rather than of the mechanism: one hand-typed predicate changes it
   permanently. **This is the change engineering would recommend if the mechanism stays**, and
   it is deliberately not made here.
3. **What is the retention?** Rows about deleted workers accumulate with no policy. An erasure
   request that leaves a forensics row keyed to the erased worker's id is the awkward case.

---

## 2. `ensure_rls` — an event trigger that changes what `CREATE TABLE` means

### The mechanism

```
any CREATE TABLE / CREATE TABLE AS / SELECT INTO
  -> ddl_command_end  ->  rls_auto_enable()   [SECURITY DEFINER]
       -> for each created table in `public`:
            ALTER TABLE … ENABLE ROW LEVEL SECURITY
```

**It enables RLS and does nothing else.** No `FORCE`, no `REVOKE`. That single fact explains
GAP-DB-21 completely: `agency_profiles`, `employer_profiles`, `payer_capabilities` and
`payer_member_invites` were RLS-**enabled** and simultaneously **FORCE-less and granted to every
Data-API role**, which reads as half a lock applied by hand and is instead a whole mechanism
working exactly as written.

Since `service_role` has `rolbypassrls = true`, "RLS is on" was never the control on that role —
the grant was. So the event trigger produced tables that *looked* protected and were not.

### ⚠ It swallows every error

```sql
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
```

A failure is invisible outside the server log. A table created during a failure window is simply
unprotected, and nothing anywhere says so. `db:audit:rls` is the only thing that would ever
notice — which is an argument for that audit, not for this exception handler.

### Blast radius

| | |
|---|---|
| scope | every `CREATE TABLE` in `public`, forever, on production only |
| effect today | **0 tables are unlocked** — `relforcerowsecurity` is true on every table in `public` |
| a fresh database | does not have it, so a new table there is created with RLS **off**; the two environments diverge on the first `CREATE TABLE` |
| interaction with migration `0084` | none, and deliberately: `0084` states `ENABLE` + `FORCE` + four `REVOKE`s explicitly rather than relying on this trigger, which is why it produces the same locked state everywhere |

### What needs an answer

1. **Keep it?** It is a genuinely useful backstop — a table created out of band still gets RLS.
   If it stays, it should be declared in a migration so every environment has it.
2. **If it stays, should it FORCE and REVOKE too?** As written it delivers the *appearance* of a
   lock. The house posture is three conditions, and this implements one.
3. **The exception handler.** Swallowing `WHEN OTHERS` on a security control is the part that
   turns a backstop into a false assurance.

---

## 3. `is_active_payer_member(uuid)` — a policy helper for a policy that was never written

```sql
SELECT EXISTS (
  SELECT 1 FROM public.payer_members pm
  WHERE pm.payer_id = target_payer_id
    AND pm.user_id = auth.uid()
    AND pm.status = 'active'
);
```

`SECURITY DEFINER`, `STABLE`, owned by `postgres`.

**Nothing uses it.** `pg_policies` in `public` holds **zero rows** — there is not a single RLS
policy in the schema, by design: the posture is *enable + FORCE + REVOKE*, a total deny, and the
backend reaches the data as the owner. So this is a helper for a policy-based design that was
started and abandoned.

Note also that it reads `payer_members.user_id` and `auth.uid()` — **Supabase Auth**, which this
codebase does not use. Same lineage as `payer_member_invites`'s `auth.users` foreign key: both
are remnants of a Supabase-Auth-based design.

### Blast radius

| | |
|---|---|
| policies referencing it | **0** |
| callers in this repository | **0** |
| what it discloses if called | whether *the caller's own* `auth.uid()` is an active member of a given payer. For `anon`, `auth.uid()` is NULL, so it is always false |
| exposure | it holds `EXECUTE` for `anon`, `authenticated` and `service_role` — see below |

---

## The cross-cutting finding: SECURITY DEFINER + EXECUTE to the Data-API roles

**All three functions are `SECURITY DEFINER` and all three grant `EXECUTE` to `PUBLIC`, `anon`,
`authenticated` and `service_role`.**

```
_log_delete             =X/postgres | anon=X | authenticated=X | service_role=X
is_active_payer_member  =X/postgres | anon=X | authenticated=X | service_role=X
rls_auto_enable         =X/postgres | anon=X | authenticated=X | service_role=X
```

**This arrives by default, not by decision.** Postgres grants `EXECUTE` on new functions to
`PUBLIC` unless told otherwise, and Supabase's default privileges extend it to the Data-API
roles. Nobody chose it for any of these three.

**Severity today: low, and for reasons that are accidents rather than controls.**

| function | why calling it does nothing useful |
|---|---|
| `_log_delete` | a trigger function — Postgres refuses a direct call (`can only be called as a trigger`) |
| `rls_auto_enable` | calls `pg_event_trigger_ddl_commands()`, which errors outside an event trigger |
| `is_active_payer_member` | returns a boolean about the CALLER's own `auth.uid()`, and this codebase does not use Supabase Auth, so it is NULL |

Two of those three are protected by *what the function happens to do*, not by a privilege. The
posture everywhere else in this schema is `REVOKE` first and grant deliberately, and the
functions are the one surface where that has not been applied.

**The recommendation is `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated, service_role` on all
three** — and it is *not made here*, because a REVOKE is a modification and this investigation
was asked not to make one. It is a one-line-per-function migration whenever the owner says so.

---

## Provenance: where each of these actually came from — measured, 2026-08-20

The first version of this page said "somebody here did this and did not write it down" and left
it there. That was one query short. Two catalog facts date these objects without anybody having
to remember: **OIDs are assigned in creation order**, and Supabase records the schema snapshot it
was set up from in `supabase_migrations.schema_migrations`.

That table holds **exactly one row** — `20260624061908 remote_schema`, 97,366 characters, the
baseline this project's Supabase instance was created from. Searching its text settles which of
these objects predate this repository's migration history:

| object | in the 2026-06-24 baseline? | OID | sits between |
|---|---|---|---|
| `rls_auto_enable()` | **yes** | 17170 | before `worker_profiles` (17646) and `workers` (17664) |
| `ensure_rls` (event trigger) | **no** (see below) | 17171 | created immediately after its own function |
| `is_active_payer_member(uuid)` | **yes** | 18991 | after `workers`, before `payer_member_invites` (19297) |
| `_delete_forensics` | **no** | 30815 | after `payer_members` (20052), before `worker_feedback` (31355, migration 0080) |
| `_log_delete()` | **no** | 30824 | created immediately after its own table |

**Three distinct origins, not one.**

1. **`rls_auto_enable` + `ensure_rls` came with the Supabase baseline.** The function's OID
   (17170) is *below* `worker_profiles` and `workers` — it predates the earliest core tables, so
   it was there before this repository's first migration ran. The event trigger is absent from
   the snapshot text only because `supabase db pull` does not emit event triggers (they need
   superuser to dump); its OID is 17171, one above its own function, which is what "created in
   the same statement pair" looks like.
2. **`is_active_payer_member` came with the baseline too, and it has company.** Its OID sits
   directly below `payer_member_invites`, `employer_profiles`, `agency_profiles` and
   `payer_capabilities` — **the four GAP-DB-21 tables**, in one contiguous run. The policy helper
   and the four tables it was written for are a single abandoned Supabase-Auth payer-onboarding
   design, created together; #1143 modelled the tables without knowing the function was part of
   the same artifact. `auth.uid()` and `payer_member_invites.accepted_by_user_id`'s `auth.users`
   foreign key are the two visible ends of it.
3. **`_delete_forensics` + `_log_delete` are recent, and they are ours.** Absent from the
   baseline, OIDs between `payer_members` and `worker_feedback` (migration 0080), and the table's
   first row is dated **2026-08-13**. Somebody added a deletion trail this month.

### Who has actually been deleting

Every one of the 147 rows carries the same pair:

```
db_user = 'postgres'      app_name = 'supabase/dashboard'      147 / 147
```

**Not one delete came from the application.** They were all typed at the Supabase SQL editor, by
somebody holding this project's credentials, between 2026-08-13 and 2026-08-19 — and 95 of the
147 landed on **2026-08-19 alone** (70 `workers`, 25 `worker_profiles`). All 104 distinct
`worker_id`s are **gone** from `workers`; none is still live.

That answers a question the first pass could only speculate about. This is not a trail of
application behaviour. It is a trail of **console operations**, and it began on the day the
console operations began.

---

## The root cause is one setting, and it is still live

The three functions are not three mistakes. They are three instances of one default:

```
pg_default_acl:  grantor=postgres  schema=public  objtype=FUNCTION
                 {postgres=X, anon=X, authenticated=X, service_role=X}
```

`ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS GRANT EXECUTE` is in force for role `postgres` in
schema `public` — and it is **in the 2026-06-24 baseline**, so it came from Supabase's own setup
rather than from anybody here. **Every function created in `public` by `postgres` gets that
grant, forever, unless a REVOKE follows it.**

The same entry exists for tables:

```
pg_default_acl:  grantor=postgres  schema=public  objtype=TABLE
                 {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
```

**That is where GAP-DB-21 came from as well.** Four tables created out of band arrived with full
DML for all three Data-API roles, because that is what a `CREATE TABLE` in this schema *means*
here. `ensure_rls` then enabled RLS on them and nothing else, which is why they looked protected.
Two independent defaults, pulling the same direction.

The discipline works when it is applied: **78 of 78 public tables are ENABLED + FORCED with zero
Data-API grantees today**, because `0048`/`0082`/`0083`/`0084` each wrote their own REVOKE tail.
But that is 78 individual acts of remembering against a default that never forgets, and the
functions are where the remembering did not happen.

**This is why `--strict` is not scoped to the three known names.** A check that knew only
`_log_delete`, `rls_auto_enable` and `is_active_payer_member` would go green the day a fourth
function appears — which is this finding, repeated.

---

## Dependency closure — measured, all three

| | `_log_delete` | `rls_auto_enable` | `is_active_payer_member` |
|---|---|---|---|
| `pg_depend` dependents | 2 triggers (`_t_log_del_workers`, `_t_log_del_worker_profiles`) | 1 event trigger (`ensure_rls`) | **none** |
| RLS policies referencing it, **all schemas** | 0 | 0 | **0** |
| callers in this repository | 0 | 0 | **0** |
| `COMMENT ON` | none | none | none |

`pg_policies` holds **zero rows in every schema**, not only `public`. There is no policy anywhere
in this database, by design: the posture is enable + FORCE + REVOKE, a total deny, and the
backend reaches data as the owner. `is_active_payer_member` is therefore reachable by nothing at
all — no trigger, no policy, no code. It is the only one of the three that is genuinely inert.

`pg_stat_user_functions` returns no rows for any of the three: `track_functions` is off on this
cluster. Note what that does and does not prove — "no recorded calls" is not evidence of no
calls. The argument that these are uncallable in practice rests on what each function does, set
out above, and not on this.

---

## ⚠ `_log_delete` fires on the platform's own right-to-erasure path

This is the interaction that decides the retention question, and it is invisible from either side
alone.

The platform has a real, shipped DPDP right-to-erasure feature: `AccountDeletionService` →
`WorkersRepository.hardDelete` → `DELETE FROM workers WHERE id = $1` inside a transaction, with a
strict documented order (revoke sessions → delete storage objects → write the erasure-audit proof
→ hard delete → tombstone → emit event). It was designed with real care about what may survive:

| what the erasure deliberately keeps | form |
|---|---|
| the cool-down tombstone | Redis, keyed on the **PII-free `phone_hash`** blind index, with a TTL |
| the erasure-audit proof (TD58 / #712) | a row recording **what was erased**, keyed to the worker id |
| the `worker.account_deleted` event | counts and flags only, opaque `actor_id` |

`_log_delete` is an `AFTER DELETE FOR EACH ROW` trigger on `workers`. **It fires on that DELETE
too.** Nobody who designed the erasure knew it was there, and it writes a fourth record the
design never accounted for:

| | the designed residue | the `_delete_forensics` residue |
|---|---|---|
| declared | yes — in code, in tests, in an ADR | **no** |
| retention | TTL (tombstone) / a policy-bearing audit row | **none** |
| statement text | never | **`current_query()`, verbatim** |
| operator IP | never | **`client_addr`** |
| removed by the cascade | n/a | **no** — `worker_id` carries no foreign key |

**What this does not claim.** Retaining a worker's uuid past erasure is *already* the platform's
deliberate posture — the erasure-audit row does exactly that, on purpose, as the proof the
erasure happened. So `_delete_forensics` is not a new category of residue. What it adds is a
**second, undeclared copy** carrying **two fields the deliberate one deliberately omits**, with
no retention and no test.

**And it has not happened yet.** All 147 rows are `supabase/dashboard`; the application erasure
path has produced none. This is a statement about the *next* production erasure, not about damage
already done — which is exactly the window in which it is cheap to decide.

---

## Blast radius of each proposed change

Five changes are on the table. **One is written and unapplied; four are not written at all.**

### 1. REVOKE EXECUTE from the Data-API roles — WRITTEN as `0085`, NOT APPLIED

| | |
|---|---|
| what changes | 12 grants disappear: 3 functions × (`PUBLIC`, `anon`, `authenticated`, `service_role`) |
| what keeps working | everything. `postgres` retains its explicit `postgres=X/postgres`, and revoking from `PUBLIC` never touches an explicit grant to a named role |
| the triggers | `_log_delete` fires for whoever runs the DELETE, `rls_auto_enable` for whoever runs the DDL. On this database that is `postgres` in **147 of 147** recorded cases, and the backend's erasure path connects as `postgres` too. Measured, not assumed |
| reversible | fully — one `GRANT EXECUTE ON FUNCTION … TO …` restores it |
| on a fresh database | **nothing.** `to_regprocedure` returns NULL for all three and each loop iteration skips with a NOTICE. The migration is production-only in effect, stated in its own header rather than discovered later |
| how you know it took | `db:audit:undeclared-routines --strict` — **exit 1 naming all three today, exit 0 after**. Adoption re-checks the same 12 facts from the catalog and currently refuses 0085 with 12 mismatches |
| what it does **not** fix | the default privilege that created all 12. A fourth function gets the same grant the day it is created |

### 2. Drop `_delete_forensics.query` — NOT WRITTEN

| | |
|---|---|
| what changes | the one column that can carry raw PII into an audit record stops existing |
| what is lost | the statement text. `txid`, `row_id`, `worker_id`, `db_user`, `app_name` and `backend_pid` remain, which identify **who, what and in which transaction**; the text answers only *how it was phrased*, and nothing in this repository reads it |
| irreversible | **yes.** Dropping the column destroys 147 rows of existing text, and no backup of this table is declared anywhere |
| measured risk today | 0 phone-shaped, 0 email-shaped, and none of the 35 quoted ten-digit literals is a bare Indian mobile |
| why still recommended | "clean today" is a property of how deletes have happened so far — parameterised, or by uuid at a console. One hand-typed `WHERE phone_e164 = '+91…'` changes it permanently and nothing would report it |
| the cheaper alternative | stop *writing* it (`CREATE OR REPLACE FUNCTION _log_delete` minus the column) and leave the existing 147 values under a retention policy. Reversible, and it caps exposure at what already exists |

### 3. Declare whatever stays — NOT WRITTEN

| | |
|---|---|
| what changes | a migration creates the surviving objects, so a fresh database has them and `db:audit:live-drift` stops reporting them |
| blocked on | the ownership answer. Declaring a mechanism is endorsing it, and #1110 was scoped not to endorse anything |
| ⚠ the trap | `declaredRoutines` scans migrations for `CREATE FUNCTION` / `CREATE TRIGGER`. **The moment any migration writes one of these three names in a CREATE, the drift audit goes green** and the open question closes without anybody deciding it. `0085` names all three in REVOKEs only, and a test pins that they are still undeclared afterwards |
| if `ensure_rls` stays | it should also FORCE and REVOKE, and its `EXCEPTION WHEN OTHERS` should go. As written it delivers one of the three conditions a lock needs, and swallows its own failures into the server log |

### 4. Change the default privileges — NOT WRITTEN, and the largest of the five

| | |
|---|---|
| what changes | `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM …` (and the same for TABLES) would stop new objects arriving pre-granted |
| blast radius | **every future `CREATE FUNCTION` and `CREATE TABLE` in `public`.** That is the point, and also why it is not a patch |
| what would break | anything reaching these tables through PostgREST as `anon`/`authenticated`/`service_role`. Today that is **nothing** — 78 of 78 tables already grant those roles zero privileges and the backend connects as `postgres` — but it changes what a Supabase feature enabled later would find |
| the argument for | it is the generator. Without it every migration author is one forgotten REVOKE tail away from repeating GAP-DB-21, and `0048` already demonstrated exactly that failure |
| the argument against | it diverges from Supabase's platform convention, and a future maintainer who expects the convention gets a confusing permission error rather than a clear one |
| the cheap middle | leave the default alone and keep `--strict` as the standing check, so a fourth exposed function is *reported* rather than prevented |

### 5. A retention policy for `_delete_forensics` — NOT WRITTEN

| | |
|---|---|
| current state | 147 rows, 160 kB, primary key on `id` only, **no index on `at`**, no TTL, no sweep, no declaration |
| growth | console-driven, so bounded by how often somebody deletes by hand — 95 rows on the busiest day so far |
| the awkward case | an erasure request that leaves a row keyed to the erased worker's id. Already the deliberate posture for the erasure-audit row, and **not** deliberate here |
| what a policy must say | how long a deletion record is kept, whether the statement text is kept for that whole period, and what removes it |
| note | any age-based sweep will want an index on `at`; there is none today |

---

## What is now tested

| | |
|---|---|
| `db:audit:undeclared-routines` | finds all six, separates ours from the platform's by owner, flags the SECURITY-DEFINER-plus-EXECUTE pair, and reports `_delete_forensics` by counts |
| `db:audit:undeclared-routines --strict` | the **verdict**: exit 1 while any function we own is SECURITY DEFINER *and* Data-API executable, exit 0 once it is not. Not scoped to the three known names — a fourth would fail it too |
| `selectsAValueColumn` | refuses to run if any query in the tool projects `query` or `client_addr`; driven in both directions by a test |
| the `0085` effect verifier | re-checks the same 12 grants from the catalog at adoption time. Run against production today it reports **12 mismatches and refuses** — the property that a verifier must be able to fail |
| the drift-parser trap | a test asserts all three functions are still **undeclared** after `0085` lands, so a REVOKE-only migration cannot quietly turn the drift audit green |
| `audit-live-drift` | already reports the routines as undeclared; this tool adds ownership, privilege and content |
| `audit-rls` | the independent check that `ensure_rls`'s single-condition lock has not left anything open — 0 deviating today |

**Nothing has been removed, altered or declared, and `0085` has not been applied.** The five
changes engineering recommends, and their exact blast radius, are the section above. In short:

1. **REVOKE EXECUTE** from the Data-API roles on all three functions — **written as `0085`,
   awaiting approval.** No behaviour change; closes the privilege finding; fully reversible.
2. **Drop `query` from `_delete_forensics`** (or stop writing it), if the mechanism stays. The
   only column that can carry PII, and the trail does not need it. **Irreversible** — prefer
   "stop writing it" if the answer is not yet certain.
3. **Declare whatever stays**, so a fresh database has it and the drift audit stops reporting it.
4. **Decide about the default privileges** — the generator behind both this finding and
   GAP-DB-21. The largest change of the five, and the only one that prevents a recurrence.
5. **Write a retention policy for `_delete_forensics`**, which today has none.

Items 2–5 need the ownership answer first, which is the point of this page. **Item 1 does not**:
it removes a privilege nobody chose, that nothing uses, on functions two of which cannot be
called at all.

### The three questions only an owner can answer

1. **Was the deletion trail deliberate, and is it permanent?** It records console operations and
   nothing else — 147 of 147 rows are `supabase/dashboard`, all within the last week.
2. **Should the statement text and the client IP stay?** They are the two fields the platform's
   own erasure design deliberately does not keep.
3. **What is the retention?** There is none today, and the next application erasure will leave a
   row behind.

---

## Change log

| date | what |
|---|---|
| 2026-08-20 | Investigated read-only. Mechanisms, owners, privileges and blast radius documented; `db:audit:undeclared-routines` added so the measurement is a command. PII shapes measured: **0 phone-shaped, 0 email-shaped**, and none of the 35 quoted ten-digit literals is a bare mobile. |
| 2026-08-20 | **Provenance measured** rather than guessed: the Supabase 2026-06-24 `remote_schema` baseline contains `rls_auto_enable` and `is_active_payer_member` but **not** `_log_delete` or `_delete_forensics`, and OID ordering dates all five. Three distinct origins, not one. `is_active_payer_member` shares a contiguous OID run with the four GAP-DB-21 tables — one abandoned Supabase-Auth design. |
| 2026-08-20 | **Root cause named**: `ALTER DEFAULT PRIVILEGES … ON FUNCTIONS GRANT EXECUTE`, live for `postgres` in `public` and part of the same baseline. The three exposed functions are three instances of one default; the equivalent TABLE entry is where GAP-DB-21's grants came from. |
| 2026-08-20 | **Deletion source measured**: 147/147 rows `db_user=postgres`, `app_name=supabase/dashboard`; 95 on 2026-08-19 alone; 104 distinct worker ids, **0 still live**. Not one delete came from the application. |
| 2026-08-20 | **Erasure interaction found**: `_log_delete` fires on `WorkersRepository.hardDelete`, the DPDP right-to-erasure path, and writes a fourth residue record the erasure design never accounted for. Has not yet occurred in production. |
| 2026-08-20 | Migration **`0085_revoke_execute_undeclared_routines` written and NOT applied**, with an effect verifier, a `--strict` verdict, and a test that keeps the drift audit honest. Verified read-only against production: adoption refuses it with 12 mismatches, `--strict` exits 1. |
