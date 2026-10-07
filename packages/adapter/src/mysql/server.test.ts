import { describe, expect, it } from 'vitest'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import {
  mysqlDiagnostics,
  mysqlKillProcess,
  mysqlListProcesses,
  mysqlListStatus,
  mysqlListVariables,
  mysqlReplicationInfo,
  mysqlServerCatalog,
  mysqlServerInfo,
} from './server.ts'

/**
 * The branches of the server module that depend on what the server answers: a status the server does not report, an
 * account that may not read performance_schema or the binary log, a log that is off or written to a file, a server
 * older than 8.0.22 that spells SHOW REPLICA STATUS as SHOW SLAVE STATUS. A real server answers one way each; the
 * others are scripted here, as the server would give them.
 */
const denied = () => fail('PERMISSION_DENIED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')

describe('mysqlServerInfo', () => {
  it('reads the version, the account, the server and its uptime', async () => {
    const { conn } = scripted([
      [/SELECT VERSION\(\)/, rows([['8.4.0', 'root@%', 'MySQL Community', 'db1', 3306]])],
      [/SHOW GLOBAL STATUS LIKE 'Uptime'/, rows([['Uptime', '3600']])],
    ])
    expect(await mysqlServerInfo(conn)).toEqual({
      dialect: 'mysql',
      version: '8.4.0',
      uptimeSec: 3600,
      currentUser: 'root@%',
      extra: { version_comment: 'MySQL Community', hostname: 'db1', port: '3306' },
    })
  })

  it('has no uptime when the server does not report one or reports something that is not a number', async () => {
    for (const status of [rows([]), rows([['Uptime', 'n/a']])]) {
      const { conn } = scripted([
        [/SELECT VERSION\(\)/, rows([['8.4.0', 'u', 'c', 'h', 1]])],
        [/SHOW GLOBAL STATUS/, status],
      ])
      expect((await mysqlServerInfo(conn)).uptimeSec).toBeNull()
    }
  })
})

describe('variables and status', () => {
  it('are name and value as text, with no description', async () => {
    const { conn } = scripted([
      [
        /SHOW GLOBAL VARIABLES/,
        rows([
          ['max_connections', 151],
          ['sql_mode', null],
        ]),
      ],
      [/SHOW GLOBAL STATUS$/, rows([['Threads_connected', 4]])],
    ])
    expect(await mysqlListVariables(conn)).toEqual([
      { name: 'max_connections', value: '151', description: null },
      { name: 'sql_mode', value: '', description: null },
    ])
    expect(await mysqlListStatus(conn)).toEqual([{ name: 'Threads_connected', value: '4', description: null }])
  })
})

describe('mysqlListProcesses', () => {
  const row = (over: Partial<Record<number, unknown>> = {}) => {
    const r: unknown[] = [7, 'app', '10.0.0.5:5555', 'shop', 'Query', 3, 'executing', 'SELECT 1', 0]
    for (const [i, v] of Object.entries(over)) r[Number(i)] = v
    return r
  }

  it('lists each connection with its command and state together, and marks the tool’s own', async () => {
    const { conn } = scripted([
      [/performance_schema/, rows([row({ 8: 1 }), row({ 0: 8, 8: true }), row({ 0: 9, 8: 0 })])],
    ])
    const out = await mysqlListProcesses(conn)
    expect(out.map((p) => p.self)).toEqual([true, true, false])
    expect(out[0]).toMatchObject({
      id: '7',
      user: 'app',
      host: '10.0.0.5:5555',
      database: 'shop',
      query: 'SELECT 1',
      timeSec: 3,
    })
    expect(out[0]?.state).toContain('Query')
  })

  it('has no time for a connection that reports none, and no database or query when null', async () => {
    const { conn } = scripted([[/performance_schema/, rows([row({ 5: null, 3: null, 7: null })])]])
    expect((await mysqlListProcesses(conn))[0]).toMatchObject({ timeSec: null, database: null, query: null })
    const undef = scripted([[/performance_schema/, rows([row({ 5: undefined })])]])
    expect((await mysqlListProcesses(undef.conn))[0]?.timeSec).toBeNull()
  })

  it('falls back to the list without the own-connection mark when performance_schema may not be read', async () => {
    const { conn, asked } = scripted([
      [/performance_schema/, denied()],
      [/information_schema\.PROCESSLIST p ORDER BY p\.ID/, rows([row({ 8: null })])],
    ])
    const out = await mysqlListProcesses(conn)
    expect(out).toHaveLength(1)
    expect(out[0]?.self).toBe(false)
    expect(asked).toHaveLength(2)
  })

  it('does not hide another error', async () => {
    const { conn } = scripted([[/performance_schema/, fail('QUERY_FAILED', 'ER_PARSE_ERROR')]])
    await expect(mysqlListProcesses(conn)).rejects.toMatchObject({ nativeCode: 'ER_PARSE_ERROR' })
  })
})

