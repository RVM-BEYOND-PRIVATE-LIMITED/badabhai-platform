"""The free chat's live news answer (ADR-0054): the search tool, the date, and the output boundary.

WHAT THE MODEL WRITES AND WHAT IT DOES NOT. The model writes the status, the kind and the lines.
It never writes a source: :func:`build_sources` builds the "read more" tiles from the provider's
response — the URLs the answer text CITED first, then the URLs the searches RETURNED — and keeps
only an ``https`` URL whose host is on the owner-approved list (R4) or a subdomain of one. So a
tile can only ever point at a page a search on the approved sites actually returned, whatever the
model or a web page says.

GROUNDED OR NOTHING (ADR-0054 §4). An ``answer`` with no surviving source becomes ``no_results``:
no ungrounded answer is served. A mock or a failed call has no provider result and therefore no
source, so it can never become an answer either.

MODEL OUTPUT IS UNTRUSTED, like the reply's (``reply.py``): every unreadable output — not JSON, not
an object, an unknown status, an answer whose kind or lines fail the contract — becomes the SAME
fail-closed refusal on ``unsafe_other``. A refusal topic outside the news prompt's four becomes
``unsafe_other`` too; that includes ``news`` itself, which the contract's shared topic set holds
for the REPLY and which would make the API serve "coming soon" from an armed news call.

WHAT THIS MODULE DOES NOT DO. It does not judge the lines: the API runs the free chat's whole reply
gate over them (§3.3), and re-checks every tile (https, listed host, title G1). The source checks
here are this service's half of the same rule, so a bad URL never crosses the seam at all.
"""

from __future__ import annotations

import json
import unicodedata
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from pydantic import ValidationError

from ..ai.gemini_client import LlmResult
from ..contracts import (
    FreeChatNewsAnswer,
    FreeChatNewsNoResults,
    FreeChatNewsRefuse,
    FreeChatNewsSource,
)
from ..profiling.canonical_roles import coerce_json_text

#: THE SITES A NEWS SEARCH MAY READ FROM, AND THE ONLY HOSTS A TILE MAY POINT AT. Mirrors
#: `FREE_CHAT_NEWS_DOMAINS` in `packages/types/src/index.ts` (owner-approved 2026-10-08, R4);
#: pinned EQUAL, order included, by tests/free_chat/test_free_chat_news.py, which reads that source.
#: A bare domain covers its subdomains, for the search's `allowed_domains` and for the tile check.
FREE_CHAT_NEWS_DOMAINS: tuple[str, ...] = (
    # Government
    "pib.gov.in",
    "labour.gov.in",
    "msde.gov.in",
    "skillindiadigital.gov.in",
    "ncs.gov.in",
    "dgt.gov.in",
    "epfindia.gov.in",
    # National and business
    "thehindu.com",
    "thehindubusinessline.com",
    "indianexpress.com",
    "indiatimes.com",
    "hindustantimes.com",
    "livemint.com",
    "business-standard.com",
    "financialexpress.com",
    "moneycontrol.com",
    "ndtv.com",
    "bbc.com",
    # Hindi
    "bhaskar.com",
    "jagran.com",
    "amarujala.com",
    "livehindustan.com",
    # Marathi
    "lokmat.com",
    "loksatta.com",
    "esakal.com",
    # Gujarati
    "divyabhaskar.co.in",
    "gujaratsamachar.com",
    "sandesh.com",
    # Kannada
    "prajavani.net",
    "kannadaprabha.com",
    # Telugu
    "eenadu.net",
    "sakshi.com",
    "andhrajyothy.com",
    # Tamil
    "dinamalar.com",
    "dailythanthi.com",
    "dinamani.com",
    "vikatan.com",
    # Everyday: weather, cricket, fuel prices
    "imd.gov.in",
    "espncricinfo.com",
    "cricbuzz.com",
    "iocl.com",
)

