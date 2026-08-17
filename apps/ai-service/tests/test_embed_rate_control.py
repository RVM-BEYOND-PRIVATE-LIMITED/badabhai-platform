"""Phase 6: pacing, bounded backoff, and the failure/recovery behaviour around them.

These tests exist because the Phase 5 corpus embed lost 97 texts to provider refusals and
the first diagnosis (a payload-size cap) was WRONG. The measured cause was a per-minute
budget on TEXTS in which failed attempts also count, so every assertion here is about the
control that actually binds, and about not making the problem worse:

  - pace before sending, rather than discovering the limit via 429s;
  - charge the budget for refused attempts, because the provider does;
  - retry a bounded number of times, and never in a way that can double-bill;
  - and whatever happens, leave the rows resumable.

No test sleeps in real time: ``nap`` is injected or ``time.sleep`` patched, so a 60-second
cooldown costs nothing in CI.
"""

from __future__ import annotations

import httpx
import pytest

from app.ai import embeddings
from app.config import Settings


@pytest.fixture(autouse=True)
def _clean_limiter():
    # The limiter is a process-wide singleton (the provider quota is per project), so a
    # test that leaves texts in the window would throttle whichever test ran next.
    embeddings.get_rate_limiter().reset()
    yield
    embeddings.get_rate_limiter().reset()


def _settings(**over) -> Settings:
    base = dict(
        gemini_flash_api_key="k",
        ai_enable_real_calls=True,
        ai_real_call_tasks="skill_embedding",
        ai_embed_texts_per_minute=0,
        ai_embed_max_retries=2,
        ai_embed_backoff_base_seconds=2.0,
        ai_embed_backoff_max_seconds=90.0,
        ai_embed_rate_limit_cooldown_seconds=60.0,
        ai_embed_retry_on_read_timeout=False,
        ai_embed_max_pacing_wait_seconds=300.0,
    )
    base.update(over)
    return Settings(**base)


class _Naps:
    """Records what the policy WOULD have slept, without sleeping."""

    def __init__(self) -> None:
        self.waits: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


# ===========================================================================
# The rate limiter itself — pure, deterministic, clock injected.
# ===========================================================================
class TestTextRateLimiter:
    def test_allows_traffic_under_the_limit(self):
        lim = embeddings._TextRateLimiter()
        assert lim.delay_for(50, limit=100, now=0.0) == 0.0
        lim.charge(50, now=0.0)
        assert lim.delay_for(50, limit=100, now=1.0) == 0.0

    def test_delays_the_request_that_would_exceed_the_limit(self):
        lim = embeddings._TextRateLimiter()
        lim.charge(90, now=0.0)
        # 90 + 20 > 100, so wait for the 90 to age out of the 60s window.
        assert lim.delay_for(20, limit=100, now=10.0) == pytest.approx(50.0)

    def test_counts_REFUSED_attempts_against_the_budget(self):
        # The finding that makes naive retrying harmful. In the Phase 5 traces a 50-text
        # request was refused at +211s with only 55 SUCCEEDED texts in the prior minute —
        # but 194 refused texts were also in that window. A limiter that credits only
        # successes would have sent that request too.
        lim = embeddings._TextRateLimiter()
        lim.charge(100, now=0.0)  # charged whether or not the call went on to fail
        assert lim.delay_for(1, limit=100, now=5.0) > 0

    def test_expires_the_window(self):
        lim = embeddings._TextRateLimiter()
        lim.charge(100, now=0.0)
        assert lim.delay_for(100, limit=100, now=60.0) == 0.0

    def test_waits_only_as_long_as_it_must(self):
        lim = embeddings._TextRateLimiter()
        lim.charge(50, now=0.0)
        lim.charge(50, now=30.0)
        # Room for 50 opens when the FIRST charge ages out at t=60, not the second.
        assert lim.delay_for(50, limit=100, now=40.0) == pytest.approx(20.0)

    def test_a_request_larger_than_the_whole_limit_is_released_not_deadlocked(self):
        # A misconfiguration (batch 100, limit 50) must not hang the runner forever. It
        # drains the window and then goes; the provider's own 429 is the backstop.
        lim = embeddings._TextRateLimiter()
        lim.charge(10, now=0.0)
        assert lim.delay_for(500, limit=50, now=0.0) == pytest.approx(60.0)
        assert lim.delay_for(500, limit=50, now=61.0) == 0.0

    def test_limit_of_zero_disables_pacing(self):
        lim = embeddings._TextRateLimiter()
        lim.charge(10_000, now=0.0)
        assert lim.delay_for(10_000, limit=0, now=0.0) == 0.0


