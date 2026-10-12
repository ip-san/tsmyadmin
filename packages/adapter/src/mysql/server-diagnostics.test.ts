import { describe, expect, it } from 'vitest'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import { mysqlDiagnostics, mysqlKillProcess, mysqlServerCatalog } from './server.ts'

/** The server pages of MySQL: kill, the catalogs and the diagnostics, each answer a server can give. */

const rejects = async (run: () => Promise<unknown>, message: RegExp) =>
  await expect(run()).rejects.toMatchObject({ message: expect.stringMatching(message) })

describe('mysqlKillProcess', () => {
  it('kills the connection by default and only the statement when asked, naming the id', async () => {
    const a = scripted([[/KILL/, rows([])]])
    await mysqlKillProcess(a.conn, '42')
    expect(a.asked[0]?.text).toBe('KILL 42')
    const b = scripted([[/KILL/, rows([])]])
    await mysqlKillProcess(b.conn, '42', 'query')
    expect(b.asked[0]?.text).toBe('KILL QUERY 42')
    const c = scripted([[/KILL/, rows([])]])
    await mysqlKillProcess(c.conn, '7', 'connection')
    expect(c.asked[0]?.text).toBe('KILL 7')
  })

  it('refuses an id that is not all digits before asking the server anything', async () => {
    for (const bad of ['', '5a', 'a5', '-1', '5 ', ' 5', '5;DROP', '1.5']) {
      const s = scripted([])
      await rejects(() => mysqlKillProcess(s.conn, bad), /process id must be numeric/)
      expect(s.asked, bad).toHaveLength(0)
    }
  })

  it('takes the loss of the connection it killed for success, giving it up, and any other failure for one', async () => {
    const own = scripted([[/KILL/, fail('CONNECTION_FAILED', 'PROTOCOL_CONNECTION_LOST')]])
    await expect(mysqlKillProcess(own.conn, '9')).resolves.toBeUndefined()
    expect(own.discard).toHaveBeenCalledTimes(1)
    const denied = scripted([[/KILL/, fail('QUERY_FAILED', 'ER_KILL_DENIED_ERROR')]])
    await rejects(() => mysqlKillProcess(denied.conn, '9'), /ER_KILL_DENIED_ERROR/)
    expect(denied.discard).not.toHaveBeenCalled()
    const plain = scripted([[/KILL/, new Error('boom')]])
    await rejects(() => mysqlKillProcess(plain.conn, '9'), /boom/)
  })
})

describe('mysqlServerCatalog', () => {
  it('names the columns of each list and writes every value as text, a missing one staying empty', async () => {
    const s = (data: unknown[][]) => scripted([[/information_schema\./, rows(data)]])
    expect(
      await mysqlServerCatalog(
        s([
          ['utf8mb4', 'utf8mb4_bin', 'Yes'],
          ['latin1', 'latin1_bin', null],
        ]).conn,
        'collations'
      )
    ).toEqual({
      columns: ['charset', 'collation', 'isDefault'],
      rows: [
        ['utf8mb4', 'utf8mb4_bin', 'Yes'],
        ['latin1', 'latin1_bin', null],
      ],
    })
    expect((await mysqlServerCatalog(s([['InnoDB', 'DEFAULT', 'YES', 'c']]).conn, 'engines')).columns).toEqual([
      'name',
      'support',
      'transactions',
      'comment',
    ])
    expect(await mysqlServerCatalog(s([['p', 'ACTIVE', 'AUTHENTICATION', null, 5]]).conn, 'plugins')).toEqual({
      columns: ['name', 'status', 'type', 'library', 'license'],
      rows: [['p', 'ACTIVE', 'AUTHENTICATION', null, '5']],
    })
    expect((await mysqlServerCatalog(s([[undefined, 1]]).conn, 'engines')).rows).toEqual([[null, '1']])
  })

  it('asks the table that holds each kind', async () => {
    const ask = async (kind: Parameters<typeof mysqlServerCatalog>[1]) => {
      const s = scripted([[/information_schema\./, rows([])]])
      await mysqlServerCatalog(s.conn, kind)
      return s.asked[0]?.text ?? ''
    }
    expect(await ask('collations')).toContain('information_schema.COLLATIONS')
    expect(await ask('engines')).toContain('information_schema.ENGINES')
    expect(await ask('plugins')).toContain('information_schema.PLUGINS')
  })
})

