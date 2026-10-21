# ADR-0058: A chat-built résumé is always professional English

- **Status:** Accepted. Owner ruling by Divyanshu, 2026-10-21.
- **Date:** 2026-10-21
- **Owner:** Divyanshu (Backend Platform)
- **Tracking:** #2387
- **Relates:**
  - §8 of the Resume Engine guideline ("the model never composes; there is no fourth source"). **Overridden** for the fields below.
  - [ADR-0039](0039-work-history-polish-section-8-override.md): the first §8 override (work-history polish). Its prohibitions are reused here unchanged.
  - [ADR-0045](0045-general-road.md): the general road's skills stage. Its prompt and its grounding wall are amended (§3.3).
  - [ADR-0047](0047-lift-pii-restriction.md): the masking policy. The new chip field is masked like every transcript line (§4).

## 1. Context

A worker profiled by chat alone (a CNC Turner, no form) received a résumé that printed his words as he typed or spoke them:

- **Headline:** `CNC Turner · 10 yrs · VMC chalata hun, let machine chalata hun, CNC programme khud feed karta hun`
- **Core Skills:** `… drawing padh lete ho, tolerance of repres season mein bhi Kafi experience, vernier use …`
- **Work History:** `donon per kam Kiya`

None of this was a rendering bug. The values come from Phase C (`extract_system_prompt`, the whole conversation in, résumé values out). That prompt was written to §8 and told the model to copy the worker's words and "not translate them into English". `RESUME_SYSTEM_PROMPT` writes only a `summary` blurb that nothing prints, so changing it would not have helped.

## 2. Decision (owner rulings, 2026-10-21)

1. **The résumé is always English.**
2. **Values are parsed professionally.** They are translated, filler is dropped, only the useful parts are kept, and each value is phrased the way a résumé would phrase it.
3. **A catch-all answer ("sab kiya hai", "sab aata hai") becomes the options the chat showed** for that question. The word itself is never recorded.
4. **The rewrite lives in the Phase C prompt.** It reads the whole conversation, so it can resolve "donon" (both) to the two machines named earlier. A per-row polish could not.
5. **The general road's skills stage follows the same rule.**

## 3. What changed

### 3.1 Phase C prompt (`apps/ai-service/app/profiling/interview_prompts.py`)

- Every value is returned in English: skills, job titles, `work_done`, domain and cities. Speech-to-text slips are repaired, filler is dropped and references are resolved.
- **`duration_text` stays verbatim.** It is never printed (#2358), and the API parses months from it.
- **Catch-all expansion.** A catch-all reply records every option that was on screen. System buttons ("Kuch aur", "Haan", "Nahi", "Bas", …) are excluded. If no options were shown, a catch-all records nothing.
- **ADR-0039's prohibitions are restated as the bound on the rewrite.** The model may not add:
  - a skill level;
  - a number the conversation lacks;
  - a machine the worker did not name or pick;
  - a responsibility he did not state;
  - praise.

### 3.2 The chips reach the model

- **API.** An assistant line now records the labels of the chips it showed:
  - in the buffer, as `BufferedMessage.options`;
  - in `chat_messages.metadata.options` at flush.

  This covers both pack options and Phase A's model chips. It is additive JSONB on an existing column, with no migration. The field is absent when a line showed no chips.
- **Contract.** `TranscriptLine.options` is an optional field in both Zod and Pydantic, and it is listed in the parity fixture. Only two calls send it:
  - the Phase C request;
  - the skills-stage history.

  The parse request, the legacy `/profile/extract` request and the classic Phase A history are unchanged, byte for byte.
- **ai-service.** Each line renders as `Bada Bhai: <question> [Options: A | B]`. A line without chips renders exactly as before.

### 3.3 General road (ADR-0045)

This road has no Phase C, so its skills print exactly as the skills stage stores them.

- **Prompt.** The skills prompt now asks for English labels. They must keep the worker's own product and trade words, because the API's grounding wall still requires one of those words to appear in his message. The prompt also expands a catch-all into the chips on screen.
- **Certifier.** `skill-certifier.ts` grounds a candidate that *equals* one of the chips on the question being answered, but only when the worker's message is a catch-all (`isCatchAllAnswer`, a closed token list). On any other message, a model that adds a chip the worker did not choose is still refused.

## 4. Privacy

- **Chip labels are platform text,** never the worker's words. That is why they may be stored in `chat_messages.metadata`.
- **The ai-service masks every chip on its own.** It uses the same masker as the line's text and drops any chip the gateway refuses. The posture follows `AI_RAW_PII_ENABLED`.
- **Output walls are unchanged.** Phase C's certification and the ADR-0047 G1 hard-identifier floor still run on every string the model returns.

## 5. What replaced the guarantee, and the residual risk

- **Phase C output can no longer be checked as a substring.** `extraction-verbatim.contract.test.ts` now checks only `duration_text`. The printed skills and `work_done` are bounded by the prompt's prohibitions alone.
- **This is the same trade ADR-0039 made,** now extended to skills, titles and descriptions.

The residual risk is a professional-sounding claim the worker did not make. Three things narrow it, and none of them closes it:

- the prohibitions;
- the raw transcript, which is kept in `chat_messages` for any dispute;
- reverting the prompt, which is a code change.

The own-words quote block on the `bb_trade` sheets will mostly print nothing for new profiles. It quotes only `work_done` text found verbatim in a worker turn, and English `work_done` will not match. That fits ruling 1.

**Catch-all expansion is a deliberate over-claim surface.** "sab" becomes every option shown. On the general road the expansion is limited to the exact chips that were on screen.

## 6. Rollout

- Behaviour changes on deploy. There is no flag.
- New extractions only. **Existing profiles are not re-extracted.** A worker's résumé changes on his next profiling run.
- Chips are stored only for chats held after the deploy. An older conversation that is re-extracted has no `[Options: …]`, so a catch-all in it records nothing.
- If `LANGFUSE_PROMPTS_ENABLED` is on and Langfuse holds a `worker-interview-extract` or `worker-interview-skills-turn` prompt, that copy overrides this one. The default is off.
