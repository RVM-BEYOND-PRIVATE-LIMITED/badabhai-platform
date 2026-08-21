# TASK 3 — AI_SPEND_REDIS_URL spend-gate verification

**Verification, not reimplementation.** The fix landed in `f2fb06fe` (merged to main as part
of #1177). This record independently checks that it is present and that the gate behaves as
claimed, by measurement rather than by reading the documentation it corrected.

```
TASK:                   3 — verify Redis spend-gate fix on main
BASE COMMIT:            1f367576
VERIFIED COMMIT:        f2fb06fe (squashed into 1f367576)
REDIS CONFIG:           AI_SPEND_REDIS_URL — unset by default; in-process backend
HOST CONNECTIVITY:      PASS (measured, see below)
CONTAINER CONNECTIVITY: PASS (compose network, redis:6379 — unaffected)
FAIL-CLOSED:            PASS (observed live, 168 blocked calls, ₹0 spent)
SUCCESS PATH:           PASS (164/164 queries succeeded on IPv4)
TD68:                   PASS (26 tests)
PRODUCTION MUTATIONS:   NONE
RESULT:                 VERIFIED
```

## A. Host connectivity — the mechanism is a timeout margin, not unreachability

This is the part the original diagnosis got slightly wrong, and the correction matters.
`localhost` is not unreachable. It tries `::1` first, waits for that to be **refused**, then
falls back to IPv4 and succeeds. It works — it just pays for the refusal first.

Measured 2026-08-21 against the running `badabhai-redis` container:

| address | outcome | time |
|---|---|---:|
| `localhost` | connects | **2.061s** |
| `127.0.0.1` | connects | **0.001s** |
| `::1` | ConnectionRefusedError | 2.054s |

`_REDIS_TIMEOUT_SECONDS = 2.0` (`apps/ai-service/app/ai/cost_tracker.py:359`).

**So `localhost` misses the SpendLedger's budget by ~61 ms.** That is the entire defect. It is
also why it resisted diagnosis: the container is healthy, `redis-cli` works, and the failure
surfaces as `spend_store_unavailable` — never as "slow".

`docker-compose.yml` publishes redis as `127.0.0.1:6379:6379`, an IPv4-only bind. That bind is
correct and is deliberately left alone: widening it would put an unauthenticated Redis on a
routable interface.

## B. Fail-closed — observed in production-shaped conditions, not simulated

Not a unit test. The Phase 9 evaluation ran with the misconfigured URL and produced:

```
errors                       168
budget_stopped               true
provider_estimated_cost_inr  0
```

`ai.cost` logged `spend_store_unavailable` with `error_type: TimeoutError`,
`timeout_seconds: 2.0`, and a per-request `projected_inr`, then blocked each call.

**168 real AI calls were prevented and ₹0 was spent.** TD68 behaved exactly as designed under a
real misconfiguration. This is the strongest available evidence that the gate fails closed, and
it was obtained by accident rather than by contrivance.

## C. Success path

With `AI_SPEND_REDIS_URL=redis://127.0.0.1:6379`, the same evaluation completed: **164/164
queries, 0 errors**, ₹0.0141 estimated, ledger reconciled. The gate permits authorized spend
when the store is reachable.

## D. TD68 unchanged

`tests/test_spend_cap.py`, `tests/test_spend_cap_redis.py`, `tests/test_task_type_ledger_parity.py`
— **26 passed**. No spend control was weakened, bypassed, or made optional. No IPv6 dependency
was introduced; the fix is guidance plus a `127.0.0.1` recommendation.

`AI_SPEND_REDIS_URL` remains **empty by default** in both compose files, so UNSET continues to
select the in-process backend — the correct dev/CI default. Nothing hardcodes a loopback URL
into shipped configuration.

## E. No production mutation

No promotion, no corpus mutation, no embedding, no edge generation, no seeding. The only writes
in this task are to two comment blocks and this document.

## Residual risk

The 61 ms margin is environment-specific. A slower host, or an IPv6 stack that black-holes
rather than refuses, would push `127.0.0.1` closer to the limit too — the fix removes the
IPv6 detour, it does not add headroom. If `spend_store_unavailable` ever recurs on a correct
IPv4 URL, the timeout constant is the thing to examine, and raising it is a TD68 change that
needs its own review rather than a quiet bump.

**Pinned by** `apps/api/src/config/redis-loopback-guidance.test.ts` (7 tests): the IPv4-only
bind still stands, the false "localhost works" claim cannot return, `localhost` is named only
as a warning, and the default stays empty.
