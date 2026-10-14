import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capture } from '../test/app-harness.ts'
import {
  createDockerDiscovery,
  type DockerGet,
  discover,
  discoverAll,
  dockerSocketGet,
  tcpReachable,
} from './docker-discovery.ts'

/**
 * Which container is a database, which port reaches it, what it is called, and how the cached lookup logs. A wrong
 * port or name sends someone to the wrong server from the login screen, so each rule is pinned
 * (found as surviving mutants; see `bun run mutation`).
 */

const id = (n: number) => n.toString(16).padStart(64, '0')

type Container = Record<string, unknown>
const getFor =
  (containers: Container[], inspect: Record<string, unknown> = {}, calls: string[] = []): DockerGet =>
  async (path) => {
    calls.push(path)
    if (path.startsWith('/containers/json')) return containers
    const m = /^\/containers\/(.+)\/json$/.exec(path)
    if (m?.[1] && inspect[m[1]]) return inspect[m[1]]
    throw new Error(`unexpected ${path}`)
  }
const presets = async (containers: Container[], inspect: Record<string, unknown> = {}) =>
  (await discover(getFor(containers, inspect), 'h')).map((d) => d.preset)

describe('which container is a database', () => {
  it('recognises an unnamed image by the usual port it exposes, MySQL first, PostgreSQL second', async () => {
    const ps = await presets([
      {
        Id: id(1),
        Names: ['/a'],
        Image: 'acme/x',
        Ports: [
          { PrivatePort: 9999, PublicPort: 1 },
          { PrivatePort: 3306, PublicPort: 2 },
        ],
      },
      {
        Id: id(2),
        Names: ['/b'],
        Image: 'acme/y',
        Ports: [
          { PrivatePort: 8080, PublicPort: 3 },
          { PrivatePort: 5432, PublicPort: 4 },
        ],
      },
      {
        Id: id(3),
        Names: ['/c'],
        Image: 'acme/z',
        Ports: [
          { PrivatePort: 3306, PublicPort: 5 },
          { PrivatePort: 5432, PublicPort: 6 },
        ],
      },
      { Id: id(4), Names: ['/d'], Image: 'acme/w', Ports: [{ PrivatePort: 8080, PublicPort: 7 }] },
      { Id: id(5), Names: ['/e'], Image: 'acme/v' },
    ])
    expect(ps.map((p) => [p.name, p.dialect, p.port])).toEqual([
      ['docker: a', 'mysql', 2],
      ['docker: b', 'postgres', 4],
      ['docker: c', 'mysql', 5],
    ])
  })

  it('takes a missing image name as "unknown" and does not guess from it', async () => {
    expect(await presets([{ Id: id(1), Names: ['/a'], Ports: [{ PrivatePort: 8080, PublicPort: 1 }] }])).toEqual([])
  })

  it('counts only containers that are running: a paused or restarting one is stopped, and no State means running', async () => {
    const containers = [
      { Id: id(1), Names: ['/ok'], Image: 'mysql', State: 'running', Ports: [{ PrivatePort: 3306, PublicPort: 1 }] },
      { Id: id(2), Names: ['/none'], Image: 'mysql', Ports: [{ PrivatePort: 3306, PublicPort: 2 }] },
      { Id: id(3), Names: ['/paused'], Image: 'mysql', State: 'paused', Ports: [{ PrivatePort: 3306, PublicPort: 3 }] },
      { Id: id(4), Names: ['/restarting'], Image: 'postgres', State: 'restarting', Ports: [] },
    ]
    const { found, skipped } = await discoverAll(getFor(containers), 'h')
    expect(found.map((d) => d.preset.name)).toEqual(['docker: none', 'docker: ok'])
    expect(skipped).toEqual([
      { name: 'docker: paused', dialect: 'mysql', reason: 'stopped', port: null },
      { name: 'docker: restarting', dialect: 'postgres', reason: 'stopped', port: null },
    ])
  })
})

