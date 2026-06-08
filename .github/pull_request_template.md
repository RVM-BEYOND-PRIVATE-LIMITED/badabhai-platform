<!-- BadaBhai PR template. Fill every section; write "N/A" if not applicable. -->

## Summary

<!-- What does this PR change and why? -->

## Phase

<!-- e.g. Phase 1 — Worker Profiling -->

## Related decision / doc

<!-- Link ADRs / sprint-plan items, e.g. docs/decisions/0001-mvp-infra-decision.md -->

## Testing done

<!-- Commands run + results: pnpm lint / typecheck / test / build; pytest; flutter analyze/test -->

## DB migration impact

<!-- New/changed tables or columns? Migration file? Backwards-compatible? "None" if N/A -->

## Event schema impact

<!-- New/changed events or payloads? Version bumps? Did you update packages/event-schema + tests? -->

## Security / privacy impact

<!-- PII handling, secrets, RLS, auth. Confirm: no raw PII in events/logs/LLM input. -->

## AI / LLM impact

<!-- Changes to pseudonymization, prompts, AI contracts, or the AI_ENABLE_REAL_CALLS path? -->

## Rollback notes

<!-- How to safely revert (incl. any migration/data considerations). -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass
- [ ] No secrets or `.env` files committed
- [ ] No phone/name/address/employer/ID sent to any LLM
- [ ] Every important new endpoint emits a validated event
- [ ] Docs/README updated where needed
