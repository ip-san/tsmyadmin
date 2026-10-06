import type { DdlOp, StatementResult } from '@tsmyadmin/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DatabaseAdapter, ExecuteOptions } from '../types.ts'
import { describeAccounts } from './conformance/accounts.ts'
import { describeBrowseAndInsert } from './conformance/browse-and-insert.ts'
import { describeCatalog } from './conformance/catalog.ts'
import { describeConnectionLoss } from './conformance/connection-loss.ts'
import { describeDatabaseOps } from './conformance/database-ops.ts'
import { describeDdl } from './conformance/ddl.ts'
import { describeDumpAndExport } from './conformance/dump-and-export.ts'
import type { ConformanceContext, ConformanceEnv } from './conformance/env.ts'
import { EXEC } from './conformance/helpers.ts'
import { describeObjectDetails } from './conformance/object-details.ts'
import { describePrepareDdl } from './conformance/prepare-ddl.ts'
import { describeRowEdits } from './conformance/row-edits.ts'
import { describeRowIdentityAndExport } from './conformance/row-identity-and-export.ts'
import { describeSearchAndQuery } from './conformance/search-and-query.ts'
import { describeServer } from './conformance/server.ts'
import { describeSqlConsole } from './conformance/sql-console.ts'

export type { ConformanceContext } from './conformance/env.ts'

/**
 * Shared behavioural contract for every DatabaseAdapter implementation.
 * Each top-level `describe` is named after the adapter method it covers (checked by spec-consistency tests).
 */
export function describeAdapterConformance(ctx: ConformanceContext): void {
  const { ns, dialect } = ctx
  const scratch = `t_${dialect}_${Date.now().toString(36)}`
  const scratchNoPk = `${scratch}_nopk`
  const scratchDdl = `${scratch}_ddl`
  let db: DatabaseAdapter

  const exec = async (sql: string, opts: Partial<ExecuteOptions> = {}): Promise<StatementResult[]> => {
    const results = await db.executeSql(ns, sql, { ...EXEC, ...opts })
    return results
  }
  const execOk = async (sql: string): Promise<StatementResult[]> => {
    const results = await exec(sql)
    for (const r of results) if (r.kind === 'error') throw new Error(`SQL failed: ${r.message}\n${r.sql}`)
    return results
  }
  const runDdl = async (op: DdlOp) => {
    for (const sql of db.ddl.build(ns, op)) await execOk(sql)
  }
  // Every scratch table this suite creates; dropped before and after the run so nothing leaks into the shared DB.
  const SCRATCH_TABLES = [
    scratch,
    scratchNoPk,
    scratchDdl,
    `${scratch}_empty`,
    `${scratch}_dump`,
    `${scratch}_keyset`,
    `${scratch}_gen`,
    `${scratch}_uns`,
    `${scratch}_partial`,
    `${scratch}_copy`,
    `${scratchDdl}_rn`,
    `${scratch}_camel`,
    `${scratch}_pu`,
    `${scratch}_seq`,
    `${scratch}_seq2`,
    `${scratch}_like`,
    `${scratch}_fk`,
    `${scratch}_typedkey`,
    `${scratch}_enumkey`,
    `${scratch}_bigkey`,
    `${scratch}_bitkey`,
    `${scratch}_trg`,
    `${scratch}_sqt`,
    `${scratch}_qtrg`,
    `${scratch}_sq`,
    `${scratch}_cons_child`,
    `${scratch}_part`,
    `${scratch}_fkopts`,
    `${scratch}_inh_kid`,
    `${scratch}_parent`,
    `${scratch}_cons`,
    `${scratch}_dep_t`,
    `${scratch}_bulk_a`,
    `${scratch}_bulk_b`,
    `${scratch}_nokey`,
    `${scratch}_slowt`,
    `${scratch}_big`,
    `${scratch}_seed`,
    `${scratch}_pseqt`,
    `${scratch}_serialt`,
    `${scratch}_inh_child`,
    `${scratch}_inh`,
    `${scratch}_seqmin_copy`,
    `${scratch}_seqmin`,
    `${scratch}_ser`,
    `${scratch}_bin`,
    `${scratch}_txt`,
  ]
  const browseAll = async (table: string) => db.browseRows(ns, table, { offset: 0, limit: 100, sort: [], filters: [] })

  /** MariaDB answers the MySQL adapter; a few server behaviours differ (see the MariaDB notes in adapter.md). */
  const isMariaDb = async () => dialect === 'mysql' && /mariadb/i.test((await db.serverInfo()).version)

  const env: ConformanceEnv = {
    ctx,
    ns,
    dialect,
    scratch,
    scratchNoPk,
    scratchDdl,
    get db() {
      return db
    },
    exec,
    execOk,
    runDdl,
    browseAll,
    isMariaDb,
  }

  describe(`adapter conformance (${dialect})`, () => {
    beforeAll(async () => {
      db = ctx.create()
      await db.ping()
      await execOk(SCRATCH_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`).join('; '))
      await execOk(`CREATE TABLE ${scratch} (id INT PRIMARY KEY, name VARCHAR(50) NULL, n INT NULL)`)
      await execOk(`CREATE TABLE ${scratchNoPk} (a INT NULL, b VARCHAR(50) NULL)`)
      await execOk(`CREATE TABLE ${scratch}_empty (id INT PRIMARY KEY)`)
      await execOk(`INSERT INTO ${scratchNoPk} (a, b) VALUES (1, 'one'), (1, 'one'), (2, 'two'), (NULL, NULL)`)
    })

    afterAll(async () => {
      await exec(SCRATCH_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`).join('; '), { stopOnError: false })
      if (dialect === 'postgres') await exec(`DROP TYPE IF EXISTS ${scratch}_enumkey_e`, { stopOnError: false })
      // The users test creates this account; a failure half-way must not leave it behind.
      await exec(dialect === 'mysql' ? `DROP USER IF EXISTS 'u_${scratch}'@'%'` : `DROP ROLE IF EXISTS u_${scratch}`, {
        stopOnError: false,
      })
      await db.close()
    })

    // The groups run in this order, as the blocks always have: later ones use what earlier ones left.
    describeCatalog(env)
    describeSearchAndQuery(env)
    describeBrowseAndInsert(env)
    describeObjectDetails(env)
    describeRowEdits(env)
    describeSqlConsole(env)
    describeDumpAndExport(env)
    describeRowIdentityAndExport(env)
    describeServer(env)
    describeAccounts(env)
    describeDdl(env)
    describeDatabaseOps(env)
    describePrepareDdl(env)
    describeConnectionLoss(env)

    describe('close', () => {
      it('is idempotent and releases the pool', async () => {
        const tmp = ctx.create()
        await tmp.ping()
        await expect(tmp.close()).resolves.toBeUndefined()
        await expect(tmp.close()).resolves.toBeUndefined()
      })
    })
  })
}
