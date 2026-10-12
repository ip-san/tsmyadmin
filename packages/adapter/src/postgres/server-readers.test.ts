import { describe, expect, it } from 'vitest'
import { rows, scripted } from '../test/scripted-conn.ts'
import { pgListProcesses, pgListStatus, pgListVariables, pgServerCatalog, pgServerInfo } from './server.ts'

/** What the server pages make of the rows PostgreSQL returns (found by mutation testing; see `bun run mutation`). */

describe('pgServerInfo', () => {
  it('reads the version, account, uptime and where the server is listening', async () => {
    const { conn } = scripted([
      [
        /current_setting\('server_version'\)/,
        rows([['16.2', 'admin', 'PostgreSQL 16.2 on x86_64', 3600, '10.0.0.5/32', 5432]]),
      ],
    ])
    expect(await pgServerInfo(conn)).toEqual({
      dialect: 'postgres',
      version: '16.2',
      uptimeSec: 3600,
      currentUser: 'admin',
      extra: { version: 'PostgreSQL 16.2 on x86_64', address: '10.0.0.5/32', port: '5432' },
    })
  })

  it('has no uptime that is not a number, and empty text for what the server did not say', async () => {
    const odd = await pgServerInfo(scripted([[/server_version/, rows([['16', 'u', 'v', 'x', null, null]])]]).conn)
    expect(odd).toMatchObject({ uptimeSec: null, extra: { address: '', port: '' } })
    expect(
      await pgServerInfo(scripted([[/server_version/, rows([['16', 'u', 'v', 0, null, null]])]]).conn)
    ).toMatchObject({ uptimeSec: 0 })
    expect(await pgServerInfo(scripted([[/server_version/, rows([])]]).conn)).toMatchObject({
      version: '',
      currentUser: '',
      uptimeSec: null,
    })
  })
})

describe('pgListVariables and pgListStatus', () => {
  it('lists the settings with their value and description, the description none when there is none', async () => {
    const { conn } = scripted([
      [
        /FROM pg_settings/,
        rows([
          ['work_mem', '4096 kB', 'Sets the memory'],
          ['port', '5432', null],
        ]),
      ],
    ])
    expect(await pgListVariables(conn)).toEqual([
      { name: 'work_mem', value: '4096 kB', description: 'Sets the memory' },
      { name: 'port', value: '5432', description: null },
    ])
  })

  it('lists the counters of the database and the connections, every value as text and no description', async () => {
    const { conn } = scripted([
      [
        /'numbackends'/,
        rows([
          ['numbackends', '3'],
          ['xact_commit', 12],
          ['max_connections', '100'],
        ]),
      ],
    ])
    expect(await pgListStatus(conn)).toEqual([
      { name: 'numbackends', value: '3', description: null },
      { name: 'xact_commit', value: '12', description: null },
      { name: 'max_connections', value: '100', description: null },
    ])
  })
})

describe('pgListProcesses', () => {
  const list = async (data: unknown[][]) =>
    await pgListProcesses(scripted([[/FROM pg_stat_activity/, rows(data)]]).conn)

  it('reads each backend with its account, host, database, running time and statement', async () => {
    const [p] = await list([[4242, 'app', '10.0.0.9', 'shop', 'active', 'Lock', 7, 'SELECT 1', false]])
    expect(p).toEqual({
      id: '4242',
      user: 'app',
      host: '10.0.0.9',
      database: 'shop',
      state: 'active / Lock',
      timeSec: 7,
      query: 'SELECT 1',
      self: false,
    })
  })

  it('shows what an active backend waits for, and only that: an idle one is just idle', async () => {
    const [waiting, running, idle, idleWaiting, none] = await list([
      [1, 'u', null, 'd', 'active', 'IO', 1, 'q', false],
      [2, 'u', null, 'd', 'active', null, 1, 'q', false],
      [3, 'u', null, 'd', 'idle', null, null, null, false],
      [4, 'u', null, 'd', 'idle in transaction', 'Client', null, null, false],
      [5, 'u', null, 'd', null, null, null, null, false],
    ])
    expect(waiting?.state).toBe('active / IO')
    expect(running?.state).toBe('active')
    expect(idle?.state).toBe('idle')
    expect(idleWaiting?.state).toBe('idle in transaction')
    expect(none?.state).toBeNull()
  })

  it("has a running time only when the backend reports one, zero included, and marks only this tool's own connection", async () => {
    const [a, b, c, d, e] = await list([
      [1, 'u', null, 'd', 'active', null, 0, 'q', true],
      [2, 'u', null, 'd', 'idle', null, null, 'q', false],
      [3, 'u', null, 'd', 'idle', null, undefined, 'q', 'true'],
      [4, 'u', null, null, 'idle', null, '12', null, 1],
      [5, null, null, null, null, null, null, null, undefined],
    ])
    expect([a?.timeSec, b?.timeSec, c?.timeSec, d?.timeSec]).toEqual([0, null, null, 12])
    expect([a?.self, b?.self, c?.self, d?.self, e?.self]).toEqual([true, false, false, false, false])
    expect(d).toMatchObject({ database: null, query: null })
    expect(e).toMatchObject({ user: null, host: null, database: null, state: null, query: null })
  })
})

describe('pgServerCatalog', () => {
  const catalog = async (kind: Parameters<typeof pgServerCatalog>[1], data: unknown[][]) => {
    const s = scripted([[/pg_collation|pg_am|pg_available_extensions/, rows(data)]])
    return { result: await pgServerCatalog(s.conn, kind), asked: s.asked }
  }

  it('names the columns of each list and writes every value as text, a missing one staying empty', async () => {
    expect(
      (
        await catalog('collations', [
          ['C', 'libc', null],
          ['en', 'icu', 6],
        ])
      ).result
    ).toEqual({
      columns: ['collation', 'provider', 'encoding'],
      rows: [
        ['C', 'libc', null],
        ['en', 'icu', '6'],
      ],
    })
    expect(
      (
        await catalog('engines', [
          ['btree', 'index'],
          ['heap', 'table'],
        ])
      ).result.columns
    ).toEqual(['name', 'type'])
    expect((await catalog('plugins', [['hstore', '1.8', null, 'key/value']])).result).toEqual({
      columns: ['name', 'version', 'installedVersion', 'comment'],
      rows: [['hstore', '1.8', null, 'key/value']],
    })
  })

  it('asks the catalog that holds each kind', async () => {
    expect((await catalog('collations', [])).asked[0]?.text).toContain('FROM pg_collation')
    expect((await catalog('engines', [])).asked[0]?.text).toContain('FROM pg_am')
    expect((await catalog('plugins', [])).asked[0]?.text).toContain('FROM pg_available_extensions')
    expect((await catalog('engines', [[1, 2]])).result.rows).toEqual([['1', '2']])
  })
})
