import { createConnection } from 'node:net'
import type { Dialect, DiscoveryDiagnosis, DiscoveryIssue, ServerPreset } from '@tsmyadmin/shared'
import type { Logger } from './logging.ts'

/** The parts of the Docker Engine API answers this module reads. Everything else in them is ignored. */
interface DockerPort {
  PrivatePort: number
  PublicPort?: number
  Type?: string
}
interface DockerContainer {
  Id: string
  /** `running`, `exited`, … — absent in a fixture means running. */
  State?: string
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
/** The environment variables read by default, and only for the database name they carry — never a password. */
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

/** A container's environment as it was started, or empty when it cannot be read. */
async function containerEnv(get: DockerGet, c: DockerContainer): Promise<Map<string, string>> {
  const env = new Map<string, string>()
  if (!CONTAINER_ID.test(c.Id)) return env
  const inspect = (await get(`/containers/${c.Id}/json`)) as DockerInspect
  for (const entry of inspect.Config?.Env ?? []) {
    const eq = entry.indexOf('=')
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1))
  }
  return env
}

function databaseHint(env: ReadonlyMap<string, string>, dialect: Dialect): string | undefined {
  for (const name of DATABASE_ENV[dialect]) {
    const value = env.get(name)
    if (value) return value
  }
  return undefined
}

/** A login the container was started with. */
export interface DockerLogin {
  user: string
  password: string
}

const YES = /^(1|yes|true|on)$/i
const first = (env: ReadonlyMap<string, string>, names: readonly string[]) => names.map((n) => env.get(n)).find(Boolean)

/**
 * The login a database image sets up from its environment, or null when the environment holds none (a password the
 * container reads from a file, or a server that lets everyone in, cannot be told from here). Read only when
 * TSMYADMIN_DOCKER_LOGIN is on, and only ever used for this container's own host and port.
 */
export function loginFromEnv(env: ReadonlyMap<string, string>, dialect: Dialect): DockerLogin | null {
  if (dialect === 'postgres') {
    const user = env.get('POSTGRES_USER') || 'postgres'
    const password = env.get('POSTGRES_PASSWORD')
    if (password) return { user, password }
    return env.get('POSTGRES_HOST_AUTH_METHOD') === 'trust' ? { user, password: '' } : null
  }
  const root = first(env, ['MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD'])
  if (root) return { user: 'root', password: root }
  if (
    YES.test(env.get('MYSQL_ALLOW_EMPTY_PASSWORD') ?? '') ||
    YES.test(env.get('MARIADB_ALLOW_EMPTY_ROOT_PASSWORD') ?? '')
  )
    return { user: 'root', password: '' }
  for (const [user, password] of [
    ['MYSQL_USER', 'MYSQL_PASSWORD'],
    ['MARIADB_USER', 'MARIADB_PASSWORD'],
  ] as const) {
    if (env.get(user) && env.get(password)) return { user: env.get(user) ?? '', password: env.get(password) ?? '' }
  }
  return null
}

/** A container found, with the login it was started with when that was asked for and the environment holds one. */
export interface DiscoveredDatabase {
  preset: ServerPreset
  login?: DockerLogin
}

/** A database container that cannot be offered, and why (`stopped`, or running without a published port). */
export type SkippedDatabase = DiscoveryIssue

/**
 * The database containers the Docker daemon knows, as login presets. A container counts when its image or its
 * usual port says MySQL / MariaDB / PostgreSQL and it is running and publishes that port (so it can be reached from
 * where this process runs); the others are returned as `skipped`, with the reason. Reads only. With `withLogin`,
 * each found one also carries the login its environment holds, kept apart from the preset (which is what the login
 * screen is told) and marked `autoLogin` there.
 */
