import type { HypotheticalIndex, PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '../../types.ts'
import type { ConformanceEnv } from './env.ts'

/**
 * Conformance: plans with indexes assumed, not built. PostgreSQL needs the HypoPG package on the server (the compose
 * image and CI install it); the test makes the extension in the database and drops it again.
 */
export function describeHypotheticalPlan(env: ConformanceEnv): void {
  const { ns, dialect, scratch, execOk, exec } = env
  const nodes = (n: PlanNode): PlanNode[] => [n, ...n.children.flatMap(nodes)]
  const one = async (sql: string) => {
    const [r] = await exec(sql)
    return r?.kind === 'rows' ? Number(r.result.rows[0]?.[0]) : null
  }

  describe('hypotheticalPlan', () => {
    it('is refused on MySQL and MariaDB, whose estimate does not offer it', async () => {
      if (dialect !== 'mysql') return
      const index: HypotheticalIndex = { table: 'users', columns: ['age'], name: 'idx_users_age' }
      await expect(env.db.hypotheticalPlan(ns, 'SELECT * FROM users', [index])).rejects.toMatchObject({
        code: 'UNSUPPORTED',
      })
      expect((await env.db.explainPlan(ns, 'SELECT name FROM users WHERE age > 20')).canAssume).toBeUndefined()
    })

    it('plans with an index that is not built, by the name given, and leaves none behind (PostgreSQL)', async () => {
      if (dialect !== 'postgres') return
      const t = `${scratch}_hypo`
      await execOk('CREATE EXTENSION IF NOT EXISTS hypopg')
      await execOk(`CREATE TABLE ${t} (id int PRIMARY KEY, a int, b text)`)
      await execOk(`INSERT INTO ${t} SELECT g, g % 1000, 'x' || g FROM generate_series(1, 20000) g`)
      await execOk(`ANALYZE ${t}`)
      try {
        const sql = `SELECT * FROM ${t} WHERE a = 5`
        const before = await env.db.explainPlan(ns, sql)
        expect(before.canAssume).toBe(true)
        expect(nodes(before.plan).some((n) => n.table === t && n.access === 'fullScan')).toBe(true)

        const onA = `idx_${t}_a`
        const onB = `idx_${t}_b`
        const r = await env.db.hypotheticalPlan(ns, sql, [
          { table: t, columns: ['a'], name: onA },
          { table: t, columns: ['b'], name: onB },
        ])
        // Read through the one on `a`, called by its given name, in the tree and the raw plan alike.
        expect(nodes(r.plan).some((n) => n.index === onA)).toBe(true)
        expect(r.assumed).toEqual([onA])
        expect(r.raw).toContain(onA)
        expect(r.raw).not.toMatch(/<\d+>/)
        // Nothing was built, and no later plan on the session's connections still sees it.
        expect(await one(`SELECT COUNT(*) FROM pg_indexes WHERE tablename = '${t}'`)).toBe(1)
        for (let i = 0; i < 6; i++) {
          const after = await env.db.explainPlan(ns, sql)
          expect(nodes(after.plan).some((n) => n.index === onA || /^<\d+>/.test(n.index ?? ''))).toBe(false)
        }

        // A column not there is the server's error, and leaves nothing either.
        await expect(
          env.db.hypotheticalPlan(ns, sql, [
            { table: t, columns: ['a'], name: onA },
            { table: t, columns: ['nope'], name: 'idx_nope' },
          ])
        ).rejects.toBeInstanceOf(AdapterError)
        const again = await env.db.explainPlan(ns, sql)
        expect(nodes(again.plan).some((n) => n.table === t && n.access === 'fullScan')).toBe(true)
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })

    it('says it cannot where HypoPG is not installed in the database (PostgreSQL)', async () => {
      if (dialect !== 'postgres') return
      await execOk('DROP EXTENSION IF EXISTS hypopg')
      const sql = 'SELECT name FROM users WHERE age > 20'
      expect((await env.db.explainPlan(ns, sql)).canAssume).toBe(false)
      await expect(
        env.db.hypotheticalPlan(ns, sql, [{ table: 'users', columns: ['age'], name: 'idx_users_age' }])
      ).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    })
  })
}
