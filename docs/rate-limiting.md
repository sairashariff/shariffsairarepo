# KAN-48 technical specification

## Scope and implementation choices

This local spec records the supplied acceptance criteria and implementation.
It does not claim to update the original Confluence page or Jira ticket.
The user authorized creating a new Orders API in this previously empty repo.
The API provides tenant-isolated create, list, and get operations using Redis.
The rate-limit boundary precedes every public route, body parsing, and 404s.
Authentication failures do not consume quota because no tenant is trusted yet.
Platform admin, health, metrics, and trusted internal service callers are exempt.

The limiter is an atomic Redis Lua token bucket with a discrete refill at UTC
minute boundaries. Continuous token refill would allow more requests after
the 60th request during the same minute, contradicting the explicit Free-tier
criterion. Capacity starts full; every accepted decision consumes one token;
the next minute replaces the tokens with capacity, with no carry-over.
This intentionally permits a boundary burst of up to twice capacity across
two adjacent minutes; it is not a sliding-window limit.

Redis TIME is authoritative across API instances. The bucket and override keys
share a tenant-specific SHA-256 Redis Cluster hash tag, so the script remains
single-slot. The script reads the override and consumes a token in the same
operation. Bucket state expires after 120 seconds of inactivity; overrides and
orders do not expire. Use an appropriate Redis ACL, persistence, TLS,
non-evictable storage policy, and backup/recovery before deployment. EVAL
is used directly, avoiding NOSCRIPT recovery on cluster failover. Configure
native Cluster discovery with `REDIS_CLUSTER_ROOTS`; reads stay on primaries
so overrides are not delayed by replica lag.

## Plans and overrides

| Plan | Requests per minute |
|---|---|
| Free | 60 |
| Pro | Required `PRO_RATE_LIMIT` from the approved Confluence table |
| Enterprise | Required `ENTERPRISE_RATE_LIMIT` from that table |

Both enabled modes fail startup without the paid plan values. Production paid
limits are not inferred from tests or benchmarks. All capacities are positive
integers up to 1,000,000; reconcile this bound with the final plan table.

Platform admins set or remove overrides through the documented authenticated
admin routes. There is no override cache: a successfully acknowledged write is
read on the next request (well within 60 seconds under normal Redis operation).
Changes preserve already-consumed tokens. Decreasing below current usage
creates negative token debt; increasing or reverting does not erase that debt.
Concurrent decisions and override writes are serialized by the Redis primary.
An in-flight decision ordered before an override can still use the old limit.
Admin mutations emit structured audit events without API keys.

## Modes and errors

- `off`: no limiter Redis operations, rejection, or limiter metrics.
- `log-only`: consume tokens, record metrics and would-reject logs, but never
  reject for quota. A limiter error is explicitly logged and measured and
  allowed through. Orders storage can independently fail with 503.
- `enforce`: reject exhausted buckets with HTTP 429 and JSON
  `error.code=RATE_LIMIT_EXCEEDED`, `error.retryAfterSeconds`, and `Retry-After`.
  Limiter errors fail closed with HTTP 503 and a five-second retry hint.

Every successfully evaluated tenant response in an enabled mode carries both
header formats, including allowed responses and quota rejections:

| Header | Legacy header | Value |
|---|---|---|
| `RateLimit-Limit` | `X-RateLimit-Limit` | Effective capacity, including overrides |
| `RateLimit-Remaining` | `X-RateLimit-Remaining` | Nonnegative remaining tokens after the decision |
| `RateLimit-Reset` | `X-RateLimit-Reset` | Relative seconds until refill / absolute Unix-epoch seconds, respectively |

Both reset values come from the same Redis TIME decision, not the API host's
clock. Every HTTP 429 includes a positive integer `Retry-After` matching
`RateLimit-Reset` and JSON `error.retryAfterSeconds` (1-60 seconds).
Log-only does not send `Retry-After` because the request was not rejected.
Off mode, exempt callers, and limiter failures do not emit either rate-limit
header format; enforce-mode limiter failures retain the five-second 503 retry
hint. A rejected request never reaches Orders storage.
The limiter applies a 200 ms application-level Redis round-trip
deadline: the Redis client's own command timeout only bounds the write queue.
The client also disables offline queuing, bounds the command queue at 10,000,
and bounds connection retries. A timed-out in-flight command may still consume
a token when Redis recovers; no refund is attempted because that could violate
the capacity under concurrency. Failures are not success-shaped responses.
Modes and the static plan/key configuration change on restart.

## Performance and validation

Unit coverage has a mandatory 85% threshold in all four coverage dimensions;
the process bootstrap is excluded and is checked separately by startup smoke
tests. Redis integration tests cover concurrency, strict Free capacity,
no continuous refill, minute-boundary refill, configured paid capacities,
tenant isolation, and immediate overrides via HTTP.

`npm run test:load` runs the real HTTP Orders API with 50 connections at a
minimum measured 5,000 RPS, first off and then enforce, for 20 seconds per mode.
It offers 5,050 RPS to allow client timing overhead without relaxing that minimum.
It uses a random synthetic Enterprise tenant with a 1,000,000 capacity so
requests exercise both Redis limiting and Orders storage, not merely fast 429s.
The benchmark records per-decision middleware duration (Redis round trip,
headers, decision handling, and the final Prometheus metrics write, excluding
authentication, downstream Orders storage, and benchmark instrumentation)
and end-to-end HTTP latency. It fails if there are HTTP/client errors,
achieved throughput is below 5,000 RPS, or limiter p95 is not strictly below 5 ms.
Raw evidence is in `load-test-results.json`. This single-host measurement is
not proof for a cross-region production Redis deployment. Repeat against the
intended regional topology before enabling enforcement.

## Observability and rollout / Definition of Done

Prometheus metrics, a Grafana dashboard, and alert rules live in
`../observability/`. They distinguish real rejections from log-only decisions
and track rejection rate/ratio per tenant, limiter errors, and p95 overhead.
Deploy and verify the scrape, dashboard, alert routing, and label cardinality
limits; committing the assets does not deploy them.

The default is off. Before enabling log-only, confirm the paid plan table,
the calendar-minute interpretation, public endpoint scope, override mechanism,
and Redis durability/eviction policy with the owners. Before enforcement:

- Obtain two human approvals.
- Run a regional production-like 5,000 RPS test with p95 limiter overhead <5 ms.
- Assign an owner to notify Enterprise tenants at least two weeks beforehand.
- Agree the log-only duration and measurable promotion/rollback criteria.
- Deploy dashboards/alerts and verify that on-call receives test notifications.
- Update the authoritative Confluence spec with the agreed decisions.
- Track the developer-documentation follow-up and link it to KAN-48.

The draft PR reports local evidence and links the
[developer-docs follow-up](https://github.com/sairashariff/shariffsairarepo/issues/3).
Human approvals, customer notices, live dashboards, and Jira/
Confluence changes cannot be claimed by this implementation.
