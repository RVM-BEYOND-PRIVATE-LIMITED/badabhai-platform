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

## P-002 · ~~No `matching_catalog.published` event~~ — **UNPARKED AND BUILT 2026-09-02**

**Status: RESOLVED.** The premise was wrong and the owner corrected it.

**What the park claimed.** That the event catalog was frozen under ADR-0014 with CEO
signature, so adding an event type — additive or not — was not an engineering decision.

**Why that was wrong.** ADR-0014 says the opposite, in its own words: _"we are **NOT
hard-freezing** the schema … additive-only + versioned migration. (Additive Phase-2
growth continues; **this is a guardrail, not a freeze**.)"_ Commit `6f377032` on `main`
confirms it in practice — it added `profile.form_completed` and
`worker.qualifications_recorded` to the same registry.

**What shipped instead.** `matching_catalog.published`, v1, built strictly under the
ADR's own terms and verified mechanically as additive — `git diff --numstat` over
`packages/event-schema/` reports **11/0, 49/0, 16/0**: seventy-six lines added, **zero
deleted**. No existing payload, event definition or enum member was mutated; the registry
entry is appended at the end, matching the append-only protocol that commit documented.

**The one design point worth keeping.** The catalog blob does not ride the spine — the
payload is a revision, the revision it replaced, the schema version, four counts and an
opaque actor. The counts are there because the validator can reject a _malformed_ catalog
but not a merely _wrong_ one: a publish that drops from twenty-one roles to two passes
every gate, and the count is where that becomes visible at the moment it happens.

**Lesson worth more than the fix:** the park was reasoned from a remembered summary of an
ADR rather than from the ADR. Reading it took one grep.
