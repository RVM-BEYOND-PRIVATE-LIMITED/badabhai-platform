# ADR-0070: The 60-trade catalogue: forms compiled from the CEO pack, one manifest per trade, a release switch per trade

- **Status:** Accepted. CEO ruling (Akshit), 23 Nov 2026: CEO pack v2.
- **Date:** 2026-11-25
- **Owner:** Divyanshu (Backend Platform, profiling and taxonomy) · **Issue:** #3034 · **Tracking:** #3024 · **Open points:** #2995
- **Source:** [`docs/reference/BadaBhai_Manufacturing_Taxonomy_and_Question_Pack_v2.md`](../reference/BadaBhai_Manufacturing_Taxonomy_and_Question_Pack_v2.md) (added by #2994). It is the source for every trade name, ladder, question, chip, phrase and code.
- **Built by:** #2997 (sheet compiler, PR #3037), #2998 (manifest and consistency tests, PR #3039), #2999 (role kinds and departments, PR #3043, migrations 0196 and 0197), #3000 (level table, PR #3041), #3001 (match skills and pairs, PR #3042), #3002 (release switch, PR #3045, migration 0198).
- **Changes how a trade is added.** [`role-pack-authoring-guide.md`](../profiling/role-pack-authoring-guide.md) §8 now follows this record.

## 1. Context

CEO pack v1 (2 Nov 2026) gave 23 sheet trades, and each was wired by hand. A trade lives in about 14 hand-kept lists across five packages: the role kind and its label, the role descriptor, the family and its code bindings, the form file, the level table and its confirm questions, the match skill and its pairs, the answer-to-skill rows, the posting catalogue, the résumé map and the chip label. Adding one trade touched eleven tables, and none of them knew the others existed (`role-form-descriptor.ts`). One missed list failed silently. A form nobody could reach, or a posting with no level, passed every gate.

Pack v2 (ruled 23 Nov 2026) sets the catalogue at **60 trades in 11 departments**, all postable by a company: 16 live (not touched), 7 deepened and 37 new, with 44 sheets of 20 to 23 questions each. Wiring 44 forms and 977 questions by hand, the v1 way, would repeat v1's mistakes 44 times.

## 2. Decision

1. **Forms are compiled from the pack, never typed.** `pnpm --filter @badabhai/db db:compile:sheets` (`packages/db/src/compile-trade-sheets.ts`) reads the pack's section 9 sheets plus one reviewed side file, `packages/db/data/question-packs/_sheet-overrides.json`. The side file holds the version, retry wording, why/scope/budget notes, kept live keys and option keys for number bands. A form is a pure function of those two inputs. The compiler fails closed: it throws on a sheet line it does not recognise, on a question the side file does not cover, and on a number band with no recorded option key. A dry run writes nothing and prints the diff; `--write` writes one file per form.
2. **One manifest per trade, with a consistency test.** `TRADE_CATALOGUE` (`packages/taxonomy/src/trade-catalogue.ts`) states each trade once. A row holds the code T01–T60, role kind, department, shop floor or desk, status, wave, pack, family, base match skill, ladder, confirmed and higher-price rungs, level key, related skills, posting question keys and NCO codes. The lists stay where they are, and three tests hold them to the manifest for every row at or below `LOADED_WAVE`:
   - `packages/taxonomy/src/trade-catalogue.consistency.test.ts`: role kinds and labels, match skills and pairs, the level table and confirm items, the posting ladder, answer-to-skill rows.
   - `apps/api/src/profiling/roles/trade-catalogue.api-parity.test.ts`: role descriptor, résumé map, chip label.
   - `packages/db/src/trade-catalogue.db-parity.test.ts`: family, code bindings, form file.

   `LOADED_WAVE` is 0 today (the 16 live trades). It rises by one in the same change that loads each wave, and that rise is what turns the checks on for the wave's rows.

3. **Kinds, skills and rung keys are declared before forms.** Phase 1 of #3024 declares the vocabulary first:
   - 36 new role kinds (63 in all) and the three migrations that widen the CHECK lists;
   - 38 new match skills (73 in all) and the section 5 pairs;
   - four new rung keys: `engineer`, `senior_engineer`, `executive`, `senior_executive`;
   - 36 role descriptors.

   Only after that does a wave publish forms. A form never lands on a kind, skill or rung the database or the taxonomy does not yet know.

4. **A changed form is a new version.** A published form is never edited: `<pack_id>@<n>.json` sits beside the old version. The compiler's `--write` refuses a version listed in `_published-versions.jsonl` and refuses to overwrite a file with different bytes. The 16 live forms' served text must stay byte-identical after every change; `pack-served-text.golden.test.ts` and `question-pack-keys.append-only.test.ts` enforce that. Question keys, skill ids and role kinds are never renamed. The 7 deepened forms keep their live keys where the sheet renames one (`keyRenames` in the side file).
5. **A release switch per trade, held in the database.** Migration 0198 adds the `trade_release` table with one row per released kind. `posting_enabled` gates the posting catalogue and posting validation (#3005, #3006). `form_enabled` gates the trade-form hand-over and the Campus translation target (#3014). A kind with no row reads as off. A read error also reads as off, and an admin write returns 503 while the table is missing. The seed switches on posting for the 16 live kinds and nothing else. The owner flips a switch through the admin route without a release, and a row is never deleted: switching off is an update. **What the switch does not gate:** whether a worker reaches a form in chat. That is decided by the seeded phrases and code bindings. Flipping a switch never drops a worker mid-interview, and switching a trade on puts its form in front of nobody until its phrases and codes are seeded.
6. **Departments are a label; clusters stay the conflict scope.** `JOB_ROLE_DEPARTMENTS` (the 11 of pack section 2) and `JOB_ROLE_DEPARTMENT_BY_KIND` group trades for people: pickers, headings and the catalogue. Routing does not read them. Whether two trades veto each other's phrases is still decided by `ROLE_CLUSTERS` (`role-form-descriptor.ts`), which gained `quality_lab`, `engineering_desk` and `supply_chain` (nine in all). A department is too coarse to veto within: under one department, a welder would lose a painter's and an inspector's words.
7. **Number bands are stored as text.** Every number band except the experience question stores its value as text (`value_text: "0.10"`), as the live forms do. An escape chip ("unknown") can then share the band's column. The experience question, the first on every sheet, stores `value_number` only, because its tier gates compare numbers (the `value_text` trap, guide §4). The pack asks for a plain number (#2995 point 13). That is a note for Akshit, not a ruling, and the compiler builds the live pattern.

## 3. Alternatives considered

- **Typing the forms by hand, as v1 did.** Rejected. 977 questions typed into JSON is where transcription mistakes come from, and a reviewer cannot tell a typo from a decision. A compiled form can be checked against its sheet by running the compiler again, and a dry run shows any difference as a diff.
- **Rewriting the existing tables as generated output** (generating `POSTING_TRADES`, `TRADE_LEVEL_PACKS`, the descriptors and the bindings from the manifest). Rejected for now. It would rewrite live lists that carry pinned history the manifest cannot express: the fitter's `senior` rung stored as `senior_fitter`, the electrician's `senior_technician` stored as `senior`, v1 confirm maps kept for stored answers. It would also have to land in one change that touches every live trade at once. Checking the hand lists against the manifest gives the same safety, keeps each list's review history, and moves one wave at a time.
- **Release switches as deploy-time values** (environment secrets, or a constant in code). Rejected. 60 trades arrive in three waves, and some trades are held for a trade reviewer's sign-off. A deploy per flip would tie each owner decision to a release. A secret has no audit trail of who turned it on and when, which the table records in `updated_by` and `updated_at`. A database row can be flipped by the owner, is audited, and reads as off when missing.

## 4. Consequences

- **Adding a 61st trade** means a sheet in the pack (a CEO ruling), a manifest row, a side-file entry, a compiler run and the three tests. The tests name every list still missing the trade, so nobody has to remember the 14 places. See guide §8.
- **The guide's old numbers are gone.** `MAX_ENGINE_ASKS` is 48 (`apps/api/src/profiling/next-question.ts`), not 24 or 28. The common tail (`qp_universal@8`) costs 19 asks: 17 questions, plus one retry each for its two mandatory questions. `_budget` notes inside published forms that say "MAX_ENGINE_ASKS is 28" or "qp_universal spends 8" are historical. Published files are not edited.
- **Nothing live changes by this record.** Each wave goes live at a named owner step (#3003, #3013): apply, seed, then flip its switches.
- **The #2995 points stay open where unruled.** Until Akshit answers a point, its default column is what gets built. Each answer is recorded on #2995 and in [`decisions-log.md`](../registers/decisions-log.md).
- **Rollback:** a wave is switched off by setting its `trade_release` rows to false. Published forms stay, because a live session pins its version. Dropping the table (0198's rollback) reads every trade as off, including the 16, until it is restored and re-seeded. That holds once the readers (#3005, #3006, #3014) are wired; on 25 Nov 2026 no shipped reader names the table yet.
