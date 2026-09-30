# Load test (1.0.0)

Measured on 28 September 2026 on a single developer laptop (Apple Silicon,
Node 26, Postgres 16 and Redis 8 on the same machine), against the compiled
API (`node dist/server.js`, `NODE_ENV=production`) with a real database of
about 900 emails, 18,500 audit events and 1,200 routing decisions.

Tool: `autocannon -c 50 -d 15` (50 concurrent connections, 15 seconds per
endpoint), authenticated with a session cookie. Every response was 2xx.
The per-client rate limit was raised for the run
(`RATE_LIMIT_PER_MINUTE=1000000`); with the default (300/min per client) a
single load generator is — correctly — throttled after 300 requests.

| Endpoint | Requests/s | Mean latency | p99 latency |
|---|---:|---:|---:|
| `GET /api/v1/ready` | 26,170 | 1.4 ms | 3 ms |
| `GET /api/v1/reviews?status=open` | 8,148 | 5.6 ms | 9 ms |
| `GET /api/v1/stats` | 6,105 | 7.7 ms | 13 ms |
| `GET /api/v1/stats/reports?days=7` | 1,820 | 27 ms | 67 ms |
| `GET /api/v1/emails?limit=25` | 547 | 91 ms | 158 ms |

The email list is the heaviest read (≈13 KB per page). One API process
serves several hundred list pages per second; run more API replicas behind
the proxy to scale out (rate limits and sessions are shared through Redis).

Reproduce:

```sh
RATE_LIMIT_PER_MINUTE=1000000 API_PORT=3902 node --env-file=.env dist/server.js &
npx autocannon -c 50 -d 15 -H "cookie=jm_session=<session>" -H "x-organization-id=<org id>" \
  "http://localhost:3902/api/v1/emails?limit=25"
```