describe('which port reaches the database', () => {
  it('prefers the dialect usual port when it is published, wherever it is in the list', async () => {
    const [p] = await presets([
      {
        Id: id(1),
        Names: ['/a'],
        Image: 'mysql',
        Ports: [
          { PrivatePort: 33060, PublicPort: 13307, Type: 'tcp' },
          { PrivatePort: 3306, PublicPort: 13306, Type: 'tcp' },
        ],
      },
    ])
    expect(p?.port).toBe(13306)
  })

  it('falls back to the first published port when the usual one is not', async () => {
    const [p] = await presets([
      {
        Id: id(1),
        Names: ['/a'],
        Image: 'postgres',
        Ports: [
          { PrivatePort: 5432 },
          { PrivatePort: 6000, PublicPort: 16000 },
          { PrivatePort: 6001, PublicPort: 16001 },
        ],
      },
    ])
    expect(p?.port).toBe(16000)
  })

  it('reaches only over TCP, and a port with no Type counts as TCP', async () => {
    const [p] = await presets([
      {
        Id: id(1),
        Names: ['/a'],
        Image: 'mysql',
        Ports: [
          { PrivatePort: 3306, PublicPort: 1, Type: 'udp' },
          { PrivatePort: 3306, PublicPort: 2 },
        ],
      },
    ])
    expect(p?.port).toBe(2)
    const { found, skipped } = await discoverAll(
      getFor([
        { Id: id(2), Names: ['/u'], Image: 'mysql', Ports: [{ PrivatePort: 3306, PublicPort: 1, Type: 'udp' }] },
      ]),
      'h'
    )
    expect(found).toEqual([])
    expect(skipped).toEqual([{ name: 'docker: u', dialect: 'mysql', reason: 'notPublished', port: 3306 }])
  })

  it('skips a container whose ports are listed but none is published', async () => {
    const { skipped } = await discoverAll(
      getFor([{ Id: id(1), Names: ['/a'], Image: 'mysql', Ports: [{ PrivatePort: 3306 }, { PrivatePort: 33060 }] }]),
      'h'
    )
    expect(skipped).toHaveLength(1)
  })
})

describe('what the container is called', () => {
  it('uses project/service only when both labels are there', async () => {
    const ps = await presets([
      {
        Id: id(1),
        Names: ['/n1'],
        Image: 'mysql',
        Labels: { 'com.docker.compose.project': 'p' },
        Ports: [{ PrivatePort: 3306, PublicPort: 1 }],
      },
      {
        Id: id(2),
        Names: ['/n2'],
        Image: 'mysql',
        Labels: { 'com.docker.compose.service': 's' },
        Ports: [{ PrivatePort: 3306, PublicPort: 2 }],
      },
    ])
    expect(ps.map((p) => p.name)).toEqual(['docker: n1', 'docker: n2'])
  })

  it('drops the leading slash of a container name only, and falls back to the first 12 characters of the ID', async () => {
    const ps = await presets([
      { Id: `abcdef012345${'0'.repeat(52)}`, Image: 'mysql', Ports: [{ PrivatePort: 3306, PublicPort: 1 }] },
      { Id: id(2), Names: ['x/y'], Image: 'mysql', Ports: [{ PrivatePort: 3306, PublicPort: 2 }] },
      { Id: id(3), Names: ['/z'], Image: 'mysql', Ports: [{ PrivatePort: 3306, PublicPort: 3 }] },
    ])
    expect(ps.map((p) => p.name)).toEqual(['docker: abcdef012345', 'docker: x/y', 'docker: z'])
  })

  it('tells replicas of one service apart by their port, and lists them in name order', async () => {
    const labels = { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 's' }
    const ps = await presets([
      { Id: id(1), Image: 'mysql', Labels: labels, Ports: [{ PrivatePort: 3306, PublicPort: 13306 }] },
      { Id: id(2), Image: 'mysql', Labels: labels, Ports: [{ PrivatePort: 3306, PublicPort: 13307 }] },
      { Id: id(3), Image: 'mysql', Labels: labels, Ports: [{ PrivatePort: 3306, PublicPort: 13308 }] },
    ])
    expect(ps.map((p) => p.name)).toEqual(['docker: p/s', 'docker: p/s :13307', 'docker: p/s :13308'])
  })
})