describe('mysqlKillProcess', () => {
  it('refuses an id that is not a number, before asking the server anything', async () => {
    const { conn, asked } = scripted([])
    await expect(mysqlKillProcess(conn, '7; DROP DATABASE x')).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    expect(asked).toEqual([])
  })

  it('ends the connection by default, and only the statement when asked for the query', async () => {
    const connection = scripted([[/^KILL/, rows([])]])
    await mysqlKillProcess(connection.conn, '7')
    const query = scripted([[/^KILL/, rows([])]])
    await mysqlKillProcess(query.conn, '7', 'query')
    expect(connection.asked[0]?.text).toBe('KILL 7')
    expect(query.asked[0]?.text).toBe('KILL QUERY 7')
  })

  it('treats killing its own connection as success, and gives that connection up', async () => {
    const { conn, discard } = scripted([[/^KILL/, fail('CONNECTION_FAILED', 'PROTOCOL_CONNECTION_LOST')]])
    await expect(mysqlKillProcess(conn, '7')).resolves.toBeUndefined()
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('does not hide another error, and does not give the connection up for it', async () => {
    const { conn, discard } = scripted([[/^KILL/, fail('QUERY_FAILED', 'ER_NO_SUCH_THREAD')]])
    await expect(mysqlKillProcess(conn, '7')).rejects.toMatchObject({ nativeCode: 'ER_NO_SUCH_THREAD' })
    expect(discard).not.toHaveBeenCalled()
  })
})

describe('mysqlServerCatalog', () => {
  it('shows every value as text, a missing one as null', async () => {
    const { conn } = scripted([[/information_schema\.ENGINES/, rows([['InnoDB', 'DEFAULT', 'YES', null]])]])
    expect(await mysqlServerCatalog(conn, 'engines')).toEqual({
      columns: ['name', 'support', 'transactions', 'comment'],
      rows: [['InnoDB', 'DEFAULT', 'YES', null]],
    })
  })
})

describe('mysqlReplicationInfo', () => {
  const answers = (over: Record<string, ReturnType<typeof rows> | Error> = {}) =>
    [
      [/SHOW REPLICA STATUS/, over.status ?? rows([])],
      [/SHOW SLAVE STATUS/, over.legacyStatus ?? rows([])],
      [/SHOW REPLICAS/, over.replicas ?? rows([])],
      [/SHOW SLAVE HOSTS/, over.legacyReplicas ?? rows([])],
      [
        /SHOW BINARY LOGS/,
        over.logs ??
          rows(
            [
              ['bin.000001', 1024],
              ['bin.000002', null],
            ],
            ['Log_name', 'File_size']
          ),
      ],
    ] as Parameters<typeof scripted>[0]

  it('lists the binary logs with their sizes, the size null where the server gives none', async () => {
    const info = await mysqlReplicationInfo(scripted(answers()).conn)
    expect(info.logs).toEqual([
      { name: 'bin.000001', size: '1024' },
      { name: 'bin.000002', size: null },
    ])
  })

  it('asks again in the older spelling when the server does not know the new one (before 8.0.22, MariaDB)', async () => {
    const { conn, asked } = scripted(
      answers({
        status: fail('QUERY_FAILED', 'ER_PARSE_ERROR'),
        replicas: fail('QUERY_FAILED', 'ER_PARSE_ERROR'),
        legacyStatus: rows([['Yes']], ['Slave_IO_Running']),
      })
    )
    const info = await mysqlReplicationInfo(conn)
    expect(info.source).toEqual([[{ name: 'Slave_IO_Running', value: 'Yes' }]])
    expect(asked.some((a) => /SHOW SLAVE STATUS/.test(a.text))).toBe(true)
    expect(asked.some((a) => /SHOW SLAVE HOSTS/.test(a.text))).toBe(true)
  })

  it('shows a part the account may not read, or that does not exist (binary logging off), as unavailable', async () => {
    const info = await mysqlReplicationInfo(
      scripted(
        answers({
          status: denied(),
          replicas: fail('PERMISSION_DENIED'),
          logs: fail('QUERY_FAILED', 'ER_NO_BINARY_LOGGING'),
        })
      ).conn
    )
    expect(info).toMatchObject({ source: null, replicas: null, logs: null })
  })

  it('does not hide an error that is not a refusal', async () => {
    await expect(
      mysqlReplicationInfo(scripted(answers({ status: fail('QUERY_FAILED', 'ER_LOCK_DEADLOCK') })).conn)
    ).rejects.toMatchObject({ nativeCode: 'ER_LOCK_DEADLOCK' })
    const { conn } = scripted([[/SHOW REPLICA STATUS/, new Error('socket closed') as never]])
    await expect(mysqlReplicationInfo(conn)).rejects.toThrow('socket closed')
  })
})

describe('mysqlDiagnostics', () => {
  const flags = (on: unknown, output: unknown) => rows([[on, output]])

  describe('the logs written to a table', () => {
    it.each(['recentStatements', 'slowLog', 'generalLog'] as const)(
      'says %s is off when the log is off',
      async (kind) => {
        const { conn } = scripted([[/@@GLOBAL/, flags(0, 'TABLE')]])
        expect(await mysqlDiagnostics(conn, kind)).toMatchObject({ status: 'disabled', rows: [] })
      }
    )

    it.each(['recentStatements', 'slowLog', 'generalLog'] as const)(
      'says %s is written to a file when it is not to a table',
      async (kind) => {
        const { conn } = scripted([[/@@GLOBAL/, flags('ON', 'FILE')]])
        expect(await mysqlDiagnostics(conn, kind)).toMatchObject({ status: 'notTable' })
      }
    )

    it('treats the flag spelled OFF or false as off, and a missing one as off', async () => {
      for (const off of ['OFF', 'false', null]) {
        const { conn } = scripted([[/@@GLOBAL/, flags(off, 'TABLE')]])
        expect((await mysqlDiagnostics(conn, 'slowLog')).status).toBe('disabled')
      }
    })

    it('groups the statements of the general log and of the slow log, every value as text', async () => {
      const general = scripted([
        [/@@GLOBAL/, flags(1, 'FILE,TABLE')],
        [
          /mysql\.general_log/,
          rows([
            ['SELECT 1', 5],
            [null, 1],
          ]),
        ],
      ])
      expect(await mysqlDiagnostics(general.conn, 'generalLog')).toMatchObject({
        status: 'ok',
        columns: ['statement', 'runs'],
        rows: [
          ['SELECT 1', '5'],
          [null, '1'],
        ],
      })
      const slow = scripted([
        [/@@GLOBAL/, flags(1, 'TABLE')],
        [/mysql\.slow_log/, rows([['SELECT SLEEP(1)', 2, 2.5, 1.5, 100]])],
      ])
      expect(await mysqlDiagnostics(slow.conn, 'slowLog')).toMatchObject({
        columns: ['statement', 'runs', 'totalSeconds', 'maxSeconds', 'rowsExamined'],
        rows: [['SELECT SLEEP(1)', '2', '2.5', '1.5', '100']],
      })
    })

    it('leaves out the statements of this tool’s own connections and those before `since`, binding both', async () => {
      const { conn, asked } = scripted([
        [/@@GLOBAL/, flags(1, 'TABLE')],
        [/mysql\.general_log/, rows([['2024-01-02 00:00:00', 'SELECT 2']])],
      ])
      const report = await mysqlDiagnostics(conn, 'recentStatements', { since: '2024-01-01 00:00:00' }, [11, 12])
      expect(report).toMatchObject({ columns: ['time', 'statement'], rows: [['2024-01-02 00:00:00', 'SELECT 2']] })
      const query = asked.at(-1)
      expect(query?.text).toContain('thread_id NOT IN (?, ?)')
      expect(query?.text).toContain('event_time > ?')
      expect(query?.params).toEqual([11, 12, '2024-01-01 00:00:00'])
    })

    it('asks for no thread filter when it has no connections of its own, and no time filter without `since`', async () => {
      const { conn, asked } = scripted([
        [/@@GLOBAL/, flags(1, 'TABLE')],
        [/mysql\.general_log/, rows([])],
      ])
      await mysqlDiagnostics(conn, 'recentStatements')
      expect(asked.at(-1)?.text).not.toContain('thread_id')
      expect(asked.at(-1)?.text).not.toContain('event_time >')
      expect(asked.at(-1)?.params).toEqual([])
    })
  })

  describe('binlogEvents', () => {
    const events = rows([['bin.000002', 4, 'Format_desc', 1, 126, 'Server ver: 8.4.0', 'extra']])

    it('reads the events of the newest log by default, six columns of each', async () => {
      const { conn, asked } = scripted([
        [/SHOW BINARY LOGS/, rows([['bin.000001'], ['bin.000002']])],
        [/SHOW BINLOG EVENTS/, events],
      ])
      const report = await mysqlDiagnostics(conn, 'binlogEvents')
      expect(report.rows[0]).toEqual(['bin.000002', '4', 'Format_desc', '1', '126', 'Server ver: 8.4.0'])
      expect(asked.at(-1)?.text).toBe("SHOW BINLOG EVENTS IN 'bin.000002' LIMIT 200")
    })

    it('reads the log it is asked for, only if the server listed it', async () => {
      const listed = rows([['bin.000001'], ['bin.000002']])
      const ok = scripted([
        [/SHOW BINARY LOGS/, listed],
        [/SHOW BINLOG EVENTS/, events],
      ])
      await mysqlDiagnostics(ok.conn, 'binlogEvents', { file: 'bin.000001' })
      expect(ok.asked.at(-1)?.text).toContain("'bin.000001'")
      const foreign = scripted([[/SHOW BINARY LOGS/, listed]])
      await expect(mysqlDiagnostics(foreign.conn, 'binlogEvents', { file: "x' OR '1" })).rejects.toMatchObject({
        code: 'VALIDATION',
      })
      expect(foreign.asked).toHaveLength(1)
    })

    it('says binary logging is off when there is none, or when the server says so', async () => {
      const none = scripted([[/SHOW BINARY LOGS/, rows([])]])
      expect(await mysqlDiagnostics(none.conn, 'binlogEvents')).toMatchObject({ status: 'disabled' })
      const off = scripted([[/SHOW BINARY LOGS/, fail('QUERY_FAILED', 'ER_NO_BINARY_LOGGING')]])
      expect(await mysqlDiagnostics(off.conn, 'binlogEvents')).toMatchObject({ status: 'disabled' })
    })

    it('does not hide another error', async () => {
      const { conn } = scripted([[/SHOW BINARY LOGS/, fail('QUERY_FAILED', 'ER_LOCK_DEADLOCK')]])
      await expect(mysqlDiagnostics(conn, 'binlogEvents')).rejects.toMatchObject({ nativeCode: 'ER_LOCK_DEADLOCK' })
    })
  })

  it('gives the InnoDB status as text, and nothing for the statement statistics PostgreSQL has', async () => {
    const { conn } = scripted([[/SHOW ENGINE INNODB STATUS/, rows([['InnoDB', '', 'BACKGROUND THREAD …']])]])
    expect(await mysqlDiagnostics(conn, 'engineStatus')).toMatchObject({ status: 'ok', text: 'BACKGROUND THREAD …' })
    const none = scripted([[/SHOW ENGINE INNODB STATUS/, rows([])]])
    expect((await mysqlDiagnostics(none.conn, 'engineStatus')).text).toBeNull()
    expect(await mysqlDiagnostics(scripted([]).conn, 'statements')).toMatchObject({ status: 'unsupported' })
  })

  it('reports an account that may not read as denied, by either spelling, and does not hide another error', async () => {
    for (const refusal of [fail('PERMISSION_DENIED'), fail('QUERY_FAILED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')]) {
      const { conn } = scripted([[/INNODB STATUS/, refusal]])
      expect(await mysqlDiagnostics(conn, 'engineStatus')).toMatchObject({ status: 'denied' })
    }
    const { conn } = scripted([[/INNODB STATUS/, fail('QUERY_FAILED', 'ER_LOCK_DEADLOCK')]])
    await expect(mysqlDiagnostics(conn, 'engineStatus')).rejects.toMatchObject({ nativeCode: 'ER_LOCK_DEADLOCK' })
  })
})
