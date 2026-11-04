# Orders API

TypeScript/Express Orders API with Redis-backed per-tenant rate limiting for
KAN-48. This repository previously contained no API; this is a new, minimal
create/list/get implementation, not a port of `contoso/orders-api`.

## Run locally

Requires Node.js 22+ and Redis 7+. Run `npm ci`, start Redis with
`docker compose up -d redis` (or your own Redis), and copy `.env.example` to
`.env`. Set `API_KEYS` to a JSON array with independently generated secrets
of at least 32 characters. Generate each secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Each entry is `{ "key": "<secret>", "principal": { ... } }`. Supported principals:

| Kind | Principal fields | Access |
|---|---|---|
| `tenant` | `tenantId`, `tier` (`free`, `pro`, `enterprise`) | That tenant's public Orders API |
| `service` | `tenantId` | That tenant's Orders API; exempt from rate limits |
| `admin` | None | Override management and metrics; no Orders access |

Use provisioned, trusted service keys only for internal service-to-service
callers. Never grant that kind based on an incoming header. Keys for the same
tenant must use the same plan. In production, supply secrets from your secret
manager, terminate TLS, use authenticated TLS Redis and persistence/backups,
and replace the static key registry with your identity provider as appropriate.
API key and mode changes currently require a process restart.
For native Redis Cluster, set `REDIS_CLUSTER_ROOTS` to a JSON array of seed URLs
(prefer three nodes); commands use primary nodes, not potentially stale replicas.

Run `npm run dev`, or `npm run build && npm start`.

## Endpoints

Send `Authorization: Bearer <key>`. Tenant identity and plan are resolved from
the configured key, never from tenant/role/plan headers.

| Method and path | Behavior |
|---|---|
| `POST /orders` | Create `{ "items": [{ "sku": "SKU-1", "quantity": 2 }] }`; returns 201 and `Location` |
| `GET /orders` | List this tenant's orders |
| `GET /orders/:orderId` | Read one of this tenant's orders |
| `PUT /admin/tenants/:tenantId/rate-limit` | Admin only; set `{ "limit": 75 }` requests per minute |
| `DELETE /admin/tenants/:tenantId/rate-limit` | Admin only; revert to the plan limit |
| `GET /metrics` | Admin-only Prometheus metrics |
| `GET /healthz` | Unauthenticated process liveness, not Redis readiness |

Orders are stored in tenant-isolated Redis hashes. The initial API has no
billing, fulfillment, deletion, idempotency, or pagination contract; list is
intended for small datasets. Redis must be configured for durable order data
and persistent, non-evictable overrides before production use.

## Rate limiting

`RATE_LIMIT_MODE` defaults to `off`; choose `log-only` to observe or `enforce`
to reject. Free is **60 requests per UTC calendar minute**. Paid limits must be
supplied in `PRO_RATE_LIMIT` and `ENTERPRISE_RATE_LIMIT` from the approved
Confluence table before either enabled mode will start. No paid limits are
invented here. Limits and overrides accept integers from 1 to 1,000,000.

All authenticated public endpoints and unknown public paths share one bucket
per tenant across API instances. Authenticated service traffic, health, admin
routes, and metrics do not consume tenant quota. Invalid authenticated public
requests do consume quota. Overrides take effect on the next request, without
a cache or process restart. Evaluated tenant responses include both
`RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset` and legacy
`X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` headers.
Limit and remaining values match across formats; `RateLimit-Reset` is seconds
until refill, while `X-RateLimit-Reset` is the refill's Unix timestamp in seconds.
Every 429 includes `Retry-After`, matching `RateLimit-Reset` and JSON
`error.retryAfterSeconds`. Log-only responses include both header formats but
no `Retry-After`; off mode and exempt callers include neither format.

See the [technical spec and rollout gates](docs/rate-limiting.md),
[observability setup](observability/README.md), and
[load-test evidence](docs/load-test-results.json).

## Validation

```sh
npm run typecheck
npm run test:coverage
npm run build
# Start a dedicated Redis at 127.0.0.1:16379 (no production data).
npm run test:integration
npm run test:smoke
LOAD_REPORT=docs/load-test-results.json npm run test:load
```

`TEST_REDIS_URL` overrides the test Redis address. Set
`TEST_REDIS_CLUSTER_ROOTS` to a JSON array of seed URLs to run integration tests
against Redis Cluster instead. Integration/load tests create
random tenant namespaces and remove only their own keys; they never flush Redis.
Coverage enforces 85% for statements, lines, functions, and branches over all
application modules except the process bootstrap (`src/server.ts`). The real
Lua script is additionally exercised against Redis by the integration suite.
The smoke test checks the compiled process and briefly pauses its dedicated
standalone test Redis to verify timeout/recovery. Never run it against shared
or production Redis.
The load harness offers 5,050 RPS and requires at least 5,000 completed RPS
with limiter p95 strictly below 5 ms; the report records actual throughput.