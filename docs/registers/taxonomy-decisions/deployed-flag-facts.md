# The deployed flags — one is settled, one moved on 2026-08-24

**Prepared against main `e00bec27` · measured 2026-08-26 · read-only · repository + GitHub metadata**
**Production mutation: NONE · AI spend: ₹0 · no flag read, changed, enabled or probed**

Reproduce: `pnpm db:audit:deployed-flags --json=<out>` (needs `gh` authenticated; touches no database)
Artifact: [`deployed-flag-facts.json`](./deployed-flag-facts.json) · Tests: `deployed-flags.test.ts` (13)
Supersedes nothing: [`task17b-canonicalize-flag-investigation.md`](./task17b-canonicalize-flag-investigation.md) is unedited and still correct.

> **The two capability flags have completely different epistemic status, and every document
> treats them the same.** One is provably false. The other is unknown, was **deliberately
> changed on 2026-08-24**, and reaches the running container on the next merge.

---

## What Task 17b could not do, and why this can

Task 17b concluded the deployed value is *"NOT DETERMINABLE from the repository"* — the effective
value comes from a GitHub Actions secret. That is right, and it stopped one step early.

**GitHub never exposes a secret's value. It does expose whether the secret EXISTS, and when it
was created and last set.** No value is read here, and the running service is not probed —
Task 17b's own retracted claim came from exactly that kind of inference.

Those three metadata facts separate the flags completely.

---

## DOMAIN_MATCH_ENABLED — **provably false**

```
secret exists          false      <- 404 from the secrets API
bridged by CI          true       DOMAIN_MATCH_ENABLED: ${{ secrets.DOMAIN_MATCH_ENABLED }}
compose default        false      ${DOMAIN_MATCH_ENABLED:-false}
DEPLOYED VALUE         false (provable)
```

The secret does not exist, so the CD bridges the **empty string**, and compose's `:-` form
substitutes on empty as well as unset — a property the compose file states explicitly and for
this exact reason. **The deployed value is `false`, established without reading anything secret.**

This is not a new claim; it is the first time it has been *proved* rather than assumed. A test
pins both halves — the CI bridge and the compose default — so if either moves, the proof stops
holding loudly.

---

## SKILL_CANONICALIZE_ENABLED — **unknown, and it moved**

```
secret exists          true
created                2026-07-16T11:51:11Z
updated                2026-08-24T11:30:45Z    <- CHANGED, 39 days after creation
bridged by CI          true
compose default        false                   <- governs ONLY if the value is empty
DEPLOYED VALUE         NOT DETERMINABLE
```

Three facts, none of them inferred:

1. **The secret exists**, so the compose default is not what governs. The `${VAR:-false}` fallback
   applies only if the secret's value is the empty string.
2. **Its value was set on 2026-08-24 at 11:30:45 UTC**, 39 days after creation. For comparison,
   `AI_ENABLE_REAL_CALLS` and `RESUME_RENDER_ENABLED` both still carry `updated_at ==
   created_at` — set once in the 2026-07-16 bulk provisioning and never touched. **Among the
   flag-shaped secrets checked, this is the only one anybody has gone back and changed.**
3. **The deploy job runs on every push to `main`.** There is no separate release step. A secret
   changed on day X reaches the running container at the next merge — and `main` has merged many
   times since 2026-08-24, most recently today.

**What that adds up to: the running ai-service carries whatever was set on 2026-08-24, and
nothing in this repository records what that was.**

### Timing, stated without inference

The 2026-08-24 `unresolved_phrase` rows Task 17b analysed were written at **07:59** and **08:14
UTC**. The secret was set at **11:30:45 UTC** — about three hours later. The two are adjacent in
time and that is all this establishes. **It does not indicate the direction of the change**, and
guessing one would repeat the mistake Task 17b retracted.

---

## Why this matters more than it looks

Several committed documents use *"the flag is off"* as a **safety argument** for leaving other
things alone — the D-7B chassis assignment, the §5a collisions, the D-7C seed. That argument is
now in two pieces:

| claim | status |
|---|---|
| the ANN domain-match path is off | **PROVED** |
| `/skills/canonicalize` is off | **UNVERIFIED — and the one observable signal shows deliberate movement** |

The second is the one the collision findings depend on. §5a measured three phrases that would be
misassigned above the floor *if canonicalization were on*; that finding's severity is a function
of a value nobody in this repository can read.

> **OWNER FACT REQUEST — not a decision, an unknown only you can close.**
> **What is the effective value of `SKILL_CANONICALIZE_ENABLED` in the running ai-service, and
> what was it set to on 2026-08-24 at 11:30:45 UTC?**
> One command on the box settles it:
> `docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED`
> **This is not repository work and no agent should attempt it.** Until it is answered, treat
> *"canonicalization is off"* as an assumption, and note that it is load-bearing for D-7B, §5a
> and D-7C.

---

## Safety property worth keeping

Both flags use `${VAR:-false}`, never `${VAR:?}`. That is deliberate and correct: these are
**capability gates, not credentials**, so every failure mode of the bridge — secret absent,
secret empty, `envs:` entry forgotten — must land on *off* rather than failing the deploy. A test
asserts the `:?` form has not crept in.

## What did NOT change

No secret read, created, changed or deleted. No workflow edited. No container touched. No
production probe. `SKILL_CANONICALIZE_ENABLED` and `DOMAIN_MATCH_ENABLED` are exactly as they
were before this audit ran.

## Gates

```
MATCH_VOCABULARY          PASS — 0 of 96 missing a disposition
EVAL_COVERED              PASS — 0 of 96 uncovered under retrieval-v3
RESOLVABLE_ABOVE_FLOOR    FAIL — 34 of 96 blocked
NO_REGRESSION             FAIL — 96 of 96 blocked
PROMOTION CANDIDATES      96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION STATE UNVERIFIED.**