describe('what is read from the container environment', () => {
  const one = (image: string, port: number, env: string[]): [Container[], Record<string, unknown>] => [
    [{ Id: id(1), Names: ['/a'], Image: image, Ports: [{ PrivatePort: port, PublicPort: 1 }] }],
    { [id(1)]: { Config: { Env: env } } },
  ]

  it('takes the database name from the first variable that has a value (MariaDB images name it differently)', async () => {
    const [c, i] = one('mariadb', 3306, ['MARIADB_DATABASE=app'])
    expect((await presets(c, i))[0]?.database).toBe('app')
    const [c2, i2] = one('mysql', 3306, ['MYSQL_DATABASE=', 'MARIADB_DATABASE=other'])
    expect((await presets(c2, i2))[0]?.database).toBe('other')
    const [c3, i3] = one('mysql', 3306, ['MYSQL_DATABASE=one', 'MARIADB_DATABASE=two'])
    expect((await presets(c3, i3))[0]?.database).toBe('one')
  })

  it('splits a variable at the first "=" and ignores an entry without one', async () => {
    const [c, i] = one('postgres', 5432, ['POSTGRES_DBx', 'POSTGRES_DB=a=b'])
    expect((await presets(c, i))[0]?.database).toBe('a=b')
    const [c2, i2] = one('postgres', 5432, ['POSTGRES_DBx'])
    expect((await presets(c2, i2))[0]).not.toHaveProperty('database')
  })

  it('does not ask Docker about a container whose ID is not a hex ID, and still lists it', async () => {
    const calls: string[] = []
    const ps = (
      await discover(
        getFor(
          [{ Id: 'not-an-id', Names: ['/a'], Image: 'mysql', Ports: [{ PrivatePort: 3306, PublicPort: 1 }] }],
          {},
          calls
        ),
        'h'
      )
    ).map((d) => d.preset)
    expect(ps).toHaveLength(1)
    expect(calls).toEqual(['/containers/json?all=1'])
  })

  it('reads no login unless asked: not even when the environment holds one', async () => {
    const [c, i] = one('mysql', 3306, ['MYSQL_ROOT_PASSWORD=root'])
    const found = (await discoverAll(getFor(c, i), 'h')).found
    expect(found[0]).toEqual({ preset: expect.not.objectContaining({ autoLogin: true }) })
    expect(found[0]).not.toHaveProperty('login')
    const withLogin = (await discoverAll(getFor(c, i), 'h', true)).found
    expect(withLogin[0]?.login).toEqual({ user: 'root', password: 'root' })
  })
})

