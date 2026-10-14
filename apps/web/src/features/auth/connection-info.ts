import type { Dialect, ServerPreset } from '@tsmyadmin/shared'

/**
 * Where the application under development runs, seen from the database container: on the host itself, in a
 * container on the same Compose network (it reaches the service by name), or in a container on another network.
 */
export type Viewpoint = 'host' | 'sameNetwork' | 'otherNetwork'

/** An address one viewpoint reaches the database by. */
export interface Endpoint {
  viewpoint: Viewpoint
  host: string
  port: number
}

/** The lines to paste into the application's configuration, for one endpoint. Never a password. */
export interface ConnectionSnippets {
  address: string
  databaseUrl: string
  env: string
  laravelEnv: string
}

/** What stands in for the password: the screen never has it, and the developer fills it in. */
const PASSWORD_PLACEHOLDER = '<password>'
const USER_PLACEHOLDER = '<user>'
/** The host name Docker Desktop gives every container for the host (Linux: `extra_hosts: host-gateway`). */
const HOST_GATEWAY = 'host.docker.internal'

const URL_SCHEME: Record<Dialect, string> = { mysql: 'mysql', postgres: 'postgresql' }
const LARAVEL_CONNECTION: Record<Dialect, string> = { mysql: 'mysql', postgres: 'pgsql' }
/**
 * The database a login lands in when the container named none: the PostgreSQL image creates one named after its
 * user; a MySQL account needs none.
 */
const DEFAULT_DATABASE: Record<Dialect, (user: string | undefined) => string | undefined> = {
  mysql: () => undefined,
  postgres: (user) => user,
}

/**
 * The addresses of a discovered container, one per viewpoint; empty for a preset that is not a Docker container.
 * The host's own address is the one discovery reaches the published port by, except when tsmyadmin itself runs in a
 * container (it reaches the host as host.docker.internal): the host then reaches its own published port on 127.0.0.1.
 * The same-network address needs the Compose service name, so a container started without Compose has none.
 */
export function connectionEndpoints(preset: ServerPreset): Endpoint[] {
  const docker = preset.docker
  if (!docker) return []
  const fromHost = preset.host === HOST_GATEWAY ? '127.0.0.1' : preset.host
  return [
    { viewpoint: 'host', host: fromHost, port: preset.port },
    ...(docker.service ? [{ viewpoint: 'sameNetwork' as const, host: docker.service, port: docker.privatePort }] : []),
    { viewpoint: 'otherNetwork', host: HOST_GATEWAY, port: preset.port },
  ]
}

/** `[::1]` for an IPv6 literal (a URL needs the brackets), anything else as it is. */
const urlHost = (host: string) => (host.includes(':') ? `[${host}]` : host)

/** The `DATABASE_URL`, the generic `.env` line and Laravel's `.env` block for one endpoint of a preset. */
export function connectionSnippets(preset: ServerPreset, endpoint: Endpoint): ConnectionSnippets {
  const user = preset.docker?.user
  const database = preset.database ?? DEFAULT_DATABASE[preset.dialect](user)
  const userPart = user ? encodeURIComponent(user) : USER_PLACEHOLDER
  const path = database ? `/${encodeURIComponent(database)}` : ''
  const databaseUrl = `${URL_SCHEME[preset.dialect]}://${userPart}:${PASSWORD_PLACEHOLDER}@${urlHost(endpoint.host)}:${endpoint.port}${path}`
  const laravelEnv = [
    `DB_CONNECTION=${LARAVEL_CONNECTION[preset.dialect]}`,
    `DB_HOST=${endpoint.host}`,
    `DB_PORT=${endpoint.port}`,
    `DB_DATABASE=${database ?? ''}`,
    `DB_USERNAME=${user ?? USER_PLACEHOLDER}`,
    `DB_PASSWORD=${PASSWORD_PLACEHOLDER}`,
  ].join('\n')
  return {
    address: `${urlHost(endpoint.host)}:${endpoint.port}`,
    databaseUrl,
    env: `DATABASE_URL=${databaseUrl}`,
    laravelEnv,
  }
}
