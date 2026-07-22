"""PARITY SEAM — drive the REAL FastAPI app's profiling endpoints, never the
engine functions.

WHY THIS MODULE EXISTS. The onboarding CLI used to call
``interview_engine.next_turn`` / ``profile_extractor.extract`` / ``router.run``
DIRECTLY. It therefore mirrored ``main.profiling_respond`` only by CONVENTION:
every guard, ordering rule and assembly step written in ``main.py`` had a second,
hand-copied implementation in the CLI that could (and did) drift — the CLI
assembled its final profile with ``profile_extractor.merge_collected``, which the
production endpoint never calls.

Everything here goes through ``POST /profiling/respond``, ``POST /profile/extract``
and ``POST /pseudonymize`` on the SAME ASGI app the service deploys, so the
pseudonymization gate, the request/response Pydantic contracts, the
clarify-vs-advance branch, the router call and the response assembly are the
deployed code by construction. There is no second implementation to drift.

Two transports, identical request bodies:

* :class:`InProcessTransport` (default) — ``fastapi.testclient.TestClient`` over
  ``app.main:app``. No server, no DB, no Node, no network (TestClient speaks ASGI
  in-process; it opens no socket).
* :class:`HttpTransport` (``--http BASE_URL``) — a real HTTP client against a
  running ai-service.

REQUEST-SHAPE PARITY is deliberate and load-bearing; each field below is what the
production caller sends:

* ``/profiling/respond`` ← ``apps/api/src/chat/chat.service.ts`` step 3:
  ``{session_id, worker_ref, message_text, history: [], conversation_state,
  role_family}``. ``history`` ships EMPTY on purpose (PERF-2/COST-3) and
  ``real_call_allowed`` is omitted so the contract default applies — exactly as
  ``AiService.profilingRespond`` posts it.
* ``/profile/extract`` ← ``apps/api/src/profiles/profile-extraction.processor.ts``:
  ``{worker_ref, transcript}`` where the transcript is ``buildTranscript``'s shape
  (see :meth:`InterviewSession.transcript`).

PRIVACY. This module never sees the worker's name: the CLI keeps it in a local
variable and interpolates it over the engine's ``{{worker_name}}`` token at PRINT
time (AI-PERSONA-2). ``worker_ref`` is a per-run opaque UUID, mirroring the
production workerId — PII-free. The raw worker message is posted to the ai-service
exactly as the worker app posts it; the ai-service pseudonymizes it there, before
any model call, and fails closed.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..profiling import signals

# Mirrors DEFAULT_ROLE_FAMILY in apps/api/src/chat/chat.service.ts.
DEFAULT_ROLE_FAMILY = "cnc_vmc"

PROFILING_RESPOND_PATH = "/profiling/respond"
PROFILE_EXTRACT_PATH = "/profile/extract"
PSEUDONYMIZE_PATH = "/pseudonymize"

# Transcript line prefixes — VERBATIM from profile-extraction.processor.ts
# buildTranscript(): `${m.direction === "inbound" ? "Worker" : "Bada Bhai"}: ${body}`.
WORKER_PREFIX = "Worker"
ASSISTANT_PREFIX = "Bada Bhai"
# ...including its empty-session placeholder (`text || "(no conversation captured)"`).
EMPTY_TRANSCRIPT = "(no conversation captured)"
# apps/api chat.repository.ts CHAT_HISTORY_MAX — the extraction transcript is the
# most recent N messages. Far above any CLI run; mirrored so the shape is complete.
CHAT_HISTORY_MAX = 500


@dataclass(frozen=True)
class ApiResponse:
    """One endpoint round trip. ``body`` is the decoded JSON (or ``{}``)."""

    path: str
    status_code: int
    body: dict[str, Any]

    @property
    def ok(self) -> bool:
        return self.status_code == 200

    def validation_errors(self) -> list[dict[str, Any]]:
        """FastAPI 422 detail, reduced to ``loc``/``msg``/``type``.

        ``input`` and ``ctx`` are DROPPED on purpose: a Pydantic error echoes the
        offending VALUE, which here is the worker's raw message. The CLI prints
        only the machine-readable failure, never the value.
        """
        detail = self.body.get("detail")
        if not isinstance(detail, list):
            return []
        out: list[dict[str, Any]] = []
        for item in detail:
            if isinstance(item, dict):
                out.append({k: item.get(k) for k in ("loc", "msg", "type")})
        return out


class Transport(Protocol):
    """Anything that can reach the ai-service's HTTP surface."""

    label: str

    def post(self, path: str, payload: dict[str, Any]) -> ApiResponse: ...

    def get(self, path: str) -> ApiResponse: ...

    def close(self) -> None: ...


