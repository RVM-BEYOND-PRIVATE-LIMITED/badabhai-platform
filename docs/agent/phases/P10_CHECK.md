STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

NOTHING SURVIVES THIS CLOSURE. Every deliverable is either shipped, deleted by a signed
ruling, or carried by an E-phase. Checked adversarially, not assumed.

------------------------------------------------------------------------------
PHASE-ID: P10
INVARIANT: no file under apps/payer-web/src/app/(portal)/postings/new/wizard/ declares a step,
a field id, or an option array. Every one arrives from the GET /schema payload, or from
GET /payer/match/skills for the skill vocabulary MatchSkillPicker already renders.

STATUS: BLOCKED ON P8. Run
`git grep -nIiE "job-posting-drafts|drafts/schema" -- '*.ts' '*.tsx' '*.dart' '*.sql'`.
Exit 1 means P8's schema route does not exist and P10 was correctly not started: VERDICT is
BLOCKED ON P8, NOT FAIL. Stop there.

EXPECTED ARTIFACTS: the wizard directory above, a committed schema fixture, a test that renders
the wizard from it, a checkpoint seam test recording the POSTs, a 409 conflict screen, and a
schema_version drift screen. If these do not exist, VERDICT is FAIL, "phase not built". Stop.

Paste raw output AND the exit code for every check. Scope every grep to the wizard directory
and exclude *.test.ts / *.test.tsx BY NAME.
1. grep -rnE "TRADE_KEYS|SHIFTS|NEEDED_BY|tradeKeySchema|shiftSchema|neededBySchema" and
   grep -rnE '"(day|night|rotational|immediate|soon|flexible)"'. Any hit is a FAIL — importing
   the constant hardcodes the option set as surely as typing it. RED looks like today's
   posting-form.tsx:260, `options={TRADE_KEYS.map(...)}`. Do NOT grep role names or collar
   tiers: neither appears in apps/payer-web, and no count is the client's business — it
   renders whatever the server serves.
2. Add a field to the committed fixture whose field_id returns zero hits from
   `grep -rn <field_id> apps/payer-web/src`. Re-run `pnpm --filter @badabhai/payer-web test`.
   Its label must appear in the collected tree (node env, no DOM — house walk/collect at
   agency-job-form.test.tsx:156,191). RED: the field renders nothing.
3. Delete a step from the same fixture. Re-run. The collected ids (acc.ids,
   agency-job-form.test.tsx:187) must equal the fixture's remaining step ids, in order, no
   extras. RED: the deleted step's id still collected — the step list is a client constant.
4. Call the checkpoint reducer directly with a 409 carrying the conflicting step_id: it must
   return the conflict state. Then drive that submit through the seam test: exactly ONE POST
   recorded. RED: the reducer returns success, or a second POST — a silent retry.
5. Render against a fixture whose schema_version differs from the draft's. The drift screen
   must be in the tree and no fixture field id may be. RED: field ids present. Silent
   migration is a FAIL.

pnpm build cannot pass on this box (PARKED.md:140). Do not record it as a P10 failure.
