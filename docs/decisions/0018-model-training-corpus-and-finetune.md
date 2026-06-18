# ADR-0018: In-house model-training track — consent-scoped, de-identified voice/transcript corpus → fine-tune

- **Status:** **PROPOSED — STOP, pending human/RVM + MANDATORY security sign-off.** Design artifact
  only. **Nothing is built or authorized.** **OFFLINE only.** **Full training compute (GPU spend)
  is a hard human gate** (CLAUDE.md §7). The corpus pipeline, the de-identifier, and any fine-tune
  run are handed to the engineer agents **only after this ADR + its security review are signed off**.
  No real voice/transcript PII is read or copied by this document.
- **Date:** 2026-06-17
- **Phase:** **Phase-2 moat — NOT alpha-gate.** Does not block or alter the alpha. The live
  profiling/AI path is untouched; this is an offline corpus + training track.
- **Author:** **ai-engineer (owns the AI/PII boundary — MANDATORY)** + system-architect (ADR) +
  database-architect (corpus tables) + **security-engineer (MANDATORY gate)**.
- **Relates / builds on:**
  - **CLAUDE.md invariant #2** — raw PII (phone, full name, address, employer, ID tokens) lives
    **only** in `workers`; it must **never** appear in events/`ai_jobs`/`audit_logs`/logs — **and,
    this ADR adds, never in the training corpus**. **Invariant #3** — pseudonymization runs before
    any LLM call and **fails closed**.
  - **`pseudonymize.py`** (the existing fail-closed gateway: PAN/Aadhaar/phone/employer/name/city
    detection, request-scoped mapping never persisted, blocks on residual digit runs). It is the
    **starting primitive** — but it is tuned for *LLM-call-time over-masking* and notes "real NER
    comes later" (**TD3**). A permanent corpus needs a **stronger, fail-closed de-identifier** (§D2).
  - **ADR-0010** (the consent architecture: append-only `worker_consents`, latest-row + revocation,
    `ConsentGuard` fail-closed pattern) — the corpus consent gate mirrors it.
  - **ADR-0017 / Q8** — confirmed there is **no `model_training`/`embeddings`/storage-tier table**
    in the schema; `worker_profiles.embedding` is for profiling. This ADR is the **first concrete
    use of the `model_training` consent purpose** and designs the corpus tables additively.
  - **Schema facts (verified 2026-06-17):** `model_training` **is** a `CONSENT_PURPOSES` value
    (`packages/types`). Voice/transcript PII lives in `voice_notes` (`storage_path` audio,
    `transcript_text`, `transcript_english`, `storage_class`/`retention_policy` tiers) and
    `chat_messages.body_text`. **No corpus/training table exists.**

---

## Context

The product captures the richest free-text PII in the system: **worker voice notes and their
transcripts/translations** (`voice_notes.transcript_text` / `transcript_english`) and **chat
messages** (`chat_messages.body_text`). Workers can grant a **`model_training`** consent purpose —
so a **lawful basis exists**. The moat opportunity: an **in-house fine-tuned model** (better
Hinglish/shop-floor understanding for profiling extraction) trained on this domain corpus.

**The governing principle, stated up front: consent ≠ a license to mishandle PII.** A worker
consenting to model training does **not** put their raw name/phone/employer into a training set.
Invariants #2/#3 still bind. The corpus must be **consent-scoped**, **de-identified before entry**,
**fail-closed**, and **revocable** — and the whole track is **offline**, with **full training
compute behind a human spend gate**.

This ADR fixes the architecture + privacy contract **before** a line of pipeline code, exactly as
ADR-0010 did for the unlock PII path.

---

## Decision

Define — **for sign-off, not for build** — the smallest honest **consent-scoped, de-identified
training corpus + offline fine-tune track** that: (a) admits **only** active-`model_training`-consent
workers, fail-closed; (b) **de-identifies transcripts before they ever enter the corpus** and
**excludes** anything it cannot confidently clean; (c) keeps raw PII in its existing boundary and
the corpus in a **separate, PII-free, tiered** store; (d) trains a small model **offline** with a
**PII-leakage eval**; and (e) records the **lawful-basis/DPDP** posture incl. revocation.

