import type { DdlOp } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import type { ConformanceEnv } from './env.ts'

/** Conformance: what `prepareDdl` fills in from the real server before an op's SQL is built. */
export function describePrepareDdl(env: ConformanceEnv): void {
  const { ns, dialect, scratch, execOk, exec } = env
  const t = `${scratch}_prep`
  const generated = 'GENERATED ALWAYS AS (a * 2) STORED'
  const own = (op: DdlOp | undefined) => op as unknown as Record<string, unknown>

  describe('prepareDdl', () => {
    it('lists the writable columns of a copy with its data, leaving a generated column out', async () => {
      try {
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, a INT, b INT ${generated})`)
        const op = await env.db.prepareDdl(ns, { op: 'copyTable', table: t, newName: `${t}_c`, withData: true })
        expect(own(op).columns).toEqual(['id', 'a'])
        if (dialect === 'postgres') {
          // PostgreSQL's copy also says which columns have sequences of their own to advance (none here).
          expect(own(op).identityColumns).toEqual([])
          expect(own(op).serialColumns).toEqual([])
        }
      } finally {
        await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      }
    })

    it('does not overwrite what the request already carried', async () => {
      try {
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, a INT)`)
        const op = await env.db.prepareDdl(ns, {
          op: 'copyTable',
          table: t,
          newName: `${t}_c`,
          withData: true,
          columns: ['id'],
        })
        expect(own(op).columns).toEqual(['id'])
      } finally {
        await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      }
    })

    it('lists the tables of the database for a collation that is applied to them', async () => {
      try {
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20))`)
        const op = await env.db.prepareDdl(ns, {
          op: 'setDatabaseCollation',
          name: ns.database,
          collation: dialect === 'mysql' ? 'utf8mb4_bin' : 'C',
          applyToTables: true,
        })
        expect(own(op).tables).toContain(t)
        if (dialect === 'postgres') expect(own(op).columns).toMatchObject({ [t]: [{ name: 'name' }] })
      } finally {
        await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      }
    })

    it('fills in, per table, what a copy of several tables needs', async () => {
      try {
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, a INT, b INT ${generated})`)
        const op = await env.db.prepareDdl(ns, { op: 'copyTables', tables: [t], withData: true })
        expect(own(op).details).toMatchObject({ [t]: { columns: ['id', 'a'] } })
      } finally {
        await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      }
    })

    it('returns an op that needs nothing from the server as it came', async () => {
      const op: DdlOp = { op: 'createDatabase', name: `${scratch}_nodb` }
      expect(await env.db.prepareDdl(ns, op)).toEqual(op)
    })

    it('refuses a rename or copy of a database that cannot be done, with the error a person is shown', async () => {
      const refusal = (op: DdlOp) =>
        env.db.prepareDdl(ns, op).then(
          () => null,
          (e: unknown) => e
        )
      expect(await refusal({ op: 'renameDatabase', name: ns.database, newName: ns.database })).toMatchObject({
        code: 'VALIDATION',
      })
      expect(
        await refusal({ op: 'renameDatabase', name: `${scratch}_nowhere`, newName: `${scratch}_x` })
      ).toMatchObject({
        code: 'NOT_FOUND',
      })
      const system = dialect === 'mysql' ? 'mysql' : 'postgres'
      expect(await refusal({ op: 'renameDatabase', name: system, newName: `${scratch}_x` })).toMatchObject({
        code: 'VALIDATION',
      })
    })
  })
}
