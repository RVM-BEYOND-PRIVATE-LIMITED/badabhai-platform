"""ONE builder for the metadata dict that rides every Langfuse observation.

WHY CENTRALIZE IT. Before this, each call site invented its own dict — the router put
``provider``/``attempt``/``temperature`` on a generation, the voice route put
``chunk_index``, the trace root got ``AICallMetadata.model_dump()`` — so no two
observations agreed on what a field was called or whether it was present. Every Langfuse
filter, dashboard and evaluator targets metadata BY KEY, so a key that is ``provider`` here
and ``provider_name`` there is not a naming nit: it is a dashboard that silently reports
half the traffic.

THE RULE FOR WHAT GOES IN HERE, and it is a short list on purpose: a field belongs in
metadata only if Langfuse has NO NATIVE HOME for it. Duplicating a native field is worse
than useless — the two copies drift, and the native one is what the UI, the pricing table
and the evaluators actually read. So these are deliberately ABSENT:

  model            -> native on a generation (``model=``); the router passes it there.
  environment      -> native, set once on the client (``environment=``).
  user / session   -> native, via ``propagate_attributes(user_id=, session_id=)``.
  tags             -> native, same call.
  tokens           -> native (``usage_details``), which is also what Langfuse prices from.
  input / output   -> native, and the ONLY fields the privacy mask rewrites.
  latency          -> native: an observation's wall-clock IS its duration.
  error text       -> native (``level`` + ``status_message``).

WHAT IS DELIBERATELY NOT COLLECTED. ``agent_version`` has no referent: there is no agent
and no agent loop in this service (every LLM interaction is one-shot text-in/JSON-out), so
emitting one would invent a dimension that does not exist. ``language`` is likewise absent
from the shipped contracts on the LLM paths — ``ProfileParseInput.language`` is the one
exception and it is passed explicitly by that caller rather than guessed here.

PRIVACY. Every value this builder accepts is a config id, a closed-set code, a count or a
bool. It never takes worker text. That is what makes it safe for metadata to be exempt from
the heavy masking that input/output get — though the mask still walks it, because
``_mask_value`` recurses into every container the SDK is handed.
"""

from __future__ import annotations

from typing import Any

#: Which service produced the observation. Constant today (only the ai-service traces),
#: but a trace with no producer is unattributable the moment a second one starts tracing.
SERVICE_NAME = "ai-service"

#: The observation-type vocabulary, previously raw string literals at every call site.
#: ``as_type`` is load-bearing — only a generation/embedding carries model, tokens and
#: cost — so a typo silently downgrades an observation to a plain span that no cost
#: dashboard will ever count.
AS_SPAN = "span"
AS_GENERATION = "generation"
AS_EMBEDDING = "embedding"


def build(
    *,
    workflow: str | None = None,
    task: str | None = None,
    provider: str | None = None,
    application_version: str | None = None,
    prompt_name: str | None = None,
    prompt_version: str | None = None,
    prompt_source: str | None = None,
    attempt: int | None = None,
    max_attempts: int | None = None,
    real_call: bool | None = None,
    error_category: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The standardized metadata dict. Absent values are OMITTED, never null-filled.

    Omission over ``None`` is deliberate and it is a Langfuse-specific choice: a key
    present with a null value still creates the metadata key in the UI's filter list, so
    null-filling would offer an operator a dozen filters that never match anything. A
    missing key reads as "not applicable here", which is the truth.

    ``extra`` is the per-call-site escape hatch for genuinely local dimensions (a chunk
    index, a gate name). It is merged LAST and may override a standard key — the caller is
    closer to the truth than this builder is, and a silent drop would be worse than a
    deliberate override.
    """
    metadata: dict[str, Any] = {"service": SERVICE_NAME}

    # Ordered so the dict reads top-down as "where am I, what am I doing, with what".
    if workflow is not None:
        metadata["workflow"] = workflow
    if task is not None:
        metadata["task"] = task
    if provider is not None:
        metadata["provider"] = provider
    if application_version is not None:
        metadata["application_version"] = application_version
    if prompt_name is not None:
        metadata["prompt_name"] = prompt_name
    if prompt_version is not None:
        metadata["prompt_version"] = prompt_version
    if prompt_source is not None:
        # "local" or "langfuse" — WITHOUT this, a prompt_version is ambiguous: a
        # Langfuse-managed v3 and a local content hash are both "the version", and only
        # one of them means the prompt is being managed outside the deploy.
        metadata["prompt_source"] = prompt_source
    if attempt is not None:
        metadata["attempt"] = attempt
    if max_attempts is not None:
        metadata["max_attempts"] = max_attempts
    if real_call is not None:
        metadata["real_call"] = real_call
    if error_category is not None:
        metadata["error_category"] = error_category
    if extra:
        metadata.update(extra)
    return metadata


def model_parameters(
    *,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    json_mode: bool | None = None,
    thinking_budget: int | None = None,
) -> dict[str, Any]:
    """Sampling parameters for a generation, in the SDK's ``model_parameters`` shape.

    Kept apart from :func:`build` because Langfuse treats these as a first-class field on a
    generation rather than free metadata, and because they answer a different question:
    metadata says which call this was, model_parameters says what was asked of the model.
    Two runs that differ only in temperature must be distinguishable without diffing
    metadata blobs — that is the whole basis of a later A/B.
    """
    params: dict[str, Any] = {}
    if temperature is not None:
        params["temperature"] = temperature
    if max_output_tokens is not None:
        params["max_output_tokens"] = max_output_tokens
    if json_mode is not None:
        params["json_mode"] = json_mode
    if thinking_budget is not None:
        params["thinking_budget"] = thinking_budget
    return params