```
workers w/ active model_training consent (fail-closed gate, §D1)
        │  ONLY consented workers
        ▼
raw transcripts (voice_notes/chat_messages — PII, stay in place)
        │  read offline, per-record
        ▼
[DE-IDENTIFIER] §D2  — NER+heuristics, FAIL-CLOSED
   clean? ── no ──► EXCLUDE (never enters corpus; logged as a count only, no text)
        │ yes
        ▼  de-identified text ONLY (mapping never persisted)
[CORPUS STORE] §D3/§D4 — PII-FREE, tiered, provenance + consent_version per item
        │  offline
        ▼
[FINE-TUNE] §D5 — small model, SFT/LoRA on a SMALL SAMPLE (harness only)
        │   ▲ FULL training compute = HUMAN-GATED (spend) — STOP here
        ▼
[OFFLINE EVAL] §D5 — task metrics + PII-LEAKAGE / canary eval (no live serving)
```

### Decision 1 — Consent scope (fail-closed, tested)

- The corpus admits a worker's data **only if** their **latest** `worker_consents` row carries
  `"model_training"` in `purposes` **and** `revoked_at IS NULL`. A single server-side
  **`CorpusConsentGate`** is the only path that admits a record — **no bypass** (mirrors
  `ConsentGuard`, ADR-0010 §D4 chokepoint).
- **Fail-closed:** missing/ambiguous/revoked consent → the worker's records are **excluded**. Any
  error resolving consent → exclude (never "include on doubt").
- **Revocation propagates:** a revoked `model_training` consent **removes** that worker's items from
  the corpus and **excludes** them from future training. (Effect on an *already-trained* model is a
  documented retrain/forgetting posture, §D6 — not silently ignored.)
- **Test (gate):** a worker without active `model_training` consent contributes **zero** corpus
  items; a revoked worker's items are removed; table-driven across missing/expired/revoked/none.

### Decision 2 — De-identification BEFORE corpus entry (the privacy heart; MANDATORY security gate)

- **Nothing raw is ever copied.** Transcripts/messages are read, de-identified **in-process**, and
  **only the de-identified text** is written to the corpus. The original↔token mapping is
  **request-scoped, never persisted** (same rule as `pseudonymize.py`).
- **Detector:** start from `pseudonymize.py` (PAN/Aadhaar/phone/employer/name/city, fail-closed) and
  **harden it to corpus strength** — pay down **TD3** with real **NER** (multilingual/Hinglish) for
  person/employer/location, plus the existing regex ID/phone net. Names/employers/phones/IDs are
  **removed or tokenized** (`[PERSON_n]`/`[EMPLOYER_n]`/`[PHONE]`/`[ID]`) — never left in clear.
- **FAIL-CLOSED at corpus boundary:** a record is admitted **only if** de-id completes cleanly
  (no parse error, no residual digit run, NER confidence ≥ threshold). **Anything it cannot
  confidently clean is EXCLUDED** (over-exclusion is the safe direction). Exclusions are counted,
  **never logged with text**.
- **Audio is OUT for v1.** Raw audio (`voice_notes.storage_path`) is **biometric voiceprint PII** —
  a higher tier. v1 corpus is **transcript-text only**; audio/ASR fine-tuning is deferred to a
  separate decision with its own biometric-consent + threat model.
- **Proof obligations (security sign-off blockers, like ADR-0010 F-1/F-2):**
  - a **sentinel-PII test**: a transcript carrying a known name/phone/employer must appear **nowhere**
    in the corpus, the de-id logs, or any error string;
  - a **schema test**: no corpus table/column can hold raw text outside the de-identified field;
  - a **residual-PII scan** over an assembled sample asserts zero detector hits.

### Decision 3 — Storage tiers (raw PII stays put; corpus is a separate PII-free tier)

