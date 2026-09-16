<!-- translated-from: docs/hosting.md sha256:b420345ce39c7844f1d3b798d82058f696f80966c3103fd7c0a29c2e40f05b1c -->

# Where to run it (VPS / AWS / Azure)

*日本語版: [docs/hosting.md](../hosting.md)*

[deployment.md](deployment.md) is the single list of environment variables, Docker usage and reverse proxy setup. This page covers **only what differs between places you might run it**. Cloudflare Containers has its own page, [cloudflare.md](cloudflare.md).

## Decide one thing first: does the disk survive?

That alone determines the session store.

| Disk | Examples | `SESSION_STORE` |
|---|---|---|
| Survives | Sakura VPS, EC2, Lightsail, Azure VM | `sqlite` (keep the volume) |
| Does not | ECS Fargate, App Runner, Azure Container Apps, Cloud Run | `redis` (`REDIS_URL` required) |

Leaving `sqlite` on a disk that does not survive signs everyone out and loses every saved query each time the container is replaced.

## The same everywhere

| Item | Setting |
|---|---|
| TLS | tsmyadmin does not terminate TLS. Something in front always must |
| `TRUST_PROXY` | `1` when something sits in front; leave it `0` when exposed directly |
| Health checks | `/readyz` for startup, `/healthz` for liveness |
| Port | 3100 by default; `PORT` or `API_PORT` changes it |
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
    image: tsmyadmin:local        # There is no published image — build your own
    environment:
      NODE_ENV: production
      SESSION_SECRET: "…"          # openssl rand -hex 32
      TSMYADMIN_ALLOWED_HOSTS: "db.example.com:3306"
      TRUST_PROXY: "1"
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

**Watch out**: do not open port 3100 in the firewall. While it is open, anyone can bypass the reverse proxy and name their own `X-Forwarded-For`.

---

## AWS

### ECS Fargate behind an ALB

| Item | Setting |
|---|---|
| Sessions | ElastiCache for Redis: `SESSION_STORE=redis` and `REDIS_URL=rediss://…` |
| TLS | Terminated at the ALB, so `TRUST_PROXY=1` |
| Health check | Set the target group's health check path to `/readyz` |
| Memory | 1 GB or more — a 64 MB import peaks in the hundreds of MB |
| Secrets | Pass them from Secrets Manager or SSM via `secrets`; anything in `environment` sits in the task definition in the clear |
| More than one task | Turn on sticky sessions in the target group |

*Several replicas* in [deployment.md](deployment.md) explains why stickiness is still needed with `SESSION_STORE=redis`: being signed in is shared, but cancelling a running query, the login rate limit and the connection pools all stay in the task that created them.

An ALB appends the client IP to `X-Forwarded-For`, so with a single hop the last element is the client.

### App Runner

Simpler, since it needs neither an ALB nor a VPC. It injects `PORT`, which tsmyadmin honours, and terminates TLS itself, so use `TRUST_PROXY=1`. The disk does not survive, so Redis is required. Reaching RDS or ElastiCache needs a VPC connector.

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
| Replicas | Minimum 1 — scaling to zero means a cold start on the next visit |
| Secrets | Assign Container Apps secrets to environment variables |

### App Service for Containers

This works, but `WEBSITES_PORT` has to be set to 3100.

This service can pass `X-Forwarded-For` with a port attached (`1.2.3.4:56789`). tsmyadmin drops a trailing port before using the address, so rate limiting stays per IP.

### VM

Same as *Sakura VPS and other ordinary servers* above.

---

> Every front-end shape listed here is covered by `apps/api/src/platform-conformance.test.ts`: for each one it checks that the visitor is identified, that rate-limiting one visitor does not take another down with them, and that cycling user names does not get around the per-address limit. **Adding a place to run it means adding the same row to that test.**

## Verified and not verified

**Verified**: booting the production image with `SESSION_STORE=redis` and `TRUST_PROXY` set — logging in, the session landing in Redis, and the client IP being taken from the forwarded header — all locally.

**Not verified**: running on real AWS or Azure accounts. The tables above come from each service's own documentation and have not been measured on the real thing. On the first deploy, confirm the same three things *Confirm it actually works* in [cloudflare.md](cloudflare.md) lists: that the database and Redis are reachable, that the client IP differs per visitor, and that stopping waits for work in flight.