#: The Anthropic server tool and its version (ADR-0054 §3.2).
WEB_SEARCH_TOOL_TYPE = "web_search_20250305"
#: At most two searches per answer (§3.2). Each is billed (`WEB_SEARCH_COST_INR`), and the router
#: reserves every permitted one before the call.
NEWS_SEARCH_MAX_USES = 2

#: India Standard Time: UTC+05:30 all year, no daylight saving, so a fixed offset IS the zone
#: (and needs no tz database, which Windows hosts do not ship).
IST = timezone(timedelta(hours=5, minutes=30), "IST")

#: The contract's bounds (`NEWS_*` in packages/ai-contracts/src/free-chat.ts, pinned by the news
#: tests). The title is TRUNCATED to its cap rather than dropped: a long headline is still a source.
NEWS_SOURCES_MAX = 3
NEWS_URL_MAX = 500
NEWS_TITLE_MAX = 200
NEWS_SITE_MAX = 100
NEWS_SEARCHES_MAX = 3

#: The deterministic mock-posture answer, served while the task is unarmed (R7). The API tells it
#: apart by ``ai_metadata.real_call`` false and keeps today's NEWS line for it; the parse below
#: reads its status only, so the mock never reports a search it did not run.
MOCK_RESPONSE = '{"status": "no_results", "search_count": 0}'

#: What every unreadable output becomes. One constant, as on the reply.
REFUSED_FALLBACK = FreeChatNewsRefuse(status="refuse", topic="unsafe_other")

#: The topics the news prompt offers. `news` is deliberately absent (see the module docstring).
NEWS_REFUSAL_TOPICS = frozenset(
    {"off_limits", "distress", "legal_medical_financial", "unsafe_other"}
)


def news_search_tools() -> list[dict[str, Any]]:
    """The web search tool for one news call: a fresh list, so no caller can mutate a shared one.

    ``allowed_domains`` is the approved list (subdomains included by the provider);
    ``user_location`` biases results to India in India's time zone; ``max_uses`` caps the
    searches the provider will run, and therefore bill.
    """
    return [
        {
            "type": WEB_SEARCH_TOOL_TYPE,
            "name": "web_search",
            "max_uses": NEWS_SEARCH_MAX_USES,
            "allowed_domains": list(FREE_CHAT_NEWS_DOMAINS),
            "user_location": {
                "type": "approximate",
                "country": "IN",
                "timezone": "Asia/Kolkata",
            },
        }
    ]


def ist_today(now: datetime | None = None) -> date:
    """The calendar day in India: what "aaj" means to the worker. ``now`` is for tests."""
    return (now or datetime.now(UTC)).astimezone(IST).date()


def listed_host(host: str) -> bool:
    """``host`` is an approved domain, or a subdomain of one (a dot boundary, never a suffix).

    ``timesofindia.indiatimes.com`` passes; ``evil-indiatimes.com`` and
    ``indiatimes.com.evil.net`` do not.
    """
    return any(host == domain or host.endswith(f".{domain}") for domain in FREE_CHAT_NEWS_DOMAINS)


def _url_host(url: str) -> str | None:
    """The host of an acceptable tile URL, or None.

    Acceptable: at most ``NEWS_URL_MAX`` characters, ASCII with no whitespace or control
    character, scheme exactly ``https``, no user info and no explicit port, and an ASCII host on
    the list. Anything else is dropped rather than repaired: a source is evidence, not input.
    """
    if not url or len(url) > NEWS_URL_MAX or not url.isascii():
        return None
    if any(ch.isspace() or not ch.isprintable() for ch in url):
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    host = parts.hostname
    if parts.scheme != "https" or host is None or port is not None:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    return host if listed_host(host) else None