def _auth_headers(token: str | None) -> dict[str, str]:
    """TD67 service bearer, when the local env has one configured."""
    return {"x-ai-internal-token": token} if token else {}


class InProcessTransport:
    """Default transport: the real ASGI app, in this process, no socket.

    Imports ``app.main`` LAZILY (at construction) so merely importing this module
    does not boot the app — tests and ``--help`` stay cheap.
    """

    def __init__(self, token: str | None = None) -> None:
        from fastapi.testclient import TestClient  # local import: heavy

        from ..main import app

        self._client = TestClient(app)
        self._client.__enter__()  # run the lifespan (spend-ledger boot log)
        self._headers = _auth_headers(token)
        self.label = "in-process TestClient (app.main:app)"

    def post(self, path: str, payload: dict[str, Any]) -> ApiResponse:
        res = self._client.post(path, json=payload, headers=self._headers)
        return ApiResponse(path, res.status_code, _decode(res))

    def get(self, path: str) -> ApiResponse:
        res = self._client.get(path, headers=self._headers)
        return ApiResponse(path, res.status_code, _decode(res))

    def close(self) -> None:
        self._client.__exit__(None, None, None)


class HttpTransport:
    """``--http BASE_URL`` transport: a really-running ai-service.

    A transport failure (service down, timeout) is reported as status 0 with a
    reason rather than a traceback — the operator needs to know WHICH call failed,
    and apps/api degrades the same way (``ai.service.ts post()`` catches and falls
    back to its local mock).
    """

    def __init__(self, base_url: str, token: str | None = None, timeout: float = 30.0) -> None:
        import httpx  # local import: only needed for this mode

        self._httpx = httpx
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout)
        self._headers = _auth_headers(token)
        self.label = f"HTTP {base_url}"

    def post(self, path: str, payload: dict[str, Any]) -> ApiResponse:
        try:
            res = self._client.post(path, json=payload, headers=self._headers)
        except self._httpx.HTTPError as exc:
            return ApiResponse(path, 0, {"detail": f"transport error: {type(exc).__name__}"})
        return ApiResponse(path, res.status_code, _decode(res))

    def get(self, path: str) -> ApiResponse:
        try:
            res = self._client.get(path, headers=self._headers)
        except self._httpx.HTTPError as exc:
            return ApiResponse(path, 0, {"detail": f"transport error: {type(exc).__name__}"})
        return ApiResponse(path, res.status_code, _decode(res))

    def close(self) -> None:
        self._client.close()


def _decode(res: Any) -> dict[str, Any]:
    try:
        body = res.json()
    except (ValueError, TypeError):
        return {"detail": f"non-JSON response ({len(res.content)} bytes)"}
    return body if isinstance(body, dict) else {"detail": body}


@dataclass(frozen=True)
class GateView:
    """What ``POST /pseudonymize`` says about one message — i.e. the text that
    WOULD reach a model, and whether the gate fails closed on it.

    This is the SAME ``pseudonymize()`` the turn endpoint runs first (a pure
    function of the input), reached through its own production route so it works
    identically over ``--http``. The AUTHORITATIVE blocked flag for a turn is still
    the turn response's ``pseudonymization_metadata`` — :class:`TurnResult`
    cross-checks the two and surfaces any disagreement rather than hiding it.
    """

    text: str
    blocked: bool
    blocked_reason: str | None
    replaced_entities: int
    placeholder_tokens: list[str]

    @classmethod
    def from_body(cls, body: dict[str, Any]) -> GateView:
        return cls(
            text=body.get("pseudonymized_text", ""),
            blocked=bool(body.get("blocked")),
            blocked_reason=body.get("blocked_reason"),
            replaced_entities=int(body.get("replaced_entities") or 0),
            placeholder_tokens=list(body.get("placeholder_tokens") or []),
        )


