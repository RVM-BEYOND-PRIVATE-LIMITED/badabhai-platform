# @badabhai/config

Typed environment validation with a strict **server / public split**.

| Entry point                  | Use from        | Contains                          |
| ---------------------------- | --------------- | --------------------------------- |
| `@badabhai/config`           | backend only    | secrets (service role, LLM, STT)  |
| `@badabhai/config/public`    | frontend + back | only `NEXT_PUBLIC_*`-safe values  |

Key behaviors:

- `loadServerConfig(env?)` — validates server env; safe local defaults so the API
  boots in dev without every secret. Throws a readable error on invalid input.
- `loadPublicConfig(env?)` — validates only public keys; **ignores** server
  secrets, so the frontend can never crash because a backend key is missing.
- **Fail closed:** `areRealAiCallsEnabled` / `realAiCallsBlockedReason` only allow
  real LLM traffic when `AI_ENABLE_REAL_CALLS=true` **and** `GEMINI_FLASH_API_KEY`
  exists (the deprecated `LITELLM_API_KEY` is still accepted as an alias — TD28/ADR-0008).

> Never import `@badabhai/config` (server) from the web/worker app.
