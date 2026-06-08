# @badabhai/web

Internal **ops console** for BadaBhai (Next.js App Router). Simple, clean,
internal-tool quality — intentionally not over-designed.

## Pages

| Route                | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `/`                  | dashboard shell                          |
| `/ops/workers`       | workers table (placeholder)              |
| `/ops/workers/[id]`  | worker profile view (placeholder)        |
| `/ops/events`        | read-only event stream (placeholder)     |
| `/ops/ai-jobs`       | AI jobs status (placeholder)             |

All pages currently render clearly-synthetic placeholder data; wiring to the API
is a later slice.

## Run

```bash
pnpm --filter @badabhai/web dev      # http://localhost:3000
pnpm --filter @badabhai/web build
pnpm --filter @badabhai/web typecheck
```

## Config & privacy

Reads only `@badabhai/config/public` (`NEXT_PUBLIC_*`) — it never imports backend
secrets, so a missing service-role key can't crash it. Worker views never render
raw PII (phone/full name).
