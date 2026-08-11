"""AI service configuration (env-driven).

Real LLM calls are gated and FAIL CLOSED: they require AI_ENABLE_REAL_CALLS=true
AND a direct Gemini key (GEMINI_FLASH_API_KEY). The real provider is Google AI
Studio (Gemini) reached over REST — there is NO LiteLLM proxy. Default mock-only.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Schemes redis-py's ``from_url`` accepts. It validates these EAGERLY at client
# construction (no network — it raises before any I/O), so a malformed value would
# otherwise surface as a bare ValueError from deep inside the redis lib that never
# names the variable that is actually wrong.
_REDIS_URL_SCHEMES = ("redis://", "rediss://", "unix://")


def _parse_csv(value: str) -> tuple[str, ...]:
    """Split a comma-separated setting into an ordered, de-duplicated tuple.

    Order-preserving (``dict.fromkeys``, not ``set``) because the RFS lists encode
    a priority the model is told to work through. Blanks are dropped, so a trailing
    comma or a wrapped multi-line template value parses cleanly.
    """
    return tuple(dict.fromkeys(part.strip() for part in value.split(",") if part.strip()))


class ConfigError(Exception):
    """A setting is malformed — raised at ``Settings()``, i.e. at STARTUP.

    DELIBERATELY NOT a ValueError (or AssertionError). §2, and this is subtle enough to
    be worth stating: pydantic converts ValueError/AssertionError raised inside a
    validator into a ``ValidationError``, which RECORDS THE OFFENDING INPUT VALUE. Even
    with ``hide_input_in_errors=True`` — which does clean ``str()`` and ``repr()`` —
    ``ValidationError.errors()`` and ``.json()`` still carry
    ``'input': 'redis://user:pass@host'`` verbatim. This model holds almost nothing but
    credentials, so that is a live leak path for any structured error handling.

    Pydantic propagates any OTHER exception type unwrapped, so raising this keeps the
    message we control as the only thing that can be rendered: no ``.errors()``, no
    ``.json()``, no input echo, nothing in the traceback. Verified by test
    (``test_malformed_spend_redis_url_error_never_leaks_the_credential``).
    """


# AI-ENV-1: the env_file is ANCHORED to this package, never resolved against the
# CWD. `env_file=".env"` is CWD-relative, so `uvicorn app.main:app` from the repo
# root silently loaded the ROOT .env (the NestJS API's) instead of the ai-service's
# — and the two define OVERLAPPING names with INCOMPATIBLE meanings. Loading the
# wrong file is silent: you get a stall, not an error. parents[1] == apps/ai-service/
# (parents[0] == app/), so this resolves identically from ANY working directory.
_AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    # hide_input_in_errors: §2. Pydantic echoes the offending INPUT VALUE into every
    # validation error by default (``input_value='redis://user:pass@host'``), and this
    # model holds nothing BUT credentials — provider keys, the service-role key, the
    # internal tokens, the ledger URL. A boot-time validation error is printed to logs
    # and CI output, so the default would leak whichever secret was misconfigured. This
    # also closes the same latent leak in TD67's ``ai_internal_token`` min_length check
    # (a short token was previously echoed verbatim). Error messages must name the
    # FIELD, never its value.
    model_config = SettingsConfigDict(
        env_file=_AI_SERVICE_ROOT / ".env",
        extra="ignore",
        hide_input_in_errors=True,
    )

    ai_enable_real_calls: bool = False
    # Per-task allowlist for real calls (comma-separated TaskTypes, e.g.
    # "profile_extraction"). Lets real calls be enabled for ONE role/task while
    # every other task stays on the mock path. EMPTY = NO tasks (fail-closed,
    # owner-ruled 2026-08-01): a real call requires the task to be explicitly
    # listed. The master flag + key are still required regardless.
    ai_real_call_tasks: str = ""

    # COST-4: the profiling chat turn returns the deterministic question_bank
    # question DIRECTLY (already ≤20 words, on-persona) and skips the chat LLM
    # entirely on the straight-line path — zero output tokens on the ask. When TRUE,
    # an off-script/clarifying worker message (interview_engine.needs_rephrase) MAY
    # spend one real LLM call to phrase a contextual reply — still gated by the
    # master real-call flag + key. Off by default: templated-only, no chat LLM call.
    ai_profiling_rephrase_enabled: bool = False

    # Send EVERY profiling chat turn to the model, not just clarifying ones.
    #
    # This deliberately overrides the COST-4 straight-line optimisation above: with it
    # on, each turn spends one real call so the model phrases the engine's question
    # instead of serving the templated string verbatim. Off by default — turning it on
    # multiplies chat cost by roughly the number of questions in the interview.
    #
    # WHAT IT DOES NOT CHANGE, and this is the point: the ENGINE still chooses which
    # topic is asked and in what order (interview_engine._next_topic). The model only
    # rephrases the chosen question. LLMs assist, they never decide (CLAUDE.md §2 #4).
    #
    # The job-prospect exclusion is NOT relaxed by this flag. That turn serves the §5
    # guarantee line — a fixed, sanctioned refusal ("Guarantee nahi de sakta — ...")
    # that a rephrase could soften into the promise §2 Law 9 forbids. It stays
    # templated on every path.
    ai_profiling_llm_every_turn: bool = False

    # =========================================================================
    # GENERALIZED PROFILING — the LLM-driven chat path
    # =========================================================================
    # The old flow chose questions from a hardcoded Python question bank keyed to
    # 7 hardcoded role families, so supporting a new trade meant editing code. In
    # the new flow the LLM asks its own questions and the only thing fixed is WHAT
    # IT MUST COME AWAY WITH — the Resume Field Set below. That set is DATA: adding
    # a field, or changing what gates completion, is an env edit, never a code edit.
    # This is the whole point of "generalized profiling".

    # --- The Resume Field Set (RFS) -----------------------------------------
    # REQUIRED gates `is_complete`: the interview is not done until every one of
    # these is captured (or the worker declined it, or the turn cap fires). These
    # are persona Law 4's six askable fields with location split in two, exactly as
    # the law itself demands ("current AND preferred, never conflated").
    profiling_required_fields: str = (
        "trade,skills,experience_years,current_city,"
        "preferred_locations,salary_expected,availability"
    )
    # OPTIONAL is CAPTURED-IF-VOLUNTEERED, never asked. Law 4 governs what the model
    # may ASK, not what it may RECORD — a worker who mentions ITI or a licence
    # unprompted gets it on their resume without the model ever having to ask.
    # Trade-agnostic by construction: `tools_equipment` is a VMC + Fanuc for a
    # machinist, an overlock for a tailor, a tandoor for a cook, an LMV class for a
    # driver. No per-trade code anywhere.
    profiling_optional_fields: str = (
        "tools_equipment,salary_current,education_level,education_field,"
        "certifications,work_history,languages,relocation_willingness"
    )

    # --- Interview bounds ----------------------------------------------------
    # HARD turn cap. The interview ends when the model self-declares complete OR
    # this fires, whichever comes first. With a real LLM call per turn this is the
    # per-worker cost ceiling, so it is deliberately env-tunable: the deleted engine
    # carried the same bound as a source constant (MAX_ENGINE_ASKS) whose history
    # records it being changed 15->20->22->24 by code edit each time.
    profiling_max_turns: int = Field(default=30, ge=1, le=200)
    # Rolling history window sent to the model, in TURNS (a turn = worker + reply).
    # Re-sending the whole transcript every turn makes input cost grow O(n^2); the
    # previous design dodged that by sending NO history at all, which is why the
    # model could not ask a follow-up. A window keeps context without the quadratic:
    # cost becomes O(n * window) instead of O(n^2). 0 = unbounded (send everything).
    profiling_history_max_turns: int = Field(default=20, ge=0, le=200)

    # --- Persona guard -------------------------------------------------------
    # The persona spec is unusually mechanical (one "?", <=20 words, a CLOSED
    # acknowledgement set, an explicit banned-word list, no "!", no emoji), so most
    # of it is ENFORCEABLE rather than merely requested. The guard checks each reply
    # and, on a violation, retries once quoting the specific broken rule; if that
    # also fails it serves a safe templated question. Off => prompt-only (the model's
    # word is taken as final), which is a drift risk a real worker would see.
    profiling_persona_guard_enabled: bool = True
    profiling_max_reply_words: int = Field(default=20, ge=1, le=200)
    # Repair attempts per turn on a guard violation. Each one is a real LLM call, so
    # this trades money for on-spec replies. 0 = detect and fall back, never repair.
    profiling_persona_repair_retries: int = Field(default=1, ge=0, le=3)

    # --- Job-domain RAG match (runs ONCE, at the end, never per turn) ---------
    # After the chat completes, the summary is embedded and matched against the
    # job_domain catalog: ANN -> top-K shortlist -> the model picks one -> the id is
    # RE-VALIDATED against the DB before anything is persisted. Below the floor the
    # profile is stored UNRESOLVED — a wrong domain is worse than no domain, so a
    # match is never forced. Wiring flag off until the catalog is seeded (Phase 1).
    domain_match_enabled: bool = False
    domain_match_top_k: int = Field(default=10, ge=1, le=50)
    domain_match_floor: float = Field(default=0.55, ge=0.0, le=1.0)
    # The NO-MODEL shortcut. When one candidate is both very close AND clearly ahead of
    # the runner-up, there is nothing for a model to weigh: it is picked directly,
    # deterministically, for free, and recorded as `matched_auto` so the two paths stay
    # distinguishable in the data. Both conditions are required — a high score with a
    # near-tied runner-up ("Lathe Operator" 0.87 vs "Lathe Maintenance Fitter" 0.86) is
    # exactly the case that NEEDS judgement, and is precisely where a score-only rule
    # would get it wrong most confidently.
    domain_match_auto_floor: float = Field(default=0.88, ge=0.0, le=1.0)
    domain_match_auto_margin: float = Field(default=0.08, ge=0.0, le=1.0)

    # --- Per-task model routing overrides ------------------------------------
    # model_config.py used to hardcode these. They are the levers that decide both
    # answer quality and per-turn cost, so they belong in env.
    #
    # CHAT TIER moves cheap -> capable. The cheap tier was correct when the model
    # only had to REPHRASE a question the engine had already chosen; it now has to
    # conduct the interview, track the RFS, and emit strict JSON in Hinglish.
    ai_chat_model_tier: str = "capable"
    # 48 was sized for the SHIPPED MOCK path (model_config.py's own note: "Raise the
    # cap then if it bites"). The new turn returns a JSON object carrying reply_text
    # + chips + missing_fields + captured values, so 48 would truncate every reply.
    ai_chat_max_output_tokens: int = Field(default=512, ge=16, le=8192)
    ai_chat_temperature: float = Field(default=0.3, ge=0.0, le=2.0)
    ai_chat_max_retries: int = Field(default=1, ge=0, le=5)

    ai_extraction_max_output_tokens: int = Field(default=1024, ge=16, le=8192)
    ai_extraction_temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    ai_extraction_max_retries: int = Field(default=2, ge=0, le=5)

    # OIE Phase 7 acceptance criterion: parse p95 < 6 s. A HARD DEADLINE is how that becomes a
    # property of the route instead of a hope about the provider — `gemini_timeout_seconds` (30 s)
    # times the retry chain is an order of magnitude past the budget, and the worker is waiting on
    # this call to see their finished profile. On expiry the parse degrades to the deterministic
    # projection, which is a real profile; the overlay is the only thing lost.
    profile_parse_deadline_seconds: float = Field(default=6.0, gt=0.0, le=60.0)

    # The same hard bound for the LEGACY `/profile/extract` route, which shipped without one.
    # `apps/api` aborts that request at 8 s and Starlette does not cancel a running handler on
    # client disconnect, so an unbounded call outlived its caller and kept hitting a provider
    # that was already rate-limiting us — long after the profile had been written from the
    # fallback. 7 s sits just inside the caller's abort, so the deadline fires here (named,
    # logged, `error_code` set) rather than presenting as an unexplained socket close.
    profile_extract_deadline_seconds: float = Field(default=7.0, gt=0.0, le=60.0)

    # The Phase A turn deadline — a WORKER IS WAITING ON THIS ONE, which is what makes it
    # different from every other deadline in this file. The deterministic turn it replaces
    # answers in ~77 ms, so any budget here is a large regression by construction; the owner has
    # accepted that for this stage, and the number's job is to bound how bad it can get rather
    # than to be fast. On expiry the API serves its own authored question, so the cost of the
    # timeout is a less tailored interview, never a failed turn.
    #
    # DELIBERATELY LARGER than `profile_parse_deadline_seconds` (6.0): that one degrades an
    # overlay on a profile the worker never sees being built, while this one is the question in
    # front of them — and a fallback question mid-conversation is more jarring than a slow one.
    profiling_turn_deadline_seconds: float = Field(default=10.0, gt=0.0, le=60.0)

    ai_resume_max_output_tokens: int = Field(default=512, ge=16, le=8192)
    ai_resume_temperature: float = Field(default=0.4, ge=0.0, le=2.0)
    ai_resume_max_retries: int = Field(default=1, ge=0, le=5)

    # --- Gemini transport ----------------------------------------------------
    # Previously module constants in ai/gemini_client.py, kept env-tunable so a tier
    # change never needs a deploy.
    #
    # `gemini_max_total_backoff_seconds` is the bound that matters and the one that was
    # missing: the per-sleep cap alone allowed
    # max_rate_limit_retries * max_backoff_seconds = 4 * 20s = 80s stalled INSIDE a
    # single request — against `profile_parse_deadline_seconds` of 6s and an `apps/api`
    # abort at 8s. Time spent past those is spent on a response nobody is left to
    # receive. The retry chain must fit inside the deadline it is running under, so the
    # ceiling is CUMULATIVE and the defaults are small (one retry, ~5s of total sleep).
    gemini_api_base: str = "https://generativelanguage.googleapis.com/v1beta/models"
    gemini_timeout_seconds: float = Field(default=30.0, gt=0.0, le=600.0)
    gemini_max_rate_limit_retries: int = Field(default=1, ge=0, le=10)
    gemini_max_backoff_seconds: float = Field(default=20.0, gt=0.0, le=300.0)
    gemini_max_total_backoff_seconds: float = Field(default=5.0, gt=0.0, le=300.0)
    gemini_backoff_base: float = Field(default=2.0, gt=1.0, le=10.0)
    # Gemini "thinking" tokens. 0 = off, the cost decision for a chat turn. A future
    # capable-tier extraction may want >0 without a code change.
    gemini_thinking_budget: int = Field(default=0, ge=0, le=32768)

    # Direct Google AI Studio (Gemini) API key. The PRIMARY real-call credential
    # and the master gate for real calls (see real_calls_blocked_reason). The
    # field name maps to the env var GEMINI_FLASH_API_KEY (pydantic-settings is
    # case-insensitive). Optional so mock mode boots without it.
    gemini_flash_api_key: str | None = None

    # Anthropic (Claude) API key — credential for the FALLBACK provider only.
    # Maps to env ANTHROPIC_API_KEY. Its presence ADDS Claude Haiku to the
    # router's provider-fallback chain; it is NOT a master gate (Gemini's key
    # still governs whether real calls happen at all). Optional.
    anthropic_api_key: str | None = None

    # Model routing. Cheap model handles high-volume chat turns; the capable
    # model handles strict-JSON extraction. Bare Gemini model ids (no provider
    # prefix). Defaults are REAL Gemini ids so the service resolves a valid model
    # even when .env is absent; .env overrides them per environment.
    #
    # PINNED PROD EXTRACTION MODEL = gemini-2.5-flash (ADR-0008 "capable" tier +
    # docs/ai/enable-real-llm-extraction.md). This default now MATCHES the runbook so
    # the model that ships in prod == the model the gold set is validated on (resolves
    # GO/NO-GO Finding 4 / Q3: validation-model must equal flip-model). Real calls stay
    # OFF by default (AI_ENABLE_REAL_CALLS=false); this only fixes WHICH model is used
    # when extraction is turned real. The clean 56-case re-validation + p95 on this
    # exact model is the remaining (human-gated) gate before any flip.
    default_cheap_model: str = "gemini-2.5-flash-lite"
    default_capable_model: str = "gemini-2.5-flash"
    # Cross-provider FALLBACK model: tried by the router only AFTER the primary
    # (Gemini) candidate fails, and only when anthropic_api_key is set and this
    # model's provider differs from the primary's. Claude Haiku 4.5 (no date
    # suffix per the Anthropic API).
    default_fallback_model: str = "claude-haiku-4-5"

    # ADR-0030 / TAX-3: embedding model for the skill-vocabulary embed (offline corpus +
    # later the request-path resolver). MUST output the 768-dim vector skill_alias.embedding
    # + worker_profiles.embedding store. VERIFIED LIVE at the first gated run (2026-07-14):
    # `gemini-embedding-001` + outputDimensionality=768 -> HTTP 200, 768 dims (the request
    # sets the dimensionality; vectors are L2-normalized client-side since truncated dims
    # come back unnormalized). `text-embedding-004` is RETIRED (provider 404s it).
    # Real embedding calls are gated by AI_ENABLE_REAL_CALLS + the per-task allowlist
    # ("skill_embedding"); the default path is a deterministic MOCK embedding (zero spend).
    embedding_model: str = "gemini-embedding-001"

    # ADR-0030 / TAX-4: skill-phrase canonicalization (vector match against skill_alias,
    # floor-gated). `enabled` is the WIRING flag — when False the extraction path keeps the
    # status quo (local gazetteer only, raw phrase preserved); rollback = flip it off. `floor`
    # is the min cosine similarity to ASSIGN an id; below it the phrase is UNRESOLVED and
    # recorded. `top_k` bounds the nearest-alias fetch.
    #
    # FLOOR = 0.75 — CALIBRATED on the TAX-5 labeled wedge set (2026-07-14, REAL
    # gemini-embedding-001@768 vectors, tests/wedge_eval/scores_2026_07_14.json).
    # TWO recall numbers, honestly scoped (#225 review M1):
    #   ORACLE (each phrase scored in its correct domain): precision 1.000/recall 0.800.
    #   SHIPPED anchor-domain path (every label queried in the default domain until
    #   per-label domain resolution, TAX-6): precision 1.000 / recall 0.350 — the
    #   number that applies when the flag flips TODAY. Do not cite 0.800 for launch.
    # Floor safety: labeled-domain negative ceiling 0.598, sibling-confusion ceiling
    # 0.722, ANCHOR-path negative ceiling 0.7263 — 0.75 clears all three (next TP
    # 0.7815). Re-sweep (embed_wedge + score-wedge) on any corpus/model change; the
    # wedge tests pin snapshot-model == this config's embedding_model. Never hand-tune.
    skill_canonicalize_enabled: bool = False
    skill_canonicalize_floor: float = 0.75
    skill_canonicalize_top_k: int = 5
    # Anchor skill domain for the wedge when the extraction wiring canonicalizes labels and no
    # finer per-label domain is known yet (per-label multi-domain resolution is TAX-5/6).
    skill_canonicalize_default_domain: str = "cnc-machining"

    # ADR-0030 / TAX-7: growth-loop clustering defaults (/growth/cluster — pure compute,
    # REPORT-ONLY; the ratification flow is the only activation path, so these tune what
    # gets PROPOSED to a human, never what activates). Eligibility: cluster size >=
    # min_cluster_size OR summed count >= min_total_count. cluster_threshold is the
    # leader-cosine to join a cluster. band_low..floor is the "near-skill" band → an
    # alias-on-existing-skill proposal; below band_low → provisional-skill proposal
    # (calibration 2026-07-14: negative ceiling 0.598, sibling confusion 0.722 — 0.60
    # keeps genuinely-unrelated phrases out of alias proposals while catching the
    # kharad-at-0.61 class the wedge evidence is built on).
    skill_growth_min_cluster_size: int = 2
    skill_growth_min_total_count: int = 3
    skill_growth_cluster_threshold: float = 0.80
    skill_growth_band_low: float = 0.60

    # FORK-B-1 seam A: the NestJS api base URL + the SCOPED skills-seam secret the
    # HttpSkillStore uses for the INTERNAL skill routes (nearest-aliases / unresolved).
    # SKILLS_INTERNAL_TOKEN is deliberately NOT the api's all-routes
    # INTERNAL_SERVICE_TOKEN (least privilege, #222 review): this credential opens ONLY
    # the two skills routes — never resume-PII/money routes. The ai-service stays
    # DB-FREE — the api runs the authorized vector/upsert queries. Both unset by
    # default → get_skill_store() returns the NullSkillStore (inert), so the wiring
    # cannot activate by flag alone (TD65 chain: store + flag).
    backend_api_url: str | None = None
    skills_internal_token: str | None = None

    # TD67: the ONE service-level bearer for THIS service's routes. When set, every
    # route except /health requires the exact value in `x-ai-internal-token`
    # (timing-safe compare); unset (default) keeps the historical internal-only OPEN
    # posture — flipping it on is a staging env action on BOTH sides (the api's
    # AI_INTERNAL_TOKEN + the db runners' env), never a committed file. Deliberately
    # ONE token for the whole service (the TAX-7 review's "no per-route one-offs").
    # Distinct from skills_internal_token, which guards the REVERSE (ai→api) direction.
    # min_length mirrors the api's Zod .min(16) ON THE ENFORCING SIDE: an EMPTY or short
    # value (e.g. a templated `AI_INTERNAL_TOKEN=` placeholder) fails Settings() at
    # STARTUP instead of arming the gate vacuously — compare_digest("", "") is True, so
    # an empty token would pass every tokenless request while /health claimed the guard
    # was on AND 401'd correctly-tokened callers (the TD67 review's HIGH).
    ai_internal_token: str | None = Field(default=None, min_length=16)

    # Per-profile cost guardrails (INR). Used for alerting only in Phase 1.
    #
    # RAISED for the generalized profiling flow (Rs 4/6 -> Rs 15/20). The old numbers
    # were sized for a chat that spent ZERO output tokens on the straight-line path —
    # the engine served its templated question and the LLM was never called. Every
    # turn is now a real call, so a full interview is ~1 call per turn plus the
    # summarize + domain-match + extraction + resume calls at the end. Rs 4 was not a
    # budget for that shape of work; it was a budget for not doing it.
    #
    # These remain ALERT/TARGET values, not enforcement. The hard stops are
    # ai_max_call_cost_inr (per call), ai_max_user_daily_cost_inr (per worker/day)
    # and the process caps below.
    ai_cost_alert_profile_inr: float = 20.0
    ai_target_profile_cost_inr: float = 15.0
    # Hard per-call spend ceiling (INR). A real call whose worst-case cost would
    # exceed this is refused (falls back to mock) — a stateless runaway guard.
    ai_max_call_cost_inr: float = 10.0

    # --- TD27: cumulative spend cap + retry budget + kill-switch ---------------
    # Independent HARD kill for real calls (env AI_REAL_CALLS_KILL_SWITCH). When
    # true it blocks real calls FIRST in real_calls_blocked_reason — before the
    # flag/key checks — so it disables real calls regardless of
    # AI_ENABLE_REAL_CALLS. Off by default.
    ai_real_calls_kill_switch: bool = False
    # Rolling per-UTC-day spend cap (INR). Real candidates are blocked once the
    # day's recorded spend + a call's worst-case projected cost would exceed it.
    ai_max_daily_cost_inr: float = 200.0
    # Process-lifetime cumulative spend cap (INR). Same check against total spend.
    ai_max_total_cost_inr: float = 1000.0
    # PER-USER rolling per-UTC-day spend cap (INR) — the user-facing budget that
    # bounds ALL real AI spend for one worker per day (profiling chat + extraction
    # + resume combined), keyed by the opaque ``worker_ref`` (PII-free). Checked
    # only when a worker_ref is supplied; the process-level caps above remain the
    # backstop for any call without one.
    #
    # RAISED Rs 6 -> Rs 25 alongside the per-profile target above: this cap is the
    # HARD per-worker stop, so leaving it at Rs 6 while targeting Rs 15/profile would
    # halt a legitimate interview partway through. Sized at ~1 completed profile per
    # worker per day plus headroom for a retry, NOT at N profiles.
    ai_max_user_daily_cost_inr: float = 25.0
    # Max RETRY attempts (attempt > 0) across ALL requests within a rolling
    # window — cuts retry multiplication against a failing provider.
    ai_retry_budget_per_window: int = 20
    ai_retry_budget_window_seconds: int = 60

    # How long a provider stays skipped after it returns a rate limit (429).
    #
    # THE STATE THAT OUTLIVES THE REQUEST. Every other guard here — the retry budget
    # above, the client's in-call 429 loop, the router's attempt loop — is scoped to one
    # request and resets for the next, so a minute-long rate limit was met by every
    # request in that minute walking the whole chain again and adding more rejected calls
    # to the same exhausted window. The cooldown is what makes the FIRST 429 inform the
    # requests behind it.
    #
    # 60s matches the shape of a per-minute (RPM) cap, the common free-tier limit. Set to
    # 0 to disable entirely (the kill switch, and it costs no round trip).
    ai_provider_cooldown_seconds: float = Field(default=60.0, ge=0.0, le=3600.0)

    # Shared spend-ledger store (env AI_SPEND_REDIS_URL).
    #
    # AI-ENV-1 — RENAMED from REDIS_URL (hard cut, no back-compat alias). The
    # NestJS API also defines REDIS_URL, and the two meanings are INCOMPATIBLE:
    # for the API it is MANDATORY infrastructure (sessions, the OTP HMAC store,
    # rate-limit counters, BullMQ); for THIS service it is an OPTIONAL TD27 spend
    # ledger whose absence is a valid, deliberate default. One shared name across
    # two services meant a stray API REDIS_URL — from a root .env, a shell export,
    # or a compose `environment:` block — silently armed the ai-service's Redis
    # backend against a store it does not own, and the symptom was a multi-second
    # stall per real call, not an error. Distinct names make that collision
    # impossible: the API's REDIS_URL can no longer reach these Settings at all
    # (`extra="ignore"` drops it). Deliberately NO deprecation shim — this wiring
    # is dev-only today (no deployed ai-service; TD80), so an alias would preserve
    # exactly the collision we are removing.
    #
    # When UNSET the spend ledger uses the in-process backend: daily / cumulative /
    # per-user INR caps are enforced PER PROCESS (with N Uvicorn workers each holds
    # its own counters). This is the deliberate dev / test / single-process default
    # — NOT a failure. The selected backend is logged ONCE at ledger construction
    # (cost_tracker.SpendLedger) so "unset" is never mistaken for "misconfigured".
    # When SET it uses the Redis backend (CLAUDE.md §3 locked stack — activating the
    # deferred wiring, not a new datastore): the SAME caps enforce GLOBALLY across
    # all workers, keyed by UTC day. The Redis store FAILS CLOSED — if Redis is
    # unreachable a real call is blocked (mock fallback); an unverifiable cap never
    # permits a real spend. Only PII-free data is stored (INR, counts, the UTC date,
    # and the opaque worker_ref). The retry budget stays per-process regardless.
    #
    # SECRET: may carry credentials (redis://user:pass@host). Never log the VALUE —
    # name the variable instead (§2). Scheme-validated at STARTUP: see
    # _validate_spend_redis_url below.
    ai_spend_redis_url: str | None = None

    @field_validator("ai_spend_redis_url")
    @classmethod
    def _validate_spend_redis_url(cls, value: str | None) -> str | None:
        """Reject a malformed ledger URL at ``Settings()`` — i.e. at STARTUP.

        Mirrors the TD67 precedent (``ai_internal_token``'s min_length): a setting that
        can be misconfigured must be rejected at startup, never armed and left to fail
        somewhere less legible. ``redis.asyncio.from_url`` validates the scheme EAGERLY
        at construction, so a missing ``redis://`` prefix — the likeliest typo for this
        var — otherwise raised a bare ValueError from inside the redis library that
        never names AI_SPEND_REDIS_URL. Worse, without this the failure lands in the
        boot lifespan hook (service won't start, opaque reason) or, if that hook were
        removed, inside the first real call — where it would breach the router's
        never-raise contract and surface as a worker-facing 500 instead of a mock.

        UNSET STAYS VALID. ``None`` (and ``""``, which conftest/an empty template line
        produce) mean "no shared store" -> InProcessSpendBackend, the deliberate
        dev/test/single-process default. This validator only rejects a value that was
        clearly MEANT to be a Redis URL and isn't one.

        NO NETWORK: this is a string-shape check only. A well-formed but unreachable URL
        passes here and boots fine — connectivity stays lazy and fails CLOSED per call
        (``spend_store_unavailable`` -> mock), which is the required behaviour.

        §2: names the variable and the allowed schemes; NEVER echoes the value (it can
        carry credentials). Raises ``ConfigError`` — NOT a ValueError — so pydantic does
        not wrap it into a ValidationError that would record the input verbatim in
        ``.errors()``/``.json()``. See ConfigError's docstring.
        """
        if not value:  # None / "" -> in-process backend (a valid, deliberate default)
            return value
        if not value.startswith(_REDIS_URL_SCHEMES):
            raise ConfigError(
                "AI_SPEND_REDIS_URL must start with one of "
                f"{', '.join(_REDIS_URL_SCHEMES)} "
                "(value omitted from this message — it may carry credentials)"
            )
        return value

    sarvam_api_key: str | None = None
    # Sarvam STT model id. Config so the future ``saaras:v3`` swap is one line.
    sarvam_stt_model: str = "saarika:v2.5"
    # TD68/D-2: projected INR cost of ONE sync STT call (= one <=30s chunk) for
    # the SpendLedger reserve->reconcile on the real path. ESTIMATE — saarika at
    # ~Rs 30/audio-hour => ~Rs 0.25 per 30s chunk; calibrate against the invoice
    # at the §7 real-Sarvam flip. Worst-case note = 5 chunks (120s / 29.5s) =
    # Rs 1.25, bounded by ai_max_user_daily_cost_inr (Rs 6/user/day => ~4 full-
    # length notes/user/day) and per chunk by ai_max_call_cost_inr.
    sarvam_stt_cost_inr_per_chunk: float = 0.25
    # Sarvam text-translation model. mayura:v1 is required for auto-detect + code-mixed
    # (the only model that supports Hinglish source + source_language_code="auto").
    sarvam_translate_model: str = "mayura:v1"

    # --- Sarvam text-to-speech (the voice form's spoken questions) --------------
    # Rendered OFFLINE by app/cli/tts_render.py, never per request: the questions are
    # static reviewed pack copy, so the audio is a build artifact. Defaults are the
    # render defaults; the CLI can override each one per run for A/B listening.
    sarvam_tts_model: str = "bulbul:v2"
    # v2 speaker. Chosen by an actual listening test with native speakers from the
    # target demographic, NOT from the docs — this is the voice a low-literacy worker
    # hears instead of reading, so intelligibility beats pleasantness.
    sarvam_tts_speaker: str = "anushka"
    # BCP-47. The packs are locale hi-IN; whether bulbul renders their ROMANIZED
    # Hinglish correctly at this code is the open question V0 exists to answer (the
    # whole 466-item corpus is ASCII — zero Devanagari codepoints).
    sarvam_tts_language: str = "hi-IN"
    # 22.05 kHz mono speech is ample for a phone speaker and roughly half the bytes
    # of 44.1k; the client bundles the corpus, so size is shipped to every worker.
    sarvam_tts_sample_rate: int = 22050
    # wav is Sarvam's default and is what the render step stores as a master. The
    # client ships a transcoded, far smaller format — the master stays lossless so a
    # codec change never needs a re-render (and never another provider call).
    sarvam_tts_output_codec: str = "wav"
    # Published rate card: bulbul:v2 Rs 15 / 10,000 chars, bulbul:v3 Rs 30 / 10,000.
    # ESTIMATE until the first invoice, exactly like sarvam_stt_cost_inr_per_chunk.
    sarvam_tts_cost_inr_per_10k_chars: float = 15.0
    # Sarvam rounds UP per request, so a 40-char question is not billed as 40 chars.
    # Modelling that floor is what makes the "render once" vs "synthesize per session"
    # comparison honest. CALIBRATE against the first invoice — V0 measures it.
    sarvam_tts_min_billed_chars: int = 500

    # Supabase Storage access for the AI service. Read ONLY to fetch voice audio
    # for real STT (Storage Mode A — REST + service-role key). Backend-only.
    # Supabase project URL; never used for anything but the storage object GET.
    supabase_url: str | None = None
    # Service-role key; backend-only; never logged. Bypasses RLS by design.
    supabase_service_role_key: str | None = None
    # PRIVATE bucket holding uploaded voice notes; object key = the request's
    # ``storage_path``. MUST be created PRIVATE out-of-band (Storage object ACLs
    # are not covered by RLS/migrations).
    #
    # EMPTY BY DEFAULT, AND THAT IS A CHANGE. This used to default to the literal
    # ``"worker-voice-notes"`` while apps/api's ``VOICE_NOTES_BUCKET`` defaults to ``""`` —
    # a split brain across two services reading the SAME environment variable name. Neither
    # compose file declares it, so in any containerised environment both services ran on
    # their own defaults, and arming ONE side (say the API, pointed at a differently named
    # bucket) produced total silent failure: the API mints signed uploads into bucket X, this
    # service fetches from ``worker-voice-notes``, every transcription fails closed to an empty
    # transcript, and ``/health`` stays green on both sides because neither reports a bucket.
    #
    # Matching the API's fail-closed default makes the divergence structurally impossible: an
    # unset variable now means "unset" on both sides rather than "unset here, guessed there".
    voice_notes_bucket: str = ""

    # Observability (Langfuse). Optional — tracing is silently disabled if either
    # key is missing, so local dev never depends on Langfuse being configured.
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None
    langfuse_base_url: str = "https://cloud.langfuse.com"
    # Which Langfuse environment these traces belong to. Named after the SDK's own
    # LANGFUSE_TRACING_ENVIRONMENT variable so there is ONE name for one concept.
    # Defaults to "development" on purpose: an unset deployment must not be able to
    # pollute the production dashboards and evaluators by accident — a staging box
    # mislabelled as prod silently corrupts every cost and quality metric read off it.
    langfuse_tracing_environment: str = "development"

    ai_service_port: int = 8000

    def real_calls_blocked_reason(self) -> str | None:
        """Return why real LLM calls are disabled, or None if allowed.

        Real calls require the master flag AND a direct Gemini key. With either
        missing we fail closed (a non-None reason) so the mock path is used.

        The kill-switch is checked FIRST so it hard-disables real calls
        independently of AI_ENABLE_REAL_CALLS (TD27).
        """
        if self.ai_real_calls_kill_switch:
            return "kill switch engaged"
        if not self.ai_enable_real_calls:
            return "AI_ENABLE_REAL_CALLS is false"
        if not self.gemini_flash_api_key:
            return "GEMINI_FLASH_API_KEY is not set"
        return None

    @property
    def real_calls_enabled(self) -> bool:
        return self.real_calls_blocked_reason() is None

    @property
    def real_call_task_allowlist(self) -> frozenset[str]:
        """Parsed AI_REAL_CALL_TASKS. Empty = NO tasks may go real (fail-closed)."""
        return frozenset(t.strip() for t in self.ai_real_call_tasks.split(",") if t.strip())

    def real_call_enabled_for(self, task_type: str) -> bool:
        """Whether a REAL call is permitted for this specific task. Requires the
        master flag + key (``real_calls_enabled``) AND the task explicitly listed
        in AI_REAL_CALL_TASKS. An EMPTY allowlist blocks every task (fail-closed,
        owner-ruled 2026-08-01; no wildcard) — real calls in any env require an
        explicit task list."""
        if not self.real_calls_enabled:
            return False
        return task_type in self.real_call_task_allowlist

    @field_validator("profiling_required_fields")
    @classmethod
    def _validate_required_fields(cls, value: str) -> str:
        """Reject an EMPTY required set at STARTUP.

        This one is worth a startup check rather than a runtime surprise: the
        required set is what gates ``is_complete``, so an empty value (a blank
        template line, a trailing-comma typo that parses to nothing) makes every
        interview "complete" on turn one. The worker would be handed an empty
        resume and the failure would look like a model problem, not a config one.

        Raises ``ConfigError`` — not ValueError — purely for consistency with this
        file's other validator; see ConfigError's docstring for why that matters
        where the value could be a credential. This value is not secret, but one
        error style per module beats two.
        """
        if not _parse_csv(value):
            raise ConfigError(
                "PROFILING_REQUIRED_FIELDS must list at least one field. It gates "
                "interview completion, and an empty set completes every interview "
                "on the first turn."
            )
        return value

    @field_validator("profiling_required_fields", "profiling_optional_fields")
    @classmethod
    def _reject_identity_field_ids(cls, value: str) -> str:
        """No RFS field may be an IDENTITY slot. Structural, not documentary.

        ``rfs.py`` states that there is deliberately no field for a name, phone, address,
        employer or id — but that is only true of the hand-written ``FIELD_GUIDE``. The
        vocabulary the model may actually write into is ``settings.profiling_all_fields``,
        i.e. whatever these two env vars say, checked only for slug SHAPE. So
        ``PROFILING_OPTIONAL_FIELDS=...,full_name,employer_name`` passes startup and mints
        identity slots that persist into ``chat_sessions.conversation_state`` and ride
        back into the prompt every turn — the gateway masks message TEXT, it does not stop
        us from asking for a name in a field we invented.

        Kept as a DENY-LIST rather than an intersection with ``FIELD_GUIDE`` on purpose:
        "adding a resume field is an env edit, never a code edit" is the whole point of
        the generalized design, and an allow-list would take that away. This forbids only
        the classes that must never be collected.
        """
        # Long, unambiguous tokens match anywhere in the id.
        substrings = (
            "name",
            "phone",
            "mobile",
            "email",
            "address",
            "aadhaar",
            "aadhar",
            "employer",
            "passport",
            "father",
            "husband",
            "birth",
        )
        # Short tokens match a whole underscore-separated PART only. This is a trades
        # platform: `pan` is a government id, but it is also a substring of `panel_wiring`
        # and `expansion`, and `dob` of nothing useful yet. A false positive here refuses
        # to boot the service, so the ambiguous ones are held to an exact part match.
        exact_parts = {"pan", "dob", "uan", "esic", "id", "nominee"}
        banned = {
            f
            for f in _parse_csv(value)
            if any(t in f for t in substrings) or (set(f.split("_")) & exact_parts)
        }
        if banned:
            raise ConfigError(
                "PROFILING_REQUIRED_FIELDS/PROFILING_OPTIONAL_FIELDS must not define "
                f"identity fields: {sorted(banned)}. The Resume Field Set collects what a "
                "resume needs about the WORK; a field for a name, contact detail, address, "
                "government id or employer creates a slot for PII the privacy gate is not "
                "designed to keep out of the conversation state."
            )
        return value

    @field_validator("profiling_required_fields", "profiling_optional_fields")
    @classmethod
    def _validate_field_id_shape(cls, value: str) -> str:
        """Every RFS id must be a lowercase slug, and there must not be too many.

        NOT cosmetic — this enforces a contract that is checked much later, much further
        away, and much more expensively. The api derives ``answered_topics`` from these
        very ids and puts them in the ``profile.extraction_ready`` event, whose payload
        schema enforces ``^[a-z_]+$``, ``max 40`` chars and ``max 50`` entries. That emit
        happens INSIDE the flush transaction, so one bad id — a capital letter, a hyphen,
        a stray space that survived the split — does not produce a validation warning: it
        throws, rolls back the whole transaction, and DISCARDS the worker's entire
        completed interview while they see a normal closing reply.

        The whole point of the RFS is that changing it is an env edit, never a code edit
        (see the field docs above). That makes an env typo a first-class failure mode, so
        it fails at STARTUP, loudly, before any worker is affected — rather than per
        worker, silently, at the very end of a successful conversation.
        """
        fields = _parse_csv(value)
        bad = [f for f in fields if not re.fullmatch(r"[a-z_]{1,40}", f)]
        if bad:
            raise ConfigError(
                "RFS field ids must be lowercase slugs matching [a-z_]{1,40} — the "
                "profile.extraction_ready event payload enforces that regex INSIDE the "
                f"flush transaction, so a bad id discards a completed interview. Bad: {bad}"
            )
        if len(fields) > 50:
            raise ConfigError(
                f"RFS declares {len(fields)} fields; the profile.extraction_ready "
                "payload caps answered_topics at 50."
            )
        return value

    @property
    def profiling_required_field_list(self) -> tuple[str, ...]:
        """Ordered RFS fields that gate ``is_complete``.

        A TUPLE, not a frozenset (unlike ``real_call_task_allowlist``): order is
        meaningful here — it is the priority the model is told to work through, and
        the order missing fields are reported back in.
        """
        return _parse_csv(self.profiling_required_fields)

    @property
    def profiling_optional_field_list(self) -> tuple[str, ...]:
        """RFS fields captured if volunteered but NEVER asked (persona Law 4).

        Anything also present in the required list is dropped here, so a field
        listed in both is REQUIRED. That direction is deliberate: the failure mode
        of asking about something we would have taken anyway is a slightly longer
        interview, whereas silently demoting a required field to optional produces
        an incomplete resume with no error anywhere.
        """
        required = set(self.profiling_required_field_list)
        return tuple(f for f in _parse_csv(self.profiling_optional_fields) if f not in required)

    @property
    def profiling_all_fields(self) -> tuple[str, ...]:
        """Every RFS field, required first. The full vocabulary the model may fill."""
        return self.profiling_required_field_list + self.profiling_optional_field_list

    def has_credential_for(self, provider: str) -> bool:
        """Whether the API credential for a provider label (as returned by
        ``provider_for_model``) is configured. Single source of truth shared by the
        router's fallback-chain gating and the CLI's readiness banner, so the
        primary/fallback providers can be swapped freely without either drifting.

        This is a CREDENTIAL-ONLY check: it does NOT verify the provider's client
        transport (e.g. the ``anthropic`` SDK) is importable. The router additionally
        requires ``fallback_transport_available`` before ARMING a cross-provider
        fallback, so a key-set-but-SDK-absent config does not add a 100%-failing
        candidate. Keeping this method credential-only preserves its other use as the
        CLI readiness banner (which reports configured keys, not installed SDKs)."""
        if provider == "google":
            return bool(self.gemini_flash_api_key)
        if provider == "anthropic":
            return bool(self.anthropic_api_key)
        return False

    def fallback_transport_available(self, provider: str) -> bool:
        """Whether a provider's REAL client transport is actually usable RIGHT NOW —
        credential present AND its client library importable. The router gates the
        cross-provider fallback on this (not bare ``has_credential_for``) so a config
        with the key set but the provider SDK NOT installed never arms a fallback that
        fails 100% of the time and burns the per-call retries + the TD27 retry budget.

        - "google" (Gemini, primary): reached over raw ``httpx`` (always present as a
          core dep), so transport == credential.
        - "anthropic" (Claude, fallback): reached via the OPTIONAL ``anthropic`` SDK,
          which mock-only deployments do not install. We probe importability with
          ``importlib.util.find_spec`` — cheap, NO network, NO key use, NO import side
          effects (it does not actually import the package).

        Unknown providers have no live transport -> False."""
        if not self.has_credential_for(provider):
            return False
        if provider == "google":
            return True
        if provider == "anthropic":
            import importlib.util

            return importlib.util.find_spec("anthropic") is not None
        return False

    @property
    def storage_configured(self) -> bool:
        """Whether Supabase Storage is reachable (URL + service-role key). Real STT
        enforces this inside ``_transcribe_real`` so a missing-storage real call
        fails CLOSED to empty — never to mock."""
        return bool(self.supabase_url and self.supabase_service_role_key)

    @property
    def langfuse_enabled(self) -> bool:
        """Langfuse tracing is enabled only when BOTH keys are present."""
        return bool(self.langfuse_public_key and self.langfuse_secret_key)


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
