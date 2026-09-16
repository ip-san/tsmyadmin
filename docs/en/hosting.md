<!-- translated-from: docs/hosting.md sha256:57f788c67c87f806f782feb7827c5c922139134d8a161290cbcd6ebb01050980 -->

# Where to run it (VPS / AWS / Azure)

*日本語版: [docs/hosting.md](../hosting.md)*

[deployment.md](deployment.md) is the single list of environment variables, Docker usage and reverse proxy setup. This page covers **only what differs between places you might run it**. Cloudflare Containers has its own page, [cloudflare.md](cloudflare.md).

## Decide one thing first: does the disk survive?

That alone determines the session store.

| Disk | Examples | `SESSION_STORE` |
|---|---|---|
| Survives | Sakura VPS, EC2, Lightsail, Azure VM | `sqlite` (keep the volume) |
| Does not | ECS Fargate, App Runner, Azure Container Apps, App Service for Containers (unverified) | `redis` (`REDIS_URL` required) |

Leaving `sqlite` on a disk that does not survive signs everyone out and loses every saved query each time the container is replaced.

## The same everywhere

| Item | Setting |
|---|---|
| TLS | tsmyadmin does not terminate TLS. Something in front always must |
| `TRUST_PROXY` | `1` when something sits in front. With nothing in front (a closed network without TLS, and only that) leave it `0` and also set `COOKIE_SECURE=0` — in production a plain-HTTP login is refused by default |
| Health checks | Point a load balancer at `/healthz`. **`/readyz` checks the session store** (Redis under `redis`), not the database you connect to |
| Memory | 512 MB or more (*Size and limits* in [deployment.md](deployment.md)). Only a 64 MB import pushes the peak into the hundreds of MB |
| More than one instance | Sharing sessions does not share the rest: cancelling a running query, the login rate limit and the connection pools stay per instance. Running two or more requires sticky sessions (*Several replicas* in [deployment.md](deployment.md)). If you cannot enable them, stay at one |
| Port | 3100 by default; `API_PORT` changes it. The platform-injected `PORT` is honoured only when `API_PORT` is unset — set both and `API_PORT` wins |
| Reachability | [security.md](security.md) states that exposing it directly to the internet is not an intended use. Put a VPN, an IP restriction or SSO in front |

> `TRUST_PROXY=1` takes the **last** element of `X-Forwarded-For`. With several proxies in a chain, normalise that header down to the client IP in the proxy directly in front of tsmyadmin (see *Reverse proxy and TLS* in [deployment.md](deployment.md)).

---

## Sakura VPS and other ordinary servers

ConoHa, EC2, Lightsail and Azure VM all work the same way. **The disk survives, which makes this the simplest option.**

1. Install Docker
2. Bring up tsmyadmin (`docker compose`; there is a full example in [deployment.md](deployment.md))
3. Put a reverse proxy that terminates TLS in front

```yaml
# Just the parts that matter here; the full example is in deployment.md
services:
  tsmyadmin:
    image: tsmyadmin:latest       # There is no published image — build your own with `docker build -t tsmyadmin .`
    environment:
      NODE_ENV: production
      SESSION_SECRET: "…"          # openssl rand -hex 32
      TSMYADMIN_ALLOWED_HOSTS: "db.example.com:3306"
      TRUST_PROXY: "1"
    ports:
      - "127.0.0.1:3100:3100"     # Loopback only; this is what Caddy connects to
    volumes:
      - session:/app/data          # Delete this and everyone is signed out
volumes:
  session:
```

Caddy is the shortest thing to put in front, since it handles Let's Encrypt on its own.

```caddyfile
tsmyadmin.example.com {
  reverse_proxy 127.0.0.1:3100
}
```

Caddy sets `X-Forwarded-For` and `X-Forwarded-Proto` itself, so `TRUST_PROXY=1` is all that is needed to match it. There is an nginx example in [deployment.md](deployment.md).

**Watch out**: writing `"3100:3100"` without the `127.0.0.1:` opens 3100 to the outside. While it is open, anyone can bypass the reverse proxy and name their own `X-Forwarded-For`.

---

## AWS

### ECS Fargate behind an ALB

| Item | Setting |
|---|---|
| Sessions | ElastiCache for Redis: `SESSION_STORE=redis` and `REDIS_URL=rediss://…` |
| TLS | Terminated at the ALB, so `TRUST_PROXY=1` |
| Health check | Set the target group's health check path to `/healthz`. With `/readyz`, one brief Redis outage marks every task unhealthy at once and the service cycles |
| Secrets | Pass them from Secrets Manager or SSM via `secrets`; anything in `environment` sits in the task definition in the clear |
| More than one task | Turn on sticky sessions in the target group |

*Several replicas* in [deployment.md](deployment.md) explains why stickiness is still needed with `SESSION_STORE=redis`: being signed in is shared, but cancelling a running query, the login rate limit and the connection pools all stay in the task that created them.

An ALB appends the client IP to `X-Forwarded-For`, so with a single hop the last element is the client.

### App Runner

Simpler, since it needs neither an ALB nor a VPC. It injects `PORT`, which tsmyadmin honours, and terminates TLS itself, so use `TRUST_PROXY=1`. The disk does not survive, so Redis is required. Reaching RDS or ElastiCache needs a VPC connector. Whether App Runner can do sticky sessions is unverified, so keep it at one instance until you have checked.

### EC2 and Lightsail

Same as *Sakura VPS and other ordinary servers* above.

---

## Azure

### Container Apps

| Item | Setting |
|---|---|
| Sessions | Azure Cache for Redis: `SESSION_STORE=redis` |
| TLS | Terminated by ingress, so `TRUST_PROXY=1` |
| Port | Set the ingress target port to 3100 |
| Health checks | `/readyz` for startup and readiness, `/healthz` for liveness |
| Replicas | Minimum 1 — scaling to zero means a cold start on the next visit. Going above one means enabling session affinity on the ingress |
| Secrets | Assign Container Apps secrets to environment variables |

### App Service for Containers

Use `redis` for sessions here — whether this container's filesystem survives a restart is unverified. `WEBSITES_PORT` also has to be set to 3100.

This service can pass `X-Forwarded-For` with a port attached (`1.2.3.4:56789`). tsmyadmin drops a trailing port before using the address, so rate limiting stays per IP.

### VM

Same as *Sakura VPS and other ordinary servers* above.

---

> Every front-end shape listed here is covered by `apps/api/src/platform-conformance.test.ts`: for each one it checks that the visitor is identified, that rate-limiting one visitor does not take another down with them, and that cycling user names does not get around the per-address limit. **Adding a place to run it means adding the same shape to `PLATFORMS` in that test.**

## Verified and not verified

**Verified**: booting the production image with `SESSION_STORE=redis` and `TRUST_PROXY` set — logging in, the session landing in Redis, and the client IP being taken from the forwarded header — all locally.

**Not verified**: running on real AWS or Azure accounts. The tables above come from each service's own documentation and have not been measured on the real thing. On the first deploy, confirm three things:

1. `/readyz` returns 200 **and** you can log in — the first means Redis is reachable, the second means the database is
2. The `ip` field of the `event: http` log lines differs per visitor
3. Roll out an update during an export, and an export that finishes within `SHUTDOWN_TIMEOUT_SECONDS` (30 seconds by default) completes

The Cloudflare equivalent is in [cloudflare.md](cloudflare.md).
