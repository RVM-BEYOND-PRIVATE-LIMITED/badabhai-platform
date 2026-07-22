"""The edge-case suite, run from pytest.

Two things are asserted:

1. the whole suite is GREEN against the real app (so CI notices the day any of
   these behaviours changes — including the labelled defects, which are asserted
   as CURRENT behaviour and become STALE the moment they are fixed);
2. the runner itself can FAIL. A suite that cannot go red is decoration, so a
   deliberately-wrong expectation and a no-longer-reproducing defect are both
   proven to fail.
"""

from __future__ import annotations

from cli_harness import transport

from app.cli import edge_cases
from app.cli.edge_cases import (
    ALL_CASES,
    Case,
    Seed,
    collects_exactly,
    records,
    run_suite,
)


def test_the_edge_case_suite_is_green():
    result = run_suite(transport(), ALL_CASES)
    assert result.ok, result.stale or [c.case.id for c in result.failed_cases]
    assert not result.stale, f"a known-defect expectation no longer reproduces: {result.stale}"


def test_the_suite_actually_covers_the_required_families():
    groups = {case.group for case in ALL_CASES}
    assert {
        "fabrication",
        "exclusion",
        "origin-vs-preference",
        "vague",
        "devanagari",
        "privacy",
        "robustness",
        "extraction",
        "flow",
    } <= groups
    ids = [case.id for case in ALL_CASES]
    assert len(ids) == len(set(ids)), "duplicate case id"


def test_every_defect_label_is_documented():
    """A defect id that is not explained in the module docstring is a label nobody
    can act on."""
    labels = {
        check.defect
        for case in ALL_CASES
        for check in case.checks
        if check.defect
    }
    assert labels, "expected labelled known-defect expectations"
    for label in labels:
        assert label in edge_cases.__doc__, f"{label} is not documented in edge_cases.py"


def test_all_seven_fabrication_probes_are_covered():
    """The strings from three review rounds, verbatim — these are the ones that bit
    us, so they may not be quietly dropped."""
    probes = {
        "angle grinder chalata hu",
        "mere bhai lathe operator hai",
        "lathe operator ka helper hu",
        "lathe operator banna chahta hu",
        "lathe operator ki salary kitni hoti hai",
        "pitaji lathe chalate hai",
        "lathe chalane ki training li hai",
    }
    covered = {m for case in ALL_CASES for m in case.messages}
    assert probes <= covered, probes - covered


def test_a_wrong_expectation_fails_the_suite():
    """The runner must be able to go RED."""
    bogus = Case(
        id="bogus",
        group="self-test",
        messages=("vmc operator hu",),
        seed=Seed(asked=("role",)),
        checks=(records("role", "Welder"),),  # the engine records "VMC Operator"
    )
    result = run_suite(transport(), [bogus])
    assert not result.ok
    assert result.failed_cases[0].case.id == "bogus"
    assert "FAILED" in edge_cases.render_summary(result)


def test_a_defect_that_no_longer_reproduces_is_reported_as_stale():
    """The other direction: a fixed defect must not keep passing silently."""
    stale = Case(
        id="stale-defect",
        group="self-test",
        messages=("vmc operator hu",),
        seed=Seed(asked=("role",)),
        # Claims a defect that does not exist: the engine DOES record the role.
        checks=(collects_exactly({}, defect="TD-NOT-REAL"),),
    )
    result = run_suite(transport(), [stale])
    assert not result.ok
    assert result.stale == [("stale-defect", "TD-NOT-REAL")]
    assert "STALE" in edge_cases.render_summary(result)


def test_main_exits_non_zero_when_the_suite_fails(monkeypatch):
    """The exit code is what makes the suite usable from a shell/CI."""
    from app.cli import onboarding_chat

    failing = Case(
        id="bogus",
        group="self-test",
        messages=("vmc operator hu",),
        seed=Seed(asked=("role",)),
        checks=(records("role", "Welder"),),
    )
    monkeypatch.setattr(
        onboarding_chat,
        "run_suite",
        lambda transport, *a, **k: run_suite(transport, [failing]),
    )
    monkeypatch.setattr(onboarding_chat, "_make_transport", lambda *_a, **_k: _NoClose())
    assert onboarding_chat.main(["--edge-cases"]) == 1


class _NoClose:
    """The shared transport with close() disabled (other tests reuse the client)."""

    def __init__(self):
        self._inner = transport()
        self.label = self._inner.label

    def post(self, path, payload):
        return self._inner.post(path, payload)

    def get(self, path):
        return self._inner.get(path)

    def close(self):
        return None


def test_the_suite_prints_a_readable_report():
    result = run_suite(transport(), ALL_CASES[:3], print_fn=lambda *_a, **_k: None)
    summary = edge_cases.render_summary(result)
    assert "=== SUMMARY ===" in summary
    assert "cases      :" in summary
    # Defect counts are surfaced, never hidden behind a green tick.
    assert "defects" in summary
