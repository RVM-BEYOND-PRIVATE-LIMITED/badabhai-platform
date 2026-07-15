"""The labeled launch-wedge eval set (ADR-0030 / TAX-5) — phrase → expected outcome.

Tiers:
- ``exact``       in-vocabulary phrasing → MUST assign the labeled id at the floor.
- ``paraphrase``  natural Hinglish/eng rewordings → measure recall (assign if the floor
                  permits; a miss is honest, not a failure — it feeds the growth queue).
- ``vernacular``  shop-floor terms the standards miss (kharad/chhilai/ghisai…) →
                  expected to MISS until the TAX-5 wedge aliases are RVM-ratified +
                  seeded + embedded (``requires_wedge=True``); after ratification they
                  must assign.
- ``negative``    out-of-domain phrases → MUST stay UNRESOLVED at the floor (precision).
- ``cross_domain`` in-vocab phrase queried in the WRONG domain → MUST stay UNRESOLVED
                  (the domain filter is load-bearing).

The floor sweep (``score-wedge`` runner + the committed scores fixture) evaluates
precision/recall over this set on REAL embeddings. Keep the set REPRESENTATIVE, not
overfit: entries are added when a real transcript class appears, never tuned to make a
floor look good (the over-fitting risk named in the TAX-5 spec).
"""

from __future__ import annotations

from dataclasses import dataclass

UNRESOLVED = "UNRESOLVED"


@dataclass(frozen=True)
class WedgeCase:
    phrase: str
    domain_id: str
    expected: str  # a skill_id, or UNRESOLVED
    tier: str  # exact | paraphrase | vernacular | negative | cross_domain
    requires_wedge: bool = False  # True → only assignable after RVM-ratified aliases seed


WEDGE_SET: tuple[WedgeCase, ...] = (
    # --- exact (assign at floor; precision anchors) --------------------------------
    WedgeCase("CNC programming", "cnc-programming", "skill_cnc_programming", "exact"),
    WedgeCase("program editing", "cnc-programming", "skill_program_editing", "exact"),
    WedgeCase("turning", "cnc-machining", "skill_turning", "exact"),
    WedgeCase("lathe operation", "cnc-machining", "skill_turning", "exact"),
    WedgeCase("milling", "vmc-machining", "skill_milling", "exact"),
    WedgeCase("drilling", "cnc-machining", "skill_drilling", "exact"),
    WedgeCase("surface grinding", "grinding", "skill_grinding_ops", "exact"),
    WedgeCase("MIG welding", "welding", "skill_mig_welding", "exact"),
    WedgeCase("fixture setup", "cnc-machining", "skill_fixture_setup", "exact"),
    WedgeCase("CMM operation", "metrology-quality", "skill_cmm", "exact"),
    WedgeCase("offset setting", "cnc-machining", "skill_tool_offset_setting", "exact"),
    WedgeCase("quality control", "metrology-quality", "skill_quality_control", "exact"),
    # --- paraphrase (recall probes; honest misses feed the queue) -------------------
    WedgeCase("lathe machine chalana", "cnc-machining", "skill_turning", "paraphrase"),
    WedgeCase("program banana", "cnc-programming", "skill_cnc_programming", "paraphrase"),
    WedgeCase("surface grinding ka kaam", "grinding", "skill_grinding_ops", "paraphrase"),
    WedgeCase("thread katna", "cnc-machining", "skill_tapping_threading", "paraphrase"),
    WedgeCase(
        "micrometer se measurement",
        "metrology-quality",
        "skill_measuring_instruments",
        "paraphrase",
    ),
    WedgeCase("g code likhna", "cnc-programming", "skill_cnc_programming", "paraphrase"),
    WedgeCase("welding karna", "welding", "skill_welder_occupation", "paraphrase"),
    WedgeCase("job set karna", "cnc-machining", "skill_fixture_setup", "paraphrase"),
    # --- vernacular (require the RVM-ratified wedge aliases) ------------------------
    WedgeCase("kharad", "cnc-machining", "skill_turning", "vernacular", requires_wedge=True),
    WedgeCase(
        "kharad ka kaam", "cnc-machining", "skill_turning", "vernacular", requires_wedge=True
    ),
    WedgeCase("chhilai", "vmc-machining", "skill_milling", "vernacular", requires_wedge=True),
    WedgeCase("ghisai", "grinding", "skill_grinding_ops", "vernacular", requires_wedge=True),
    WedgeCase(
        "chudi katna", "cnc-machining", "skill_tapping_threading", "vernacular", requires_wedge=True
    ),
    # --- negatives (must stay UNRESOLVED; precision guards) -------------------------
    WedgeCase("biryani banana", "cnc-machining", UNRESOLVED, "negative"),
    WedgeCase("astrophysics lecturer", "cnc-machining", UNRESOLVED, "negative"),
    WedgeCase("computer typing", "cnc-programming", UNRESOLVED, "negative"),
    WedgeCase("security guard ki naukri", "cnc-machining", UNRESOLVED, "negative"),
    WedgeCase("driving licence hai", "cnc-machining", UNRESOLVED, "negative"),
    WedgeCase("english bolna", "metrology-quality", UNRESOLVED, "negative"),
    # --- cross-domain (the WHERE clause is load-bearing) ----------------------------
    WedgeCase("MIG welding", "cnc-machining", UNRESOLVED, "cross_domain"),
    WedgeCase("CNC programming", "welding", UNRESOLVED, "cross_domain"),
)
