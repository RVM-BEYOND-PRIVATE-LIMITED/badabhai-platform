"""Sample fine-tune harness — offline dry-run, canary leakage gate, and the
HARD human gate on full compute (ADR-0018 §D5)."""

from __future__ import annotations

import pytest

from app.corpus.assemble import CorpusItem
from app.corpus.finetune_sample import (
    build_sft_examples,
    dry_run_finetune,
    evaluate_canary_leakage,
    run_full_training,
)


def _item(content: str) -> CorpusItem:
    return CorpusItem(
        source_kind="voice_transcript",
        source_ref="vn1",
        worker_id="w",
        consent_version="2026-06-01",
        deid_method="regex+gazetteer+residual-scan",
        deid_version="corpus-deid-1",
        content=content,
        token_count=len(content.split()),
        lang="hi",
    )


def test_dry_run_is_offline_and_never_serves():
    items = [_item("CNC lathe operator 5 years"), _item("VMC setting and fixtures")]
    r = dry_run_finetune(items)
    assert r.compute == "dry-run-cpu"
    assert r.served is False
    assert r.n_examples == 2


def test_dry_run_manifest_is_reproducible():
    items = [_item("CNC lathe operator 5 years")]
    assert dry_run_finetune(items).manifest_hash == dry_run_finetune(items).manifest_hash


def test_trainer_boundary_rejects_residual_pii():
    # A defense-in-depth gate: nothing with residual PII may reach the trainer.
    with pytest.raises(ValueError):
        build_sft_examples([_item("call 9876543210")])


def test_canary_leakage_gate_fails_a_leaking_model():
    canaries = ["CANARY-7Q2X", "CANARY-9Z1A"]
    leaking = evaluate_canary_leakage(["...the value is CANARY-7Q2X..."], canaries)
    assert leaking.passed is False
    assert leaking.leaked_count == 1

    clean = evaluate_canary_leakage(["a clean shop-floor answer"], canaries)
    assert clean.passed is True
    assert clean.leaked_count == 0


def test_full_training_is_human_gated_and_refuses():
    with pytest.raises(RuntimeError, match="human-gated"):
        run_full_training()
