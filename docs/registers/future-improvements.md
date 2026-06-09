# Future Improvements (Phase 2+)

Ideas worth keeping, not yet scheduled. This is a backlog of intent, not a
commitment. The authoritative deferral list is ADR-0001 and the Phase-1 plan;
this expands on them.

## Phase 2 — Monetization & matching (the deferred core)
- **Reach Engine** — the deterministic `reach → rank → pace → protect → learn`
  pipeline. LLMs assist; the engine decides. (`@badabhai/reach-engine` placeholder.)
- **Employer posting + unlock flow** — the revenue path: employers/agencies pay
  to unlock profiled candidates (workers stay free).
- **Payments + payouts + boosts** — gateway integration, agency payouts, paid
  visibility. Real legal/DPDP commercial flows.
- **Advanced matching** — use the already-frozen `embeddings` + `model_training`
  tables for semantic candidate↔role matching.

## AI / data
- **Real NER pseudonymization** replacing the heuristic gateway (pays down TD3).
- **Langfuse** wired for real LLM observability + eval (placeholder today).
- **Self-hosted / fine-tuned model** only if cost/latency/privacy demands it —
  the `model_training` + storage-tier schema keeps the door open (ADR-0001 #4).
- **BullMQ job pipeline** for extraction/transcription/embedding (pays down TD1).

## Platform & ops
- **Finalized RLS** + per-worker isolation (pays down R1/TD4).
- **Disaster-recovery runbook** + tested restore (pays down R5).
- **Secrets manager** + multi-environment promotion (pays down R8 / TD10).
- **Real provider integrations**: OTP, STT (Sarvam), payment gateway.

## Product / reach
- Worker app polish; **multilingual** chat (Hindi + regional) end to end.
- Employer-facing surface (beyond the internal ops console).
- Expansion beyond CNC/VMC to adjacent blue/grey-collar verticals.

> When an item here is picked up, move it into a sprint plan / ADR and link back.
