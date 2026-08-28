# R9 §3.1 / R10 §3.1 — what a second `TRADE_RESUME_MAPS` entry costs

> Report only. Nothing here is built, and milling beyond this estimate is out of scope.

## The question

`TRADE_RESUME_MAPS` has exactly one entry: `qp_cnc_turning`. The ratified sample is a **VMC
milling** sheet, so a real milling worker cannot today be given the document nine packets have
been spent matching — Zone 2 would render empty for him and Zone 1's controllers segment could not
populate either. The one-spine architecture says adding a role is "data, not code". **Is that true
now that the first entry exists, or did the first one cost something the second will too?**

## The answer: it is a data change, and R10 is what made that true

**Three of the mechanisms a milling map needs did not exist before R10 §2.5**, and all three were
built as part of the parity work rather than for milling:

| Mechanism                                                 | Before R10                                                                      | Now                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Configuration appended to a machine chip (`VMC · 3-axis`) | no mechanism at all — `buildTradeCapabilityRows` iterated one attribute per row | `TradeRowSpec.configFrom` + `configValues`                  |
| The Verdict Line's axis segment (`3 & 4-axis`)            | documented in the renderer's slot contract, composed nowhere                    | `buildVerdictLine({ axes })` with shared-suffix compression |
| A fresher's Zone 4                                        | nothing asked training / trade test / workshop machines                         | `buildFresherRows`, trade-independent                       |

Had a milling map been attempted before this packet, all three would have surfaced as code changes
inside it. They are now generic and shipped.

## What a milling entry actually requires

**1. A pack — `qp_vmc_milling.json` (data).** The largest single item, and it is authoring rather
than engineering: roughly fifteen questions with reviewed shop-floor vocabulary. The machinery it
needs — tier gating by `ask_if`, `multi_select` chips, `value_number` gates, the fresher branch —
is all in use by the turner pack today. **Cost: one author-day plus a practising-miller review**,
the same review the turner pack is still carrying as an open redline (Q2).

**2. A `TRADE_RESUME_MAPS` entry (data).** A `section_title`, and one `TradeRowSpec` per row with
its `from`, `label`, `kind`, `rank`, `values` dictionary and caps. The turner entry is ~130 lines
of dictionary. **Cost: half a day**, and it is the file's whole purpose — the second entry is what
the abstraction was built for.

**3. Two seed rows** — `profiling_family` `fam_vmc_milling` and a `profiling_family_binding` to
ISCO 7223 with a specificity above `fam_machining`. Data.

**4. Devanagari TTS twins for every new prompt, retry and why-text.** Not optional and not
generated: `question-tts-text.ts` is a hand-authored table and a missing twin fails a gate. R10
added nine for three fresher questions; a fifteen-question pack needs roughly forty-five. **Cost:
half a day of careful Hindi**, and it is the item most likely to be forgotten in an estimate —
the clarify twins compose automatically but only if the why-text is filed in `WHY_TTS_TEXT` and
not in the question table, which R10 got wrong first time.

**5. Golden-record regeneration.** `UPDATE_PACK_SERVED_TEXT=1` and `UPDATE_REPLY_CLOSURE=1`.
Mechanical, but the served-text record is a deliberate speed bump: it exists so an audible-surface
change is reviewed rather than absorbed.

## What it does NOT require

- **No renderer change.** The template is trade-independent; `cap_section_title` is read from the
  map.
- **No mapper change.** `buildTradeCapabilityRows` is keyed by pack id.
- **No contract change.** Capability answers are `worker_attributes`, outside the frozen contract.
- **No ask-budget change.** R10 made `worstCaseAsks` tier-aware, so a milling pack with a fresher
  branch is measured against workers who can exist.

## The one real risk, and it is not in the list above

**`CAPABILITY_ROW_BUDGET` is 9 and it is global.** A milling pack that defines more than nine rows
hits the same forced choice the turner has — and the turner's version of that choice is the open
Q2 redline. A second trade does not create the problem, but it doubles the surface on which an
unresolved ruling is applied silently, because the budget drops by rank with no per-trade override.

**Estimate: two days of authoring and review, no engineering.** The one-spine claim holds — but it
holds _because_ R10 built the three missing mechanisms, not because it was already true.