@dataclass
class TurnResult:
    """One ``POST /profiling/respond`` round trip plus read-only diagnostics.

    Everything under "from the response" is the production endpoint's own output.
    Everything under "derived" is computed FROM that output (state deltas) or is a
    clearly-labelled LOCAL diagnostic (``detected``), which drives nothing.
    """

    index: int
    message: str
    request: dict[str, Any]
    response: ApiResponse
    gate: GateView | None
    prev_state: dict[str, Any] | None
    # LOCAL read-only diagnostic: signals.detect_answered_topics(message, last_asked).
    # The endpoint ran the same detector internally; this copy exists ONLY to show
    # what was detected but NOT collected. Over --http the remote build may differ.
    detected: dict[str, Any] = field(default_factory=dict)

    # --- straight off the response ---
    @property
    def ok(self) -> bool:
        return self.response.ok

    @property
    def body(self) -> dict[str, Any]:
        return self.response.body

    @property
    def reply_text(self) -> str:
        return str(self.body.get("reply_text") or "")

    @property
    def blocked(self) -> bool:
        return bool(self.body.get("blocked"))

    @property
    def blocked_reason(self) -> str | None:
        return self.body.get("blocked_reason")

    @property
    def asked_question_id(self) -> str | None:
        return self.body.get("asked_question_id")

    @property
    def extraction_ready(self) -> bool:
        return bool(self.body.get("extraction_ready"))

    @property
    def is_mock(self) -> bool:
        # The contract defaults is_mock to True; a missing field must never read
        # as "a real model answered".
        return bool(self.body.get("is_mock", True))

    @property
    def state(self) -> dict[str, Any] | None:
        return self.body.get("updated_state")

    @property
    def ai_metadata(self) -> dict[str, Any] | None:
        return self.body.get("ai_metadata")

    @property
    def turn_pseudonymization(self) -> dict[str, Any] | None:
        return self.body.get("pseudonymization_metadata")

    # --- derived from the response ---
    @property
    def gate_disagreement(self) -> str | None:
        """Non-None when the /pseudonymize probe and the turn's own gate metadata
        disagree about blocking. Should be impossible (same pure function); if it
        ever happens the operator must SEE it, not be shown a comfortable lie."""
        meta = self.turn_pseudonymization
        if self.gate is None or meta is None:
            return None
        if bool(meta.get("blocked")) != self.gate.blocked:
            return (
                f"turn says blocked={meta.get('blocked')} but /pseudonymize says "
                f"blocked={self.gate.blocked}"
            )
        return None

    @property
    def clarified(self) -> bool:
        """True when the endpoint took the COST-4 clarify branch (re-serve) rather
        than advancing. Derived from the response alone: ``clarify_turn`` is the
        only writer that increments ``clarify_count``; every ``next_turn`` resets
        it to 0."""
        if self.state is None:
            return False
        before = int((self.prev_state or {}).get("clarify_count") or 0)
        return int(self.state.get("clarify_count") or 0) > before

    @property
    def last_asked(self) -> str | None:
        asked = (self.prev_state or {}).get("asked_question_ids") or []
        return asked[-1] if asked else None

    @property
    def ask_number(self) -> int | None:
        """Which ask of that topic this was (1 or 2), per ``ask_counts``."""
        if self.state is None or self.asked_question_id is None:
            return None
        counts = self.state.get("ask_counts") or {}
        value = counts.get(self.asked_question_id)
        return int(value) if isinstance(value, (int, float)) else None

    @property
    def newly_answered(self) -> list[str]:
        before = set((self.prev_state or {}).get("answered_topics") or [])
        after = (self.state or {}).get("answered_topics") or []
        return [t for t in after if t not in before]

    @property
    def collected(self) -> dict[str, Any]:
        return (self.state or {}).get("collected") or {}

    @property
    def newly_collected(self) -> dict[str, Any]:
        before = (self.prev_state or {}).get("collected") or {}
        return {k: v for k, v in self.collected.items() if before.get(k) != v}

    def discarded(self) -> list[tuple[str, Any, str]]:
        """``(topic, detected_value, why)`` for every detected signal this turn
        that did NOT end up in ``collected``.

        The three real causes, all documented in the engine:
        * a DENIAL (P1-2) reports the topic with value ``None`` — answered, nothing
          collected;
        * the P1-1 overwrite rule (``_may_commit``) — an incidental cross-topic
          mention may fill an empty slot but never overwrite an established one;
        * a blocked turn — the engine never ran at all.
        """
        if not self.detected:
            return []
        if self.state is None:
            return [(t, v, "turn blocked/failed — the engine never saw it") for t, v in
                    self.detected.items()]
        before = (self.prev_state or {}).get("collected") or {}
        out: list[tuple[str, Any, str]] = []
        for topic, value in self.detected.items():
            if value is None:
                out.append((topic, None, "denial (P1-2): topic marked answered, nothing collected"))
                continue
            if _same(self.collected.get(topic), value):
                continue
            out.append(
                (
                    topic,
                    value,
                    "not committed (P1-1 overwrite rule: first write wins unless it is "
                    f"the asked topic or a correction); kept {_short(before.get(topic))}",
                )
            )
        return out


