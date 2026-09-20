import type { Dialect, ServerPreset } from '@tsmyadmin/shared'
import type { Logger } from './logging.ts'

/** The parts of the Docker Engine API answers this module reads. Everything else in them is ignored. */
interface DockerPort {
  PrivatePort: number
  PublicPort?: number
  Type?: string
}
interface DockerContainer {
  Id: string
  Names?: string[]
  Image?: string
  Labels?: Record<string, string>
  Ports?: DockerPort[]
}
interface DockerInspect {
  Config?: { Env?: string[] }
}

const DEFAULT_PORT: Record<Dialect, number> = { mysql: 3306, postgres: 5432 }
/** Image names that say what a container is. */
const IMAGE_DIALECT: Record<string, Dialect> = {
  mysql: 'mysql',
  mariadb: 'mysql',
  percona: 'mysql',
  postgresql: 'postgres',
  postgres: 'postgres',
  postgis: 'postgres',
  timescaledb: 'postgres',
  pgvector: 'postgres',
}
const IMAGE_NAME = /(?:^|[/:_-])(mysql|mariadb|percona|postgresql|postgres|postgis|timescaledb|pgvector)(?![a-z0-9])/
/** The only environment variables read, and only for the database name they carry — never a password. */
const DATABASE_ENV: Record<Dialect, readonly string[]> = {
  mysql: ['MYSQL_DATABASE', 'MARIADB_DATABASE'],
  postgres: ['POSTGRES_DB'],
}
const CONTAINER_ID = /^[0-9a-f]{12,64}$/

export type DockerGet = (path: string) => Promise<unknown>

function dialectOf(image: string, ports: readonly DockerPort[]): Dialect | null {
  const named = IMAGE_NAME.exec(image.toLowerCase())?.[1]
  if (named) return IMAGE_DIALECT[named] ?? null
  if (ports.some((p) => p.PrivatePort === DEFAULT_PORT.mysql)) return 'mysql'
  if (ports.some((p) => p.PrivatePort === DEFAULT_PORT.postgres)) return 'postgres'
  return null
}

/** The published TCP port that carries the database: the dialect's usual one when published, else the first. */
function databasePort(dialect: Dialect, ports: readonly DockerPort[]): number | null {
  const published = ports.filter((p) => p.PublicPort !== undefined && (p.Type ?? 'tcp') === 'tcp')
  const usual = published.find((p) => p.PrivatePort === DEFAULT_PORT[dialect])
  return (usual ?? published[0])?.PublicPort ?? null
}

/** `project/service` for a Compose container (what people call it), else the container's own name. */
function displayName(c: DockerContainer): string {
  const project = c.Labels?.['com.docker.compose.project']
  const service = c.Labels?.['com.docker.compose.service']
  if (project && service) return `${project}/${service}`
  return (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '')
}

async function databaseHint(get: DockerGet, c: DockerContainer, dialect: Dialect): Promise<string | undefined> {
  if (!CONTAINER_ID.test(c.Id)) return undefined
  const inspect = (await get(`/containers/${c.Id}/json`)) as DockerInspect
  for (const entry of inspect.Config?.Env ?? []) {
    const eq = entry.indexOf('=')
    if (eq > 0 && DATABASE_ENV[dialect].includes(entry.slice(0, eq)) && eq < entry.length - 1)
      return entry.slice(eq + 1)
  }
  return undefined
}

/**
 * The database containers the Docker daemon is running, as login presets. A container counts when its image or its
 * usual port says MySQL / MariaDB / PostgreSQL and it publishes that port (so it can be reached from where this
 * process runs). Reads only; the answer names no password.
 */
export async function discoverDatabases(get: DockerGet, connectHost: string): Promise<ServerPreset[]> {
  const containers = (await get('/containers/json')) as DockerContainer[]
  const found: ServerPreset[] = []
  const taken = new Set<string>()
  for (const c of [...containers].sort((a, b) => displayName(a).localeCompare(displayName(b)))) {
    const ports = c.Ports ?? []
    const dialect = dialectOf(c.Image ?? '', ports)
    const port = dialect ? databasePort(dialect, ports) : null
    if (!dialect || port === null) continue
    let name = `docker: ${displayName(c)}`
    if (taken.has(name)) name = `${name} :${port}`
    taken.add(name)
    const database = await databaseHint(get, c, dialect).catch(() => undefined)
    found.push({ name, dialect, host: connectHost, port, ...(database ? { database } : {}) })
  }
  return found
}

/** GET-only access to the Docker Engine API over its unix socket. */
export function dockerSocketGet(socketPath: string): DockerGet {
  return async (path) => {
    let res: Response
    try {
      res = await fetch(`http://docker${path}`, { unix: socketPath } as RequestInit)
    } catch {
      // Bun's own message ("Was there a typo in the url or port?") says nothing about a socket.
      throw new Error(`Cannot open the Docker socket ${socketPath}: it is missing, or this user may not read it`)
    }
    if (!res.ok) throw new Error(`Docker API answered ${res.status} for ${path.split('/').slice(0, 3).join('/')}`)
    return res.json()
  }
}

export interface DockerDiscovery {
  list: () => Promise<readonly ServerPreset[]>
}

/**
 * The discovery the app consults: cached for a few seconds (the login list is public and the login check asks too),
 * one lookup at a time, and never failing — with no Docker it is an empty list, and the cause is logged once.
 */
export function createDockerDiscovery(opts: {
  get: DockerGet
  connectHost: string
  logger: Logger
  ttlMs?: number
  now?: () => number
}): DockerDiscovery {
  const ttl = opts.ttlMs ?? 5000
  const now = opts.now ?? Date.now
  let cached: { at: number; list: readonly ServerPreset[] } | null = null
  let inflight: Promise<readonly ServerPreset[]> | null = null
  let lastError = ''
  return {
    list() {
      if (cached && now() - cached.at < ttl) return Promise.resolve(cached.list)
      inflight ??= discoverDatabases(opts.get, opts.connectHost)
        .then((list) => {
          if (lastError !== '') opts.logger.log('info', 'discovery.recovered', { count: list.length })
          lastError = ''
          cached = { at: now(), list }
          return list
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (message !== lastError) opts.logger.log('warn', 'discovery.failed', { error: message })
          lastError = message
          cached = { at: now(), list: [] }
          return [] as readonly ServerPreset[]
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
  }
}
