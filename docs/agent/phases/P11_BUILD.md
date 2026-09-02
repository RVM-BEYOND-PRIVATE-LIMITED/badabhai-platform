PHASE P11 — the posting chat becomes a parser, not a writer.

Work in apps/ai-service.

  payer types something
    -> the LLM emits deltas:
       { field_id, value_raw, value_normalized, confidence, evidence_span }
    -> POST to the SAME checkpoint endpoint the form uses
    -> the same draft

The delta shape is deliberately identical to pack_answers. Reuse the existing validator.

HARD RULES:
  - The model emits PHRASES only. The gazetteer turns phrases into canonical role ids.
  - The validator REJECTS any canonical id produced by the model. This already exists
    on the worker side. Reuse it. Do not write a second one.
  - value_raw must be a literal substring of what the payer typed. Same provenance
    gate as the worker-side parse gates.

COST: route this to the cheap tier. It is a short parse task.
The interview turn currently runs on gemini-2.5-pro, which does not fit the
4 rupees per profile cap. Do not repeat that here.
State which tier you chose and why.

INVARIANT: the model can never write a canonical id into a draft.
