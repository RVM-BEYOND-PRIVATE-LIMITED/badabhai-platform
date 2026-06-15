"""Supabase Storage fetch over the REST API — backend-only (Storage Mode A).

Mirrors the TS ``StorageService`` (``apps/api/src/storage/storage.service.ts``):
a direct REST call with the service-role key as ``Authorization: Bearer``, no SDK.
The AI service uses this for ONE purpose — downloading uploaded voice audio so the
real Sarvam STT path can transcribe it.

PRIVACY / SECURITY:
- Audio bytes and object keys are NEVER logged. Errors carry only status codes or
  generic strings (never the body or the key).
- The voice-notes bucket MUST be created PRIVATE (anon denied) OUT-OF-BAND by
  devops. RLS and migrations cover Postgres TABLES only — they do NOT govern
  Storage object ACLs. A public bucket would expose every uploaded voice note to
  anyone who guesses the object key.
"""

from __future__ import annotations

import urllib.parse

import httpx

from .config import Settings

_TIMEOUT_SECONDS = 20.0


async def download_object(settings: Settings, object_key: str, *, bucket: str) -> bytes:
    """Download the private object ``bucket/object_key`` and return its raw bytes.

    Raises ``RuntimeError`` (PII-free message) if storage is unconfigured, on a
    transport error, or on a non-2xx response. Never logs the bytes or the key.
    """
    if not settings.storage_configured:
        raise RuntimeError("supabase storage not configured (SUPABASE_URL / SERVICE_ROLE_KEY)")

    quoted = urllib.parse.quote(object_key, safe="/")
    url = f"{settings.supabase_url}/storage/v1/object/{bucket}/{quoted}"
    headers = {"Authorization": f"Bearer {settings.supabase_service_role_key}"}

    async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
        try:
            resp = await client.get(url, headers=headers)
        except httpx.HTTPError:
            # Never surface the exception detail (URL/key could appear there).
            raise RuntimeError("voice audio fetch failed (transport error)") from None

    if resp.status_code < 200 or resp.status_code >= 300:
        # Never include the bytes or the response body — status only.
        raise RuntimeError(f"voice audio fetch failed with status {resp.status_code}")

    return resp.content