def _same(a: Any, b: Any) -> bool:
    """JSON-shape equality — the state came back over the wire (tuples became
    lists, ints may be floats), so compare on the serialized form."""
    if a is None or b is None:
        return a is b
    try:
        return json.dumps(a, sort_keys=True, default=str) == json.dumps(
            b, sort_keys=True, default=str
        )
    except (TypeError, ValueError):
        return a == b


def _short(value: Any, limit: int = 40) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[: limit - 3] + "..."


@dataclass
class ExtractResult:
    """One ``POST /profile/extract`` round trip — the PRODUCTION result."""

    request: dict[str, Any]
    response: ApiResponse

    @property
    def ok(self) -> bool:
        return self.response.ok

    @property
    def blocked(self) -> bool:
        return bool(self.response.body.get("blocked"))

    @property
    def blocked_reason(self) -> str | None:
        return self.response.body.get("blocked_reason")

    @property
    def status(self) -> str:
        return str(self.response.body.get("extraction_status") or "unknown")

    @property
    def is_mock(self) -> bool:
        return bool(self.response.body.get("is_mock", True))

    @property
    def profile(self) -> dict[str, Any]:
        """The legacy ``DraftProfile`` — what apps/api persists as
        ``profiles.raw_profile``."""
        return self.response.body.get("profile") or {}

    @property
    def draft(self) -> dict[str, Any] | None:
        """The rich ``WorkerProfileDraft`` — persisted as ``rich_profile_draft``."""
        return self.response.body.get("worker_profile_draft")

    @property
    def ai_metadata(self) -> dict[str, Any] | None:
        return self.response.body.get("ai_metadata")