# ===========================================================================
# Retry classification — which failures may be re-sent at all.
# ===========================================================================
class TestRetryClassification:
    def test_429_is_retryable_and_rate_limited(self):
        e = embeddings.ProviderEmbedError("x", status=429)
        assert e.retryable and e.rate_limited and not e.isolatable

    def test_5xx_is_retryable_but_not_isolatable(self):
        e = embeddings.ProviderEmbedError("x", status=503)
        assert e.retryable and not e.isolatable and not e.rate_limited

    def test_4xx_other_than_429_is_isolatable_and_NOT_retryable(self):
        # One bad text. Re-sending the identical batch spends quota to fail again;
        # bisecting rescues the other 99.
        e = embeddings.ProviderEmbedError("x", status=400)
        assert e.isolatable and not e.retryable

    def test_connect_failure_is_retryable_because_nothing_was_sent(self):
        assert embeddings.ProviderEmbedError("x", retryable=True).retryable

    def test_a_bare_transport_failure_is_not_retryable_by_default(self):
        assert not embeddings.ProviderEmbedError("x").retryable

    def test_retry_after_header_is_parsed_and_bad_input_ignored(self):
        assert embeddings._parse_retry_after("30") == 30.0
        assert embeddings._parse_retry_after(None) is None
        assert embeddings._parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT") is None
        assert embeddings._parse_retry_after("-5") is None


class TestBackoffDelay:
    def test_a_429_waits_out_the_rate_WINDOW_not_two_seconds(self):
        # Exponential backoff from 2s retries INSIDE the exhausted minute, and the failed
        # attempt has already spent more of it. This is the whole point of the split.
        s = _settings()
        e = embeddings.ProviderEmbedError("x", status=429)
        assert embeddings._backoff_delay(1, e, s) == 60.0

    def test_a_429_honours_the_provider_Retry_After(self):
        s = _settings()
        e = embeddings.ProviderEmbedError("x", status=429, retry_after=12.0)
        assert embeddings._backoff_delay(1, e, s) == 12.0

    def test_a_5xx_backs_off_exponentially_within_bounds(self):
        s = _settings()
        e = embeddings.ProviderEmbedError("x", status=503)
        first = [embeddings._backoff_delay(1, e, s) for _ in range(40)]
        second = [embeddings._backoff_delay(2, e, s) for _ in range(40)]
        assert all(1.0 <= d <= 2.0 for d in first)  # jittered half-range of base 2
        assert all(2.0 <= d <= 4.0 for d in second)
        assert len(set(first)) > 1  # jitter is real, not a constant

    def test_backoff_is_CLAMPED_so_one_bad_run_cannot_hang_for_an_hour(self):
        s = _settings(ai_embed_backoff_max_seconds=5.0)
        e = embeddings.ProviderEmbedError("x", status=503)
        assert embeddings._backoff_delay(10, e, s) <= 5.0

    def test_a_retry_after_longer_than_the_cap_is_clamped(self):
        s = _settings(ai_embed_backoff_max_seconds=30.0)
        e = embeddings.ProviderEmbedError("x", status=429, retry_after=3600.0)
        assert embeddings._backoff_delay(1, e, s) == 30.0