describe('the cached lookup', () => {
  const containers = [{ Id: id(1), Names: ['/a'], Image: 'mysql', Ports: [{ PrivatePort: 3306, PublicPort: 1 }] }]
  const logs = capture

  it('keeps an answer for less than its lifetime, not for all of it', async () => {
    let now = 10_000
    const calls: string[] = []
    const d = createDockerDiscovery({
      get: getFor(containers, {}, calls),
      connectHost: 'h',
      logger: logs().logger,
      ttlMs: 1000,
      now: () => now,
    })
    await d.list()
    const first = calls.length
    now = 10_999
    await d.list()
    expect(calls.length).toBe(first)
    now = 11_000
    await d.list()
    expect(calls.length).toBeGreaterThan(first)
  })

  it('lists the presets, without logins', async () => {
    const d = createDockerDiscovery({ get: getFor(containers), connectHost: 'h', logger: logs().logger })
    expect(await d.list()).toEqual([
      { name: 'docker: a', dialect: 'mysql', host: 'h', port: 1, docker: { privatePort: 3306 } },
    ])
  })

  it('asks for logins only when told to', async () => {
    const withEnv = getFor(containers, { [id(1)]: { Config: { Env: ['MYSQL_ROOT_PASSWORD=r'] } } })
    const off = createDockerDiscovery({ get: withEnv, connectHost: 'h', logger: logs().logger })
    expect(await off.login('docker: a')).toBeNull()
    const on = createDockerDiscovery({ get: withEnv, connectHost: 'h', logger: logs().logger, withLogin: true })
    expect((await on.login('docker: a'))?.login).toEqual({ user: 'root', password: 'r' })
  })

  it('logs a failure once as a warning, and the recovery once as information with the count', async () => {
    let now = 0
    let broken: string | null = 'socket gone'
    const { lines, logger } = logs()
    const d = createDockerDiscovery({
      get: async (path) => {
        if (broken) throw new Error(broken)
        return getFor(containers)(path)
      },
      connectHost: 'h',
      logger,
      ttlMs: 10,
      now: () => now,
    })
    await d.list()
    now += 100
    await d.list()
    expect(lines).toEqual([
      { time: expect.any(String), level: 'warn', event: 'discovery.failed', error: 'socket gone' },
    ])
    broken = 'another cause'
    now += 100
    await d.list()
    expect(lines.at(-1)).toMatchObject({ level: 'warn', event: 'discovery.failed', error: 'another cause' })
    broken = null
    now += 100
    expect(await d.list()).toHaveLength(1)
    expect(lines.at(-1)).toMatchObject({ level: 'info', event: 'discovery.recovered', count: 1 })
    const n = lines.length
    now += 100
    await d.list()
    expect(lines).toHaveLength(n)
  })

  it('does not log a recovery on the first success', async () => {
    const { lines, logger } = logs()
    await createDockerDiscovery({ get: getFor(containers), connectHost: 'h', logger }).list()
    expect(lines).toEqual([])
  })

  it('keeps the empty answer of a failed lookup for its lifetime too (it does not hammer a missing socket)', async () => {
    let tries = 0
    const d = createDockerDiscovery({
      get: async () => {
        tries++
        throw new Error('no socket')
      },
      connectHost: 'h',
      logger: logs().logger,
      ttlMs: 1000,
      now: () => 5000,
    })
    await d.list()
    await d.list()
    expect(tries).toBe(1)
  })

  it('reports no cause while the lookup works', async () => {
    const d = createDockerDiscovery({
      get: getFor(containers),
      connectHost: 'h',
      logger: logs().logger,
      reach: async () => true,
    })
    expect(await d.diagnosis()).toEqual({ enabled: true, connectHost: 'h', unavailable: null, found: 1, issues: [] })
  })
})

describe('dockerSocketGet', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the socket with GET and returns the JSON answer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ Id: 'x' }])))
    vi.stubGlobal('fetch', fetchMock)
    expect(await dockerSocketGet('/tmp/d.sock')('/containers/json?all=1')).toEqual([{ Id: 'x' }])
    expect(fetchMock).toHaveBeenCalledWith('http://docker/containers/json?all=1', { unix: '/tmp/d.sock' })
  })

  it('names the status and the first two path segments (no query, nothing after the ID) when Docker refuses', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }))
    await expect(dockerSocketGet('/tmp/d.sock')(`/containers/${id(1)}/json`)).rejects.toThrow(
      new Error(`Docker API answered 500 for /containers/${id(1)}`)
    )
  })

  it('says the socket could not be opened, naming it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('Was there a typo in the url or port?')
    })
    await expect(dockerSocketGet('/tmp/d.sock')('/containers/json')).rejects.toThrow(
      'Cannot open the Docker socket /tmp/d.sock: it is missing, or this user may not read it'
    )
  })
})

describe('tcpReachable', () => {
  /** A listener on a free local port, and the promise of its first connection having been closed again. */
  const listen = async () => {
    const server = createServer((socket) => socket.on('error', () => undefined))
    const closed = new Promise<void>((resolve) => server.once('connection', (s) => s.once('close', resolve)))
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    )
    return { port, closed, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

  it('answers true for a port that accepts, and closes the connection it opened to look', async () => {
    const { port, closed, stop } = await listen()
    try {
      expect(await tcpReachable('127.0.0.1', port)).toBe(true)
      await closed
    } finally {
      await stop()
    }
  })

  it('answers false for a port nothing listens on', async () => {
    // A port that was free a moment ago: the connection is refused.
    const { port, stop } = await listen()
    await stop()
    expect(await tcpReachable('127.0.0.1', port)).toBe(false)
  })
})
