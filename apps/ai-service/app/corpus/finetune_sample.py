"""Small-sample fine-tune harness + PII-leakage eval (ADR-0018 Decision 5).

This proves the data contract and the eval wiring WITHOUT spending compute:
  - :func:`build_sft_examples` formats PII-free corpus items into training rows,
    re-asserting (belt-and-suspenders) that nothing entering the trainer carries
    residual PII;
  - :func:`dry_run_finetune` runs a tiny, deterministic CPU dry-run that validates
    format + emits a content-hashed manifest — NO model weights, NO GPU, NO network;
  - :func:`evaluate_canary_leakage` is the PII-leakage / canary gate: given a
    (fine-tuned) model's generations and the canaries planted in training, a model
    that reproduces any canary FAILS and is never promoted;
  - :func:`run_full_training` is the HARD HUMAN GATE — it refuses. Real training
    compute (GPU spend) and any live serving are separate signed decisions (§7).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from .assemble import CorpusItem
from .deidentify import _has_residual_pii


@dataclass(frozen=True)
class DryRunFineTuneResult:
    """Outcome of the format-validating dry run. ``served`` is ALWAYS False."""

    n_examples: int
    deid_versions: tuple[str, ...]
    manifest_hash: str
    compute: str  # always "dry-run-cpu"
    served: bool  # always False


@dataclass(frozen=True)
class LeakageEvalResult:
    passed: bool
    leaked_count: int
    n_canaries: int


def build_sft_examples(items: tuple[CorpusItem, ...] | list[CorpusItem]) -> list[dict[str, str]]:
    """Format corpus items into continued-pretraining rows ``{"text": <de-id content>}``.

    Final fail-closed gate: if ANY item's content still trips the residual PII scan,
    raise — nothing with residual PII may reach the trainer.
    """
    examples: list[dict[str, str]] = []
    for item in items:
        if _has_residual_pii(item.content):
            raise ValueError(
                "residual PII in corpus content at trainer boundary — refusing (fail-closed)"
            )
        examples.append({"text": item.content})
    return examples


def dry_run_finetune(items: tuple[CorpusItem, ...] | list[CorpusItem]) -> DryRunFineTuneResult:
    """Validate format + emit a reproducible manifest. No weights, no GPU, no network."""
    examples = build_sft_examples(items)
    deid_versions = tuple(sorted({i.deid_version for i in items}))
    payload = json.dumps(
        {"examples": examples, "deid_versions": list(deid_versions)},
        sort_keys=True,
        ensure_ascii=True,
    )
    manifest_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return DryRunFineTuneResult(
        n_examples=len(examples),
        deid_versions=deid_versions,
        manifest_hash=manifest_hash,
        compute="dry-run-cpu",
        served=False,
    )


def evaluate_canary_leakage(generations: list[str], canaries: list[str]) -> LeakageEvalResult:
    """PII-leakage gate: a model PASSES only if NONE of the planted ``canaries``
    appears in its ``generations``. A single leak fails the model."""
    leaked = sum(1 for c in canaries if any(c in g for g in generations))
    return LeakageEvalResult(passed=leaked == 0, leaked_count=leaked, n_canaries=len(canaries))


def run_full_training(*_args: object, **_kwargs: object) -> None:
    """HARD HUMAN GATE. Full training compute (GPU spend) is escalation-only
    (CLAUDE.md §7; ADR-0018 §D5). This function intentionally refuses."""
    raise RuntimeError(
        "Full training compute is human-gated (GPU spend, CLAUDE.md §7). "
        "STOP: requires recorded human sign-off + a funded compute decision. "
        "Only dry_run_finetune() is authorized here."
    )
