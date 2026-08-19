# Release Checklist — `apps/api` to AWS Lightsail

**Citation note:** no live code cites a specific procedure "from `docs/release-checklist.md`" —
the only citations of this exact path are `.claude/agents/devops-engineer.md`'s
ownership-mandate list and this repo's audit documents analyzing it
(`docs/audit/16_OBSERVABILITY_AUDIT.md`, `docs/audit/24_RISK_REGISTER.md` R46). This checklist is
reconstructed directly from `.github/workflows/ci.yml`'s `deploy-lightsail` job (the **only**
automated deploy path this repo has) and its own extensive inline comments — the release
mechanic is fully documented in that file even though no separate runbook currently exists to
walk a human through it.

## Before merging to `main`

1. **CI is green on `ci-required`**, not on individual job checks — `ci-required` is the only
   status branch protection can require (see `docs/github-actions.md` for why). A green
   `ci-required` means every `needs:` job is `success` or legitimately path-filtered `skipped`.
2. **If the PR includes a migration** (`packages/db/migrations/*.sql`): confirm it is additive
   (never drops/renames a production column without a reviewed plan — CLAUDE.md §10) and that
   `ci.yml`'s `e2e` job applied it cleanly from a fresh database (this happens automatically on
   every PR that touches `apps/api/**`/`packages/**` — see the `e2e` path filter).
3. **If the PR introduces a new env var**: confirm it has a safe default and fails closed when
   absent if it gates anything security/spend-sensitive (see `docs/environment-variables.md`'s
   fail-closed-assertion list), and that it is added to `deploy-lightsail`'s secret bridge below
   if the box needs it in production.
4. **If the PR flips a real-provider gate** (payments/AI/WhatsApp/push real-send, or anything
   under CLAUDE.md §7): this requires explicit human sign-off and is out of scope for a routine
   merge — confirm the flip was actually intended and signed off, not incidental.

## What happens automatically on merge to `main`

`ci.yml` re-runs on `push` to `main` (the same jobs as the PR run). Two additional jobs then run,
**gated on that same run's own success** (not merely "a build exists somewhere"):

1. **`build-and-push-image`** (`needs: [changes, node, ai-service, e2e]`) — builds and pushes
   **two** images to GHCR: `badabhai-api` (context: repo root, `apps/api/Dockerfile`) and
   `badabhai-ai-service` (context: `apps/ai-service`, its own Dockerfile). Both are tagged
   `sha-<short7>` (immutable, the tag a rollback pins) and `main` (mutable, humans/local pulls).
   **This job only runs on a direct push to `main`, never on a PR** — a PR gets no registry
   credentials, no `packages: write` permission, no tags.
2. **`deploy-lightsail`** (`needs: [build-and-push-image]`, `environment: staging` — named for
   the current default; rename **and** add a required reviewer if this box is ever ruled
   production) — SSHes into the box and runs the sequence below.

**Both jobs use the `always()` + explicit `needs.*.result` idiom, not a plain `if:`.** This
matters because `ai-service` and `e2e` are path-filtered and legitimately report `skipped` on
most pushes (a frontend-only or docs-only change touches neither) — GitHub's implicit
`&& success()` on a plain `if:` treats `skipped` as failing, which silently skipped both jobs on
the majority of merges until this was fixed (confirmed via `gh run view` on real runs — this was
a shipped bug, not a hypothetical). If a merge does **not** trigger a deploy, check
`needs.changes.result`/`needs.node.result` first before assuming the deploy pipeline itself is
broken.

## The deploy sequence (`deploy-lightsail`, in order)

1. **SSH to the box** as the deploy user, `cd ~/deployments/badabhai-platform`, `git pull origin main`.
2. **GHCR login** with the ephemeral job `GITHUB_TOKEN` (dies with the run — never a long-lived
   PAT on the box).
3. **Pin the immutable image tags**: `API_IMAGE`, `AI_SERVICE_IMAGE`, `PAYER_WEB_IMAGE` and
   `ADMIN_WEB_IMAGE` all set to `sha-<first 7 chars of github.sha>` (lowercased). **All four**
   are exported even for an api-only change — `docker-compose.staging.yml` interpolates the
   **whole** overlay before filtering by service, so a single missing `*_IMAGE` would fail every
   command, including `pull api`. (Measured, not assumed: with every other variable satisfied,
   unsetting `ADMIN_WEB_IMAGE` makes `... --profile api config api` — which names admin-web
   nowhere — exit 1 with "required variable ADMIN_WEB_IMAGE is missing a value".)