describe('mysqlDiagnostics: the logs kept in tables', () => {
  const FLAGS = { slow: /@@GLOBAL\.slow_query_log/, general: /@@GLOBAL\.general_log/ }
  const flagged = (
    kind: 'slow' | 'general',
    flags: unknown[] | null,
    extra: [RegExp, ReturnType<typeof rows>][] = []
  ) => scripted([[FLAGS[kind], rows(flags === null ? [] : [flags])], ...extra])

  it('says a log that is off is disabled, whatever way the server writes off', async () => {
    for (const off of [0, '0', 'OFF', 'off', 'false', 'FALSE', null, undefined]) {
      const s = flagged('slow', [off, 'TABLE'])
      expect(await mysqlDiagnostics(s.conn, 'slowLog'), String(off)).toEqual({
        status: 'disabled',
        columns: [],
        rows: [],
        text: null,
      })
    }
    expect((await mysqlDiagnostics(flagged('slow', null).conn, 'slowLog')).status).toBe('disabled')
    for (const on of [1, '1', 'ON', 'on', 'true', '10', 'offline', '01']) {
      expect((await mysqlDiagnostics(flagged('slow', [on, 'FILE']).conn, 'slowLog')).status, String(on)).toBe(
        'notTable'
      )
    }
  })

  it('says a log written to a file is not a table, and reads one that is written to a table, among others or not', async () => {
    for (const out of ['FILE', 'NONE', '', null]) {
      expect((await mysqlDiagnostics(flagged('general', [1, out]).conn, 'generalLog')).status, String(out)).toBe(
        'notTable'
      )
    }
    const logRule: [RegExp, ReturnType<typeof rows>] = [
      /mysql\.general_log/,
      rows([
        ['SELECT 1', 5],
        ['SELECT 2', null],
      ]),
    ]
    for (const out of ['TABLE', 'table', 'FILE,TABLE', 'TABLE,FILE']) {
      expect((await mysqlDiagnostics(flagged('general', [1, out], [logRule]).conn, 'generalLog')).status, out).toBe(
        'ok'
      )
    }
  })

  it('reads the general log as statements with how often each ran, every value as text', async () => {
    const s = flagged(
      'general',
      [1, 'TABLE'],
      [
        [
          /mysql\.general_log/,
          rows([
            ['SELECT 1', 5],
            ['SELECT 2', null],
          ]),
        ],
      ]
    )
    expect(await mysqlDiagnostics(s.conn, 'generalLog')).toEqual({
      status: 'ok',
      columns: ['statement', 'runs'],
      rows: [
        ['SELECT 1', '5'],
        ['SELECT 2', null],
      ],
      text: null,
    })
    expect(s.asked.map((q) => q.text).join('\n')).toContain("command_type = 'Query'")
  })

  it('reads the slow log as statements with their count, total and longest time and rows examined', async () => {
    const s = flagged('slow', [1, 'TABLE'], [[/mysql\.slow_log/, rows([['SELECT SLEEP(1)', 2, 2.5, 1.5, 100]])]])
    expect(await mysqlDiagnostics(s.conn, 'slowLog')).toEqual({
      status: 'ok',
      columns: ['statement', 'runs', 'totalSeconds', 'maxSeconds', 'rowsExamined'],
      rows: [['SELECT SLEEP(1)', '2', '2.5', '1.5', '100']],
      text: null,
    })
    const query = s.asked.find((q) => /slow_log/.test(q.text))?.text ?? ''
    expect(query).toContain('TIME_TO_SEC(query_time) + MICROSECOND(query_time) / 1000000')
    expect(query).toContain('ORDER BY 3 DESC LIMIT 50')
  })
})

describe('mysqlDiagnostics: recent statements', () => {
  const recent = async (query: Parameters<typeof mysqlDiagnostics>[2], own: readonly number[] = []) => {
    const s = scripted([
      [/@@GLOBAL\.general_log/, rows([[1, 'TABLE']])],
      [
        /mysql\.general_log WHERE/,
        rows([
          ['2030-01-01 00:00:00', 'SELECT 1'],
          ['2030-01-01 00:00:01', null],
        ]),
      ],
    ])
    const report = await mysqlDiagnostics(s.conn, 'recentStatements', query, own)
    return { report, ask: s.asked.find((q) => /general_log WHERE/.test(q.text)) }
  }

  it('reads the newest statements with their time, as text', async () => {
    const { report } = await recent(undefined)
    expect(report).toEqual({
      status: 'ok',
      columns: ['time', 'statement'],
      rows: [
        ['2030-01-01 00:00:00', 'SELECT 1'],
        ['2030-01-01 00:00:01', null],
      ],
      text: null,
    })
  })

  it("leaves out the tool's own threads and what came before a time, only when asked", async () => {
    const plain = (await recent(undefined)).ask
    expect(plain?.text).toContain("WHERE command_type IN ('Query', 'Execute') ORDER BY event_time DESC LIMIT 200")
    expect(plain?.params).toEqual([])
    const threads = (await recent(undefined, [3, 4])).ask
    expect(threads?.text).toContain("command_type IN ('Query', 'Execute') AND thread_id NOT IN (?, ?) ORDER BY")
    expect(threads?.params).toEqual([3, 4])
    const since = (await recent({ since: '2030-01-01 00:00:00' })).ask
    expect(since?.text).toContain("command_type IN ('Query', 'Execute') AND event_time > ? ORDER BY")
    expect(since?.params).toEqual(['2030-01-01 00:00:00'])
    const both = (await recent({ since: 'T' }, [9])).ask
    expect(both?.text).toContain(
      "command_type IN ('Query', 'Execute') AND thread_id NOT IN (?) AND event_time > ? ORDER BY"
    )
    expect(both?.params).toEqual([9, 'T'])
  })

  it('says so when the general log is off', async () => {
    const s = scripted([[/@@GLOBAL\.general_log/, rows([[0, 'TABLE']])]])
    expect((await mysqlDiagnostics(s.conn, 'recentStatements')).status).toBe('disabled')
  })
})