# ===========================================================================
# The policy end to end.
# ===========================================================================
class TestPacedBatch:
    def test_a_clean_call_neither_waits_nor_retries(self, monkeypatch):
        monkeypatch.setattr(embeddings, "_real_embedding_batch", lambda t, s: [[0.1]] * len(t))
        naps = _Naps()
        out = embeddings._embed_batch_paced(["a", "b"], _settings(), sleep=naps)
        assert out.vectors is not None and out.attempts == 1
        assert naps.waits == [] and out.waited_seconds == 0.0

    def test_RECOVERS_from_a_transient_failure(self, monkeypatch):
        calls = {"n": 0}

        def flaky(texts, settings):
            calls["n"] += 1
            if calls["n"] == 1:
                raise embeddings.ProviderEmbedError("boom", status=503)
            return [[0.1]] * len(texts)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", flaky)
        naps = _Naps()
        out = embeddings._embed_batch_paced(["a"], _settings(), sleep=naps)
        assert out.vectors is not None
        assert out.attempts == 2
        assert len(naps.waits) == 1

    def test_gives_up_after_a_BOUNDED_number_of_attempts(self, monkeypatch):
        calls = {"n": 0}

        def always_503(texts, settings):
            calls["n"] += 1
            raise embeddings.ProviderEmbedError("boom", status=503)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", always_503)
        out = embeddings._embed_batch_paced(["a"], _settings(ai_embed_max_retries=2), sleep=_Naps())
        # 1 initial + 2 retries. Not "until it works", which is how a retry storm starts.
        assert calls["n"] == 3
        assert out.vectors is None and out.attempts == 3

    def test_does_not_SLEEP_after_its_final_attempt(self, monkeypatch):
        # Backing off is only useful before another try. Sleeping once more after the last
        # attempt burns up to ai_embed_backoff_max_seconds of the caller's HTTP budget to
        # achieve nothing — and the db-side runner holds the connection for only ten
        # minutes. A mutation that dropped the attempt bound left the loop correctly
        # terminated but added exactly this wasted wait, and nothing caught it.
        def always_503(texts, settings):
            raise embeddings.ProviderEmbedError("boom", status=503)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", always_503)
        naps = _Naps()
        s = _settings(ai_embed_max_retries=2)
        out = embeddings._embed_batch_paced(["a"], s, sleep=naps)
        assert out.vectors is None
        assert out.attempts == 3
        # 3 attempts => 2 gaps between them, and none trailing.
        assert len(naps.waits) == 2

    def test_max_retries_zero_means_exactly_one_attempt(self, monkeypatch):
        calls = {"n": 0}

        def always_503(texts, settings):
            calls["n"] += 1
            raise embeddings.ProviderEmbedError("boom", status=503)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", always_503)
        embeddings._embed_batch_paced(["a"], _settings(ai_embed_max_retries=0), sleep=_Naps())
        assert calls["n"] == 1

    def test_does_NOT_retry_a_read_timeout_by_default(self, monkeypatch):
        # The request was sent and the outcome is unknown, so a retry can pay twice for
        # the same texts. The resumable runner picks the row up next pass for free.
        calls = {"n": 0}

        def timeout(texts, settings):
            calls["n"] += 1
            raise embeddings.ProviderEmbedError("timeout", retryable=False)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", timeout)
        out = embeddings._embed_batch_paced(["a"], _settings(), sleep=_Naps())
        assert calls["n"] == 1
        assert out.vectors is None

    def test_retries_a_read_timeout_when_explicitly_opted_in(self, monkeypatch):
        calls = {"n": 0}

        def timeout(texts, settings):
            calls["n"] += 1
            raise embeddings.ProviderEmbedError("timeout", retryable=True)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", timeout)
        embeddings._embed_batch_paced(
            ["a"], _settings(ai_embed_retry_on_read_timeout=True, ai_embed_max_retries=1), sleep=_Naps()
        )
        assert calls["n"] == 2

    def test_RERAISES_an_isolatable_4xx_so_the_caller_can_bisect(self, monkeypatch):
        calls = {"n": 0}

        def bad_text(texts, settings):
            calls["n"] += 1
            raise embeddings.ProviderEmbedError("bad", status=400)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", bad_text)
        with pytest.raises(embeddings.ProviderEmbedError):
            embeddings._embed_batch_paced(["a", "b"], _settings(), sleep=_Naps())
        assert calls["n"] == 1  # not retried — bisection is the cheaper recovery

    def test_PACES_before_sending_rather_than_discovering_the_limit(self, monkeypatch):
        monkeypatch.setattr(embeddings, "_real_embedding_batch", lambda t, s: [[0.1]] * len(t))
        s = _settings(ai_embed_texts_per_minute=100)
        naps = _Naps()
        embeddings._embed_batch_paced(["x"] * 100, s, sleep=naps)  # fills the window
        embeddings._embed_batch_paced(["y"] * 100, s, sleep=naps)  # must wait
        assert len(naps.waits) == 1 and naps.waits[0] > 0

    def test_charges_the_budget_for_a_FAILED_attempt(self, monkeypatch):
        def always_503(texts, settings):
            raise embeddings.ProviderEmbedError("boom", status=503)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", always_503)
        s = _settings(ai_embed_texts_per_minute=100, ai_embed_max_retries=0)
        embeddings._embed_batch_paced(["x"] * 100, s, sleep=_Naps())
        # The refused attempt consumed the window at the provider, so it must consume it
        # here too — otherwise the next call sails straight into another refusal.
        assert embeddings.get_rate_limiter().delay_for(100, limit=100) > 0

    def test_gives_up_rather_than_blowing_the_client_HTTP_timeout(self, monkeypatch):
        # The db-side runner holds the request for 10 minutes. A limiter tighter than the
        # batch could out-wait it and lose the whole batch; failing early costs one
        # resumable retry instead.
        monkeypatch.setattr(embeddings, "_real_embedding_batch", lambda t, s: [[0.1]] * len(t))
        s = _settings(ai_embed_texts_per_minute=10, ai_embed_max_pacing_wait_seconds=5.0)
        naps = _Naps()
        embeddings._embed_batch_paced(["x"] * 10, s, sleep=naps)
        out = embeddings._embed_batch_paced(["y"] * 10, s, sleep=naps)
        assert out.vectors is None
        assert naps.waits == []  # refused to start a wait it could not finish

    def test_reports_rate_limiting_even_when_the_call_eventually_SUCCEEDS(self, monkeypatch):
        # A run that only got through by waiting is healthy by every counter and is still
        # telling you the configuration is wrong. It has to be visible.
        calls = {"n": 0}

        def throttled_once(texts, settings):
            calls["n"] += 1
            if calls["n"] == 1:
                raise embeddings.ProviderEmbedError("429", status=429, retry_after=1.0)
            return [[0.1]] * len(texts)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", throttled_once)
        out = embeddings._embed_batch_paced(["a"], _settings(), sleep=_Naps())
        assert out.vectors is not None
        assert out.rate_limited is True
        assert out.waited_seconds == 1.0


