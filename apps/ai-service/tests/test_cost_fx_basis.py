"""Token-audit fix D13 — one rupee basis for the cost ledger (`AI_COST_FX_INR_PER_USD`).

The rate table is written in rupees at ~Rs 83/US$; the providers bill in dollars. Set, the basis
prices every model with a US$ list price (and the web-search fee) at that many rupees per dollar.
Unset — the default and an empty pass-through — is today's table, row for row.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app import config as config_module
from app.ai import cost_tracker
from app.ai.model_config import (
    _DEFAULT_RATE_INR,
    _MODEL_LIST_PRICES_USD_PER_1M,
    _MODEL_RATES_INR,
    WEB_SEARCH_COST_INR,
    rate_inr_per_1k,
    web_search_cost_inr,
)
from app.config import Settings


@pytest.fixture
def basis(monkeypatch):
    """Run the process-wide basis at a given rupees-per-dollar (or unset)."""

    def _set(fx: float | None) -> Settings:
        settings = Settings(_env_file=None, ai_cost_fx_inr_per_usd=fx)
        monkeypatch.setattr(config_module, "_settings", settings)
        return settings

    return _set


def test_it_ships_unset():
    assert Settings.model_fields["ai_cost_fx_inr_per_usd"].default is None


@pytest.mark.parametrize("value", ["", "   "])
def test_an_empty_pass_through_is_unset_not_a_boot_failure(value):
    assert Settings(_env_file=None, ai_cost_fx_inr_per_usd=value).ai_cost_fx_inr_per_usd is None


@pytest.mark.parametrize("value", [0, -85, 1001, "eighty-five"])
def test_a_nonsense_basis_refuses_to_boot(value):
    # Zero would price every call at nothing, so the caps would never trip: fail closed.
    with pytest.raises(ValidationError):
        Settings(_env_file=None, ai_cost_fx_inr_per_usd=value)


def test_unset_is_todays_table_row_for_row(basis):
    basis(None)
    for model, rate in _MODEL_RATES_INR.items():
        assert rate_inr_per_1k(model) == rate, model
    assert rate_inr_per_1k("a-model-nobody-priced") == _DEFAULT_RATE_INR
    assert web_search_cost_inr() == WEB_SEARCH_COST_INR == 0.83


def test_a_basis_prices_listed_models_at_their_dollar_list_price(basis):
    basis(85.0)
    for model, (usd_in, usd_out) in _MODEL_LIST_PRICES_USD_PER_1M.items():
        assert rate_inr_per_1k(model) == pytest.approx((usd_in * 0.085, usd_out * 0.085)), model
    assert web_search_cost_inr() == 0.85


def test_a_basis_leaves_every_unlisted_row_as_it_was(basis):
    basis(85.0)
    unlisted = set(_MODEL_RATES_INR) - set(_MODEL_LIST_PRICES_USD_PER_1M)
    assert unlisted, "the fixture must contain an unlisted row for this test to mean anything"
    for model in unlisted:
        assert rate_inr_per_1k(model) == _MODEL_RATES_INR[model], model
    assert rate_inr_per_1k("a-model-nobody-priced") == _DEFAULT_RATE_INR


def test_the_dollar_list_reproduces_the_rupee_table_at_its_own_basis(basis):
    # Each rupee row was written from these list prices at ~Rs 83/US$, ROUNDED: 2.5 Flash-Lite's
    # input row is 0.008 where Rs 83 gives 0.0083 (the table under-reads it by ~3.6%, one of the
    # drifts a basis removes). Within 5%, so a typo in either table (a missing zero, a swapped
    # pair) fails here rather than in a reconciliation, while that rounding passes.
    basis(83.0)
    for model, rupee in ((m, _MODEL_RATES_INR[m]) for m in _MODEL_LIST_PRICES_USD_PER_1M):
        converted = rate_inr_per_1k(model)
        for at_83, table in zip(converted, rupee, strict=True):
            if table == 0:
                assert at_83 == 0, model
            else:
                assert abs(at_83 - table) / table < 0.05, (model, at_83, table)


def test_the_basis_reaches_a_priced_call(basis):
    settings = basis(85.0)
    assert settings.ai_cost_fx_inr_per_usd == 85.0
    model = "gemini-2.5-flash-lite"
    # 10,000 input + 1,000 output at $0.10 / $0.40 per 1M, at Rs 85.
    expected = round(10_000 / 1000 * 0.10 * 0.085 + 1_000 / 1000 * 0.40 * 0.085, 4)
    assert cost_tracker.estimate_cost_inr(model, 10_000, 1_000) == expected