- **Raw PII boundary unchanged:** transcripts/audio stay in `voice_notes`/`chat_messages`
  (RLS-backlog, service-role today). **No raw PII is duplicated.**
- **Corpus is a distinct, access-controlled, PII-free store**, tiered with the existing
  `storage_class` concept (**hot** working set for active training; **cold** archive for retained
  corpus versions). De-identified content lives in object storage referenced by an **opaque** ref;
  the DB holds **only provenance metadata** (§D4). India data-residency (§D6).

### Decision 4 — Corpus data model (additive, PII-FREE — database-architect)

New additive tables (no existing column altered; join the RLS backlog). **No raw text, no PII.**

- **`training_corpus_items`** — one de-identified unit. Columns (illustrative): `id` uuid PK;
  `source_kind` enum(`voice_transcript`|`chat_message`); `source_ref` uuid (opaque pointer to the
  origin row — **the only identity link, like `applications.worker_id`**); `worker_id` uuid → FK
  `workers` (for consent/revocation joins **only**, never a feature/text); `consent_version` text;
  `deid_method` text; `deid_version` text; `content_storage_ref` text (opaque object-store key to the
  **de-identified** text); `token_count` int; `lang` enum; `created_at`. **No transcript/name/phone
  column exists.**
- **`training_corpus_versions`** — an immutable, content-hashed snapshot (manifest) of the items in
  a build (for reproducibility + which version trained which model).
- **CHECK/contract:** the de-identified content lives in storage, not the DB; the DB row is
  provenance only. Revocation deletes the worker's `training_corpus_items` + their object refs.

### Decision 5 — Fine-tune approach + eval (offline; full compute human-gated)

