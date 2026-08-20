# #1110 — the routines nobody declared

> **Investigation, 2026-08-20. Read-only throughout. Nothing was removed, altered or created.**
>
> Owner instruction: *"Treat this as a security/schema-integrity investigation. Do not remove or
> modify anything until the blast radius and intended ownership are documented and tested."*
> This page is the documentation half; `db:audit:undeclared-routines` and its tests are the
> tested half.
>
> Re-run the measurement at any time:
> ```
> pnpm --filter @badabhai/db db:audit:undeclared-routines
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

## What is now tested

| | |
|---|---|
| `db:audit:undeclared-routines` | finds all six, separates ours from the platform's by owner, flags the SECURITY-DEFINER-plus-EXECUTE pair, and reports `_delete_forensics` by counts |
| `selectsAValueColumn` | refuses to run if any query in the tool projects `query` or `client_addr`; driven in both directions by a test |
| `audit-live-drift` | already reports the routines as undeclared; this tool adds ownership, privilege and content |
| `audit-rls` | the independent check that `ensure_rls`'s single-condition lock has not left anything open — 0 deviating today |

**Nothing above has been removed, altered or declared.** The three changes engineering would
recommend, in order of how cheap they are:

1. **REVOKE EXECUTE** from the Data-API roles on all three functions. One migration, no
   behaviour change, closes the only privilege finding here.
2. **Drop `query` from `_delete_forensics`** (or stop writing it), if the mechanism stays. It is
   the only column that can carry PII and the trail does not need it.
3. **Declare whatever stays** in a migration, so a fresh database has it and
   `db:audit:live-drift` stops reporting it.

Each needs the ownership answer first, which is the point of this page.

---

## Change log

| date | what |
|---|---|
| 2026-08-20 | Investigated read-only. Mechanisms, owners, privileges and blast radius documented; `db:audit:undeclared-routines` added so the measurement is a command. PII shapes measured: **0 phone-shaped, 0 email-shaped**, and none of the 35 quoted ten-digit literals is a bare mobile. |
