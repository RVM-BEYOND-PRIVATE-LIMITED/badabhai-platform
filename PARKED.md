# PARKED

Real problems found during a build phase that were **not** in that phase's scope.
Recorded, not fixed. Each entry carries a file and a line.

---

## P-001 · Prettier silently corrupts markdown fill-in lines and never converges

**Found:** 2026-09, while producing `docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md`
**Location:** [package.json](package.json) line 12 — `"format": "prettier --write \"**/*.{ts,tsx,js,jsx,json,md,yml,yaml}\""` and line 13 `format:check`
**Severity:** low blast radius today, but silent and repeating

**What happens.** A markdown line containing a long run of underscores — the normal way to
write a signature or fill-in line —

```
Signed (RVM): ____________________  Date: __________
```

is parsed by Prettier as emphasis/strong delimiters and rewritten to garbage
(`**********\_\_**********`). It also corrupts bare `MASTER_CONTEXT` into
`MASTER*CONTEXT`. Worse, **the transformation is not idempotent**: each
`prettier --write` produces different output, so `pnpm format:check` can never pass on
such a file. Measured by writing twice and diffing — 36 differing lines between pass 1 and
pass 2.

**Why it matters.** Any signature sheet, decision record, or fill-in form committed as
`.md` will be mangled the first time anyone runs `pnpm format`, and will then fail
`format:check` permanently with no obvious cause.

**Workaround used** (not a fix): put fill-in and signature lines inside fenced code
blocks, and backtick any bare identifier containing underscores.

**Not fixed because:** the repo-wide fix is either a `.prettierignore` entry for
`docs/**/*.md` or a prose-wrap policy change, and both are formatting-policy decisions
outside this task's scope. Note the existing constraint that there is **no
`.prettierignore` today**, so `pnpm format` already reformats the drizzle migration
snapshots — any change here should be made deliberately, not as a side effect.

---

## P-002 · No `matching_catalog.published` event — the event catalog is frozen

**Found:** 2026-09-02, phase P1 (`matching_catalog`)
**Location:** [apps/api/src/match/matching-catalog.service.ts](apps/api/src/match/matching-catalog.service.ts) `publish()` — the point where a sibling service would emit
**Owner ruling:** parked by Prakash, 2026-09-02

**What is missing.** Every important business action emits a validated event
(engineering contract §3, "Event First"). Publishing a matching catalog is one: it
changes, platform-wide, which workers are visible for which jobs. The sibling path
emits `pricing.changed` on exactly the analogous write.

**Why it is not built.** The event schema is frozen under ADR-0014 with CEO signature.
Additive or not, a new event type is a change to a frozen catalog, and that is not an
engineering decision to make inside a build phase.

**What ships instead.** The publish path logs the new revision at INFO
(`MatchingCatalogService`) and the row itself is the durable record — `revision` is
unique and never reused, `updated_by` and `updated_at` are stamped, and no revision is
ever deleted. So the audit trail exists in the table; what is missing is the
_notification_, not the record.

**The specific thing to watch for.** No consumer needs cache invalidation on publish
today, because nothing reads `matching_catalog` yet — P2's tier resolver is the first
consumer and is not built. **If a consumer caches the active catalog, this stops being
a documentation gap and becomes a correctness bug**: a published revision would not
take effect until restart, with no signal that it had not. The standing instruction is
to HALT and raise it rather than work around it, because a cache that needs
invalidation changes the answer on whether the event is optional.
