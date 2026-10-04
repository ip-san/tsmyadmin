import type { DdlOp } from '@tsmyadmin/shared'
import { sqlScript } from '@tsmyadmin/shared'
import { describe } from 'vitest'
import { describeDdlColumnsAndDatabases } from './ddl-columns-and-databases.ts'
import { describeDdlDefaults } from './ddl-defaults.ts'
import { describeDdlObjects } from './ddl-objects.ts'
import { describeDdlTables } from './ddl-tables.ts'
import type { ConformanceEnv, DdlHelpers } from './env.ts'

/** Conformance: the blocks of `ddl`, one group per file, in the order they have always run in. */
export function describeDdl(env: ConformanceEnv): void {
  const { ns, dialect, execOk } = env
  describe('ddl', () => {
    /** As the web runs a preview: all of an op's statements as one script through the SQL route. */
    const runScript = async (op: DdlOp) => execOk(sqlScript(dialect, env.db.ddl.build(ns, op)))
    const firstValue = async (sql: string) => {
      const r = await execOk(sql)
      const rows = r.find((x) => x.kind === 'rows')
      return rows?.kind === 'rows' ? rows.result.rows[0]?.[0] : undefined
    }

    const helpers: DdlHelpers = { runScript, firstValue }
    describeDdlObjects(env, helpers)
    describeDdlTables(env, helpers)
    describeDdlDefaults(env, helpers)
    describeDdlColumnsAndDatabases(env, helpers)
  })
}
