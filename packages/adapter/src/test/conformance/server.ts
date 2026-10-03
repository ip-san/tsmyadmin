import { describe, expect, it } from 'vitest'
import { mysqlAccount } from '../../mysql/users.ts'
import { quoteIdent } from '../../sql/quote.ts'
import type { ConformanceEnv } from './env.ts'
import { EXEC } from './helpers.ts'

/** Conformance: the blocks of `server` (in the order they have always run in). */
export function describeServer(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, exec, execOk, isMariaDb } = env
  describe('serverInfo', () => {
    it('reports version, uptime and the connected user', async () => {
      const info = await env.db.serverInfo()
      expect(info.dialect).toBe(dialect)
      expect(info.version).toMatch(/^\d+\./)
      expect(info.uptimeSec === null || info.uptimeSec >= 0).toBe(true)
      expect(info.currentUser).toContain('tsmyadmin')
    })
  })

  describe('serverCatalog', () => {
    it('lists collations, engines (access methods) and plugins (extensions), row by row as wide as the columns', async () => {
      const find = async (kind: 'collations' | 'engines' | 'plugins', column: string) => {
        const catalog = await env.db.serverCatalog(kind)
        for (const row of catalog.rows) expect(row).toHaveLength(catalog.columns.length)
        const at = catalog.columns.indexOf(column as never)
        expect(at, `${kind} has ${column}`).toBeGreaterThanOrEqual(0)
        return catalog.rows.map((r) => r[at])
      }
      // Something every server of the dialect has.
      expect(await find('collations', 'collation')).toContain(dialect === 'mysql' ? 'utf8mb4_bin' : 'C')
      expect(await find('engines', 'name')).toContain(dialect === 'mysql' ? 'InnoDB' : 'btree')
      expect(await find('plugins', 'name')).toContain(dialect === 'mysql' ? 'InnoDB' : 'plpgsql')
    })
  })

  describe('diagnostics', () => {
    it('answers with a status instead of an error for what this server lacks or the account may not read', async () => {
      if (dialect === 'postgres') {
        // pg_stat_statements is not installed in the compose server; everything else is MySQL's.
        expect(['ok', 'noExtension', 'denied']).toContain((await env.db.diagnostics('statements')).status)
        expect(['ok', 'noExtension', 'denied']).toContain((await env.db.diagnostics('recentStatements')).status)
        for (const kind of ['slowLog', 'generalLog', 'engineStatus', 'binlogEvents'] as const)
          expect((await env.db.diagnostics(kind)).status).toBe('unsupported')
        return
      }
      expect((await env.db.diagnostics('statements')).status).toBe('unsupported')
      const engine = await env.db.diagnostics('engineStatus')
      expect(['ok', 'denied']).toContain(engine.status)
      if (engine.status === 'ok') expect(engine.text).toMatch(/INNODB/i)

      // MariaDB keeps no binary log until asked; MySQL 8 does.
      const events = await env.db.diagnostics('binlogEvents')
      expect(['ok', 'disabled', 'denied']).toContain(events.status)
      if (events.status === 'ok') {
        expect(events.columns).toEqual(['logName', 'position', 'eventType', 'serverId', 'endPosition', 'info'])
        expect(events.rows.length).toBeGreaterThan(0)
        // The file name is only taken from what SHOW BINARY LOGS lists.
        await expect(env.db.diagnostics('binlogEvents', { file: "nope'; SELECT 1 -- " })).rejects.toThrow(
          /Unknown binary log/
        )
      }

      // A log that is off, or goes to a file, says so.
      expect(['ok', 'disabled', 'notTable', 'denied']).toContain((await env.db.diagnostics('slowLog')).status)
      expect(['ok', 'disabled', 'notTable', 'denied']).toContain((await env.db.diagnostics('generalLog')).status)
    })

    it('lists what another connection ran, newest first, and leaves out its own statements', async () => {
      if (dialect === 'postgres') {
        const report = await env.db.diagnostics('recentStatements')
        if (report.status !== 'ok') return
        // pg_stat_statements is loaded: a statement counted once shows with its call count, the tool's own do not.
        const other = ctx.create()
        const marker = `recentmark_${scratch}`
        try {
          // A statement the console does not wrap (a read is wrapped in `_tsmyadmin`, which the history hides as
          // this tool's own), and an identifier, which pg_stat_statements' normalising of literals leaves alone.
          await other.executeSql(ns, `CREATE TEMP TABLE ${marker} (a int)`, EXEC)
          const after = await env.db.diagnostics('recentStatements')
          expect(after.columns).toEqual(['statement', 'runs'])
          expect(after.rows.some((r) => r[0]?.includes(marker) && Number(r[1]) >= 1)).toBe(true)
          expect(after.rows.some((r) => /^\s*(discard|rollback)/i.test(r[0] ?? ''))).toBe(false)
        } finally {
          await other.close()
        }
        return
      }
      const value = async (sql: string) => {
        const first = (await exec(sql))[0]
        return first?.kind === 'rows' ? first.result.rows[0]?.[0] : undefined
      }
      const on = await value('SELECT @@GLOBAL.general_log')
      const output = await value('SELECT @@GLOBAL.log_output')
      const set = await exec("SET GLOBAL log_output = 'TABLE'; SET GLOBAL general_log = 1", { stopOnError: false })
      // The account may not change server variables (the CI MariaDB user): nothing to enable, nothing to check.
      if (set.some((r) => r.kind === 'error')) return
      const other = ctx.create()
      try {
        const app = `appmark_${scratch}`
        const own = `ownmark_${scratch}`
        await other.executeSql(ns, `SELECT '${app}'`, EXEC)
        // A statement of this adapter's own connections is what the history leaves out.
        await exec(`SELECT '${own}'`)
        const report = await env.db.diagnostics('recentStatements')
        expect(report.status).toBe('ok')
        expect(report.columns).toEqual(['time', 'statement'])
        const seen = report.rows.map((r) => r[1] ?? '')
        expect(seen.some((sql) => sql.includes(app))).toBe(true)
        expect(seen.some((sql) => sql.includes(own))).toBe(false)
        // Newest first, and `since` asks only for what came after it.
        const times = report.rows.map((r) => r[0] ?? '')
        expect([...times].sort().reverse()).toEqual(times)
        const newest = times[0] ?? ''
        expect((await env.db.diagnostics('recentStatements', { since: newest })).rows).toEqual([])
        await other.executeSql(ns, `SELECT '${app}_2'`, EXEC)
        const later = await env.db.diagnostics('recentStatements', { since: newest })
        expect(later.rows.some((r) => r[1]?.includes(`${app}_2`))).toBe(true)
      } finally {
        await other.close()
        await exec(
          `SET GLOBAL general_log = ${on === 1 || on === '1' ? 1 : 0}; SET GLOBAL log_output = '${String(output).replaceAll("'", '')}'`,
          { stopOnError: false }
        )
      }
    })

    it('groups the statements of the slow log table when it is switched on', async () => {
      if (dialect !== 'mysql') return
      const value = async (sql: string) => {
        const first = (await exec(sql))[0]
        return first?.kind === 'rows' ? first.result.rows[0]?.[0] : undefined
      }
      const on = await value('SELECT @@GLOBAL.slow_query_log')
      const output = await value('SELECT @@GLOBAL.log_output')
      const marker = `slowmark_${scratch}`
      const set = await exec("SET GLOBAL log_output = 'TABLE'; SET GLOBAL slow_query_log = 1", { stopOnError: false })
      // The account may not change server variables (the CI MariaDB user): nothing to enable, nothing to check.
      if (set.some((r) => r.kind === 'error')) return
      try {
        await exec(`SET SESSION long_query_time = 0; SELECT '${marker}'`, { stopOnError: false })
        const report = await env.db.diagnostics('slowLog')
        expect(report.status).toBe('ok')
        expect(report.columns).toEqual(['statement', 'runs', 'totalSeconds', 'maxSeconds', 'rowsExamined'])
        expect(report.rows.some((r) => r[0]?.includes(marker) && Number(r[1]) >= 1)).toBe(true)
      } finally {
        await exec(
          `SET GLOBAL slow_query_log = ${on === 1 || on === '1' ? 1 : 0}; SET GLOBAL log_output = '${String(output).replaceAll("'", '')}'`,
          {
            stopOnError: false,
          }
        )
      }
    })
  })

  describe('replicationInfo', () => {
    it('reports a lone server as standalone, with its logs, and hides what an account may not read', async () => {
      const info = await env.db.replicationInfo()
      // The compose servers replicate nothing.
      expect(info.role).toBe('standalone')
      expect(info.source ?? []).toEqual([])
      expect(info.replicas ?? []).toEqual([])
      // MySQL 8 keeps binary logs by default (MariaDB does not: null there); PostgreSQL always has WAL.
      if (dialect === 'postgres' || !(await isMariaDb())) {
        expect(info.logs?.length ?? 0).toBeGreaterThan(0)
        expect(info.logs?.[0]?.name).toMatch(dialect === 'mysql' ? /\.\d+$/ : /^[0-9A-F]{24}$/)
      }
      // An account without the privilege gets the parts it cannot read as null, not an error.
      const name = `rep_${scratch}`
      if (dialect === 'mysql') {
        await execOk(
          `CREATE USER ${mysqlAccount({ name, host: '%' })} IDENTIFIED BY 'rp-pw'; GRANT SELECT ON ${quoteIdent(dialect, ns.database)}.* TO ${mysqlAccount({ name, host: '%' })}`
        )
      } else {
        await execOk(
          `CREATE ROLE ${quoteIdent(dialect, name)} LOGIN PASSWORD 'rp-pw'; GRANT CONNECT ON DATABASE ${quoteIdent(dialect, ns.database)} TO ${quoteIdent(dialect, name)}`
        )
      }
      const plain = ctx.createAs(name, 'rp-pw')
      try {
        const limited = await plain.replicationInfo()
        // MySQL keeps the replication state from such an account, so its role cannot be told (PostgreSQL shows
        // the views to anyone, with the details blanked, and the role stays known).
        expect(limited.role).toBe(dialect === 'mysql' ? 'unknown' : 'standalone')
        expect(limited.logs).toBeNull()
      } finally {
        await plain.close()
        if (dialect === 'mysql') await exec(`DROP USER IF EXISTS ${mysqlAccount({ name, host: '%' })}`)
        else await exec(`DROP OWNED BY ${quoteIdent(dialect, name)}; DROP ROLE IF EXISTS ${quoteIdent(dialect, name)}`)
      }
    })
  })

  describe('listVariables', () => {
    it('includes max_connections', async () => {
      const vars = await env.db.listVariables()
      const mc = vars.find((v) => v.name === 'max_connections')
      expect(mc).toBeDefined()
      expect(Number(mc?.value)).toBeGreaterThan(0)
    })
  })

  describe('listStatus', () => {
    it('returns numeric counters', async () => {
      const status = await env.db.listStatus()
      expect(status.length).toBeGreaterThan(5)
      expect(status.every((s) => typeof s.name === 'string' && typeof s.value === 'string')).toBe(true)
    })
  })

  describe('listProcesses', () => {
    it('lists at least this connection', async () => {
      const procs = await env.db.listProcesses()
      expect(procs.length).toBeGreaterThan(0)
      expect(procs.every((p) => /^\d+$/.test(p.id))).toBe(true)
      expect(procs.some((p) => p.user?.includes('tsmyadmin'))).toBe(true)
    })
  })

  describe('killProcess', () => {
    it('terminates another connection running a slow query', async () => {
      const victim = ctx.create()
      const marker = `slow_${scratch}`
      const slow = victim.executeSql(ns, `${ctx.slowSql} /* ${marker} */`, { ...EXEC, timeoutMs: 60_000 })
      let target: string | undefined
      for (let i = 0; i < 40 && !target; i++) {
        await new Promise((r) => setTimeout(r, 100))
        target = (await env.db.listProcesses()).find((p) => p.query?.includes(marker))?.id
      }
      expect(target).toBeDefined()
      await env.db.killProcess(target as string)
      const results = await slow
      expect(results[0]?.kind).toBe('error')
      await victim.close()
    })

    it("cancels only the statement in 'query' mode, leaving the connection usable", async () => {
      const victim = ctx.create()
      const marker = `cancel_${scratch}`
      const slow = victim.executeSql(ns, `${ctx.slowSql} /* ${marker} */`, { ...EXEC, timeoutMs: 60_000 })
      let target: string | undefined
      for (let i = 0; i < 40 && !target; i++) {
        await new Promise((r) => setTimeout(r, 100))
        target = (await env.db.listProcesses()).find((p) => p.query?.includes(marker))?.id
      }
      expect(target).toBeDefined()
      await env.db.killProcess(target as string, 'query')
      await slow
      // The connection itself is still there — that is the whole difference from a connection kill.
      const alive = async () => (await env.db.listProcesses()).some((p) => p.id === target)
      expect(await alive()).toBe(true)

      // ...and killing the connection does remove it.
      await env.db.killProcess(target as string, 'connection')
      let gone = false
      for (let i = 0; i < 40 && !gone; i++) {
        await new Promise((r) => setTimeout(r, 100))
        gone = !(await alive())
      }
      expect(gone).toBe(true)
      await victim.close()
    })

    it('rejects non-numeric ids and unknown backends', async () => {
      await expect(env.db.killProcess('1; DROP TABLE users')).rejects.toMatchObject({ name: 'AdapterError' })
      await expect(env.db.killProcess('999999999')).rejects.toMatchObject({ name: 'AdapterError' })
    })
  })
}
