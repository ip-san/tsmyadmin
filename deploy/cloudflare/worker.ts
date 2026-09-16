/**
 * The Worker that fronts the container on Cloudflare. See docs/cloudflare.md.
 *
 * Not part of any workspace: it is outside the repository's tsconfig projects, so `bun run check` does not
 * typecheck it. Neither does anything else — `wrangler deploy` and `bun run cf:check` bundle with esbuild, which
 * strips types without checking them. `cf:check` therefore proves the file bundles and the bindings resolve, not
 * that it is type-correct. Keep this file small enough to review by eye.
 */
// @ts-nocheck - Cloudflare's Worker types (DurableObjectState, DurableObjectNamespace) are not in this project.
import { Container } from '@cloudflare/containers'

/** Must match EXPOSE in the Dockerfile; `bun run check:static` fails if the two drift apart. */
const CONTAINER_PORT = 3100

/** What `wrangler secret put` stores. `TSMYADMIN_SERVERS` is optional (only for connection presets). */
interface Env {
  SESSION_SECRET: string
  REDIS_URL: string
  TSMYADMIN_ALLOWED_HOSTS: string
  TSMYADMIN_SERVERS?: string
  TSMYADMIN: DurableObjectNamespace<TsmyadminContainer>
}

export class TsmyadminContainer extends Container<Env> {
  defaultPort = CONTAINER_PORT
  /**
   * How long an idle instance stays up. Cloudflare's default is 10 minutes, which a long export or import can
   * run into; this is deliberately longer. Lower it to pay less, at the cost of a cold start for whoever
   * arrives next.
   */
  sleepAfter = '30m'

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Secrets reach the *Worker*, not the container: a container only receives what is listed here. Leave one
    // out and the process exits at startup — `SESSION_SECRET` is required in production, and `SESSION_STORE=redis`
    // makes `REDIS_URL` required too.
    for (const name of ['SESSION_SECRET', 'REDIS_URL', 'TSMYADMIN_ALLOWED_HOSTS']) {
      // Fail here with a readable message rather than passing `undefined` through and having the container exit
      // with `Invalid environment: …` from inside a process whose logs may not be wired up yet.
      if (!env[name]) throw new Error(`${name} is not set. Run: bunx wrangler secret put ${name}`)
    }
    this.envVars = {
      NODE_ENV: 'production',
      // Pinned so CONTAINER_PORT is what the app actually listens on, rather than matching its default by
      // coincidence. scripts/validate-docs.mjs ties CONTAINER_PORT to the Dockerfile's EXPOSE.
      API_PORT: String(CONTAINER_PORT),
      // Required: a container's disk is wiped whenever it sleeps, so the file-backed store would sign everyone
      // out and drop every saved query each time that happened.
      SESSION_STORE: 'redis',
      // Reads CF-Connecting-IP. A request forwarded by a Worker may carry no X-Forwarded-For, and '1' would then
      // fall back to the socket address — the Worker's own — giving every visitor one shared rate-limit bucket.
      TRUST_PROXY: 'cloudflare',
      SESSION_SECRET: env.SESSION_SECRET,
      REDIS_URL: env.REDIS_URL,
      TSMYADMIN_ALLOWED_HOSTS: env.TSMYADMIN_ALLOWED_HOSTS,
      ...(env.TSMYADMIN_SERVERS ? { TSMYADMIN_SERVERS: env.TSMYADMIN_SERVERS } : {}),
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const headers = new Headers(request.headers)
    // The container library reads this off the incoming request to pick the port it proxies to, so a client must
    // not be able to supply it.
    headers.delete('cf-container-target-port')
    // The library rewrites https: to http: before proxying, so inside the container the URL scheme always reads
    // as plain. The API would then refuse every login with INSECURE_TRANSPORT unless X-Forwarded-Proto says
    // otherwise. Set it from the scheme the edge actually used, rather than relying on the header arriving.
    headers.set('x-forwarded-proto', new URL(request.url).protocol === 'https:' ? 'https' : 'http')
    // One fixed name, so every request reaches the same instance. Spreading requests over several names sends a
    // login to one instance and the next request to another; see "Running more than one" in docs/cloudflare.md.
    return env.TSMYADMIN.getByName('default').fetch(new Request(request, { headers }))
  },
}