def clean_title(title: str) -> str:
    """A tile title: control and format characters gone, whitespace collapsed, at most 200 chars.

    Line breaks and tabs become spaces before the collapse; a zero-width or bidi character
    (category Cf) and any other control character (Cc) is removed outright. Truncated, not
    dropped, past the cap.
    """
    spaced = "".join(" " if ch in "\t\n\r\x0b\x0c" else ch for ch in title)
    kept = "".join(ch for ch in spaced if unicodedata.category(ch) not in ("Cc", "Cf"))
    return " ".join(kept.split())[:NEWS_TITLE_MAX].rstrip()


def _source(url: str, title: str) -> FreeChatNewsSource | None:
    """One tile from one ``(url, title)``, or None when the URL or the title cannot be used."""
    host = _url_host(url)
    if host is None:
        return None
    text = clean_title(title)
    site = host.removeprefix("www.")
    if not text or not site or len(site) > NEWS_SITE_MAX:
        return None
    try:
        return FreeChatNewsSource(url=url, title=text, site=site)
    except ValidationError:
        return None


def build_sources(result: LlmResult | None) -> list[FreeChatNewsSource]:
    """The answer's tiles, deterministically: cited URLs first, then search-result URLs.

    Deduplicated by exact URL (first occurrence wins, order kept), at most ``NEWS_SOURCES_MAX``.
    A citation without a usable title borrows the title its search result gave the same URL.
    ``None`` (a mock or a failed call) has no sources.
    """
    if result is None:
        return []
    result_titles: dict[str, str] = {}
    for url, title in result.search_results:
        if clean_title(title):
            result_titles.setdefault(url, title)
    sources: list[FreeChatNewsSource] = []
    seen: set[str] = set()
    for url, title in [*result.citations, *result.search_results]:
        if url in seen:
            continue
        seen.add(url)
        source = _source(url, title if clean_title(title) else result_titles.get(url, ""))
        if source is None:
            continue
        sources.append(source)
        if len(sources) == NEWS_SOURCES_MAX:
            break
    return sources


def search_count(result: LlmResult | None) -> int:
    """The searches the provider billed, capped at the contract's 3; 0 without a result."""
    if result is None:
        return 0
    return min(max(result.search_requests, 0), NEWS_SEARCHES_MAX)


def parse_news_output(
    content: str, result: LlmResult | None
) -> FreeChatNewsAnswer | FreeChatNewsNoResults | FreeChatNewsRefuse:
    """The model's content plus the provider's result as one validated output.

    Reads ``status``, and only the fields that status owns: ``kind`` and ``lines`` for an
    answer, ``topic`` for a refusal. Any other key the model writes — sources, a search count,
    chips, ``ai_metadata`` — is ignored: sources and the count come from ``result``, never from
    the model. Order of verdicts for an answer: an answer that fails the contract is
    ``unsafe_other``; a valid answer with no surviving source is ``no_results``.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return REFUSED_FALLBACK
    if not isinstance(raw, dict):
        return REFUSED_FALLBACK
    status = raw.get("status")
    count = search_count(result)
    no_results = FreeChatNewsNoResults(status="no_results", search_count=count)
    if status == "no_results":
        return no_results
    if status == "refuse":
        topic = raw.get("topic")
        if topic not in NEWS_REFUSAL_TOPICS:
            return REFUSED_FALLBACK
        return FreeChatNewsRefuse(status="refuse", topic=topic)
    if status != "answer":
        return REFUSED_FALLBACK
    sources = build_sources(result)
    try:
        return FreeChatNewsAnswer.model_validate(
            {
                "status": "answer",
                "kind": raw.get("kind"),
                "lines": raw.get("lines"),
                "sources": sources,
                "search_count": count,
            }
        )
    except ValidationError as exc:
        # Every source here is already a valid `FreeChatNewsSource` and there are at most three,
        # so `sources` can only fail by being EMPTY. If that is the ONLY failure, the answer was
        # well formed but ungrounded: `no_results`. Any failure in the model's own fields
        # (kind, lines) is a malformed answer: the refusal, whatever the search returned.
        locations = {error["loc"][:1] for error in exc.errors()}
        return no_results if locations == {("sources",)} else REFUSED_FALLBACK
