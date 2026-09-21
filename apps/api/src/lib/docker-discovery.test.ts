import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  createDockerDiscovery,
  type DockerGet,
  discover,
  discoverAll,
  discoverDatabases,
  loginFromEnv,
  tcpReachable,
} from './docker-discovery.ts'
import { createLogger } from './logging.ts'

const id = (n: number) => n.toString(16).padStart(64, '0')

// Shaped like a real `GET /containers/json`: IPv4 and IPv6 rows for one published port, unpublished ports without
// a PublicPort, and Compose labels.
const CONTAINERS = [
  {
    Id: id(1),
    Names: ['/tsmyadmin-mysql-1'],
    Image: 'mysql:8.4',
    Labels: { 'com.docker.compose.project': 'tsmyadmin', 'com.docker.compose.service': 'mysql' },
    Ports: [{ IP: '127.0.0.1', PrivatePort: 3306, PublicPort: 13306, Type: 'tcp' }],
  },
  {
    Id: id(2),
    Names: ['/snook-pgsql-1'],
    Image: 'postgres:18-alpine',
    Labels: { 'com.docker.compose.project': 'snook', 'com.docker.compose.service': 'pgsql' },
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' },
      { IP: '::', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' },
    ],
  },
  {
    Id: id(3),
    Names: ['/snook-redis-1'],
    Image: 'redis:alpine',
    Ports: [{ PrivatePort: 6379, PublicPort: 6379, Type: 'tcp' }],
  },
  // A database nobody published a port for: not reachable from here.
  { Id: id(4), Names: ['/internal-db'], Image: 'mariadb:11', Ports: [{ PrivatePort: 3306, Type: 'tcp' }] },
  // A custom image recognised by the port it exposes, on a mapped host port.
  { Id: id(5), Names: ['/legacy'], Image: 'acme/db', Ports: [{ PrivatePort: 3306, PublicPort: 3307, Type: 'tcp' }] },
  // A database that is not running: named as stopped, not left out without a word.
  { Id: id(7), Names: ['/old-pg'], Image: 'postgres:16', State: 'exited', Ports: [] },
  // Not a server: an exporter whose name only starts like one.
  {
    Id: id(6),
    Names: ['/exporter'],
    Image: 'prom/mysqld-exporter',
    Ports: [{ PrivatePort: 9104, PublicPort: 9104, Type: 'tcp' }],
  },
]
const INSPECT: Record<string, unknown> = {
  [id(1)]: { Config: { Env: ['MYSQL_ROOT_PASSWORD=root', 'MYSQL_DATABASE=tsmyadmin_test', 'MYSQL_USER=tsmyadmin'] } },
  [id(2)]: { Config: { Env: ['POSTGRES_PASSWORD=secret', 'POSTGRES_DB=app'] } },
  [id(5)]: { Config: { Env: ['MYSQL_DATABASE='] } },
}
const fakeGet =
  (calls: string[] = []): DockerGet =>
  async (path) => {
    calls.push(path)
    if (path.startsWith('/containers/json')) return CONTAINERS
    const m = /^\/containers\/([0-9a-f]+)\/json$/.exec(path)
    if (m?.[1] && INSPECT[m[1]]) return INSPECT[m[1]]
    throw new Error(`unexpected ${path}`)
  }

describe('discoverDatabases', () => {
  it('lists published MySQL / PostgreSQL containers as presets, named after their Compose service', async () => {
    const found = await discoverDatabases(fakeGet(), '127.0.0.1')
    expect(found).toEqual([
      { name: 'docker: legacy', dialect: 'mysql', host: '127.0.0.1', port: 3307 },
      { name: 'docker: snook/pgsql', dialect: 'postgres', host: '127.0.0.1', port: 5432, database: 'app' },
      { name: 'docker: tsmyadmin/mysql', dialect: 'mysql', host: '127.0.0.1', port: 13306, database: 'tsmyadmin_test' },
    ])
  })

  it('never carries a password out of the container environment', async () => {
    const found = JSON.stringify(await discoverDatabases(fakeGet(), 'host.docker.internal'))
    expect(found).not.toMatch(/root|secret|PASSWORD/)
    expect(found).toContain('host.docker.internal')
  })

  it('only reads: the list, then the environment of each database container', async () => {
    const calls: string[] = []
    await discoverDatabases(fakeGet(calls), '127.0.0.1')
    expect(calls[0]).toBe('/containers/json?all=1')
    expect(calls.slice(1).every((c) => /^\/containers\/[0-9a-f]+\/json$/.test(c))).toBe(true)
  })

  it('keeps a container whose environment cannot be read, without a database name', async () => {
    const get: DockerGet = async (path) => {
      if (path.startsWith('/containers/json')) return CONTAINERS.slice(0, 1)
      throw new Error('gone')
    }
    expect(await discoverDatabases(get, '127.0.0.1')).toEqual([
      { name: 'docker: tsmyadmin/mysql', dialect: 'mysql', host: '127.0.0.1', port: 13306 },
    ])
  })
})

