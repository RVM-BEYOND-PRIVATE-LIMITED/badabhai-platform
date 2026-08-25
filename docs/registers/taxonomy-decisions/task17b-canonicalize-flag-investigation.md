# Task 17b — was `SKILL_CANONICALIZE_ENABLED` actually on?

**Prepared against main `1d83b9d7` · investigated 2026-08-25 · read-only**
**Production mutation: NONE · AI spend: ₹0 · nothing enabled, disabled or configured**

Evidence tags: **MEASURED** production · **STATIC** repository · **INFERRED** derived ·
**NOT DETERMINABLE** outside the repository.

---

## 0. Headline — I asserted this, and the inference was unsound

In the D-7B PR (#1222) I wrote:

> *"`unresolved_phrase` carries skill-scope misses from 2026-08-24, reachable only from inside
> `canonicalize_skill` — so `SKILL_CANONICALIZE_ENABLED` is effectively ON in the running
> service."*

**That does not follow.** The Python `record_unresolved` is indeed only reachable from inside
`canonicalize_skill`, but **it is not what writes the row.** The ai-service is DB-free; it calls
back into the backend, and the row is written by:

```
POST /internal/skills/unresolved      apps/api/src/skills/skills.controller.ts:74-86
  @Controller("internal/skills")
  @UseGuards(SkillsInternalGuard)     scoped secret SKILLS_INTERNAL_TOKEN, fail-closed
```

**STATIC.** That endpoint takes `phrase`, `domain_id`, `lang`, `job_domain_id` straight from the
request body and upserts. Any holder of the token can write those rows — the ai-service when
canonicalization is on, a smoke test, a runbook step, or a manual probe. **The rows are not
evidence about the flag.**

---

## 1. The six questions

### 1. Was it actually ON?
**NOT DETERMINABLE from the repository, and the evidence that suggested "yes" is unsound (§0).**
Everything recorded points the other way (§2). No artifact in the database records a deployed
configuration.

### 2. Where would the effective value be supplied?
**STATIC**, in precedence order:

| source | value | note |
|---|---|---|
| container env, from CD | `${{ secrets.SKILL_CANONICALIZE_ENABLED }}` | **a GitHub Actions secret — not in the repo, not readable here** |
| `docker-compose.staging.yml:515` | `${SKILL_CANONICALIZE_ENABLED:-false}` | **default `false`** |
| `apps/ai-service/.env` (anchored, *not* repo root) | unknown | exists locally; **guard-protected, not read** |
| `config.py:384` | `False` | pydantic default |

**Two corrections to earlier reasoning.** The ai-service anchors `env_file` to
`apps/ai-service/.env` (`config.py:78`), so the **repo-root `.env` is not its config** — an
earlier trace quoted the root file and drew a conclusion about the service from it. And
`apps/ai-service/.env` is classified secret; the repository's own guard hook blocked reading
it, correctly, and I did not work around it.

### 3. What execution path produced the 2026-08-24 rows?
**MEASURED** — five skill-scope rows, in two tight bursts:

| phrase | `domain_id` | `job_domain_id` | count | last seen (UTC) |
|---|---|---|---:|---|
| `cnc operator` | `cnc-machining` | NULL | 2 | 08:14:02 |
| `milling` | `cnc-machining` | NULL | 1 | 07:59:26 |
| `carpenter` | `carpentry` | NULL | 1 | 07:59:33 |
| `electrician` | `electrical` | NULL | 1 | 08:14:09 |
| `plumber` | `plumbing` | NULL | 1 | 08:14:12 |

**INFERRED — this is a smoke probe, not organic traffic.** Three signals: every phrase is an
**occupation noun** (`plumber`, `electrician`, `carpenter`) being submitted as a *skill*, which
is not how a worker describes their skills; each is paired with **its own matching legacy slug**,
so the caller already knew the domain rather than resolving it; and they arrive in two bursts
seconds apart, walking one domain at a time. Organic profiling traffic would carry
`job_domain_id`, not a hand-picked legacy slug — **MEASURED: zero canonical-scope skill misses
have ever been recorded.**

### 4. If it was not ON, how can the rows exist?
Exactly as §0 describes: the write is an authenticated HTTP endpoint independent of the Python
flag. Nothing needs to be guessed.

### 5. Is the 0.7570 chassis assignment reachable in the current production configuration?
**NOT DETERMINABLE read-only.** What is established and unchanged:

- **MEASURED** — the shipped retrieval statement returns `skill_mechanical_assembly` at
  **0.7570 ≥ 0.75** for the chassis phrase, on three canonical domains and the legacy
  `fitting-assembly` slug. The *query* behaves that way regardless of any flag.
- **INFERRED** — whether it *fires* needs (a) the deployed flag on **and** (b) a caller scoping
  to one of those domains.
- **MEASURED** — no skill-scope miss has ever been recorded on a canonical scope, so no observed
  traffic has taken that path.

So: **a demonstrated capability of the shipped code on live data, not an observed occurrence.**
D-7B's classification is unchanged — it did not rest on this flag.

### 6. Owner decision, or stale assumption?
**Neither, exactly — a factual gap with one derived finding.**

The stale assumption is mine and is corrected here. The gap is that **the deployed value lives
in a GitHub Actions secret**, so no amount of repository or database inspection can settle it.

**The derived finding worth an owner's attention:** several documents use *"the flag is off"* as
a safety argument for leaving other things alone. Nothing in the repository can verify that, and
the only place it is pinned is the **compose default** — which applies only when the secret is
unset. That is a reasonable posture, but it is an assumption, and it is load-bearing.

---

## 2. What the repository does pin

**STATIC**, and it all agrees:

- `deploy-workflow-taxonomy.guard.test.ts` (15 tests, passing) pins that the CD workflow bridges
  `SKILL_CANONICALIZE_ENABLED` from a secret **and** that the compose overlay's default is the
  string `"false"`.
- `apps/ai-service/.env.example:163` — `SKILL_CANONICALIZE_ENABLED=false`
- `config.py:384` — `skill_canonicalize_enabled: bool = False`
- `production-release-runbook.md` step 8 lists flipping it to `true` as a **future** step gated
  on step 7.
- `project-control.md` §B and `project-status.md` record the canonicalization route as
  **FLAG-OFF**.

**Nothing here is changed by this investigation.**

---

## 3. Corrections issued

| where | claim | correction |
|---|---|---|
| PR #1222 body and `d7b-chassis-fitting-decision.md` §4 | *"`SKILL_CANONICALIZE_ENABLED` is effectively ON"* | **unsound** — the rows are written by a token-guarded API endpoint, not by the Python flag path |
| an earlier trace | *"repo-root `.env` says true, so the service has it on"* | the ai-service reads `apps/ai-service/.env`, not the repo root |

Neither correction changes D-7B's classification (**B — owner decision**) or any gate.

---

## 4. What would settle it

Not repository work. Someone with deployment access reads the effective environment of the
running ai-service container, or the value of the `SKILL_CANONICALIZE_ENABLED` GitHub Actions
secret. **Recorded as an infrastructure question, not actioned.**

## 5. Gates

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL              unchanged
PROMOTION CANDIDATES      0                 unchanged
```
