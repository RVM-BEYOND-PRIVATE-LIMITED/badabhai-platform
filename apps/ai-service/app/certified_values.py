"""Clean-or-withhold for the résumé's single-value fields (issue #1739).

`pseudonymize.certified_clean_skill_labels` certifies the label LISTS (`skill_labels`,
`education`, `certifications`) at extraction and again at the résumé boundary. Other
model-authored values reached the same surfaces with no such certification: the location
preference (`location_preference.current_city` / `preferred_cities`, and the Phase C container's
`current_city` / `preferred_locations`, which `build_resume` reads FIRST) and the education level
and field. The payload gate in `routers/resume.py` masks what the MODEL sees, but `build_resume`
renders the résumé text and `resume_json` from the profile it is handed, so a value the gate
masked ("Ramesh, Pune") or never touched ("Welding, Anil Kumar") was printed verbatim.

ONE CERTIFIER, NOT A SECOND ONE. A single value goes through the very call the lists go through,
as a one-element list, so every rule applies identically: the gateway must not block, mask or
alter it; a name behind a released leading city or trade word is withheld; and the FIX-5
EMPLOYER rescue keeps real vocabulary the employer pattern over-fires on ("Diploma Mechanical
Engineering"). A second predicate here could drift from the lists' one, and then one résumé
line would print what the line beside it withholds.

WITHHELD MEANS ABSENT. A scalar becomes None and a list entry is dropped, never replaced by the
masked text (that would print "[PERSON_1]" on a worker's résumé). Every consumer already treats
these fields as optional, so absence is a shape they all render.

FAIL CLOSED, NEVER RAISE. Any error while certifying withholds the value, so the résumé still
completes. Nothing here logs, and nothing returns the gateway's text or its token mapping; the
only thing a caller learns is how many values were withheld.
"""

from __future__ import annotations

from .contracts import DraftProfile
from .pseudonymize import certified_clean_skill_labels


def certified_scalar(value: str | None) -> str | None:
    """``value`` unchanged when the gateway certifies it clean, else None (withheld)."""
    if value is None:
        return None
    try:
        kept = certified_clean_skill_labels([value])
    except Exception:  # defensive: an error withholds the value, it never passes it through
        return None
    return value if kept == [value] else None


def certified_items(values: list[str]) -> list[str]:
    """The entries the gateway certifies clean, in order. A failing entry is dropped alone;
    an error certifying the list withholds all of it."""
    if not values:
        return []
    try:
        return certified_clean_skill_labels(values)
    except Exception:  # defensive: see `certified_scalar`
        return []


class _Withholder:
    """Certifies values one at a time and counts what it withheld. The count is the only
    thing a caller may log: a withheld value is suspect PII."""

    def __init__(self) -> None:
        self.withheld = 0

    def scalar(self, value: str | None) -> str | None:
        certified = certified_scalar(value)
        if value is not None and certified is None:
            self.withheld += 1
        return certified

    def items(self, values: list[str]) -> list[str]:
        certified = certified_items(values)
        self.withheld += len(values) - len(certified)
        return certified


def certify_resume_single_values(profile: DraftProfile) -> tuple[DraftProfile, int]:
    """``profile`` with every #1739 field certified, plus how many values were withheld.

    The location is certified in BOTH places it lives. `build_resume` prints the container's
    `current_city` / `preferred_locations` ahead of `location_preference`, and every interview-led
    profile carries both, so certifying only the legacy pair would leave the line the résumé
    actually prints uncertified. A container value that is withheld leaves the legacy value (also
    certified here) to fill the line, the same fallback `build_resume` applies to a blank one.

    ``profile`` is not mutated; every other field is carried over as is.
    """
    gate = _Withholder()
    location = profile.location_preference
    update: dict[str, object] = {
        "education_level": gate.scalar(profile.education_level),
        "education_field": gate.scalar(profile.education_field),
        "location_preference": location.model_copy(
            update={
                "current_city": gate.scalar(location.current_city),
                "preferred_cities": gate.items(location.preferred_cities),
            }
        ),
    }
    container = profile.resume_profile
    if container is not None:
        update["resume_profile"] = container.model_copy(
            update={
                "current_city": gate.scalar(container.current_city),
                "preferred_locations": gate.items(container.preferred_locations),
            }
        )
    return profile.model_copy(update=update), gate.withheld
