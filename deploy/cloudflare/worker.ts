/**
 * The Worker that fronts the container on Cloudflare. See docs/cloudflare.md.
 *
 * Not part of any workspace: it is built by `wrangler deploy`, against Cloudflare's own types, so it is outside
 * the repository's tsconfig projects and is not typechecked by `bun run check`.
 */
// @ts-nocheck - resolved by wrangler at deploy time (npm i -D @cloudflare/containers wrangler).
import { Container } from '@cloudflare/containers'

/** Must match EXPOSE in the Dockerfile; `bun run check:static` fails if the two drift apart. */
const CONTAINER_PORT = 3100

export class TsmyadminContainer extends Container {
  defaultPort = CONTAINER_PORT
  /**
   * How long an idle instance stays up. Cloudflare's default is 10 minutes, which a long export or import can
   * run into; this is deliberately longer. Lower it to pay less, at the cost of a cold start for whoever
   * arrives next.
   */
  sleepAfter = '30m'
  envVars = {
    NODE_ENV: 'production',
    // Required: a container's disk is wiped whenever it sleeps, so the file-backed store would sign everyone
    // out and drop every saved query each time that happened.
    SESSION_STORE: 'redis',
    // Reads CF-Connecting-IP. A request forwarded by a Worker may carry no X-Forwarded-For, and '1' would then
    // fall back to the socket address — the Worker's own — giving every visitor one shared rate-limit bucket.
    TRUST_PROXY: 'cloudflare',
  }
}

export default {
  async fetch(request: Request, env: { TSMYADMIN: DurableObjectNamespace<TsmyadminContainer> }) {
    // One fixed name, so every request reaches the same instance. Spreading requests over several names sends a
    // login to one instance and the next request to another; see "Running more than one" in docs/cloudflare.md.
    return env.TSMYADMIN.getByName('default').fetch(request)
  },
}
