"""Pin guard: the AI service image installs exact, reviewed package versions.

requirements.txt and requirements-ai.txt say which versions the code supports (ranges);
constraints.txt says which versions ship (exact pins). Without the pins, any image build that
missed the Docker layer cache re-resolved the ranges and installed whatever was newest that
day, so a deploy could change library versions in production while no code changed.

These tests keep that from coming back:
  - every runtime requirement has an exact pin, inside the range its file allows;
  - the Dockerfile builds on a digest-pinned base and installs with the pins;
  - CI runs the suite against the same pins.

PURE / OFFLINE: reads files only. Whether the pins are COMPLETE for the whole dependency tree
(transitive packages included) is proven by building the image and comparing `pip freeze`
with constraints.txt, which needs network and is not repeated here.
"""

from __future__ import annotations

import re
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
CONSTRAINTS = SERVICE_ROOT / "constraints.txt"


def _requirement_lines(path: Path, seen: set[Path] | None = None) -> list[str]:
    """Requirement specifiers in ``path``, following ``-r`` includes, comments stripped."""
    seen = set() if seen is None else seen
    if path in seen:
        return []
    seen.add(path)
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("-r "):
            lines.extend(_requirement_lines(path.parent / line[3:].strip(), seen))
            continue
        lines.append(line)
    return lines


def _pins() -> dict[str, Version]:
    """constraints.txt as ``{canonical name: exact version}``; every line must be ``==``."""
    pins: dict[str, Version] = {}
    for raw in CONSTRAINTS.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        name, sep, version = line.partition("==")
        assert sep == "==" and version.strip(), (
            f"constraints.txt must pin exactly (name==version), got {line!r}"
        )
        key = canonicalize_name(name.strip())
        assert key not in pins, f"{key} is pinned twice in constraints.txt"
        pins[key] = Version(version.strip())
    return pins


def test_every_runtime_requirement_is_pinned_inside_its_range() -> None:
    pins = _pins()
    runtime = _requirement_lines(SERVICE_ROOT / "requirements-ai.txt")
    assert runtime, "requirements-ai.txt resolved to no requirements"
    for line in runtime:
        requirement = Requirement(line)
        key = canonicalize_name(requirement.name)
        assert key in pins, (
            f"{requirement.name} is required but has no pin in constraints.txt; "
            "the image would install whatever version is newest at build time"
        )
        assert requirement.specifier.contains(pins[key], prereleases=True), (
            f"{requirement.name}=={pins[key]} is outside the range {requirement.specifier} "
            "that its requirements file allows"
        )


def test_the_image_builds_on_a_pinned_base_and_installs_the_pins() -> None:
    dockerfile = (SERVICE_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(
        r"^FROM python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}\s*$", dockerfile, re.MULTILINE
    ), "the base image must be pinned by digest; a bare tag moves under an ordinary deploy"
    assert re.search(
        r"^COPY requirements\.txt requirements-ai\.txt constraints\.txt \./\s*$",
        dockerfile,
        re.MULTILINE,
    ), "the dependency layer must copy constraints.txt"
    assert re.search(
        r"^RUN pip install --no-cache-dir -r requirements-ai\.txt -c constraints\.txt\s*$",
        dockerfile,
        re.MULTILINE,
    ), "the image must install with -c constraints.txt"


def test_ci_runs_the_suite_against_the_same_pins() -> None:
    workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "run: pip install -r requirements-dev.txt -c constraints.txt" in workflow, (
        "the ai-service CI job must install with the image's pins"
    )
    assert "apps/ai-service/constraints.txt" in workflow, (
        "the pip cache key must hash constraints.txt, or a pin change reuses a stale cache"
    )