4. **Disk reclaim, before pulling** — `docker image prune -af --filter "until=72h"` (never
   touches an image a running container references, never touches
   `badabhai_pgdata`/`badabhai_redisdata` volumes), escalating to a full `docker image prune -af`
   if free space stays under 4GB after the conservative pass, and hard-failing before any pull if
   still under 2GB. This step exists because deploys **#500/#501/#503 actually died** from disk
   exhaustion mid-pull before it was added — real incidents, not a hypothetical safeguard.
5. **Pull all four images.** Each pull is independent: a service whose image was never published
   for this commit is SKIPPED (it keeps running its previous container) and the job fails loudly
   at the end naming it, rather than one broken build blocking every healthy one.
6. **Start Redis** (`up -d --no-deps redis`) — box-local, must be started explicitly (it is not
   an `api` dependency the compose graph would otherwise bring up under `--no-deps`).
7. **Migrations are NOT run here.** `TODO(CD-2, held: 0031 human sign-off + D1)` — this is a real,
   currently-open gap, not an oversight this checklist can paper over: **applying migrations to
   the Lightsail database is still a manual, human, pre-deploy step.** `/health`'s DB check is
   connectivity-only (`SELECT 1`), so a fresh unmigrated database still boots 200 while every
   real endpoint 500s. **If this release includes a migration, apply it by hand against the
   production `DATABASE_URL` before this job runs** — do not rely on the pipeline to sequence it.
8. **Start `ai-service`, health-gate it** (`GET http://localhost:8000/health`, 15 attempts × 2s ≈
   30s budget) **before** starting `api` — a broken ai-service image blocks the `api` deploy
   entirely rather than letting the new `api` serve requests against a silently-absent AI
   backend (the exact TD81 failure class this ordering exists to prevent). A container that
   actually crashes (not merely slow) short-circuits the wait early via a `restarting`/`exited`
   Docker state check (two consecutive reads, to avoid a false positive on the boot-transition
   instant) rather than waiting out the full poll budget.
9. **Start `api`, health-gate it** (`GET http://localhost:3001/health`, 30 attempts × 2s ≈ 60s
   budget), same crash short-circuit logic.
9b. **Start `payer-web`, then `admin-web`, health-gating each** (`GET
    http://localhost:${PAYER_WEB_PORT:-3333}/health` and
    `http://localhost:${ADMIN_WEB_PORT:-3003}/health`, 15 attempts × 2s ≈ 30s each). Both run
    *after* the api's gate so a broken portal image never delays the api, and neither has a
    `depends_on` edge — the ordering here is the dependency. **`admin-web` is the internal admin
    portal and is NOT reachable from the internet**: nothing opens 3003 in the box's security
    group and no nginx server block routes to it, so those `localhost` probes are the only
    traffic it receives. Exposing it is a separate owner decision requiring an IP allowlist.
10. On any health-gate failure, the job dumps the last 100 lines of that container's logs and
    exits red — the box is left on whatever it was running before (a failed `api up` does not
    tear down a working previous container).
11. `docker logout ghcr.io` on **every** exit path (`trap ... EXIT`) — never leaves a registry
    credential on the box.

## Verify after a deploy

- Both `/health` endpoints return 200 (the job itself already confirmed this, but re-check from
  outside the box against the public URL if one exists for this environment).
- If a migration was applied by hand as part of this release, confirm it actually landed
  (`pnpm --filter @badabhai/db db:verify:...` for whichever surface it touched, or a direct
  schema check) — the deploy job's own health gate cannot tell you this.
- Watch for the specific failure classes this pipeline has hit before: disk exhaustion (step 4),
  an ai-service crash blocking `api` (step 8), a silently-skipped deploy on a path-filtered merge
  (see "What happens automatically" above).

## If it goes wrong

See `docs/rollback-guide.md` — the full box-side rollback procedure (export both previous-commit
image tags, re-run the same compose sequence). **A failed health gate already leaves the box on
the previous working image with no action needed** — rollback is for the case where the deploy
went green but the new code misbehaves at runtime in a way CI/the health gate could not catch.

## What this checklist does not cover

Deploying `apps/web`/`apps/payer-web`/`apps/admin-web` — **no deployment path is documented for
any of the three anywhere in this repo** (`docs/audit/11_COMMAND_REFERENCE.md`'s own finding,
re-verified for this reconstruction: no compose service, no workflow step, no Dockerfile);
deploying to the separate persistent-staging host (`docs/ops/staging-service-deploy-runbook.md`);
mobile app releases (Flutter CI gates the code but this repo has no store-submission workflow
documented).