class TestEmbedTextsIntegration:
    """The policy as ``embed_texts`` uses it — including that nothing is ever lost."""

    def test_a_failed_chunk_leaves_its_slots_None_for_a_later_run(self, monkeypatch):
        def always_503(texts, settings):
            raise embeddings.ProviderEmbedError("boom", status=503)

        monkeypatch.setattr(embeddings, "_real_embedding_batch", always_503)
        monkeypatch.setattr(embeddings.time, "sleep", lambda _s: None)
        out = embeddings.embed_texts(["milling", "grinding"], _settings())
        # None, NOT blocked: blocked means fail-closed and sends a clean alias to a human.
        assert out == [None, None]

    def test_a_failing_chunk_does_not_discard_the_chunk_beside_it(self, monkeypatch):
        seen: list[int] = []

        def fail_first_chunk(texts, settings):
            seen.append(len(texts))
            if "milling" in texts:
                raise embeddings.ProviderEmbedError("boom", status=503)
            return [[0.1] * embeddings.EMBEDDING_DIMENSION for _ in texts]

        monkeypatch.setattr(embeddings, "_real_embedding_batch", fail_first_chunk)
        monkeypatch.setattr(embeddings.time, "sleep", lambda _s: None)
        out = embeddings.embed_texts(["milling", "grinding"], _settings(ai_embed_request_batch=1))
        assert out[0] is None
        assert out[1] is not None and out[1].vector is not None

    def test_request_batch_is_configuration_driven(self, monkeypatch):
        sizes: list[int] = []

        def record(texts, settings):
            sizes.append(len(texts))
            return [[0.1] * embeddings.EMBEDDING_DIMENSION for _ in texts]

        monkeypatch.setattr(embeddings, "_real_embedding_batch", record)
        embeddings.embed_texts(["a", "b", "c", "d", "e"], _settings(ai_embed_request_batch=2))
        assert sizes == [2, 2, 1]

    def test_the_batch_size_is_clamped_to_something_sendable(self):
        assert embeddings.embed_request_batch(_settings(ai_embed_request_batch=0)) == 1
        assert embeddings.embed_request_batch(_settings(ai_embed_request_batch=10_000)) == 250

    def test_a_blocked_text_is_still_never_sent_to_the_provider(self, monkeypatch):
        # SG-2 is upstream of all of this and must stay that way: pacing and retries
        # change WHEN a call happens, never WHETHER a fail-closed phrase egresses.
        sent: list[list[str]] = []

        def record(texts, settings):
            sent.append(list(texts))
            return [[0.1] * embeddings.EMBEDDING_DIMENSION for _ in texts]

        monkeypatch.setattr(embeddings, "_real_embedding_batch", record)

        class _Blocked:
            blocked = True
            text = "SHOULD NEVER EGRESS"
            replaced_entities = []

        monkeypatch.setattr(embeddings, "pseudonymize", lambda t: _Blocked())
        out = embeddings.embed_texts(["anything"], _settings())
        assert sent == []
        assert out[0] is not None and out[0].blocked is True and out[0].text is None


