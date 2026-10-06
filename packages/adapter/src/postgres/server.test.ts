import { describe, expect, it } from 'vitest'
import { type Answer, fail, rows, scripted } from '../test/scripted-conn.ts'
import { pgDiagnostics, pgKillProcess, pgReplicationInfo } from './server.ts'

/**
 * The server module's branches that depend on what the server answers: an extension that is missing or not preloaded,
 * a column that was renamed between versions, a view the account may not read, the backend that is this very
 * connection. The real servers answer only one way each (the fixtures have no pg_stat_statements, the test role may
 * read everything), so the other answers are scripted here, as the server would give them.
 */
const EXTENSION = /FROM pg_extension/
const installed = [EXTENSION, rows([[1]])] as [RegExp, Answer]
const missing = [EXTENSION, rows([])] as [RegExp, Answer]

describe('pgKillProcess', () => {
  it('refuses an id that is not a number, before asking the server anything', async () => {
    const { conn, asked } = scripted([])
    await expect(pgKillProcess(conn, '12; DROP TABLE x')).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    expect(asked).toEqual([])
  })

  it('ends the connection by default and only the statement when asked for the query', async () => {
    for (const [mode, fn] of [
      ['connection', 'pg_terminate_backend'],
      ['query', 'pg_cancel_backend'],
    ] as const) {
      const { conn, asked } = scripted([
        [/pg_backend_pid/, rows([[100]])],
        [/pg_(terminate|cancel)_backend/, rows([[true]])],
      ])
      await pgKillProcess(conn, '200', mode)
      expect(asked.at(-1)).toMatchObject({ text: `SELECT ${fn}($1::int)`, params: [200] })
    }
  })

  it('says so when there is no such backend', async () => {
    const { conn } = scripted([
      [/pg_backend_pid/, rows([[100]])],
      [/pg_terminate_backend/, rows([[false]])],
    ])
    await expect(pgKillProcess(conn, '200')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('treats ending its own connection as success, and gives that connection up', async () => {
    // The statement that ends the connection fails on the connection it ended: that is the result asked for.
    const { conn, discard } = scripted([
      [/pg_backend_pid/, rows([[100]])],
      [/pg_terminate_backend/, fail('CONNECTION_FAILED', '57P01')],
    ])
    await expect(pgKillProcess(conn, '100')).resolves.toBeUndefined()
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('cancelling its own statement is an ordinary cancel: the connection is kept', async () => {
    const { conn, discard } = scripted([
      [/pg_backend_pid/, rows([[100]])],
      [/pg_cancel_backend/, rows([[true]])],
    ])
    await pgKillProcess(conn, '100', 'query')
    expect(discard).not.toHaveBeenCalled()
  })
})

describe('pgDiagnostics', () => {
  it('has only the statement statistics: the other reports are MySQL’s', async () => {
    const { conn, asked } = scripted([])
    for (const kind of ['slowLog', 'generalLog', 'engineStatus', 'binlogEvents'] as const) {
      expect(await pgDiagnostics(conn, kind)).toMatchObject({ status: 'unsupported', rows: [] })
    }
    expect(asked).toEqual([])
  })

  describe('statements', () => {
    it('says the extension is missing when it is not installed', async () => {
      const { conn } = scripted([missing])
      expect(await pgDiagnostics(conn, 'statements')).toMatchObject({ status: 'noExtension' })
    })

    it('lists the statements, with the times in seconds and every value as text', async () => {
      const { conn, asked } = scripted([
        installed,
        [/FROM pg_stat_statements/, rows([['SELECT 1', 3, 1.5, 0.5, null]])],
      ])
      const report = await pgDiagnostics(conn, 'statements')
      expect(report).toMatchObject({
        status: 'ok',
        columns: ['statement', 'runs', 'totalSeconds', 'maxSeconds', 'rows'],
        rows: [['SELECT 1', '3', '1.5', '0.5', null]],
      })
      expect(asked.at(-1)?.text).toContain('total_exec_time')
    })

    it('falls back to the older column names (PostgreSQL 12 and earlier)', async () => {
      const { conn, asked } = scripted([
        installed,
        [/total_exec_time/, fail('NOT_FOUND', '42703')],
        [/total_time/, rows([['SELECT 2', 1, 2, 3, 4]])],
      ])
      expect(await pgDiagnostics(conn, 'statements')).toMatchObject({
        status: 'ok',
        rows: [['SELECT 2', '1', '2', '3', '4']],
      })
      expect(asked.at(-1)?.text).toContain('total_time')
    })

    it('says the extension is missing when it is installed but not preloaded (55000)', async () => {
      const { conn } = scripted([installed, [/FROM pg_stat_statements/, fail('QUERY_FAILED', '55000')]])
      expect(await pgDiagnostics(conn, 'statements')).toMatchObject({ status: 'noExtension' })
    })

    it('does not hide an error it does not know', async () => {
      const { conn } = scripted([installed, [/FROM pg_stat_statements/, fail('QUERY_FAILED', '22012')]])
      await expect(pgDiagnostics(conn, 'statements')).rejects.toMatchObject({ nativeCode: '22012' })
    })

    it('says access is denied when the account may not read it', async () => {
      const { conn } = scripted([installed, [/FROM pg_stat_statements/, fail('PERMISSION_DENIED', '42501')]])
      expect(await pgDiagnostics(conn, 'statements')).toMatchObject({ status: 'denied', rows: [] })
    })
  })

  describe('recentStatements', () => {
    it('says the extension is missing when it is not installed', async () => {
      const { conn } = scripted([missing])
      expect(await pgDiagnostics(conn, 'recentStatements')).toMatchObject({ status: 'noExtension' })
    })

    it('lists what was counted, leaving out the tool’s own housekeeping in the query', async () => {
      const { conn, asked } = scripted([installed, [/FROM pg_stat_statements/, rows([['SELECT * FROM t', '7']])]])
      expect(await pgDiagnostics(conn, 'recentStatements')).toMatchObject({
        status: 'ok',
        columns: ['statement', 'runs'],
        rows: [['SELECT * FROM t', '7']],
      })
      expect(asked.at(-1)?.text).toMatch(/discard\|rollback/)
    })

    it('says the extension is missing when it is installed but not preloaded (55000)', async () => {
      const { conn } = scripted([installed, [/FROM pg_stat_statements/, fail('QUERY_FAILED', '55000')]])
      expect(await pgDiagnostics(conn, 'recentStatements')).toMatchObject({ status: 'noExtension' })
    })

    it('does not hide an error it does not know, and reports a refusal as denied', async () => {
      const unknown = scripted([installed, [/FROM pg_stat_statements/, fail('QUERY_FAILED', '22012')]])
      await expect(pgDiagnostics(unknown.conn, 'recentStatements')).rejects.toMatchObject({ nativeCode: '22012' })
      const denied = scripted([installed, [/FROM pg_stat_statements/, fail('PERMISSION_DENIED', '42501')]])
      expect(await pgDiagnostics(denied.conn, 'recentStatements')).toMatchObject({ status: 'denied' })
    })
  })
})

describe('pgReplicationInfo', () => {
  it('shows a part the account may not read as unavailable, not as an error', async () => {
    const { conn } = scripted([
      [/pg_stat_wal_receiver/, rows([[1]], ['status'])],
      [/pg_stat_replication/, fail('PERMISSION_DENIED', '42501')],
      [/pg_ls_waldir/, fail('PERMISSION_DENIED', '42501')],
    ])
    const info = await pgReplicationInfo(conn)
    expect(info.source).toEqual([[{ name: 'status', value: '1' }]])
    expect(info.replicas).toBeNull()
    expect(info.logs).toBeNull()
  })

  it('lists the WAL files with their sizes', async () => {
    const { conn } = scripted([
      [/pg_stat_wal_receiver/, rows([])],
      [/pg_stat_replication/, rows([])],
      [
        /pg_ls_waldir/,
        rows(
          [
            ['000000010000000000000001', 16777216],
            ['000000010000000000000002', null],
          ],
          ['name', 'size']
        ),
      ],
    ])
    expect((await pgReplicationInfo(conn)).logs).toEqual([
      { name: '000000010000000000000001', size: '16777216' },
      { name: '000000010000000000000002', size: null },
    ])
  })

  it('does not hide an error that is not a refusal', async () => {
    const { conn } = scripted([[/pg_stat_wal_receiver/, fail('QUERY_FAILED', '58030')]])
    await expect(pgReplicationInfo(conn)).rejects.toMatchObject({ nativeCode: '58030' })
  })
})