class InterviewSession:
    """A worker-profiling interview driven entirely through the HTTP contract.

    Holds exactly what production holds between turns: the ``ConversationState``
    (persisted on ``chat_sessions.conversation_state``) and the message rows
    (``chat_messages``). Nothing else — no engine handle, no router handle.
    """

    def __init__(
        self,
        transport: Transport,
        *,
        session_id: str | None = None,
        worker_ref: str | None = None,
        role_family: str = DEFAULT_ROLE_FAMILY,
        seed_state: dict[str, Any] | None = None,
        probe_gate: bool = True,
        local_diagnostics: bool = True,
    ) -> None:
        self.transport = transport
        # Opaque ids, PII-free — the production shapes are UUIDs.
        self.session_id = session_id or str(uuid.uuid4())
        self.worker_ref = worker_ref or str(uuid.uuid4())
        self.role_family = role_family
        self.state: dict[str, Any] | None = seed_state
        self.rows: list[tuple[str, str]] = []
        self.turns: list[TurnResult] = []
        self._probe_gate = probe_gate
        self._local_diagnostics = local_diagnostics

    # --- the interview -----------------------------------------------------
    def send(self, message: str) -> TurnResult:
        """One worker message → ``POST /profiling/respond``.

        Message-row bookkeeping mirrors ``chat.service.ts`` EXACTLY, including the
        part that surprises people: the inbound row is stored BEFORE the AI call
        (step 1), so a message the gate later BLOCKS is still in the transcript
        that extraction reads. The outbound row stores the RAW ``reply_text`` —
        the one carrying the ``{{worker_name}}`` token, never a real name (SG-1).
        """
        gate = self._gate(message) if self._probe_gate else None
        detected = self._detect(message)
        request = {
            "session_id": self.session_id,
            "worker_ref": self.worker_ref,
            "message_text": message,
            "history": [],
            "conversation_state": self.state,
            "role_family": self.role_family,
        }
        prev_state = self.state
        response = self.transport.post(PROFILING_RESPOND_PATH, request)
        turn = TurnResult(
            index=len(self.turns) + 1,
            message=message,
            request=request,
            response=response,
            gate=gate,
            prev_state=prev_state,
            detected=detected,
        )
        self.turns.append(turn)

        if not response.ok:
            # The contract rejected the request. apps/api would degrade to its own
            # local mock interview (ai.service.ts post() -> null -> mockProfilingTurn);
            # the CLI does NOT emulate that NestJS-side fallback, and stores nothing.
            return turn

        self.rows.append((WORKER_PREFIX, message))
        self.rows.append((ASSISTANT_PREFIX, turn.reply_text))
        # A blocked turn returns updated_state=None and apps/api persists nothing
        # (it just touches the session), so the interview does not advance.
        if turn.state is not None:
            self.state = turn.state
        return turn

    def opening_question(self) -> tuple[str, str]:
        """``(topic_id, question)`` for the opener.

        The opener is CLIENT-SIDE in production: apps/worker-app renders
        ``kChatOpeningText`` (the ``role`` topic's question, no vocative) and never
        posts it, so it is NOT a stored message and NOT part of the extraction
        transcript. The CLI mirrors both halves — it prints the same question and
        keeps it out of :meth:`transcript`.
        """
        from ..profiling import interview_engine  # local import: keeps module light

        return interview_engine.first_question(self.role_family, worker_name=None)

    # --- extraction --------------------------------------------------------
    def transcript(self) -> str:
        """The extraction transcript, assembled the way
        ``profile-extraction.processor.ts buildTranscript`` assembles it: every
        stored message, BOTH directions, ``"Worker: "`` / ``"Bada Bhai: "``
        prefixed, newline-joined, most recent ``CHAT_HISTORY_MAX`` kept."""
        rows = self.rows[-CHAT_HISTORY_MAX:]
        text = "\n".join(f"{who}: {body}" for who, body in rows if body)
        return text or EMPTY_TRANSCRIPT

    def extract(self) -> ExtractResult:
        """``POST /profile/extract`` with the production request body."""
        request = {"worker_ref": self.worker_ref, "transcript": self.transcript()}
        return ExtractResult(request, self.transport.post(PROFILE_EXTRACT_PATH, request))

    # --- helpers -----------------------------------------------------------
    def _gate(self, message: str) -> GateView | None:
        response = self.transport.post(PSEUDONYMIZE_PATH, {"text": message})
        return GateView.from_body(response.body) if response.ok else None

    def _detect(self, message: str) -> dict[str, Any]:
        if not self._local_diagnostics:
            return {}
        asked = (self.state or {}).get("asked_question_ids") or []
        try:
            return dict(signals.detect_answered_topics(message, asked[-1] if asked else None))
        except Exception:  # pragma: no cover - a diagnostic must never break a run
            return {}