- **Task + model class:** domain-adapt a **small open model** (SFT/LoRA) on the de-identified
  transcript corpus to improve **profiling-extraction / Hinglish shop-floor understanding** — an
  *assist* to the AI service, **not** a model that ranks/decides matches (invariant #4) and **not**
  an LLM swapped into a decision path. Base model selection is part of the human-gated compute call.
- **Offline eval (defined now):** a held-out de-identified split; **task metrics** (extraction
  accuracy vs the gold set already used for the LLM flip) **and** a **PII-leakage eval** — insert
  **canary** strings + probe/membership-inference the fine-tuned model to prove it has **not
  memorized PII**. A model that leaks a canary **fails** and is never promoted.
- **v1 builds a SMALL-SAMPLE HARNESS only:** corpus-assembly + a format-validating, tiny dry-run
  fine-tune on a handful of de-identified examples (CPU/negligible) to prove the data contract and
  eval wiring. **Full training compute (GPU spend) is a HARD HUMAN GATE — STOP before it.**
- **No live serving:** a fine-tuned model is an offline artifact; wiring it into the AI service is a
  **separate** decision (staged behind `AI_ENABLE_REAL_CALLS`-style gating + its own eval), not here.

### Decision 6 — Lawful-basis / DPDP record

- **Purpose:** `model_training` — a **distinct, explicit** consent purpose (already in
  `CONSENT_PURPOSES`); never bundled into profiling consent. **`consent_version` is stamped per
  corpus item** for auditability.
- **Data minimization:** transcript-text only (no audio v1), **de-identified**, only consented
  workers — the least PII that achieves the purpose.
- **Revocation / erasure:** a revoked consent removes the worker's corpus items (§D1/§D4); the
  **retrain/forgetting** posture for already-trained models is documented (re-train from the current
  corpus on a schedule; the corpus is the source of truth so removed items don't re-enter).
- **Retention + residency:** corpus retention tied to consent validity; PII-class data stays in an
  **India region** (Q6 launch gate). **Production DPDP legal copy for `model_training` is a launch
  gate** (CLAUDE.md §8) — the lawful-basis *architecture* is fixed here; the legal wording is the
  human/legal track.

---

## Q8 — refines the ADR-0017 resolution

The `model_training` consent purpose's **first concrete use** is **this** de-identified
voice/transcript corpus. The `model_training`/storage tables Q8 imagined **do not exist** and are
designed **additively + PII-free** here (§D4), only if/when the build is authorized — confirming
ADR-0017's resolution (embeddings = profiling; no frozen ML tables) and giving the consent purpose a
concrete, privacy-bounded home.

---

## Gate review (folded in) — design-level; MANDATORY re-run on the built artifacts

### bb-security-review (MANDATORY — security-engineer)
- **Consent-scoped, fail-closed** admission (§D1) — only active `model_training` consent; revocation
  propagates. ✅ design; **test required** on the build.
- **No raw PII in the corpus or logs** (§D2/§D4) — de-id before entry, exclude-on-doubt, corpus
  tables are provenance-only, mapping never persisted. **Proof obligations** (sentinel-PII test,
  schema test, residual-PII scan) are **BUILD-BLOCKERS** mirroring ADR-0010 F-1/F-2. ⛔→✅ on tests.
- **De-identifier strength** — `pseudonymize.py` is the start but **must be hardened (TD3 NER)** to
  corpus strength before any real corpus is assembled; over-exclusion is the safe default.
- **No biometric audio** in v1 (§D2). **PII-leakage/canary eval** gates the model (§D5).
- **Verdict:** design is soundly fail-closed; **BUILD is blocked until §D2 proof tests + the
  hardened de-identifier are pinned, and security-engineer signs off the realized feature/data set.**
- **Human-gated:** full training compute/spend; production DPDP copy; any audio/biometric track; any
  live serving of a fine-tuned model.

### bb-architecture-review
- **In phase scope** (Phase-2 moat, gated). ✅ **Privacy boundary**: raw PII never leaves
  `workers`/`voice_notes`/`chat_messages`; corpus is a separate PII-free tier. ✅ **Additive
  contracts** (new tables, no mutation; invariant 8). ✅ **No live path touched**; offline only;
  compute gated. ✅ **ADR-worthy** — new subsystem + highest-PII data flow → this ADR. Decision
  **unresolved until human + security sign-off (STOP).**

---

## EXPLICITLY OUT — hard boundary

- **No raw PII or raw audio in the corpus** (transcript-text only, de-identified, v1).
- **No full training compute / GPU spend** without a human gate.
- **No live serving** of any fine-tuned model (separate gated decision).
- **No biometric voiceprint / ASR training** (separate decision + biometric consent + threat model).
- **No bypass of consent or de-id** — both are fail-closed chokepoints.
- **No model that ranks/decides** (invariant #4) — this is a profiling *assist* only.
- **No production DPDP legal copy authored here** (launch gate).

---

## STOP — sign-off required before ANY implementation

1. **Human/RVM sign-off** on §D1–§D6 (consent scope, de-id strength, storage tiers, corpus model,
   fine-tune/eval, lawful-basis).
2. **MANDATORY security-engineer sign-off** on the data flow + the §D2 proof obligations.
3. Then hand off: **ai-engineer** (de-identifier hardening + corpus pipeline + eval — owns the PII
   boundary), **database-architect** (the additive PII-free corpus tables), **security-engineer**
   (review the realized data set + tests).
4. **Full training compute and any live serving remain separate human gates.**

**Do not proceed past this line without recorded human + security sign-off.**

---

## Related

- CLAUDE.md §2 (invariants 2, 3, 6, 8) · §8 (deferred: real model training, production DPDP copy)
- `apps/ai-service/app/pseudonymize.py` (the fail-closed de-id primitive; TD3 to harden)
- ADR-0010 (consent chokepoint + fail-closed PII-disclosure pattern this mirrors)
- ADR-0017 (Q8 — embeddings = profiling; no frozen ML tables; this is the consent's first use)
- `packages/db/src/schema.ts` (`voice_notes`, `chat_messages`, `worker_consents`, `workers`)
- `packages/types` (`CONSENT_PURPOSES` includes `model_training`)
- Open-questions Q6 (data residency) · TD3 (real NER pseudonymization)