describe('mysqlDiagnostics: binary log events and InnoDB', () => {
  const binlog = (logs: string[], events: unknown[][] = []) =>
    scripted([
      [/SHOW BINARY LOGS/, rows(logs.map((l) => [l, 100]))],
      [/SHOW BINLOG EVENTS/, rows(events)],
    ])

  it('reads the events of the newest log by default, or of the one named, as text', async () => {
    const s = binlog(['bin.000001', 'bin.000002'], [['bin.000002', 4, 'Format_desc', 1, 126, 'Server ver', 'extra']])
    expect(await mysqlDiagnostics(s.conn, 'binlogEvents')).toEqual({
      status: 'ok',
      columns: ['logName', 'position', 'eventType', 'serverId', 'endPosition', 'info'],
      rows: [['bin.000002', '4', 'Format_desc', '1', '126', 'Server ver']],
      text: null,
    })
    expect(s.asked.find((q) => /BINLOG EVENTS/.test(q.text))?.text).toBe("SHOW BINLOG EVENTS IN 'bin.000002' LIMIT 200")
    const named = binlog(['bin.000001', 'bin.000002'])
    await mysqlDiagnostics(named.conn, 'binlogEvents', { file: 'bin.000001' })
    expect(named.asked.find((q) => /BINLOG EVENTS/.test(q.text))?.text).toBe(
      "SHOW BINLOG EVENTS IN 'bin.000001' LIMIT 200"
    )
  })

  it('refuses a log the server did not list, and says there is nothing to read when it lists none', async () => {
    await rejects(
      () => mysqlDiagnostics(binlog(['bin.000001']).conn, 'binlogEvents', { file: "x'; DROP" }),
      /Unknown binary log/
    )
    expect(await mysqlDiagnostics(binlog([]).conn, 'binlogEvents')).toMatchObject({ status: 'disabled', columns: [] })
  })

  it('says binary logging is off when the server says so, and does not hide any other failure', async () => {
    const off = scripted([[/SHOW BINARY LOGS/, fail('QUERY_FAILED', 'ER_NO_BINARY_LOGGING')]])
    expect((await mysqlDiagnostics(off.conn, 'binlogEvents')).status).toBe('disabled')
    const broken = scripted([[/SHOW BINARY LOGS/, fail('QUERY_FAILED', 'ER_PARSE_ERROR')]])
    await rejects(() => mysqlDiagnostics(broken.conn, 'binlogEvents'), /ER_PARSE_ERROR/)
  })

  it('shows the InnoDB status as the text of its third column, none when there is no row', async () => {
    const s = scripted([[/SHOW ENGINE INNODB STATUS/, rows([['InnoDB', '', 'the status text']])]])
    expect(await mysqlDiagnostics(s.conn, 'engineStatus')).toEqual({
      status: 'ok',
      columns: [],
      rows: [],
      text: 'the status text',
    })
    const none = scripted([[/SHOW ENGINE INNODB STATUS/, rows([])]])
    expect(await mysqlDiagnostics(none.conn, 'engineStatus')).toEqual({
      status: 'ok',
      columns: [],
      rows: [],
      text: null,
    })
    const empty = scripted([[/SHOW ENGINE INNODB STATUS/, rows([['InnoDB', '', null]])]])
    expect((await mysqlDiagnostics(empty.conn, 'engineStatus')).text).toBeNull()
  })

  it("has no statement statistics: those are PostgreSQL's", async () => {
    expect(await mysqlDiagnostics(scripted([]).conn, 'statements')).toEqual({
      status: 'unsupported',
      columns: [],
      rows: [],
      text: null,
    })
  })

  it('says access is denied when the account may not read, and rethrows the rest', async () => {
    for (const denied of [fail('PERMISSION_DENIED'), fail('QUERY_FAILED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')]) {
      const s = scripted([[/SHOW ENGINE INNODB STATUS/, denied]])
      expect((await mysqlDiagnostics(s.conn, 'engineStatus')).status).toBe('denied')
    }
    await rejects(
      () => mysqlDiagnostics(scripted([[/SHOW ENGINE/, fail('QUERY_FAILED', 'ER_PARSE_ERROR')]]).conn, 'engineStatus'),
      /ER_PARSE_ERROR/
    )
    await rejects(() => mysqlDiagnostics(scripted([[/SHOW ENGINE/, new Error('boom')]]).conn, 'engineStatus'), /boom/)
  })
})