describe('createDockerDiscovery', () => {
  const logger = createLogger('json', () => undefined)

  it('answers from a cache for its lifetime, then asks again', async () => {
    let now = 0
    const calls: string[] = []
    const d = createDockerDiscovery({
      get: fakeGet(calls),
      connectHost: '127.0.0.1',
      logger,
      ttlMs: 1000,
      now: () => now,
    })
    await d.list()
    const first = calls.length
    await d.list()
    expect(calls.length).toBe(first)
    now = 1500
    await d.list()
    expect(calls.length).toBeGreaterThan(first)
  })

  it('shares one lookup between concurrent callers', async () => {
    const calls: string[] = []
    const d = createDockerDiscovery({ get: fakeGet(calls), connectHost: '127.0.0.1', logger })
    await Promise.all([d.list(), d.list(), d.list()])
    expect(calls.filter((c) => c.startsWith('/containers/json'))).toHaveLength(1)
  })

  it('is an empty list, logged once, when Docker cannot be reached', async () => {
    const lines: string[] = []
    let now = 0
    const d = createDockerDiscovery({
      get: async () => {
        throw new Error('connect ENOENT /var/run/docker.sock')
      },
      connectHost: '127.0.0.1',
      logger: createLogger('json', (l) => lines.push(l)),
      ttlMs: 10,
      now: () => now,
    })
    expect(await d.list()).toEqual([])
    now = 100
    expect(await d.list()).toEqual([])
    expect(lines.filter((l) => l.includes('discovery.failed'))).toHaveLength(1)
  })
})

const env = (...entries: string[]) =>
  new Map(entries.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))

describe('loginFromEnv', () => {
  it('reads what a MySQL / MariaDB image set up: the root password first, then the application account', () => {
    expect(loginFromEnv(env('MYSQL_ROOT_PASSWORD=root', 'MYSQL_USER=app', 'MYSQL_PASSWORD=pw'), 'mysql')).toEqual({
      user: 'root',
      password: 'root',
    })
    expect(loginFromEnv(env('MARIADB_ROOT_PASSWORD=r2'), 'mysql')).toEqual({ user: 'root', password: 'r2' })
    expect(loginFromEnv(env('MYSQL_USER=app', 'MYSQL_PASSWORD=pw'), 'mysql')).toEqual({ user: 'app', password: 'pw' })
    expect(loginFromEnv(env('MARIADB_USER=a2', 'MARIADB_PASSWORD=p2'), 'mysql')).toEqual({ user: 'a2', password: 'p2' })
    expect(loginFromEnv(env('MYSQL_ALLOW_EMPTY_PASSWORD=yes'), 'mysql')).toEqual({ user: 'root', password: '' })
    expect(loginFromEnv(env('MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1'), 'mysql')).toEqual({ user: 'root', password: '' })
  })

  it('reads what a PostgreSQL image set up, with postgres as the default account', () => {
    expect(loginFromEnv(env('POSTGRES_PASSWORD=secret'), 'postgres')).toEqual({ user: 'postgres', password: 'secret' })
    expect(loginFromEnv(env('POSTGRES_USER=me', 'POSTGRES_PASSWORD=secret'), 'postgres')).toEqual({
      user: 'me',
      password: 'secret',
    })
    expect(loginFromEnv(env('POSTGRES_HOST_AUTH_METHOD=trust'), 'postgres')).toEqual({ user: 'postgres', password: '' })
  })

  it('is null when the environment holds no login (a user without a password, a password kept in a file)', () => {
    expect(loginFromEnv(env('MYSQL_USER=app'), 'mysql')).toBeNull()
    expect(loginFromEnv(env('MYSQL_ROOT_PASSWORD_FILE=/run/secrets/x'), 'mysql')).toBeNull()
    expect(loginFromEnv(env('POSTGRES_PASSWORD_FILE=/run/secrets/x'), 'postgres')).toBeNull()
    expect(loginFromEnv(env(), 'postgres')).toBeNull()
  })
})

