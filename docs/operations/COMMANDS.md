# Operations — deployment paths

## apps/web, apps/payer-web, apps/admin-web (BL-1)

**Not deployed yet.** Confirmed with the owner (2026-08-13/14, during the forensic-audit
remediation pass — see `docs/audit/22_REMEDIATION_BACKLOG.md` BL-1).

All three Next.js apps build via the generic Turborepo CI step (`pnpm -w build`), so we
know they compile — but none of them has a Dockerfile, a `docker-compose.staging.yml`
service entry, or a CI deploy job. Unlike `apps/api` and `apps/ai-service` (both live on
the Lightsail staging box via `deploy-lightsail`, see `docs/rollback-guide.md`), these
three have no hosting target today.

When one of them is ready to deploy, this file should be updated with the actual path
(compose service, host, CI job) rather than left as a "not yet" note — see
`docs/rollback-guide.md`'s own "What this guide does not cover" section, which points
here.
