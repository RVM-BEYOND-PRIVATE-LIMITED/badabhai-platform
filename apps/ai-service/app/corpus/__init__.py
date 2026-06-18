"""Model-training corpus track (ADR-0018) — consent-scoped, de-identified, OFFLINE.

This package builds a PII-free training corpus from worker voice transcripts /
chat messages and a small-sample fine-tune + eval harness. Every guarantee is
FAIL-CLOSED and enforced by tests that are build-blockers (ADR-0018 §D2):

- consent gate: only active ``model_training`` consent admits a record;
- de-identification BEFORE corpus entry, exclude-on-doubt;
- the corpus item holds PII-free provenance + de-identified text ONLY;
- full training compute (GPU spend) is a HARD HUMAN GATE — :func:`run_full_training`
  refuses; only a tiny CPU dry-run harness exists here.

Nothing in this package reads a live DB, calls a network, or spends compute.
"""

from __future__ import annotations

from .assemble import AssemblyResult, CorpusItem, SourceRecord, assemble_corpus
from .consent_gate import ConsentDecision, ConsentRecord, resolve_consent
from .deidentify import DeidResult, deidentify_for_corpus
from .finetune_sample import (
    DryRunFineTuneResult,
    LeakageEvalResult,
    build_sft_examples,
    dry_run_finetune,
    evaluate_canary_leakage,
    run_full_training,
)

__all__ = [
    "AssemblyResult",
    "ConsentDecision",
    "ConsentRecord",
    "CorpusItem",
    "DeidResult",
    "DryRunFineTuneResult",
    "LeakageEvalResult",
    "SourceRecord",
    "assemble_corpus",
    "build_sft_examples",
    "deidentify_for_corpus",
    "dry_run_finetune",
    "evaluate_canary_leakage",
    "resolve_consent",
    "run_full_training",
]