class TestRealEmbeddingBatchTransport:
    """Transport failures must arrive as the classified error, not a bare exception."""

    def _client(self, monkeypatch, handler):
        class _C:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def post(self, *a, **k):
                return handler()

        monkeypatch.setattr(embeddings.httpx, "Client", _C)

    def test_a_429_carries_its_status_and_Retry_After(self, monkeypatch):
        self._client(
            monkeypatch,
            lambda: httpx.Response(429, headers={"retry-after": "17"}, text="slow down"),
        )
        with pytest.raises(embeddings.ProviderEmbedError) as ei:
            embeddings._real_embedding_batch(["a"], _settings())
        assert ei.value.status == 429 and ei.value.retry_after == 17.0 and ei.value.retryable

    def test_a_connect_error_is_marked_retryable(self, monkeypatch):
        def boom():
            raise httpx.ConnectError("refused")

        self._client(monkeypatch, boom)
        with pytest.raises(embeddings.ProviderEmbedError) as ei:
            embeddings._real_embedding_batch(["a"], _settings())
        assert ei.value.retryable is True

    def test_a_read_timeout_is_NOT_retryable_by_default(self, monkeypatch):
        def boom():
            raise httpx.ReadTimeout("took too long")

        self._client(monkeypatch, boom)
        with pytest.raises(embeddings.ProviderEmbedError) as ei:
            embeddings._real_embedding_batch(["a"], _settings())
        assert ei.value.retryable is False

    def test_a_read_timeout_becomes_retryable_only_when_configured(self, monkeypatch):
        def boom():
            raise httpx.ReadTimeout("took too long")

        self._client(monkeypatch, boom)
        with pytest.raises(embeddings.ProviderEmbedError) as ei:
            embeddings._real_embedding_batch(["a"], _settings(ai_embed_retry_on_read_timeout=True))
        assert ei.value.retryable is True