describe('discover with logins', () => {
  it('marks a container that has a login and keeps the login out of the preset', async () => {
    const found = await discover(fakeGet(), '127.0.0.1', true)
    const by = (name: string) => found.find((d) => d.preset.name === name)
    expect(by('docker: tsmyadmin/mysql')).toMatchObject({
      preset: { autoLogin: true },
      login: { user: 'root', password: 'root' },
    })
    expect(by('docker: snook/pgsql')).toMatchObject({ login: { user: 'postgres', password: 'secret' } })
    // No password in its environment: no login, no flag.
    expect(by('docker: legacy')?.login).toBeUndefined()
    expect(by('docker: legacy')?.preset.autoLogin).toBeUndefined()
    // What the login screen is told carries the flag and nothing of the login.
    expect(JSON.stringify(found.map((d) => d.preset))).not.toMatch(/root"|secret|PASSWORD|password/)
  })

  it('reads no login unless asked to', async () => {
    const found = await discover(fakeGet(), '127.0.0.1')
    expect(found.some((d) => d.login !== undefined || d.preset.autoLogin !== undefined)).toBe(false)
  })

  it('answers a sign-in by preset name, only when logins were asked for', async () => {
    const logger = createLogger('json', () => undefined)
    const on = createDockerDiscovery({ get: fakeGet(), connectHost: '127.0.0.1', withLogin: true, logger })
    expect(await on.login('docker: tsmyadmin/mysql')).toMatchObject({
      preset: { host: '127.0.0.1', port: 13306 },
      login: { user: 'root', password: 'root' },
    })
    expect(await on.login('docker: nothing')).toBeNull()
    expect(await on.login('docker: legacy')).toBeNull()
    const off = createDockerDiscovery({ get: fakeGet(), connectHost: '127.0.0.1', logger })
    expect(await off.login('docker: tsmyadmin/mysql')).toBeNull()
    expect(JSON.stringify(await on.list())).not.toMatch(/secret|"root"/)
  })
})

describe('discovery diagnosis', () => {
  const logger = createLogger('json', () => undefined)

  it('names the database containers it left out, and why', async () => {
    const { skipped } = await discoverAll(fakeGet(), '127.0.0.1')
    expect(skipped).toEqual([
      // Running, but no published port: the usual one is what to publish.
      { name: 'docker: internal-db', dialect: 'mysql', reason: 'notPublished', port: 3306 },
      { name: 'docker: old-pg', dialect: 'postgres', reason: 'stopped', port: null },
    ])
  })

  it('tries every listed container from here and reports the ones that do not open', async () => {
    const reached: string[] = []
    const d = createDockerDiscovery({
      get: fakeGet(),
      connectHost: 'host.docker.internal',
      logger,
      reach: async (host, port) => {
        reached.push(`${host}:${port}`)
        return port !== 5432
      },
    })
    const diagnosis = await d.diagnosis()
    expect(reached.sort()).toEqual([
      'host.docker.internal:13306',
      'host.docker.internal:3307',
      'host.docker.internal:5432',
    ])
    expect(diagnosis).toMatchObject({ enabled: true, connectHost: 'host.docker.internal', unavailable: null, found: 3 })
    expect(diagnosis.issues).toContainEqual({
      name: 'docker: snook/pgsql',
      dialect: 'postgres',
      reason: 'unreachable',
      port: 5432,
    })
    expect(diagnosis.issues.map((i) => i.reason).sort()).toEqual(['notPublished', 'stopped', 'unreachable'])
  })

  it('says why Docker itself could not be read', async () => {
    const d = createDockerDiscovery({
      get: async () => {
        throw new Error('Cannot open the Docker socket /var/run/docker.sock: it is missing')
      },
      connectHost: '127.0.0.1',
      logger,
      reach: async () => true,
    })
    expect(await d.diagnosis()).toMatchObject({
      unavailable: 'Cannot open the Docker socket /var/run/docker.sock: it is missing',
      found: 0,
      issues: [],
    })
  })
})

describe('tcpReachable', () => {
  it('is true for a port that is listening and false for one that is not', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      expect(await tcpReachable('127.0.0.1', port)).toBe(true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    expect(await tcpReachable('127.0.0.1', port, 500)).toBe(false)
  })
})
