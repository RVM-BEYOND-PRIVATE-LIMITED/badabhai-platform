PHASE P0 — RVM decision worksheet. No code in this phase.

Produce docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md.
This is a worksheet for RVM to fill in. You are not answering the questions.
You are making them cheap and fast for RVM to answer.

For each of the 21 to 22 Section-1 roles in BadaBhai_Role_Taxonomy_Master, output one row:
  role_label | proposed_domain | proposed_family | applicable function values
  | applicable collar tiers | 5 candidate Hinglish aliases | RVM VERDICT (leave blank)

What you may and may not fill in:
  - function values come only from this locked list:
      operator, setter, programmer, trainer, supervisor,
      maintenance, inspector, manager, apprentice
    plus the proposed new value setter_programmer.
    If a rung from the Aug-9 sheet does not map to one of these, leave it blank and
    list it under "unmapped rungs". Do not invent new values.
  - collar tiers come only from: elementary, semi-skilled, skilled trade, technician.
  - Aliases are candidates for RVM to accept or strike. Mark every one PROPOSED.

Then add a decisions section. One block for each of R1 to R7. Each block states:
the question, two or three concrete options, what each option costs later,
your recommendation, and a blank signature line for RVM or the CEO.

R4 must clearly show the three overlapping roles and the aliases that collide:
  Press/Machine Operator vs Injection Moulding Operator
  Plastic Process Technician vs Quality Inspector
  Tool & Die Maker vs Mould/Die Maker (Plastics)

Also raise two direct questions:
  1. The sheet says 22 roles but Sections 1A to 1D count 21. Which is right?
  2. Is "Design & Drafting" the unlisted 11th domain, or is it missing?
     CAD Designer cannot have an empty domain.

HALT if you find yourself deciding a domain, family, function, or tier that RVM has
not signed off. Every cell you fill is a proposal. Every verdict column stays empty.

INVARIANT: the worksheet contains zero decisions. Only proposals.
