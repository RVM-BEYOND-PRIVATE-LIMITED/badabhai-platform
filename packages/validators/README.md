# @badabhai/validators

Reusable **Zod validators** shared by API DTOs, AI contracts, and tests:

- `e164PhoneSchema` / `isE164Phone` — E.164 phone numbers
- `uuidSchema` — RFC 4122 UUID
- `languageCodeSchema` — supported language codes
- `voiceDurationSecondsSchema` / `isValidVoiceDuration` — > 0 and ≤ 120s
- `nonEmptyMessageSchema` — trimmed, non-empty text
- `safeTextSchema(max)` — bounded free text (default 5000)
- `consentPurposesSchema` — non-empty, unique subset of known purposes

Keep these small and composable. Domain constants come from `@badabhai/types`.
