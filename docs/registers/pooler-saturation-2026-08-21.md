# `pool_size: 15` — what was actually saturating, measured

> **Investigation, 2026-08-21. Read-only throughout. No pool configuration was changed.**
>
> Owner instruction: *"Investigate the `pool_size: 15` observation separately. Determine whether
> the retries were caused by actual production pool exhaustion, concurrent read-only probes,
> Supabase pooler limits, or our tooling creating unnecessary concurrent connections. Don't change
> pool configuration based only on these observations."*

Across 2026-08-20/21 a series of read-only probes against production intermittently failed with
`EMAXCONNSESSION … pool_size: 15`, and the working assumption written into memory was "the pooler
saturates; back off rather than retrying in a loop". That is sound advice and it was never
diagnosed. This page diagnoses it.

---

## The four hypotheses, answered

| hypothesis | verdict |
|---|---|
| actual production pool exhaustion (Postgres) | **NO** |
| Supabase pooler limits | **YES — this is the ceiling** |
| concurrent read-only probes | **contributing, but marginal** |
| our tooling creating unnecessary connections | **YES — one place, and it is not the scripts** |

---

## 1. Postgres is nowhere near its limit

```
max_connections                 60
superuser_reserved_connections   3
PostgreSQL 17.6
```

Live sessions on the database at the time of measurement:

| | |
|---|---|
| total | **9** |
| active | 1 |
| idle | 7 |
| **idle in transaction** | **0** |
| owned by our role (`postgres`) | **3** — one of which was this probe |

By role: `supabase_admin` 4, `postgres` 3, `authenticator` 1, `pgbouncer` 1.

**Nine of sixty.** Whatever `pool_size: 15` refers to, it is not `max_connections`.

**And there is no connection leak.** The two oldest idle sessions are `pg_net` and `postgrest` at
~30 days — Supabase platform services that hold a connection for their lifetime, which is normal.
No long-lived `idle in transaction` session exists, which is the shape a leaked transaction from
our own tooling would take.

---

## 2. The ceiling is Supavisor's per-tenant session pool

The connection string points at **port 5432** on `…pooler.supabase.com`, which is Supavisor in
**session mode** (6543 is transaction mode). Four of the nine live sessions are Supavisor's own
(`Supavisor`, `Supavisor (auth_query)`).

In session mode each *client* connection is bound to a server connection for the life of that
client session, and `pool_size` is the number of client connections Supavisor will accept for this
tenant. **`pool_size: 15` is that number.** It is a property of the Supabase project's pooler
configuration, not of the database, which is why the database looks idle while clients are being
refused.

---

## 3. Our tooling — the scripts are innocent, and one server is not

This is the part worth acting on, and it is the opposite of what the memory note implied.

**Every one of the 57 `createDbClient` call sites in `packages/db` passes `{ max: 1 }`.** The
runners are already as frugal as they can be; a probe costs exactly one slot.

There are exactly two call sites that take the library default, and `client.ts` sets that default
to **10**:

| call site | pool | note |
|---|---|---|
| `apps/api/src/database/database.module.ts:28` | **default → up to 10** | the API server's own pool |
| `packages/db/src/client.ts:47` (`getDb()` singleton) | **default → up to 10** | documented as "CLI scripts/seeds only" |

**The API server can therefore claim up to 10 of the tenant's 15 client slots on its own** — two
thirds of the pooler — and that number was never chosen against the pooler's capacity. It is
`postgres.js`'s default, arrived at by omission.

That is the whole arithmetic: with the API holding up to 10, five slots remain for everything
else — migrations, adoption, audits, probes, `psql`, the Supabase dashboard. Two or three
concurrent read-only runs plus a dashboard tab is 15.

**Concurrent probes were the trigger, not the cause.** Each cost one slot, which is correct
behaviour; they were refused because the headroom was already spent. A run killed by a shell
`timeout` also leaves its socket to age out rather than closing cleanly, which narrows the window
further for a minute or two — worth knowing, and not the main term.

---

## What this changes about how to work

**Immediately, and requiring no configuration change:** serialise local probes against production,
and prefer one runner that answers several questions over several runners that each answer one.
Both `db:audit:undeclared-routines` and `db:report:oie-canonicalize-coverage` are already shaped
that way; that shape is now justified by a number rather than by taste.

The memory note ("the pooler saturates; back off") stays true and is now explained.

---

## Recommendations — NOT APPLIED

Per the instruction, nothing below was changed.

1. **Make the API's pool size explicit and sized against the pooler**, rather than inheriting a
   library default. The specific problem is not that 10 is wrong — it may well be right — but
   that no one chose it, and it is the single largest consumer of a 15-slot pool. Whatever the
   number becomes, it should be a named constant with the pooler's capacity in the comment beside
   it, so the next person changing either one sees the other.
2. **Consider transaction mode (port 6543) for the API.** It multiplexes many client connections
   over few server ones and would remove this ceiling almost entirely. It is **not a free swap**:
   transaction mode does not support session-scoped state, so prepared statements, `SET`,
   advisory locks and `LISTEN/NOTIFY` behave differently, and `postgres.js` needs
   `prepare: false`. That is a real change with a real test burden, and it is a decision, not a
   tweak.
3. **Raise `pool_size` only after (1).** Raising the pooler's limit while one process silently
   claims two thirds of it treats the symptom and loses the diagnosis.
4. **`getDb()`'s default deserves a second look** — its own docstring says "CLI scripts/seeds
   only", and every actual script bypasses it with `max: 1`. A default of 10 for a lazy singleton
   nothing uses at that size is a trap waiting for the next script that reaches for the
   convenience.

---

## How to re-measure

Everything on this page came from `pg_stat_activity` and `current_setting`, read-only. The
distinguishing question is always the same one: **is Postgres busy, or is the pooler full?** Nine
sessions against `max_connections = 60` while clients are being refused answers it immediately,
and answers it the same way every time until the pool arithmetic changes.

## Change log

| date | what |
|---|---|
| 2026-08-21 | Investigated read-only. Postgres: 9/60 sessions, 0 idle-in-transaction, no leak. The ceiling is Supavisor session-mode `pool_size = 15`. Root cause: `apps/api`'s pool takes the `postgres.js` default of 10 — two thirds of the tenant pool, chosen by omission — while all 57 `packages/db` call sites already pass `max: 1`. Concurrent probes were the trigger, not the cause. Nothing changed. |
