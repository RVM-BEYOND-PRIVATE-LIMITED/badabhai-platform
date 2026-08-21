# Trainer pack — the six skills the strict EVAL_COVERED gate blocks

Each skill below is covered in the evaluation fixture **only by a mechanical case**: a query
that is the skill's own alias, asking the index whether an exact string matches itself. Under
E1 that no longer counts as having measured the skill, so none of the six can be promoted.

**Each needs one thing: a phrase a real worker in that trade would say.** Write it in the
slot, set `review_status` to `reviewed`, and that skill becomes promotable again.

Two slots are offered per skill — English and Hindi. **One filled slot clears the gate**; the
second is there because the Devanagari phrasing is usually the one workers actually say, and
no skill here has ever been measured against it. Leave it `pending_review` if you cannot
answer it; a `pending_review` slot stays out of every metric and costs nothing.

**Do not reuse the existing phrase.** It is printed under each skill so you can avoid it — a
paraphrase that repeats an alias tests nothing, which is the whole reason the mechanical case
stopped counting.

## Checking your work

Engineering does not write the phrases — a paraphrase written by the same side that scores it
measures nothing, which is the reason this pack exists at all. What engineering provides is the
checker:

```
pnpm --filter @badabhai/db db:verify:trainer-pack
```

It is offline and reads only this pack and the fixture. For each slot you fill it answers one
question — **would this case actually measure something?** — and reports every problem at once
rather than one per round trip. It will tell you if:

- the phrase is an existing alias of the same skill (the mechanical case again);
- the two slots for one skill hold the same phrase;
- `review_status` is not `reviewed`, so the gate still will not count it;
- `provenance` is still `pending_reviewer_authorship`, or was set back to a `corpus_alias:*`;
- the Hindi slot was answered in Latin script, or the English slot in Devanagari;
- the scope is a domain this skill is not wired to, so the case cannot pass however good the
  phrase is;
- the `case_id` collides with one already in the fixture.

**It has no opinion on whether a phrase is a good description of the trade.** That judgement is
yours, and nothing in the tool second-guesses it. Every rule above is a way a case would measure
*nothing*. A slot left empty is not an error and costs nothing.

---

> Built without alias vectors, so the *nearest other skills* section is absent. Re-run with
> `--vectors=<tsv>` from `db:export:alias-vectors` to include it. Its absence means it was
> not computed — not that these skills have no near neighbours.

---

## Earthing and bonding

- **skill_id**: `skill_earthing_and_bonding`  ·  **status**: provisional
- **label_hi**: अर्थिंग
- **trades it is wired to**: `jd_nco_7411_0100`, `jd_nco_7412_0200`
- **phrases it already answers to — DO NOT REUSE**: `earthing work`, `अर्थ पिट` (hi)
- **the case that used to count**: `DC-09` — query `earthing work` in `jd_nco_7411_0100`; `DC-19` — query `अर्थ पिट` in `jd_nco_7411_0100`

**Evidence needed from you**

- [ ] Confirm "Earthing and bonding" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] Reachable in 2 domains (jd_nco_7411_0100, jd_nco_7412_0200). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Write here**

- `PR-earthing_and_bondi-1` · English · scope `jd_nco_7411_0100`  →  _______________________________
- `PR-earthing_and_bondi-2` · **Hindi, in Devanagari** · scope `jd_nco_7411_0100`  →  _______________________________

---

## Order picking and packing

- **skill_id**: `skill_order_picking_and_packing`  ·  **status**: provisional
- **label_hi**: ऑर्डर पिकिंग
- **trades it is wired to**: `jd_nco_4321_0601`
- **phrases it already answers to — DO NOT REUSE**: `order picking`, `ऑर्डर तैयार करना` (hi)
- **the case that used to count**: `EX-HI-09` — query `ऑर्डर तैयार करना` in `jd_nco_4321_0601`

**Evidence needed from you**

- [ ] Confirm "Order picking and packing" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.

**Write here**

- `PR-order_picking_and_-1` · English · scope `jd_nco_4321_0601`  →  _______________________________
- `PR-order_picking_and_-2` · **Hindi, in Devanagari** · scope `jd_nco_4321_0601`  →  _______________________________

---

## Pipe support and clamping

- **skill_id**: `skill_pipe_support_and_clamping`  ·  **status**: provisional
- **label_hi**: पाइप क्लैंपिंग
- **trades it is wired to**: `jd_nco_7126_0301`
- **phrases it already answers to — DO NOT REUSE**: `pipe clamping`, `सपोर्ट लगाना` (hi)
- **the case that used to count**: `DC-07` — query `pipe clamping` in `jd_nco_7126_0301`

**Evidence needed from you**

- [ ] Confirm "Pipe support and clamping" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.

**Write here**

- `PR-pipe_support_and_c-1` · English · scope `jd_nco_7126_0301`  →  _______________________________
- `PR-pipe_support_and_c-2` · **Hindi, in Devanagari** · scope `jd_nco_7126_0301`  →  _______________________________

---

## Punching machine operation

- **skill_id**: `skill_punching_machine_operation`  ·  **status**: provisional
- **label_hi**: पंचिंग मशीन चलाना
- **trades it is wired to**: `jd_nco_7223_2400`
- **phrases it already answers to — DO NOT REUSE**: `punching operation`, `पंच मशीन` (hi)
- **the case that used to count**: `DC-02` — query `punching operation` in `jd_nco_7223_2400`

**Evidence needed from you**

- [ ] Confirm "Punching machine operation" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.

**Write here**

- `PR-punching_machine_o-1` · English · scope `jd_nco_7223_2400`  →  _______________________________
- `PR-punching_machine_o-2` · **Hindi, in Devanagari** · scope `jd_nco_7223_2400`  →  _______________________________

---

## Structural fit-up and tacking

- **skill_id**: `skill_structural_fit_up_and_tacking`  ·  **status**: provisional
- **label_hi**: फिट-अप और टैकिंग
- **trades it is wired to**: `jd_nco_7224_0102`
- **phrases it already answers to — DO NOT REUSE**: `fit up and tack`, `टैक वेल्ड` (hi)
- **the case that used to count**: `DC-03` — query `fit up and tack` in `jd_nco_7224_0102`

**Evidence needed from you**

- [ ] Confirm "Structural fit-up and tacking" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.

**Write here**

- `PR-structural_fit_up_-1` · English · scope `jd_nco_7224_0102`  →  _______________________________
- `PR-structural_fit_up_-2` · **Hindi, in Devanagari** · scope `jd_nco_7224_0102`  →  _______________________________

---

## Suspension and steering repair

- **skill_id**: `skill_suspension_and_steering_repair`  ·  **status**: provisional
- **label_hi**: सस्पेंशन स्टीयरिंग मरम्मत
- **trades it is wired to**: `jd_nco_7231_0400`, `jd_nco_7231_0100`
- **phrases it already answers to — DO NOT REUSE**: `suspension repair`, `स्टीयरिंग ठीक करना` (hi)
- **the case that used to count**: `DC-08` — query `suspension repair` in `jd_nco_7231_0400`

**Evidence needed from you**

- [ ] Confirm "Suspension and steering repair" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] Reachable in 2 domains (jd_nco_7231_0400, jd_nco_7231_0100). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Write here**

- `PR-suspension_and_ste-1` · English · scope `jd_nco_7231_0400`  →  _______________________________
- `PR-suspension_and_ste-2` · **Hindi, in Devanagari** · scope `jd_nco_7231_0400`  →  _______________________________

---