export async function discoverAll(
  get: DockerGet,
  connectHost: string,
  withLogin = false
): Promise<{ found: DiscoveredDatabase[]; skipped: SkippedDatabase[] }> {
  // `all=1`: stopped containers too, to say that one is stopped rather than leave it out without a word.
  const containers = (await get('/containers/json?all=1')) as DockerContainer[]
  const found: DiscoveredDatabase[] = []
  const skipped: SkippedDatabase[] = []
  const taken = new Set<string>()
  for (const c of [...containers].sort((a, b) => displayName(a).localeCompare(displayName(b)))) {
    const ports = c.Ports ?? []
    const dialect = dialectOf(c.Image ?? '', ports)
    if (!dialect) continue
    if (c.State !== undefined && c.State !== 'running') {
      skipped.push({ name: `docker: ${displayName(c)}`, dialect, reason: 'stopped', port: null })
      continue
    }
    const port = databasePort(dialect, ports)
    if (port === null) {
      skipped.push({ name: `docker: ${displayName(c)}`, dialect, reason: 'notPublished', port: DEFAULT_PORT[dialect] })
      continue
    }
    let name = `docker: ${displayName(c)}`
    if (taken.has(name)) name = `${name} :${port}`
    taken.add(name)
    const env = await containerEnv(get, c).catch(() => new Map<string, string>())
    const database = databaseHint(env, dialect)
    const login = withLogin ? loginFromEnv(env, dialect) : null
    found.push({
      preset: {
        name,
        dialect,
        host: connectHost,
        port,
        ...(database ? { database } : {}),
        ...(login ? { autoLogin: true } : {}),
      },
      ...(login ? { login } : {}),
    })
  }
  return { found, skipped }
}

export async function discover(get: DockerGet, connectHost: string, withLogin = false): Promise<DiscoveredDatabase[]> {
  return (await discoverAll(get, connectHost, withLogin)).found
}

/** The presets only (what the login screen lists): no login is read. */
export async function discoverDatabases(get: DockerGet, connectHost: string): Promise<ServerPreset[]> {
  return (await discover(get, connectHost)).map((d) => d.preset)
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

/** Whether a TCP connection to host:port opens from this process (what a login would need first). */
export function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export interface DockerDiscovery {
  /** The presets for the login screen: never a login. */
  list: () => Promise<readonly ServerPreset[]>
  /** The preset and the login of a discovered container, for a sign-in that names it; null when there is none. */
  login: (name: string) => Promise<{ preset: ServerPreset; login: DockerLogin } | null>
  /** Why a database container is not on the list, or is on it but cannot be reached; what to tell someone who is stuck. */
  diagnosis: () => Promise<DiscoveryDiagnosis>
}

/**
 * The discovery the app consults: cached for a few seconds (the login list is public and the login check asks too),
 * one lookup at a time, and never failing — with no Docker it is an empty list, and the cause is logged once.
 */
export function createDockerDiscovery(opts: {
  get: DockerGet
  connectHost: string
  /** Also read each container's own login (TSMYADMIN_DOCKER_LOGIN). */
  withLogin?: boolean
  /** Whether host:port opens (a TCP connect); replaceable in tests. */
  reach?: (host: string, port: number) => Promise<boolean>
  logger: Logger
  ttlMs?: number
  now?: () => number
}): DockerDiscovery {
  const ttl = opts.ttlMs ?? 5000
  const now = opts.now ?? Date.now
  type Snapshot = { found: readonly DiscoveredDatabase[]; skipped: readonly SkippedDatabase[] }
  const nothing: Snapshot = { found: [], skipped: [] }
  const reach = opts.reach ?? tcpReachable
  let cached: { at: number; snapshot: Snapshot } | null = null
  let inflight: Promise<Snapshot> | null = null
  let lastError = ''
  const all = (): Promise<Snapshot> => {
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.snapshot)
    inflight ??= discoverAll(opts.get, opts.connectHost, opts.withLogin === true)
      .then((snapshot) => {
        if (lastError !== '') opts.logger.log('info', 'discovery.recovered', { count: snapshot.found.length })
        lastError = ''
        cached = { at: now(), snapshot }
        return snapshot
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (message !== lastError) opts.logger.log('warn', 'discovery.failed', { error: message })
        lastError = message
        cached = { at: now(), snapshot: nothing }
        return nothing
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
  return {
    async list() {
      return (await all()).found.map((d) => d.preset)
    },
    async login(name) {
      const hit = (await all()).found.find((d) => d.preset.name === name)
      return hit?.login ? { preset: hit.preset, login: hit.login } : null
    },
    async diagnosis() {
      const { found, skipped } = await all()
      // Each container's port is tried from here: a port published on the host's 127.0.0.1 only is not reachable
      // from inside a container, and the login would just time out.
      const open = await Promise.all(found.map((d) => reach(d.preset.host, d.preset.port)))
      const unreachable: DiscoveryIssue[] = found.flatMap((d, i) =>
        open[i]
          ? []
          : [{ name: d.preset.name, dialect: d.preset.dialect, reason: 'unreachable' as const, port: d.preset.port }]
      )
      return {
        enabled: true,
        connectHost: opts.connectHost,
        unavailable: lastError === '' ? null : lastError,
        found: found.length,
        issues: [...skipped, ...unreachable],
      }
    },
  }
}
