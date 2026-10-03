import { describe, expect, it, vi } from 'vitest'
import type { ConformanceEnv } from './env.ts'

/** Conformance: the blocks of `catalog` (in the order they have always run in). */
export function describeCatalog(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, exec, execOk, runDdl, browseAll, isMariaDb } = env
  describe('ping', () => {
    it('resolves for valid credentials', async () => {
      await expect(env.db.ping()).resolves.toBeUndefined()
    })

    it('rejects with AUTH_FAILED for a wrong password', async () => {
      const bad = ctx.createBad()
      await expect(bad.ping()).rejects.toMatchObject({ name: 'AdapterError', code: 'AUTH_FAILED' })
      await bad.close()
    })
  })

  describe('listDatabases', () => {
    it('includes the fixture databases', async () => {
      const names = (await env.db.listDatabases()).map((d) => d.name)
      expect(names).toContain(ns.database)
      expect(names).toContain(ctx.otherDatabase)
    })

    it('leaves out the sizes and table counts when asked not to count them', async () => {
      // Two listings, one after the other: another test file creates and drops databases on this same server at
      // the same time, so one taken between those can differ by them. Taken again until the names agree — a real
      // difference (the option changing which databases are listed) does not go away, and still fails here.
      await vi.waitFor(
        async () => {
          const counted = await env.db.listDatabases()
          const bare = await env.db.listDatabases({ stats: false })
          expect(bare.map((d) => d.name)).toEqual(counted.map((d) => d.name))
          for (const d of bare) {
            expect(d.sizeBytes).toBeNull()
            expect(d.tableCount).toBeNull()
          }
          // The fixture database has tables, so the counted list is not all nulls.
          expect(counted.find((d) => d.name === ns.database)?.sizeBytes).not.toBeNull()
        },
        { timeout: 5000, interval: 50 }
      )
    })
  })

  describe('listSchemas', () => {
    it('returns the expected schemas for the dialect', async () => {
      const schemas = await env.db.listSchemas(ns.database)
      for (const s of ctx.schemas) expect(schemas).toContain(s)
      if (ctx.schemas.length === 0) expect(schemas).toEqual([])
    })
  })

  describe('listTables', () => {
    it('lists fixture tables and views with metadata', async () => {
      const tables = await env.db.listTables(ns)
      const map = new Map(tables.map((t) => [t.name, t]))
      for (const name of ['users', 'posts', 'types_all', 'no_pk', 'unique_only', 'composite_pk', 'active_users']) {
        expect(map.has(name), `missing table ${name}`).toBe(true)
      }
      expect(map.get('users')?.kind).toBe('table')
      expect(map.get('active_users')?.kind).toBe('view')
      expect(map.get('users')?.comment).toBe('application users')
      const est = map.get('users')?.rowEstimate
      expect(est === null || typeof est === 'number').toBe(true)
    })
  })

  describe('describeTable', () => {
    it('describes columns, primary key, indexes and comments', async () => {
      const users = await env.db.describeTable(ns, 'users')
      expect(users.kind).toBe('table')
      expect(users.comment).toBe('application users')
      expect(users.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'age', 'created_at'])
      expect(users.primaryKey).toEqual(['id'])
      expect(users.rowEstimate === null || typeof users.rowEstimate === 'number').toBe(true)
      const name = users.columns.find((c) => c.name === 'name')
      expect(name?.nullable).toBe(false)
      expect(name?.comment).toBe('display name')
      expect(users.columns.find((c) => c.name === 'age')?.nullable).toBe(true)
      expect(users.columns.find((c) => c.name === 'id')?.extra).not.toBe('')
      const createdAt = users.columns.find((c) => c.name === 'created_at')
      // `DEFAULT CURRENT_TIMESTAMP` is an expression on both dialects; a literal here would be re-quoted on
      // the next column edit and stop being a default at all.
      expect(createdAt?.defaultIsExpression).toBe(true)
      expect(createdAt?.default ?? '').toMatch(
        dialect === 'mysql' ? /^current_timestamp(\(\))?$/i : /^(?:now\(\)|CURRENT_TIMESTAMP)$/i
      )
      const uq = users.indexes.find((i) => i.name === 'uq_users_email')
      expect(uq).toMatchObject({ unique: true, primary: false, columns: ['email'] })
      expect(users.indexes.find((i) => i.name === 'idx_users_name')).toMatchObject({
        unique: false,
        columns: ['name'],
      })
      expect(users.indexes.find((i) => i.primary)?.columns).toEqual(['id'])
    })

    it('lists reverse references (tables pointing at this one)', async () => {
      const users = await env.db.describeTable(ns, 'users')
      expect(users.referencedBy).toHaveLength(1)
      expect(users.referencedBy[0]).toMatchObject({
        name: 'fk_posts_user',
        fromTable: 'posts',
        fromColumns: ['user_id'],
        columns: ['id'],
      })
      expect((await env.db.describeTable(ns, 'posts')).referencedBy).toEqual([])
      expect((await browseAll('users')).referencedBy).toHaveLength(1)
    })

    it('describes foreign keys with referential actions', async () => {
      const posts = await env.db.describeTable(ns, 'posts')
      expect(posts.foreignKeys).toHaveLength(1)
      expect(posts.foreignKeys[0]).toMatchObject({
        name: 'fk_posts_user',
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      })
    })

    it('handles composite keys, missing keys, unique-only tables and views', async () => {
      expect((await env.db.describeTable(ns, 'composite_pk')).primaryKey).toEqual(['a', 'b'])
      const noPk = await env.db.describeTable(ns, 'no_pk')
      expect(noPk.primaryKey).toEqual([])
      expect(noPk.comment).toBe('table without primary key')
      const uniqueOnly = await env.db.describeTable(ns, 'unique_only')
      expect(uniqueOnly.primaryKey).toEqual([])
      expect(uniqueOnly.indexes.some((i) => i.unique && i.columns.join() === 'code')).toBe(true)
      expect((await env.db.describeTable(ns, 'active_users')).kind).toBe('view')
    })

    it('rejects with NOT_FOUND for an unknown table', async () => {
      await expect(env.db.describeTable(ns, 'does_not_exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('listRoutines', () => {
    it('lists the fixture procedure and function', async () => {
      const routines = await env.db.listRoutines(ns)
      const proc = routines.find((r) => r.name === 'count_users')
      const fn = routines.find((r) => r.name === 'user_label')
      expect(proc?.kind).toBe('procedure')
      expect(fn?.kind).toBe('function')
      expect(fn?.returns?.toLowerCase()).toMatch(/varchar|text/)
      expect(fn?.parameters.toLowerCase()).toContain('uid')
    })
  })

  describe('routineDefinition', () => {
    it('returns the CREATE statement per routine and NOT_FOUND for unknown names', async () => {
      const fn = await env.db.routineDefinition(ns, 'user_label', 'function')
      expect(fn?.toUpperCase()).toContain('CREATE')
      expect(fn).toContain('user_label')
      expect((await env.db.routineDefinition(ns, 'count_users', 'procedure'))?.toUpperCase()).toContain('CREATE')
      await expect(env.db.routineDefinition(ns, 'does_not_exist', 'function')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      // Wrong kind for an existing name is not a match either.
      await expect(env.db.routineDefinition(ns, 'user_label', 'procedure')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('listDependencies', () => {
    it('reports what a view reads from the catalog, or null where the server has none (MariaDB)', async () => {
      const t = `${scratch}_dep_t`
      const v1 = `${scratch}_dep_v1`
      const v2 = `${scratch}_dep_v2`
      try {
        await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY)`)
        // v1's alias equals v2's name: a text scan would see a dependency the wrong way round.
        await execOk(`CREATE VIEW ${v1} AS SELECT id AS ${v2} FROM ${t}`)
        await execOk(`CREATE VIEW ${v2} AS SELECT ${v2} FROM ${v1}`)
        const deps = await env.db.listDependencies(ns)
        if (deps === null) {
          expect(await isMariaDb()).toBe(true)
          return
        }
        const of = (name: string) => deps.find((d) => d.kind === 'view' && d.name === name)?.dependsOn ?? []
        expect(of(v2)).toContainEqual({ kind: 'view', name: v1 })
        expect(of(v2)).not.toContainEqual({ kind: 'view', name: v2 })
        expect(of(v1)).toContainEqual({ kind: 'table', name: t })
        expect(of(v1)).not.toContainEqual({ kind: 'view', name: v2 })
      } finally {
        await exec(`DROP VIEW IF EXISTS ${v2}; DROP VIEW IF EXISTS ${v1}; DROP TABLE IF EXISTS ${t}`, {
          stopOnError: false,
        })
      }
    })

    it.skipIf(dialect !== 'postgres')(
      'records what a SQL-standard-body routine reads and a row-type signature (PostgreSQL)',
      async () => {
        const t = `${scratch}_dep_t`
        const v = `${scratch}_dep_v1`
        const f = `${scratch}_dep_f`
        const g = `${scratch}_dep_g`
        try {
          await execOk(
            `CREATE TABLE ${t} (id INT PRIMARY KEY); CREATE VIEW ${v} AS SELECT id FROM ${t};
             CREATE FUNCTION ${f}() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM ${v}; END;
             CREATE FUNCTION ${g}(xs ${t}[]) RETURNS SETOF ${t} LANGUAGE sql AS $$ SELECT * FROM ${t} $$`
          )
          const deps = (await env.db.listDependencies(ns)) ?? []
          const of = (name: string) => deps.find((d) => d.kind === 'routine' && d.name === name)?.dependsOn
          expect(of(f)).toContainEqual({ kind: 'view', name: v })
          // A string body records nothing, but its signature depends on the table's row type (array included).
          expect(of(g)).toContainEqual({ kind: 'table', name: t })
        } finally {
          await exec(
            `DROP FUNCTION IF EXISTS ${g}(${t}[]); DROP FUNCTION IF EXISTS ${f}(); DROP VIEW IF EXISTS ${v}; DROP TABLE IF EXISTS ${t}`,
            { stopOnError: false }
          )
        }
      }
    )
  })

  describe('listTriggers', () => {
    it('lists the fixture trigger and filters by table', async () => {
      const all = await env.db.listTriggers(ns)
      const trg = all.find((t) => t.name === 'posts_before_insert')
      expect(trg).toMatchObject({ table: 'posts', timing: 'BEFORE', events: 'INSERT', orientation: 'ROW' })
      expect(trg?.definition).toBeTruthy()
      expect((await env.db.listTriggers(ns, 'posts')).map((t) => t.name)).toContain('posts_before_insert')
      expect(await env.db.listTriggers(ns, 'users')).toEqual([])
    })
  })

  describe('listEvents', () => {
    it('lists scheduled events on MySQL and returns [] on PostgreSQL', async () => {
      const events = await env.db.listEvents(ns)
      if (dialect === 'postgres') {
        expect(events).toEqual([])
        return
      }
      const ev = events.find((e) => e.name === 'purge_old_posts')
      expect(ev).toMatchObject({
        status: 'DISABLED',
        type: 'RECURRING',
        schedule: 'EVERY 1 DAY',
        comment: 'remove posts older than a year',
      })
      expect(ev?.definition).toContain('DELETE FROM posts')
      try {
        await runDdl({ op: 'enableEvent', name: 'purge_old_posts' })
        expect((await env.db.listEvents(ns)).find((e) => e.name === 'purge_old_posts')?.status).toBe('ENABLED')
      } finally {
        await runDdl({ op: 'disableEvent', name: 'purge_old_posts' })
      }
      expect((await env.db.listEvents(ns)).find((e) => e.name === 'purge_old_posts')?.status).toBe('DISABLED')
    })
  })
}
